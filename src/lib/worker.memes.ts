import 'server-only';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { queryDb, withTransaction } from './db';
import { uploadGeneratedMeme, getMemeBlobBuffer, deleteBlob } from './memes/blob';
import { performMemeAnalysis } from './memes/analysis';
import { generateMemeImage, MemeGenerationResult } from './memes/generation';
import { validateMemeImage } from './memes/validation';
import { MemeSlotPlan } from './memes/planner';
import { ResolvedEntityLogo, resolveEntityLogos } from './memes/entity-logo-resolver';
import { ImageModelSnapshot } from './ai/image-models';
import { classifyMemeProviderError } from './memes/errors';

export interface MemeClaimedJob {
  jobId: string;
  cycleId: string;
  campaignId?: string;
  draftId?: string;
  campaignPostId?: string;
  slotIndex: number;
  slotPlan: MemeSlotPlan;
  deterministicDimensions: unknown;
  assetSnapshot: unknown;
  modelSnapshot: ImageModelSnapshot;
  attemptsCount: number;
  postText?: string;
  authorName?: string;
  authorUsername?: string;
  accessibleContext?: Record<string, unknown>;
  campaignDirection?: string;
}

export interface ProcessMemeQueueOptions {
  workerId?: string;
  budgetMs?: number;
  cycleId?: string;
  maxJobs?: number;
  maxConcurrency?: number;
}

interface NormalizedAssetSnapshot {
  id: string;
  assetType: string;
  instruction: string;
  storageKey?: string;
  storageUrl?: string;
  mimeType: string;
}

function normalizeSingleAssetSnapshot(snapshot: unknown): NormalizedAssetSnapshot | null {
  const raw = typeof snapshot === 'string'
    ? (() => { try { return JSON.parse(snapshot) as unknown; } catch { return null; } })()
    : snapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const asset = raw as Record<string, unknown>;
  const id = String(asset.id || '');
  if (!id) return null;
  return {
    id,
    assetType: String(asset.assetType || asset.asset_type || ''),
    instruction: String(asset.instruction || ''),
    storageKey: typeof (asset.storageKey || asset.storage_key) === 'string' ? String(asset.storageKey || asset.storage_key) : undefined,
    storageUrl: typeof (asset.storageUrl || asset.storage_url) === 'string' ? String(asset.storageUrl || asset.storage_url) : undefined,
    mimeType: String(asset.mimeType || asset.mime_type || 'image/png')
  };
}

function normalizeAssetSnapshots(snapshot: unknown): { primaryAsset: NormalizedAssetSnapshot; secondaryAsset: NormalizedAssetSnapshot | null } | null {
  const raw = typeof snapshot === 'string'
    ? (() => { try { return JSON.parse(snapshot) as unknown; } catch { return null; } })()
    : snapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const primaryAsset = normalizeSingleAssetSnapshot(record.primaryAsset || raw);
  if (!primaryAsset) return null;
  return { primaryAsset, secondaryAsset: normalizeSingleAssetSnapshot(record.secondaryAsset) };
}

