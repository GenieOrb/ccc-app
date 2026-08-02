import 'server-only';
import { randomUUID } from 'node:crypto';
import { queryDb, withTransaction } from './db';
import { uploadGeneratedMeme } from './memes/blob';
import { performMemeAnalysis } from './memes/analysis';
import { generateMemeImage } from './memes/generation';
import { validateMemeImage } from './memes/validation';
import { MemeSlotPlan } from './memes/planner';
import { ImageModelDefinition } from './ai/image-models';

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
  modelSnapshot: ImageModelDefinition;
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
      claimedJobs.map((job) => executeMemeJobTask(job, workerId, deadline))
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
         COALESCE(p.text_content, md.config->>'post_text') as post_text,
         p.author_name,
         p.author_username,
         p.accessible_context,
         c.direction
       FROM meme_generation_jobs j
       LEFT JOIN campaign_posts p ON j.campaign_post_id = p.id
       LEFT JOIN campaigns c ON j.campaign_id = c.id
       LEFT JOIN meme_drafts md ON j.draft_id = md.id
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

    await client.query(
      `UPDATE meme_generation_jobs 
       SET status = 'processing',
           lease_owner = $1,
           lease_expires_at = NOW() + INTERVAL '${leaseDurationSeconds} seconds',
           updated_at = NOW()
       WHERE id = $2`,
      [workerId, row.job_id]
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
      modelSnapshot: row.model_snapshot,
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
  workerId: string,
  deadline: number
): Promise<{ success: boolean; error?: string; metrics: { regenerations: number, validMemes: number, cost: number, boundedErrors: number } }> {
  const metrics = { regenerations: 0, validMemes: 0, cost: 0, boundedErrors: 0 };
  let currentCost = 0;

  try {
    const postText = job.postText || '';
    const campaignDirection = job.campaignDirection || 'General campaign';

    const logCall = async (purpose: string, cost: number, provider: string, apiModel: string, status: string, error?: string) => {
      await queryDb(`
         INSERT INTO meme_api_calls (
           call_key, campaign_id, draft_id, cycle_id, job_id, purpose, provider, model_key, api_model, status, total_cost, pricing_snapshot, currency, error_message, finished_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'USD', $13, NOW())
       `, [
         `${job.jobId}:${job.attemptsCount + 1}:${purpose}:${randomUUID()}`,
         job.campaignId || null, job.draftId || null, job.cycleId, job.jobId, purpose, provider, job.modelSnapshot.key, apiModel, status, cost, JSON.stringify(job.modelSnapshot), error || null
       ]);
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

    let assetData;
    if (job.assetSnapshot && job.assetSnapshot.storage_url) {
      try {
        const resp = await fetch(job.assetSnapshot.storage_url as string);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          assetData = {
            buffer,
            mimeType: (job.assetSnapshot.mime_type as string) || 'image/png',
            instruction: (job.assetSnapshot.instruction as string) || ''
          };
        }
      } catch (e) {
        console.error('Failed to fetch asset blob', e);
      }
    }

    // 2. GENERATE MEME IMAGE
    let generation;
    try {
      generation = await generateMemeImage(
        job.slotPlan,
        analysis,
        job.modelSnapshot.key,
        assetData,
        deadline
      );
      currentCost += parseFloat(generation.cost);
      metrics.cost = currentCost;
      await logCall('generation', parseFloat(generation.cost), job.modelSnapshot.provider, job.modelSnapshot.apiModel, 'succeeded');
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      await logCall('generation', 0, job.modelSnapshot.provider, job.modelSnapshot.apiModel, 'failed', errorMessage);
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
      try {
        generation = await generateMemeImage(
          job.slotPlan,
          analysis,
          job.modelSnapshot.key,
          assetData,
          deadline
        );
        currentCost += parseFloat(generation.cost);
        metrics.cost = currentCost;
        await logCall('regeneration', parseFloat(generation.cost), job.modelSnapshot.provider, job.modelSnapshot.apiModel, 'succeeded');
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await logCall('regeneration', 0, job.modelSnapshot.provider, job.modelSnapshot.apiModel, 'failed', errorMessage);
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

      await client.query(
        `INSERT INTO memes (
           campaign_id, campaign_post_id, job_id,
           status, storage_provider, storage_key, storage_url,
           mime_type, size_bytes, width, height, sha256_hash,
           slot_plan, model_key, accumulated_cost
         ) VALUES (
           $1, $2, $3,
           'available', 'vercel_blob', $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13
         ) RETURNING id`,
        [
          job.campaignId, job.campaignPostId, job.jobId,
          storageResult.pathname, storageResult.url,
          generation.mimeType, generation.imageBuffer.length, generation.width, generation.height, storageResult.sha256Hash,
          JSON.stringify(job.slotPlan), job.modelSnapshot.key, currentCost
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
        WHERE id = $3`,
       [err instanceof Error ? err.message : String(err), currentCost, job.jobId]
    );
    return { success: false, error: err instanceof Error ? err.message : String(err), metrics };
  }
}
