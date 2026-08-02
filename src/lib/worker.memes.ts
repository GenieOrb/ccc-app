import 'server-only';
import { randomUUID } from 'node:crypto';
import { queryDb, withTransaction } from './db';
import { uploadGeneratedMeme, getMemeBlobBuffer, deleteBlob } from './memes/blob';
import { performMemeAnalysis } from './memes/analysis';
import { generateMemeImage, MemeGenerationResult } from './memes/generation';
import { validateMemeImage } from './memes/validation';
import { MemeSlotPlan } from './memes/planner';
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
  assetSnapshot: Record<string, unknown> | null;
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

async function updateCycleStatus(cycleId: string, lastError?: string) {
  await withTransaction(async (client) => {
    const jobsRes = await client.query<{ status: string }>(
      `SELECT status FROM meme_generation_jobs WHERE cycle_id = $1`,
      [cycleId]
    );

    let pending = 0;
    let processing = 0;
    let completed = 0;
    let failed = 0;

    for (const j of jobsRes.rows) {
      if (j.status === 'pending') pending++;
      else if (j.status === 'processing') processing++;
      else if (j.status === 'completed') completed++;
      else if (j.status === 'failed' || j.status === 'cancelled') failed++;
    }

    const terminal = pending === 0 && processing === 0;
    let cycleStatus = 'processing';
    if (terminal) {
      if (completed >= 3) {
        cycleStatus = 'completed';
      } else if (completed > 0) {
        cycleStatus = 'partial';
      } else {
        cycleStatus = 'failed';
      }
    }

    await client.query(
      `UPDATE meme_generation_cycles
       SET valid_produced_count = $1,
           completed_jobs_count = $2,
           failed_jobs_count = $3,
           status = $4,
           error_message = CASE WHEN $4 IN ('failed', 'partial') THEN COALESCE($5, error_message) ELSE error_message END,
           finished_at = CASE WHEN $6::boolean THEN NOW() ELSE finished_at END,
           updated_at = NOW()
       WHERE id = $7`,
      [completed, completed, failed, cycleStatus, lastError || null, terminal, cycleId]
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
    apiModel: string
  ): Promise<{ callKey: string; shouldExecute: boolean; existingStatus?: string }> => {
    const callKey = `${job.jobId}:${attemptNumber}:${purpose}`;
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
      await updateCycleStatus(job.cycleId);
      metrics.validMemes = 1;
      return { success: true, metrics };
    }

    const availableAssets = job.assetSnapshot
      ? [
          {
            id: String(job.assetSnapshot.id || ''),
            instruction: String(job.assetSnapshot.instruction || ''),
            assetType: String(job.assetSnapshot.assetType || '')
          }
        ]
      : [];

    const analysisCall = await startApiCall('analysis', 'google', 'gemini-2.5-flash', 'gemini-2.5-flash');
    let analysis;
    ensureShouldExecute(analysisCall, 'analysis');
    try {
      analysis = await performMemeAnalysis({ postText, campaignDirection, availableAssets }, { signal: abortController.signal, timeoutMs: deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS });
      await finishApiCall(analysisCall.callKey, 0, 'succeeded');
    } catch (e: unknown) {
      await finishApiCall(analysisCall.callKey, 0, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }

    let assetData: { buffer: Buffer; mimeType: string; instruction: string } | undefined;
    const storageKeyOrUrl = (job.assetSnapshot?.storage_key || job.assetSnapshot?.storage_url) as string;
    if (job.assetSnapshot && storageKeyOrUrl) {
      try {
        const buffer = await getMemeBlobBuffer(storageKeyOrUrl);
        assetData = {
          buffer,
          mimeType: (job.assetSnapshot.mime_type as string) || 'image/png',
          instruction: (job.assetSnapshot.instruction as string) || ''
        };
      } catch (e) {
        throw new Error('Failed to fetch required asset blob');
      }
    }

    if (!hasRemainingBudget(WORKER_DURABLE_WRITE_RESERVE_MS + 10000)) {
      await releaseLease(job.jobId, 'pending', 'Insufficient budget for image generation');
      return { success: false, error: 'Insufficient budget for image generation', metrics };
    }

    const genCall = await startApiCall('generation', job.modelSnapshot.provider, job.modelSnapshot.key, job.modelSnapshot.apiModel);
    let generation: MemeGenerationResult;
    ensureShouldExecute(genCall, 'generation');
    try {
      generation = await generateMemeImage(job.slotPlan, analysis, job.modelSnapshot.key, assetData, undefined, { signal: abortController.signal, timeoutMs: deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS });
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
        currentCost += parseFloat(generation.cost);
        metrics.cost = currentCost;
        await finishApiCall(regenCall.callKey, parseFloat(generation.cost), 'succeeded');
      } catch (e: unknown) {
        await finishApiCall(regenCall.callKey, 0, 'failed', e instanceof Error ? e.message : String(e));
        throw e;
      }

      const revalCall = await startApiCall('revalidation', 'google', 'gemini-2.5-flash', 'gemini-2.5-flash');
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
          [finalDraftId, finalCampaignId, finalCampaignPostId, job.jobId, finalStatus, storageResult.pathname, storageResult.url, generation.mimeType, generation.imageBuffer.length, generation.width, generation.height, storageResult.sha256Hash, JSON.stringify(job.slotPlan), job.modelSnapshot.key, currentCost, job.slotIndex, job.assetSnapshot?.id || null]
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

    await updateCycleStatus(job.cycleId);
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

    await updateCycleStatus(job.cycleId, finalErrorMessage);
    return { success: false, error: finalErrorMessage, metrics };
  } finally {
    stopHeartbeat();
  }
}