async function composeRequiredLogo(generation: MemeGenerationResult, assetData?: { buffer: Buffer; assetType: string }): Promise<MemeGenerationResult> {
  if (!assetData || assetData.assetType !== 'logo') return generation;
  const metadata = await sharp(generation.imageBuffer).metadata();
  const width = metadata.width || generation.width;
  const height = metadata.height || generation.height;
  if (!width || !height) throw new Error('Generated image dimensions are unavailable for logo composition');
  const logo = await sharp(assetData.buffer)
    .resize({ width: Math.max(32, Math.floor(width * 0.18)), height: Math.max(32, Math.floor(height * 0.18)), fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return {
    ...generation,
    imageBuffer: await sharp(generation.imageBuffer).composite([{ input: logo, gravity: 'southeast' }]).png().toBuffer(),
    mimeType: 'image/png',
    width,
    height
  };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

export function composeBrandTextSvg(brandText: string, width: number = 1024, height: number = 1024): string {
  const fontSize = Math.max(12, Math.floor(Math.min(width, height) * 0.045));
  const padding = Math.max(8, Math.floor(fontSize * 0.45));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${padding}" y="${height - padding}" fill="#ffffff" stroke="#000000" stroke-width="${Math.max(1, Math.floor(fontSize / 12))}" paint-order="stroke" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700">${escapeXml(brandText)}</text></svg>`;
}

async function composeBrandText(generation: MemeGenerationResult, brandText?: string): Promise<MemeGenerationResult> {
  if (!brandText) return generation;
  try {
    const metadata = await sharp(generation.imageBuffer).metadata();
    const width = metadata.width || generation.width;
    const height = metadata.height || generation.height;
    if (!width || !height) throw new Error('Generated image dimensions are unavailable for brand composition');
    return {
      ...generation,
      imageBuffer: await sharp(generation.imageBuffer).composite([{ input: Buffer.from(composeBrandTextSvg(brandText, width, height)) }]).png().toBuffer(),
      mimeType: 'image/png',
      width,
      height,
    };
  } catch {
    return generation;
  }
}

export async function composeResolvedEntityLogos(
  generation: MemeGenerationResult,
  logos: readonly ResolvedEntityLogo[],
  clientAsset?: { buffer: Buffer; assetType: string }
): Promise<MemeGenerationResult> {
  const withClientAsset = await composeRequiredLogo(generation, clientAsset);
  if (logos.length === 0) return withClientAsset;

  const metadata = await sharp(withClientAsset.imageBuffer).metadata();
  const width = metadata.width || withClientAsset.width;
  const height = metadata.height || withClientAsset.height;
  if (!width || !height) throw new Error('Generated image dimensions are unavailable for entity logo composition');

  if (width < 2 || height < 2) {
    return {
      ...withClientAsset,
      imageBuffer: await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
      mimeType: 'image/png',
      width,
      height,
    };
  }

  const smallestDimension = Math.min(width, height);
  const logoSize = Math.min(smallestDimension, Math.max(1, Math.floor(smallestDimension * 0.14)));
  const margin = Math.min(Math.max(0, smallestDimension - logoSize), Math.max(0, Math.floor(smallestDimension * 0.03)));
  const composites = await Promise.all(logos.slice(0, 2).map(async (logo, index) => ({
    input: await sharp(Buffer.from(logo.svg)).resize({ width: logoSize, height: logoSize, fit: 'inside' }).png().toBuffer(),
    left: margin + index * (logoSize + margin),
    top: Math.max(0, height - logoSize - margin),
  })));

  return {
    ...withClientAsset,
    imageBuffer: await sharp(withClientAsset.imageBuffer).composite(composites).png().toBuffer(),
    mimeType: 'image/png',
    width,
    height,
  };
}

export const MIN_MEME_WORKER_JOB_BUDGET_MS = 25_000;
const WORKER_DURABLE_WRITE_RESERVE_MS = 5_000;

export async function processMemeBackgroundQueue(
  optionsOrWorkerId: ProcessMemeQueueOptions | string = {},
  budgetMsParam: number = 50000
) {
  const options: ProcessMemeQueueOptions =
    typeof optionsOrWorkerId === 'string'
      ? { workerId: optionsOrWorkerId, budgetMs: budgetMsParam }
      : optionsOrWorkerId;

  const workerId = options.workerId || randomUUID();
  const budgetMs = options.budgetMs !== undefined ? options.budgetMs : 50000;
  const cycleId = options.cycleId;
  const maxParallelConcurrency = options.maxConcurrency || 3;
  const maxJobs = options.maxJobs;

  const startTime = Date.now();
  const deadline = startTime + Math.max(0, budgetMs);
  const hasSafeJobBudget = () => deadline - Date.now() >= MIN_MEME_WORKER_JOB_BUDGET_MS;

  let totalProcessed = 0;
  let totalCompleted = 0;
  let totalFailed = 0;
  let totalValidMemes = 0;
  let totalRegenerations = 0;
  let totalCost = 0;
  let boundedErrors = 0;

  while (hasSafeJobBudget() && (maxJobs === undefined || totalProcessed < maxJobs)) {
    const claimedJobs: MemeClaimedJob[] = [];

    for (let c = 0; c < maxParallelConcurrency; c++) {
      if (!hasSafeJobBudget()) break;
      if (maxJobs !== undefined && (totalProcessed + claimedJobs.length) >= maxJobs) break;
      const job = await claimNextMemeJob(workerId, cycleId);
      if (job) {
        claimedJobs.push(job);
      } else {
        break;
      }
    }

    if (claimedJobs.length === 0) {
      break;
    }

    const settled = await Promise.allSettled(
      claimedJobs.map((job) => executeMemeJobTask(job, workerId, deadline))
    );

    const results = settled.map((result) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            success: false,
            error: 'Unhandled worker task failure',
            metrics: { regenerations: 0, validMemes: 0, cost: 0, boundedErrors: 1 }
          }
    );

    for (const res of results) {
      totalProcessed++;
      if (res.success) {
        totalCompleted++;
      } else {
        totalFailed++;
      }
      totalValidMemes += res.metrics?.validMemes || 0;
      totalRegenerations += res.metrics?.regenerations || 0;
      totalCost += res.metrics?.cost || 0;
      boundedErrors += res.metrics?.boundedErrors || 0;
    }
  }

  return {
    processed: totalProcessed,
    completed: totalCompleted,
    failed: totalFailed,
    validMemes: totalValidMemes,
    regenerations: totalRegenerations,
    cost: totalCost,
    timeMs: Date.now() - startTime,
    boundedErrors
  };
}

async function claimNextMemeJob(
  workerId: string,
  cycleId?: string
): Promise<MemeClaimedJob | null> {
  const leaseDurationSeconds = 90;

  return await withTransaction(async (client) => {
    const queryParams: unknown[] = [];
    let cycleFilter = '';
    if (cycleId) {
      queryParams.push(cycleId);
      cycleFilter = `AND j.cycle_id = $1`;
    }

    const selectRes = await client.query(
      `
       SELECT
         j.id as job_id,
         j.cycle_id,
         j.campaign_id,
         j.draft_id,
         j.campaign_post_id,
         j.slot_index,
         j.slot_plan,
         j.deterministic_dimensions,
         j.asset_snapshot,
         j.model_snapshot,
         j.attempts_count,
         COALESCE(p.text_content, md.config->>'postText') as post_text,
         COALESCE(p.author_name, md.config->>'authorName') as author_name,
         COALESCE(p.author_username, md.config->>'authorUsername') as author_username,
         COALESCE(p.accessible_context, (md.config->>'accessibleContext')::jsonb) as accessible_context,
         COALESCE(c.direction, md.config->>'direction') as direction,
         cy.model_key as cycle_model_key,
         cy.provider as cycle_provider,
         cy.api_model as cycle_api_model
       FROM meme_generation_jobs j
       LEFT JOIN campaign_posts p ON j.campaign_post_id = p.id
       LEFT JOIN campaigns c ON j.campaign_id = c.id
       LEFT JOIN meme_drafts md ON j.draft_id = md.id
       LEFT JOIN meme_generation_cycles cy ON j.cycle_id = cy.id
       WHERE (
         (j.status = 'pending' AND j.next_attempt_at <= NOW())
         OR (j.status = 'processing' AND j.lease_expires_at < NOW())
       )
       AND (
         (c.is_active = true) OR (md.status = 'active')
       )
       ${cycleFilter}
       ORDER BY j.created_at ASC
       LIMIT 1
       FOR UPDATE OF j SKIP LOCKED
    `,
      queryParams
    );

    if (selectRes.rows.length === 0) {
      return null;
    }

    const row = selectRes.rows[0];

    const rawSnap =
      typeof row.model_snapshot === 'object' && row.model_snapshot !== null
        ? (row.model_snapshot as Record<string, unknown>)
        : {};

    const normKey = String(
      rawSnap.key || rawSnap.modelKey || rawSnap.model_key || row.cycle_model_key || ''
    );
    const normProvider = String(rawSnap.provider || row.cycle_provider || '');
    const normApiModel = String(
      rawSnap.apiModel || rawSnap.api_model || rawSnap.model_name || row.cycle_api_model || ''
    );

    const canonicalSnapshot: ImageModelSnapshot = {
      key: normKey,
      provider: normProvider as 'openai' | 'google',
      apiModel: normApiModel
    };

    await client.query(
      `UPDATE meme_generation_jobs
       SET status = 'processing',
           lease_owner = $1,
           lease_expires_at = NOW() + INTERVAL '${leaseDurationSeconds} seconds',
           model_snapshot = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [workerId, JSON.stringify(canonicalSnapshot), row.job_id]
    );

    await client.query(
      `UPDATE meme_generation_cycles
       SET status = 'processing',
           started_at = COALESCE(started_at, NOW())
       WHERE id = $1 AND status = 'pending'`,
      [row.cycle_id]
    );

    return {
      jobId: row.job_id,
      cycleId: row.cycle_id,
      campaignId: row.campaign_id,
      draftId: row.draft_id,
      campaignPostId: row.campaign_post_id,
      slotIndex: row.slot_index,
      slotPlan: row.slot_plan,
      deterministicDimensions: row.deterministic_dimensions,
      assetSnapshot: row.asset_snapshot,
      modelSnapshot: canonicalSnapshot,
      attemptsCount: row.attempts_count,
      postText: row.post_text,
      authorName: row.author_name,
      authorUsername: row.author_username,
      accessibleContext: row.accessible_context,
      campaignDirection: row.direction
    };
  });
}

async function extendLease(jobId: string, workerId: string, seconds: number = 90): Promise<boolean> {
  const res = await queryDb(
    `UPDATE meme_generation_jobs
     SET lease_expires_at = NOW() + INTERVAL '${seconds} seconds', updated_at = NOW()
     WHERE id = $1 AND lease_owner = $2 AND status = 'processing'
     RETURNING id`,
    [jobId, workerId]
  );
  return res.length > 0;
}

async function verifyLease(jobId: string, workerId: string): Promise<boolean> {
  const res = await queryDb(
    `SELECT id FROM meme_generation_jobs
     WHERE id = $1 AND lease_owner = $2 AND status = 'processing' AND lease_expires_at > NOW()`,
    [jobId, workerId]
  );
  return res.length > 0;
}

async function releaseLease(jobId: string, transition: 'pending' | 'failed' | 'cancelled' = 'pending', errorMessage?: string) {
  if (transition === 'pending') {
    await queryDb(
      `UPDATE meme_generation_jobs
       SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NOW() + INTERVAL '15 seconds', updated_at = NOW(), error_message = COALESCE($2, error_message)
       WHERE id = $1 AND status = 'processing'`,
      [jobId, errorMessage || null]
    );
  } else if (transition === 'failed') {
    await queryDb(
      `UPDATE meme_generation_jobs
       SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, attempts_count = GREATEST(attempts_count, 3), updated_at = NOW(), error_message = COALESCE($2, error_message)
       WHERE id = $1 AND status = 'processing'`,
      [jobId, errorMessage || null]
    );
  } else if (transition === 'cancelled') {
    await queryDb(
      `UPDATE meme_generation_jobs
       SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW(), error_message = COALESCE($2, error_message)
       WHERE id = $1 AND status = 'processing'`,
      [jobId, errorMessage || null]
    );
  }
}

async function recalculateMemeCycleStatus(cycleId: string, lastError?: string) {
  await withTransaction(async (client) => {
    // Lock cycles and jobs/memes to ensure consistency
    const cycleRes = await client.query<{ target_count: number; status: string }>(
      `SELECT target_count, status FROM meme_generation_cycles WHERE id = $1 FOR NO KEY UPDATE`,
      [cycleId]
    );
    if (cycleRes.rows.length === 0) return;
    const targetCount = cycleRes.rows[0].target_count;
    const currentCycleStatus = cycleRes.rows[0].status;

    const jobsRes = await client.query<{ id: string; status: string; slot_index: number }>(
      `SELECT id, status, slot_index FROM meme_generation_jobs WHERE cycle_id = $1 FOR SHARE`,
      [cycleId]
    );

    const memesRes = await client.query<{ job_id: string }>(
      `SELECT m.job_id FROM memes m JOIN meme_generation_jobs j ON m.job_id = j.id WHERE j.cycle_id = $1 FOR SHARE`,
      [cycleId]
    );

    let pending = 0;
    let processing = 0;
    let completedJobs = 0;
    let failedJobs = 0;
    const completedJobIds = new Set<string>();

    for (const j of jobsRes.rows) {
      if (j.status === 'pending') pending++;
      else if (j.status === 'processing') processing++;
      else if (j.status === 'completed') {
        completedJobs++;
        completedJobIds.add(j.id);
      }
      else if (j.status === 'failed' || j.status === 'cancelled') failedJobs++;
    }

    const uniqueMemeJobIds = new Set<string>();
    for (const m of memesRes.rows) {
      uniqueMemeJobIds.add(m.job_id);
    }
    const validProducedCount = uniqueMemeJobIds.size;

    let cycleStatus = 'processing';

    if (currentCycleStatus === 'cancelled') {
      cycleStatus = 'cancelled';
    } else {
      const terminal = pending === 0 && processing === 0;
      if (terminal) {
        if (completedJobs === 3 && validProducedCount === 3 && targetCount === 3) {
          cycleStatus = 'completed';
        } else if (validProducedCount > 0) {
          cycleStatus = 'partial';
        } else {
          cycleStatus = 'failed';
        }
      }
    }

    const isTerminalNow = cycleStatus === 'completed' || cycleStatus === 'partial' || cycleStatus === 'failed' || cycleStatus === 'cancelled';

    await client.query(
      `UPDATE meme_generation_cycles
       SET valid_produced_count = $1,
           completed_jobs_count = $2,
           failed_jobs_count = $3,
           status = $4,
           error_message = CASE WHEN $4 IN ('failed', 'partial') THEN COALESCE($5, error_message) ELSE error_message END,
           finished_at = CASE WHEN $6::boolean AND finished_at IS NULL THEN NOW() ELSE finished_at END
       WHERE id = $7`,
      [validProducedCount, completedJobs, failedJobs, cycleStatus, lastError || null, isTerminalNow, cycleId]
    );
  });
}

async function executeMemeJobTask(
  job: MemeClaimedJob,
  workerId: string,
  deadline: number
): Promise<{
  success: boolean;
  error?: string;
  metrics: { regenerations: number; validMemes: number; cost: number; boundedErrors: number };
}> {
  const metrics = { regenerations: 0, validMemes: 0, cost: 0, boundedErrors: 0 };
  let currentCost = 0;

  const hasRemainingBudget = (reserveMs: number = WORKER_DURABLE_WRITE_RESERVE_MS) =>
    deadline - Date.now() >= reserveMs;

  const attemptNumber = job.attemptsCount + 1;
  const abortController = new AbortController();

  let heartbeatInterval: NodeJS.Timeout | null = null;
  const startHeartbeat = () => {
    heartbeatInterval = setInterval(async () => {
      try {
        const ext = await extendLease(job.jobId, workerId, 90);
        if (!ext) {
          console.error(`Lease extension failed for ${job.jobId}, aborting`);
          abortController.abort();
          if (heartbeatInterval) clearInterval(heartbeatInterval);
        }
      } catch (e) {
        console.error('Heartbeat error', e);
      }
    }, 30000);
  };
  const stopHeartbeat = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  };

  const startApiCall = async (
    purpose: string,
    provider: string,
    modelKey: string,
    apiModel: string,
    phase?: 'revalidation'
  ): Promise<{ callKey: string; shouldExecute: boolean; existingStatus?: string }> => {
    const callKey = phase
      ? `${job.jobId}:${attemptNumber}:${purpose}:${phase}`
      : `${job.jobId}:${attemptNumber}:${purpose}`;

    const insertRes = await queryDb<{ id: string }>(
      `INSERT INTO meme_api_calls (
         call_key, campaign_id, draft_id, cycle_id, job_id, purpose, provider, model_key, api_model, status, total_cost, pricing_snapshot, currency, attempt
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'started', 0, $10, 'USD', $11)
       ON CONFLICT (call_key) DO NOTHING
       RETURNING id`,
      [
        callKey,
        job.campaignId || null,
        job.draftId || null,
        job.cycleId,
        job.jobId,
        purpose,
        provider,
        modelKey,
        apiModel,
        JSON.stringify(job.modelSnapshot),
        attemptNumber
      ]
    );

    if (insertRes.length > 0) {
      return { callKey, shouldExecute: true };
    }

    const existing = await queryDb<{ status: string; created_at: Date | string }>(
      `SELECT status, created_at FROM meme_api_calls WHERE call_key = $1 LIMIT 1`,
      [callKey]
    );

    if (existing.length > 0) {
      const callStatus = existing[0].status;
      const createdAt = new Date(existing[0].created_at).getTime();
      const ageSeconds = (Date.now() - createdAt) / 1000;

      if (callStatus === 'started') {
        if (ageSeconds >= 120) {
          await queryDb(`UPDATE meme_api_calls SET status = 'usage_unknown' WHERE call_key = $1`, [callKey]);
          return { callKey, shouldExecute: false, existingStatus: 'usage_unknown' };
        }
        return { callKey, shouldExecute: false, existingStatus: 'started' };
      }
      return { callKey, shouldExecute: false, existingStatus: callStatus };
    }
    return { callKey, shouldExecute: true };
  };

  const finishApiCall = async (callKey: string, cost: number, status: string, error?: string) => {
    await queryDb(
      `UPDATE meme_api_calls
       SET status = $1, total_cost = $2, error_message = $3, finished_at = NOW()
       WHERE call_key = $4`,
      [status, cost, error || null, callKey]
    );
  };

  const ensureShouldExecute = (call: { shouldExecute: boolean; existingStatus?: string }, stepName: string) => {
    if (!call.shouldExecute) {
       if (call.existingStatus === 'started') throw new Error(`Idempotency conflict: ${stepName} currently processing`);
       if (call.existingStatus === 'succeeded') throw new Error(`Inconsistency: ${stepName} succeeded but state not recovered`);
       if (call.existingStatus === 'failed') throw new Error(`Idempotency conflict: ${stepName} failed previously`);
       if (call.existingStatus === 'usage_unknown') throw new Error(`Idempotency conflict: ${stepName} stuck in unknown state`);
       throw new Error(`Call already executed or pending reconciliation for ${stepName}`);
    }
  };

  try {
    startHeartbeat();

    if (!job.modelSnapshot.key || !job.modelSnapshot.provider || !job.modelSnapshot.apiModel) {
      const classified = classifyMemeProviderError('apimodel is missing');
      job.attemptsCount = 99; 
      throw new Error(classified.sanitizedMessage);
    }

    if (!hasRemainingBudget()) {
      await releaseLease(job.jobId, 'pending', 'Budget timeout before starting job');
      return { success: false, error: 'Budget timeout before starting job', metrics };
    }

    const postText = job.postText || '';
    const campaignDirection = job.campaignDirection || 'General campaign';

    const existingMemes = await queryDb<{ id: string }>(
      `SELECT id FROM memes WHERE job_id = $1 LIMIT 1`,
      [job.jobId]
    );
    if (existingMemes.length > 0) {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE meme_generation_jobs
           SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, error_message = NULL, updated_at = NOW()
           WHERE id = $1`,
          [job.jobId]
        );
      });
      await recalculateMemeCycleStatus(job.cycleId);
      metrics.validMemes = 1;
      return { success: true, metrics };
    }

    const assetSnapshots = normalizeAssetSnapshots(job.assetSnapshot);
    if (job.slotPlan.requiresAsset && !assetSnapshots) {
      throw new Error('Required asset snapshot is unavailable');
    }
    const primaryAssetSnapshot = assetSnapshots?.primaryAsset;
    const secondaryAssetSnapshot = assetSnapshots?.secondaryAsset;

    const availableAssets = [primaryAssetSnapshot, secondaryAssetSnapshot].filter((asset): asset is NormalizedAssetSnapshot => Boolean(asset)).map((asset) => ({
      id: asset.id,
      instruction: asset.instruction,
      assetType: asset.assetType,
    }));

    const analysisCall = await startApiCall('analysis', 'google', 'gemini-2.5-flash', 'gemini-2.5-flash');
    let analysis;
    ensureShouldExecute(analysisCall, 'analysis');
    try {
      analysis = await performMemeAnalysis({ postText, campaignDirection, availableAssets, brandContext: job.slotPlan.brandText }, { signal: abortController.signal, timeoutMs: deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS });
      await finishApiCall(analysisCall.callKey, 0, 'succeeded');
    } catch (e: unknown) {
      await finishApiCall(analysisCall.callKey, 0, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }

    const loadAssetData = async (assetSnapshot: NormalizedAssetSnapshot) => {
      const storageKeyOrUrl = assetSnapshot.storageKey || assetSnapshot.storageUrl;
      if (!storageKeyOrUrl) throw new Error('Required asset blob is unavailable');
      try {
        const buffer = await getMemeBlobBuffer(storageKeyOrUrl);
        return {
          buffer,
          mimeType: assetSnapshot.mimeType,
          instruction: assetSnapshot.instruction,
          assetType: assetSnapshot.assetType
        };
      } catch {
        throw new Error('Failed to fetch required asset blob');
      }
    };
    const primaryAssetData = primaryAssetSnapshot ? await loadAssetData(primaryAssetSnapshot) : undefined;
    const secondaryAssetData = secondaryAssetSnapshot ? await loadAssetData(secondaryAssetSnapshot) : undefined;
    if (job.slotPlan.requiresAsset && !primaryAssetData) throw new Error('Required asset blob is unavailable');
    const assetData = secondaryAssetData || primaryAssetData;

    if (!hasRemainingBudget(WORKER_DURABLE_WRITE_RESERVE_MS + 10000)) {
      await releaseLease(job.jobId, 'pending', 'Insufficient budget for image generation');
      return { success: false, error: 'Insufficient budget for image generation', metrics };
    }

    const analysisEvidence = analysis.entityEvidence as (typeof analysis.entityEvidence & { entities?: Array<{ canonicalEntity?: string; postJustification?: string }> }) | undefined;
    const entityEvidence = analysisEvidence?.entities
      ? analysisEvidence.entities.flatMap((entity) => typeof entity.canonicalEntity === 'string' && typeof entity.postJustification === 'string'
        ? [{ canonicalEntity: entity.canonicalEntity, postJustification: entity.postJustification }]
        : [])
      : (analysis.canonicalEntities || []).map((canonicalEntity) => ({ canonicalEntity, postJustification: analysis.entityEvidence?.postJustification || '' }));
    const resolvedEntityLogos = resolveEntityLogos({
      postText,
      externalLogoIntent: analysis.entityEvidence?.externalLogoIntent === true,
      entityEvidence,
    });
    const genCall = await startApiCall('generation', job.modelSnapshot.provider, job.modelSnapshot.key, job.modelSnapshot.apiModel);
    let generation: MemeGenerationResult;
    ensureShouldExecute(genCall, 'generation');
    try {
      generation = await generateMemeImage(job.slotPlan, analysis, job.modelSnapshot.key, assetData, undefined, { signal: abortController.signal, timeoutMs: deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS });
      generation = await composeResolvedEntityLogos(generation, resolvedEntityLogos, primaryAssetData);
      generation = await composeBrandText(generation, job.slotPlan.brandText);
      currentCost += parseFloat(generation.cost);
      metrics.cost = currentCost;
      await finishApiCall(genCall.callKey, parseFloat(generation.cost), 'succeeded');
    } catch (e: unknown) {
      await finishApiCall(genCall.callKey, 0, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }

    if (!(await verifyLease(job.jobId, workerId))) {
      return { success: false, error: 'Lost worker lease after image generation', metrics };
    }

    const valCall = await startApiCall('validation', 'google', 'gemini-2.5-flash', 'gemini-2.5-flash');
    let validation;
    ensureShouldExecute(valCall, 'validation');
    try {
      validation = await validateMemeImage(generation.imageBuffer, generation.mimeType, job.slotPlan, campaignDirection, { signal: abortController.signal, timeoutMs: deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS });
      await finishApiCall(valCall.callKey, 0, 'succeeded');
    } catch (e: unknown) {
      await finishApiCall(valCall.callKey, 0, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }

    let is_valid = validation.is_valid;

    if (!is_valid) {
      metrics.regenerations++;
      metrics.boundedErrors++;

      if (!hasRemainingBudget(WORKER_DURABLE_WRITE_RESERVE_MS + 10000)) {
        await releaseLease(job.jobId, 'pending', 'Insufficient budget for regeneration');
        return { success: false, error: 'Insufficient budget for regeneration', metrics };
      }

      const regenCall = await startApiCall('regeneration', job.modelSnapshot.provider, job.modelSnapshot.key, job.modelSnapshot.apiModel);
      ensureShouldExecute(regenCall, 'regeneration');
      try {
        const regenerateInstruction = `FAILED VALIDATION REASON: ${validation.reason}\n\nCRITICAL: Simplify radically, remove all explanations, remove extra labels, reduce scene complexity, express one immediate visual joke. Do NOT render text if no_text was specified!`;
        generation = await generateMemeImage(job.slotPlan, analysis, job.modelSnapshot.key, assetData, regenerateInstruction, { signal: abortController.signal, timeoutMs: deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS });
        generation = await composeResolvedEntityLogos(generation, resolvedEntityLogos, primaryAssetData);
        generation = await composeBrandText(generation, job.slotPlan.brandText);
        currentCost += parseFloat(generation.cost);
        metrics.cost = currentCost;
        await finishApiCall(regenCall.callKey, parseFloat(generation.cost), 'succeeded');
      } catch (e: unknown) {
        await finishApiCall(regenCall.callKey, 0, 'failed', e instanceof Error ? e.message : String(e));
        throw e;
      }

      const revalCall = await startApiCall('validation', 'google', 'gemini-2.5-flash', 'gemini-2.5-flash', 'revalidation');
      ensureShouldExecute(revalCall, 'revalidation');
      try {
        validation = await validateMemeImage(generation.imageBuffer, generation.mimeType, job.slotPlan, campaignDirection, { signal: abortController.signal, timeoutMs: deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS });
        await finishApiCall(revalCall.callKey, 0, 'succeeded');
      } catch (e: unknown) {
        await finishApiCall(revalCall.callKey, 0, 'failed', e instanceof Error ? e.message : String(e));
        throw e;
      }

      if (!validation.is_valid) {
        throw new Error('Meme validation failed twice');
      }
      is_valid = true;
    }

    if (is_valid) {
      metrics.validMemes = 1;
    }

    if (!hasRemainingBudget(WORKER_DURABLE_WRITE_RESERVE_MS)) {
      await releaseLease(job.jobId, 'pending', 'Insufficient budget for Blob storage and DB write');
      return { success: false, error: 'Insufficient budget for Blob storage and DB write', metrics };
    }

    if (!(await verifyLease(job.jobId, workerId))) {
      return { success: false, error: 'Lost worker lease before Blob upload', metrics };
    }

    let storageResult;
    try {
      storageResult = await uploadGeneratedMeme(generation.imageBuffer, generation.mimeType);
    } catch (blobErr) {
      console.error('Blob upload failed', blobErr);
      throw new Error('No se pudo guardar la imagen en el almacenamiento de blobs.');
    }

    let insertSuccess = false;
    try {
      await withTransaction(async (client) => {
        const leaseRes = await client.query<{ id: string }>(
          `SELECT id FROM meme_generation_jobs
           WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > NOW()
           FOR UPDATE`,
          [job.jobId, workerId]
        );

        if (leaseRes.rows.length === 0) return;

        if (job.draftId) {
          const draftLock = await client.query(`SELECT id FROM meme_drafts WHERE id = $1 AND status = 'active' FOR SHARE`, [job.draftId]);
          if (draftLock.rows.length === 0) {
            await client.query(`UPDATE meme_generation_jobs SET status = 'cancelled', error_message = 'Draft expired' WHERE id = $1`, [job.jobId]);
            return;
          }
        } else {
          const postLock = await client.query(`SELECT p.id FROM campaign_posts p JOIN campaigns c ON p.campaign_id = c.id WHERE p.id = $1 AND p.retired_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > NOW()) AND c.is_active = true FOR SHARE`, [job.campaignPostId]);
          if (postLock.rows.length === 0) {
            await client.query(`UPDATE meme_generation_jobs SET status = 'cancelled', error_message = 'Post retired' WHERE id = $1`, [job.jobId]);
            return;
          }
        }

        const finalDraftId = job.draftId || null;
        const finalCampaignId = job.campaignId || null;
        const finalCampaignPostId = job.campaignPostId || null;
        const finalStatus = finalDraftId ? 'preview' : 'available';

        await client.query(
          `INSERT INTO memes (
             draft_id, campaign_id, campaign_post_id, job_id,
             status, storage_provider, storage_key, storage_url,
             mime_type, size_bytes, width, height, sha256_hash,
             slot_plan, model_key, accumulated_cost, delivery_order, asset_id
           ) VALUES (
             $1, $2, $3, $4, $5, 'vercel_blob', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
           ) RETURNING id`,
          [finalDraftId, finalCampaignId, finalCampaignPostId, job.jobId, finalStatus, storageResult.pathname, storageResult.url, generation.mimeType, generation.imageBuffer.length, generation.width, generation.height, storageResult.sha256Hash, JSON.stringify({ ...job.slotPlan, analysisEvidence: analysis.entityEvidence, entityLogoResolution: resolvedEntityLogos.map(({ entity, slug }) => ({ entity, slug })) }), job.modelSnapshot.key, currentCost, job.slotIndex, primaryAssetSnapshot?.id || null]
        );

        await client.query(
          `UPDATE meme_generation_jobs
           SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, error_message = NULL, accumulated_cost = accumulated_cost + $1, updated_at = NOW()
           WHERE id = $2`,
          [currentCost, job.jobId]
        );

        insertSuccess = true;
      });
    } catch (dbErr) {
      console.error('DB Insert meme failed, attempting blob cleanup', dbErr);
      if (storageResult?.url) {
        try {
          await deleteBlob(storageResult.url);
        } catch {}
      }
      throw dbErr;
    }

    if (!insertSuccess) {
      if (storageResult?.url) {
        try { await deleteBlob(storageResult.url); } catch {}
      }
      return { success: false, error: 'Failed to insert meme or lost lease', metrics };
    }

    await recalculateMemeCycleStatus(job.cycleId);
    return { success: true, metrics };
  } catch (err: unknown) {
    if (abortController.signal.aborted) {
      return { success: false, error: 'Aborted due to lease loss or timeout', metrics };
    }
    metrics.boundedErrors++;

    const classified = classifyMemeProviderError(err);
    const isPermanent = classified.isPermanent || (err instanceof Error && err.message.includes('403'));
    const nextAttemptCount = job.attemptsCount + 1;
    const isTerminal = isPermanent || nextAttemptCount >= 3;
    const finalErrorMessage = classified.sanitizedMessage;

    await queryDb(
      `UPDATE meme_generation_jobs
       SET status = CASE WHEN $1::boolean THEN 'failed' ELSE 'pending' END,
           attempts_count = $2,
           next_attempt_at = NOW() + INTERVAL '1 minute',
           error_message = COALESCE($3, error_message),
           accumulated_cost = accumulated_cost + $4,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $5
       RETURNING status`,
      [isTerminal, isTerminal ? 3 : nextAttemptCount, finalErrorMessage, currentCost, job.jobId]
    );

    await recalculateMemeCycleStatus(job.cycleId, finalErrorMessage);
    return { success: false, error: finalErrorMessage, metrics };
  } finally {
    stopHeartbeat();
  }
}
