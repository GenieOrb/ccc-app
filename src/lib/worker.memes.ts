import 'server-only';
import { randomUUID } from 'node:crypto';
import { queryDb, withTransaction } from './db';
import { uploadGeneratedMeme, getMemeBlobBuffer } from './memes/blob';
import { performMemeAnalysis } from './memes/analysis';
import { generateMemeImage, MemeGenerationResult } from './memes/generation';
import { validateMemeImage } from './memes/validation';
import { MemeSlotPlan } from './memes/planner';
import { ImageModelSnapshot } from './ai/image-models';

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

export const MIN_MEME_WORKER_JOB_BUDGET_MS = 25_000;

export async function processMemeBackgroundQueue(
  workerId: string = randomUUID(),
  budgetMs: number = 50000
) {
  const startTime = Date.now();
  const deadline = startTime + Math.max(0, budgetMs);
  const hasSafeJobBudget = () => deadline - Date.now() >= MIN_MEME_WORKER_JOB_BUDGET_MS;
  const maxParallelConcurrency = 10; // "lotes de 10" from instructions

  let totalProcessed = 0;
  let totalCompleted = 0;
  let totalFailed = 0;
  let totalValidMemes = 0;
  let totalRegenerations = 0;
  let totalCost = 0;
  let boundedErrors = 0;

  while (hasSafeJobBudget()) {
    const claimedJobs: MemeClaimedJob[] = [];

    for (let c = 0; c < maxParallelConcurrency; c++) {
      if (!hasSafeJobBudget()) break;
      const job = await claimNextMemeJob(workerId);
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
      claimedJobs.map((job) => executeMemeJobTask(job, workerId))
    );

    const results = settled.map((result) => result.status === 'fulfilled'
      ? result.value
      : ({ success: false, error: 'Unhandled worker task failure', metrics: { regenerations: 0, validMemes: 0, cost: 0, boundedErrors: 1 } }));

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

async function claimNextMemeJob(workerId: string): Promise<MemeClaimedJob | null> {
  const leaseDurationSeconds = 300;

  return await withTransaction(async (client) => {
    const selectRes = await client.query(`
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
       ORDER BY j.created_at ASC
       LIMIT 1
       FOR UPDATE OF j SKIP LOCKED
    `);

    if (selectRes.rows.length === 0) {
      return null;
    }

    const row = selectRes.rows[0];

    const rawSnap = (typeof row.model_snapshot === 'object' && row.model_snapshot !== null) 
       ? (row.model_snapshot as Record<string, unknown>) 
       : {};

    const normKey = String(rawSnap.key || rawSnap.modelKey || rawSnap.model_key || row.cycle_model_key || '');
    const normProvider = String(rawSnap.provider || row.cycle_provider || '');
    const normApiModel = String(rawSnap.apiModel || rawSnap.api_model || rawSnap.model_name || row.cycle_api_model || '');

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

    // Update cycle if it's the first time
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

async function executeMemeJobTask(
  job: MemeClaimedJob,
  workerId: string
): Promise<{ success: boolean; error?: string; metrics: { regenerations: number, validMemes: number, cost: number, boundedErrors: number } }> {
  const metrics = { regenerations: 0, validMemes: 0, cost: 0, boundedErrors: 0 };
  let currentCost = 0;

  try {
    if (!job.modelSnapshot.key || !job.modelSnapshot.provider || !job.modelSnapshot.apiModel) {
      console.error(`Invalid meme model snapshot: apiModel is missing for job ${job.jobId}`);
      job.attemptsCount = 99; // Prevents indefinite retries
      throw new Error('No se pudo recuperar el modelo de imagen asociado al trabajo.');
    }

    const postText = job.postText || '';
    const campaignDirection = job.campaignDirection || 'General campaign';
    const callKeyBase = `${job.jobId}:${job.attemptsCount + 1}`;

    const startApiCall = async (purpose: string): Promise<string> => {
       const callKey = `${callKeyBase}:${purpose}`;
       await queryDb(`
         INSERT INTO meme_api_calls (
           call_key, campaign_id, draft_id, cycle_id, job_id, purpose, provider, model_key, api_model, status, total_cost, pricing_snapshot, currency
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'started', 0, $10, 'USD')
         ON CONFLICT (call_key) DO NOTHING
       `, [
         callKey, job.campaignId || null, job.draftId || null, job.cycleId, job.jobId, purpose, job.modelSnapshot.provider, job.modelSnapshot.key, job.modelSnapshot.apiModel, JSON.stringify(job.modelSnapshot)
       ]);
       return callKey;
    };

    const finishApiCall = async (callKey: string, cost: number, status: string, error?: string) => {
       await queryDb(`
         UPDATE meme_api_calls
         SET status = $1, total_cost = $2, error_message = $3, finished_at = NOW()
         WHERE call_key = $4
       `, [status, cost, error || null, callKey]);
    };

    // 1. ANÁLISIS SEMÁNTICO PREVIO
    const availableAssets = job.assetSnapshot ? [{
        id: String(job.assetSnapshot.id || ''),
        instruction: String(job.assetSnapshot.instruction || ''),
        assetType: String(job.assetSnapshot.assetType || '')
    }] : [];

    const analysis = await performMemeAnalysis({
      postText,
      campaignDirection,
      availableAssets
    });

    let assetData: { buffer: Buffer, mimeType: string, instruction: string } | undefined;
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
        console.error('Failed to fetch asset blob', e);
      }
    }

    // 2. GENERATE MEME IMAGE
    let generation: MemeGenerationResult;
    let currentCallKey = `${callKeyBase}:generation`;
    try {
      await startApiCall('generation');
      generation = await generateMemeImage(
        job.slotPlan,
        analysis,
        job.modelSnapshot.key,
        assetData
      );
      currentCost += parseFloat(generation.cost);
      metrics.cost = currentCost;
      await finishApiCall(currentCallKey, parseFloat(generation.cost), 'succeeded');
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      await finishApiCall(currentCallKey, 0, 'failed', errorMessage);
      throw e;
    }

    // 3. VALIDATE MULTIMODAL
    let validation = await validateMemeImage(
      generation.imageBuffer,
      generation.mimeType,
      job.slotPlan,
      campaignDirection
    );

    let is_valid = validation.is_valid;

    // Regeneración controlada
    if (!is_valid) {
      metrics.regenerations++;
      metrics.boundedErrors++;

      // Intentamos otra vez
        currentCallKey = `${callKeyBase}:regeneration`;
        try {
          await startApiCall('regeneration');
          const regenerateInstruction = `FAILED VALIDATION REASON: ${validation.reason}\n\nCRITICAL: Simplify radically, remove all explanations, remove extra labels, reduce scene complexity, express one immediate visual joke. Do NOT render text if no_text was specified!`;
          generation = await generateMemeImage(
            job.slotPlan,
            analysis,
            job.modelSnapshot.key,
            assetData,
            regenerateInstruction
          );
          currentCost += parseFloat(generation.cost);
          metrics.cost = currentCost;
          await finishApiCall(currentCallKey, parseFloat(generation.cost), 'succeeded');
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          await finishApiCall(currentCallKey, 0, 'failed', errorMessage);
          throw e;
        }

      validation = await validateMemeImage(
        generation.imageBuffer,
        generation.mimeType,
        job.slotPlan,
        campaignDirection
      );

      if (!validation.is_valid) {
        throw new Error('Meme validation failed twice');
      }
      is_valid = true;
    }

    if (is_valid) {
      metrics.validMemes = 1;
    }

    // 4. Upload to blob storage
    const storageResult = await uploadGeneratedMeme(
      generation.imageBuffer,
      generation.mimeType
    );

    // 5. Save to DB
    await withTransaction(async (client) => {
      const leaseRes = await client.query<{ id: string }>(
        `SELECT id FROM meme_generation_jobs
         WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > NOW()
         FOR UPDATE`,
        [job.jobId, workerId]
      );

      if (leaseRes.rows.length === 0) return; // Lease expired or taken

      // Verify draft or campaign is still valid
      if (job.draftId) {
         const draftLock = await client.query(`SELECT id FROM meme_drafts WHERE id = $1 AND status = 'active' FOR SHARE`, [job.draftId]);
         if (draftLock.rows.length === 0) {
            await client.query(`UPDATE meme_generation_jobs SET status = 'cancelled', error_message = 'Draft expired' WHERE id = $1`, [job.jobId]);
            return;
         }
      } else {
         const postLock = await client.query(
            `SELECT p.id FROM campaign_posts p JOIN campaigns c ON p.campaign_id = c.id WHERE p.id = $1 AND p.retired_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > NOW()) AND c.is_active = true FOR SHARE`,
            [job.campaignPostId]
         );
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
           $1, $2, $3, $4,
           $5, 'vercel_blob', $6, $7,
           $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17
         ) RETURNING id`,
        [
          finalDraftId, finalCampaignId, finalCampaignPostId, job.jobId,
          finalStatus, storageResult.pathname, storageResult.url,
          generation.mimeType, generation.imageBuffer.length, generation.width, generation.height, storageResult.sha256Hash,
          JSON.stringify(job.slotPlan), job.modelSnapshot.key, currentCost, job.slotIndex, job.assetSnapshot?.id || null
        ]
      );

      await client.query(
        `UPDATE meme_generation_jobs
         SET status = 'completed',
             lease_owner = NULL,
             lease_expires_at = NULL,
             error_message = NULL,
             accumulated_cost = accumulated_cost + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [currentCost, job.jobId]
      );

      await client.query(
        `UPDATE meme_generation_cycles
         SET valid_produced_count = valid_produced_count + 1,
             completed_jobs_count = completed_jobs_count + 1,
             status = CASE WHEN valid_produced_count + 1 >= target_count THEN 'completed' ELSE status END,
             finished_at = CASE WHEN valid_produced_count + 1 >= target_count THEN NOW() ELSE finished_at END
         WHERE id = $1`,
        [job.cycleId]
      );
    });

    return { success: true, metrics };
  } catch (err: unknown) {
    metrics.boundedErrors++;
    await queryDb(
       `UPDATE meme_generation_jobs
        SET status = CASE WHEN attempts_count >= 3 THEN 'failed' ELSE 'pending' END,
            attempts_count = attempts_count + 1,
            next_attempt_at = NOW() + INTERVAL '1 minute',
            error_message = $1,
            accumulated_cost = accumulated_cost + $2,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $3
        RETURNING status`,
       [err instanceof Error ? err.message : String(err), currentCost, job.jobId]
    ).then(async (res) => {
       if (res[0]?.status === 'failed') {
         await queryDb(
           `UPDATE meme_generation_cycles
            SET failed_jobs_count = failed_jobs_count + 1,
                status = CASE WHEN valid_produced_count + failed_jobs_count + 1 >= (SELECT COUNT(*) FROM meme_generation_jobs WHERE cycle_id = $1) THEN 'partial' ELSE status END,
                finished_at = CASE WHEN valid_produced_count + failed_jobs_count + 1 >= (SELECT COUNT(*) FROM meme_generation_jobs WHERE cycle_id = $1) THEN NOW() ELSE finished_at END
            WHERE id = $1`,
           [job.cycleId]
         );
       }
    });
    return { success: false, error: err instanceof Error ? err.message : String(err), metrics };
  }
}
