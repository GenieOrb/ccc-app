import 'server-only';
import type { PoolClient } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { queryDb, withTransaction } from './db';
import { SlotPlan } from './planner';
import { generateSingleComment } from './openai';
import { getConfiguredFallbackModel } from './ai/models';
import {
  computeNormalizedHash,
  normalizeCommentText,
  validateCommentLocally,
} from './validator';

export interface ClaimedJob {
  jobId: string;
  cycleId: string;
  campaignId: string;
  campaignPostId: string;
  slotIndex: number;
  slotPlan: SlotPlan;
  attemptsCount: number;
  postText: string;
  authorName: string;
  authorUsername: string;
  accessibleContext: Record<string, unknown>;
  campaignDirection?: string;
  modelKey: string;
  provider: string;
  apiModel: string;
  inputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
  outputPricePerMillion: number;
  pricingCurrency: string;
}

export async function processBackgroundQueue(
  workerId: string = randomUUID(),
  budgetMs: number = 50000
): Promise<{
  processed: number;
  completed: number;
  failed: number;
}> {
  const startTime = Date.now();
  const maxExecutionTimeMs = budgetMs;
  const maxParallelConcurrency = 3;

  let totalProcessed = 0;
  let totalCompleted = 0;
  let totalFailed = 0;

  while (Date.now() - startTime < maxExecutionTimeMs) {
    // 1. Claim up to maxParallelConcurrency jobs atomically
    const claimedJobs: ClaimedJob[] = [];

    for (let c = 0; c < maxParallelConcurrency; c++) {
      const job = await claimNextJob(workerId);
      if (job) {
        claimedJobs.push(job);
      } else {
        break;
      }
    }

    if (claimedJobs.length === 0) {
      // No more claimable jobs in queue
      break;
    }

    // 2. Process claimed jobs in parallel
    const results = await Promise.all(
      claimedJobs.map((job) => executeJobTask(job))
    );

    for (const res of results) {
      totalProcessed++;
      if (res.success) {
        totalCompleted++;
      } else {
        totalFailed++;
      }
    }
  }

  return {
    processed: totalProcessed,
    completed: totalCompleted,
    failed: totalFailed,
  };
}

async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  const leaseDurationSeconds = 180;

  return await withTransaction(async (client) => {
    // Select candidate job FOR UPDATE SKIP LOCKED
    const selectRes = await client.query<{
      job_id: string;
      cycle_id: string;
      campaign_id: string;
      campaign_post_id: string;
      slot_index: number;
      slot_plan: unknown;
      attempts_count: number;
      post_text: string;
      author_name: string;
      author_username: string;
      accessible_context: unknown;
      direction: string | null;
      model_key: string;
      provider: string;
      api_model: string;
      input_price_per_million: number;
      cached_input_price_per_million: number | null;
      output_price_per_million: number;
      pricing_currency: string;
    }>(
      `SELECT 
         j.id as job_id,
         j.cycle_id,
         j.campaign_id,
         j.campaign_post_id,
         j.slot_index,
         j.slot_plan,
         j.attempts_count,
         p.text_content as post_text,
         p.author_name,
         p.author_username,
         p.accessible_context,
         c.direction
         ,j.model_key, j.provider, j.api_model, j.input_price_per_million, j.cached_input_price_per_million, j.output_price_per_million, j.pricing_currency
       FROM generation_jobs j
       JOIN campaign_posts p ON j.campaign_post_id = p.id
       JOIN campaigns c ON j.campaign_id = c.id
       JOIN generation_cycles cy ON j.cycle_id = cy.id
       WHERE (
         (j.status = 'pending' AND j.next_attempt_at <= NOW())
         OR (j.status = 'processing' AND j.lease_expires_at < NOW())
       )
       AND cy.status IN ('pending', 'processing')
       ORDER BY
         (NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.campaign_post_id = p.id AND s.status = 'available')) DESC,
         p.posted_at DESC NULLS LAST,
         j.created_at ASC
       LIMIT 1
       FOR UPDATE OF j SKIP LOCKED`
    );

    if (selectRes.rows.length === 0) {
      return null;
    }

    const row = selectRes.rows[0];

    // Update job to processing with lease
    await client.query(
      `UPDATE generation_jobs 
       SET status = 'processing',
           lease_owner = $1,
           lease_expires_at = NOW() + INTERVAL '${leaseDurationSeconds} seconds',
           updated_at = NOW()
       WHERE id = $2`,
      [workerId, row.job_id]
    );

    // Ensure cycle status is marked processing
    await client.query(
      `UPDATE generation_cycles 
       SET status = 'processing',
           started_at = COALESCE(started_at, NOW())
       WHERE id = $1 AND status = 'pending'`,
      [row.cycle_id]
    );

    return {
      jobId: row.job_id,
      cycleId: row.cycle_id,
      campaignId: row.campaign_id,
      campaignPostId: row.campaign_post_id,
      slotIndex: row.slot_index,
      slotPlan: row.slot_plan as SlotPlan,
      attemptsCount: row.attempts_count,
      postText: row.post_text,
      authorName: row.author_name || 'Desconocido',
      authorUsername: row.author_username || 'unknown',
      accessibleContext: (row.accessible_context as Record<string, unknown>) || ({} as Record<string, unknown>),
      campaignDirection: row.direction || undefined,
      modelKey: row.model_key, provider: row.provider, apiModel: row.api_model,
      inputPricePerMillion: row.input_price_per_million, cachedInputPricePerMillion: row.cached_input_price_per_million ?? undefined,
      outputPricePerMillion: row.output_price_per_million, pricingCurrency: row.pricing_currency,
    };
  });
}

async function executeJobTask(
  job: ClaimedJob
): Promise<{ success: boolean; error?: string }> {
  // 1. Load up to 20 recent comments for diversity context (same post first, then same campaign)
  const recentRows = await queryDb<{ comment_text: string }>(
    `SELECT comment_text FROM suggestions 
     WHERE campaign_id = $1 
     ORDER BY (campaign_post_id = $2) DESC, created_at DESC 
     LIMIT 20`,
    [job.campaignId, job.campaignPostId]
  );
  const recentComments = recentRows.map((r) => r.comment_text);

  let rawComment = '';
  let validationReason = '';
  let finalProvider = job.provider;
  let finalModelKey = job.modelKey;
  let finalApiModel = job.apiModel;
  let finalInputPrice = job.inputPricePerMillion;
  let finalCachedInputPrice = job.cachedInputPricePerMillion;
  let finalOutputPrice = job.outputPricePerMillion;
  let usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | undefined;
  let regenerations = 0;

  // Check if post is retired or expired before calling OpenAI
  const preCheckRows = await queryDb<{ id: string }>(
    `SELECT id FROM campaign_posts WHERE id = $1 AND retired_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [job.campaignPostId]
  );

  if (preCheckRows.length === 0) {
    await withTransaction(async (client) => {
      await cancelJobAndCheckCycle(client, job.jobId, job.cycleId);
    });
    return { success: true };
  }

  try {
    const generate = async (provider: 'openai' | 'deepseek' | 'qwen', apiModel: string, rewriteFeedback?: string) => generateSingleComment({
      apiModel,
      provider,
      postText: job.postText,
      authorName: job.authorName,
      authorUsername: job.authorUsername,
      accessibleContext: job.accessibleContext,
      direction: job.campaignDirection,
      plan: job.slotPlan,
      recentComments, rewriteFeedback,
    });
    try {
      const generated = await generate(job.provider as 'openai' | 'deepseek' | 'qwen', job.apiModel);
      rawComment = generated.comment;
      usage = generated.usage;
    } catch (primaryError) {
      // Fallback belongs exclusively to queued production generation. Preview
      // generation calls generateSingleComment directly and has no fallback.
      const fallback = getConfiguredFallbackModel(job.modelKey);
      if (!fallback) throw primaryError;
      const generated = await generate(fallback.provider, fallback.apiModel);
      rawComment = generated.comment;
      usage = generated.usage;
      finalProvider = fallback.provider;
      finalModelKey = fallback.key;
      finalApiModel = fallback.apiModel;
      finalInputPrice = fallback.inputPricePerMillion;
      finalCachedInputPrice = fallback.cachedInputPricePerMillion;
      finalOutputPrice = fallback.outputPricePerMillion;
    }

    // Local Validation Check
    const valResult = validateCommentLocally(rawComment, job.slotPlan, recentComments, job.campaignDirection);

    if (!valResult.valid) {
      validationReason = valResult.reason || 'Failed local validation checks.';
      // Perform 1 corrective rewrite attempt within this execution
      regenerations += 1;
      const rewritten = await generate(finalProvider as 'openai' | 'deepseek' | 'qwen', finalApiModel, validationReason);
      rawComment = rewritten.comment;
      usage = rewritten.usage;

      const rewriteValResult = validateCommentLocally(rawComment, job.slotPlan, recentComments, job.campaignDirection);
      if (!rewriteValResult.valid) {
        throw new Error(`Validation failed after rewrite: ${rewriteValResult.reason}`);
      }
    }

    // 2. Save valid suggestion and complete job in database transaction
    const normText = normalizeCommentText(rawComment);
    const normHash = computeNormalizedHash(normText);

    await withTransaction(async (client) => {
      // Re-check post status under transaction
      const postLockRes = await client.query(
        `SELECT 1 FROM campaign_posts WHERE id = $1 AND retired_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) FOR SHARE`,
        [job.campaignPostId]
      );

      if (postLockRes.rows.length === 0) {
        await cancelJobAndCheckCycle(client, job.jobId, job.cycleId);
        return; // Post was retired while OpenAI was working
      }

      // Create suggestion
      const sugRes = await client.query<{ id: string }>(
        `INSERT INTO suggestions (
           campaign_id, campaign_post_id, cycle_id, job_id, content_type,
           comment_text, normalized_hash, slot_plan, model_name, prompt_version, requested_provider, requested_model_key, final_provider, final_model_key, fallback_used,
           status, delivery_order
         ) VALUES (
           $1, $2, $3, $4, 'text',
            $5, $6, $7, $8, 1, $9, $10, $11, $12, $13,
            'available', $14
         ) RETURNING id`,
        [
          job.campaignId,
          job.campaignPostId,
          job.cycleId,
          job.jobId,
          rawComment,
          normHash,
          JSON.stringify(job.slotPlan),
          finalApiModel,
          job.provider,
          job.modelKey,
          finalProvider,
          finalModelKey,
          finalModelKey !== job.modelKey,
          job.slotPlan.deliveryOrder,
        ]
      );

      const suggestionId = sugRes.rows[0].id;

      // Update job to completed
      await client.query(
        `UPDATE generation_jobs
         SET status = 'completed',
             suggestion_id = $1,
             lease_owner = NULL,
             lease_expires_at = NULL,
             error_message = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [suggestionId, job.jobId]
      );

      await client.query(
        `INSERT INTO generation_usage_metrics (campaign_id,campaign_post_id,cycle_id,job_id,requested_provider,requested_model_key,final_provider,final_model_key,input_tokens,cached_input_tokens,output_tokens,comments_requested,comments_received,comments_valid,comments_rejected,regenerations,attempts,fallback_used,input_price_per_million,cached_input_price_per_million,output_price_per_million,currency,estimated_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,1,1,0,$12,$13,$14,$15,$16,$17,$18,CASE WHEN $9 IS NULL AND $10 IS NULL AND $11 IS NULL THEN NULL ELSE (COALESCE($9,0) - COALESCE($10,0))*$15/1000000 + COALESCE($10,0)*COALESCE($16,0)/1000000 + COALESCE($11,0)*$17/1000000 END)`,
        [job.campaignId,job.campaignPostId,job.cycleId,job.jobId,job.provider,job.modelKey,finalProvider,finalModelKey,usage?.inputTokens ?? null,usage?.cachedInputTokens ?? null,usage?.outputTokens ?? null,regenerations,job.attemptsCount + 1,finalModelKey !== job.modelKey,finalInputPrice,finalCachedInputPrice ?? null,finalOutputPrice,job.pricingCurrency]
      );

      // Update cycle counts
      const cycleRes = await client.query<{
        target_count: number;
        valid_produced_count: number;
        completed_jobs_count: number;
      }>(
        `UPDATE generation_cycles
         SET valid_produced_count = valid_produced_count + 1,
             completed_jobs_count = completed_jobs_count + 1
         WHERE id = $1
         RETURNING target_count, valid_produced_count, completed_jobs_count`,
        [job.cycleId]
      );

      const cycleData = cycleRes.rows[0];
      if (
        cycleData &&
        cycleData.valid_produced_count >= cycleData.target_count &&
        cycleData.completed_jobs_count >= cycleData.target_count
      ) {
        // Mark cycle completed
        await client.query(
          `UPDATE generation_cycles
           SET status = 'completed',
               finished_at = NOW()
           WHERE id = $1`,
          [job.cycleId]
        );
      }
    });

    // If job was cancelled inside transaction (postLockRes empty), success is still true so we don't retry
    return { success: true };
  } catch (error: unknown) {
    const errorMsg = (error instanceof Error ? error.message : 'Unknown generation error').slice(0, 300);
    const newAttemptCount = job.attemptsCount + 1;

    await withTransaction(async (client) => {
      if (newAttemptCount >= 3) {
        // Mark job permanently failed
        await client.query(
          `UPDATE generation_jobs
           SET status = 'failed',
               attempts_count = $1,
               error_message = $2,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE id = $3`,
          [newAttemptCount, errorMsg, job.jobId]
        );

        // Update cycle failed jobs count
        await client.query(
          `UPDATE generation_cycles
           SET failed_jobs_count = failed_jobs_count + 1
           WHERE id = $1`,
          [job.cycleId]
        );

        // Check if cycle should be marked failed (no remaining active/pending jobs)
        const checkJobsRes = await client.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM generation_jobs 
           WHERE cycle_id = $1 AND status IN ('pending', 'processing')`,
          [job.cycleId]
        );
        const remainingCount = parseInt(checkJobsRes.rows[0].count, 10);

        if (remainingCount === 0) {
          await client.query(
            `UPDATE generation_cycles
             SET status = 'failed',
                 error_message = $1,
                 finished_at = NOW()
             WHERE id = $2`,
            [`Job execution failed: ${errorMsg}`, job.cycleId]
          );
        }
      } else {
        // Schedule retry with exponential backoff + jitter
        const backoffSeconds = Math.min(300, Math.pow(2, newAttemptCount) * 5 + Math.floor(Math.random() * 3));
        await client.query(
          `UPDATE generation_jobs
           SET status = 'pending',
               attempts_count = $1,
               next_attempt_at = NOW() + INTERVAL '${backoffSeconds} seconds',
               error_message = $2,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE id = $3`,
          [newAttemptCount, errorMsg, job.jobId]
        );
      }
    });

    return { success: false, error: errorMsg };
  }
}

async function cancelJobAndCheckCycle(client: PoolClient, jobId: string, cycleId: string) {
  await client.query(
    `UPDATE generation_jobs
     SET status = 'cancelled',
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId]
  );

  // Check if cycle should be cancelled (no active/pending jobs remaining)
  // We only count pending and processing. Completed or failed jobs mean the cycle is mixed.
  // Actually, if a cycle only has cancelled, completed or failed, we can determine its state.
  // Let's count pending/processing.
  const checkJobsRes = await client.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM generation_jobs
     WHERE cycle_id = $1 AND status IN ('pending', 'processing')`,
    [cycleId]
  );

  if (parseInt(checkJobsRes.rows[0].count, 10) === 0) {
    // There are no pending/processing jobs left.
    // Is the cycle completed?
    const cycleRes = await client.query<{
      target_count: number;
      valid_produced_count: number;
    }>(`SELECT target_count, valid_produced_count FROM generation_cycles WHERE id = $1`, [cycleId]);

    const cData = cycleRes.rows[0];
    if (cData) {
      if (cData.valid_produced_count >= cData.target_count) {
        await client.query(`UPDATE generation_cycles SET status = 'completed', finished_at = NOW() WHERE id = $1`, [cycleId]);
      } else {
        // If not completed and no pending/processing left, check if any job is failed.
        const failedRes = await client.query<{ count: string }>(`SELECT COUNT(*) as count FROM generation_jobs WHERE cycle_id = $1 AND status = 'failed'`, [cycleId]);
        if (parseInt(failedRes.rows[0].count, 10) > 0) {
           await client.query(`UPDATE generation_cycles SET status = 'failed', finished_at = NOW() WHERE id = $1`, [cycleId]);
        } else {
           // Only cancelled (and maybe some completed, but not enough). Mark cycle as cancelled.
           await client.query(`UPDATE generation_cycles SET status = 'cancelled', finished_at = NOW() WHERE id = $1`, [cycleId]);
        }
      }
    }
  }
}
