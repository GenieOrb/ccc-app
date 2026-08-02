import 'server-only';
import type { PoolClient } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { queryDb, withTransaction } from './db';
import { generateSingleComment } from './openai';
import { getConfiguredFallbackModel } from './ai/models';
import {
  computeNormalizedHash,
  normalizeCommentText,
  validateCommentLocally,
} from './validator';
import { SlotPlanV2, normalizeStoredSlotPlan } from './brand-variants';
import { processMemeBackgroundQueue, MIN_MEME_WORKER_JOB_BUDGET_MS } from './worker.memes';

export interface ClaimedJob {
  jobId: string;
  cycleId: string;
  campaignId: string;
  campaignPostId: string;
  slotIndex: number;
  slotPlan: SlotPlanV2;
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

// A claimed job needs enough time for one bounded provider attempt plus the
// durable DB transition that completes or releases its lease.
export const MIN_WORKER_JOB_BUDGET_MS = 15_000;
const WORKER_DURABLE_WRITE_RESERVE_MS = 5_000;

export async function processBackgroundQueue(
  workerId: string = randomUUID(),
  budgetMs: number = 50000
): Promise<{
  processed: number;
  completed: number;
  failed: number;
}> {
  const startTime = Date.now();
  const deadline = startTime + Math.max(0, budgetMs);
  const hasSafeJobBudget = () => deadline - Date.now() >= MIN_WORKER_JOB_BUDGET_MS;
  const maxParallelConcurrency = 3;

  let totalProcessed = 0;
  let totalCompleted = 0;
  let totalFailed = 0;

  while (hasSafeJobBudget()) {
    // 1. Claim up to maxParallelConcurrency jobs atomically
    const claimedJobs: ClaimedJob[] = [];

    for (let c = 0; c < maxParallelConcurrency; c++) {
      if (!hasSafeJobBudget()) break;
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
    const settled = await Promise.allSettled(
      claimedJobs.map((job) => executeJobTask(job, workerId, deadline))
    );
    const results = settled.map((result) => result.status === 'fulfilled'
      ? result.value
      : ({ success: false, error: 'Unhandled worker task failure' }));

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
       AND (
         c.is_active = true
         OR (c.campaign_type = 'manual' AND cy.cycle_type = 'initial')
       )
       AND p.retired_at IS NULL
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
      slotPlan: normalizeStoredSlotPlan(row.slot_plan),
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
  job: ClaimedJob,
  workerId: string,
  deadline: number,
): Promise<{ success: boolean; error?: string }> {
  let recentComments: string[] = [];
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
  let apiCallSequence = 0;

  try {
    const recentRows = await queryDb<{ comment_text: string }>(
      `SELECT comment_text FROM suggestions WHERE campaign_id = $1
       ORDER BY (campaign_post_id = $2) DESC, created_at DESC LIMIT 20`,
      [job.campaignId, job.campaignPostId],
    );
    recentComments = recentRows.map((row) => row.comment_text);
    const preCheckRows = await queryDb<{ id: string }>(
      `SELECT id FROM campaign_posts WHERE id = $1 AND retired_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
      [job.campaignPostId],
    );
    if (preCheckRows.length === 0) {
      await withTransaction(async (client) => { await cancelJobAndCheckCycle(client, job.jobId, job.cycleId, workerId); });
      return { success: true };
    }
    const generate = async (
      provider: 'openai' | 'deepseek' | 'qwen',
      apiModel: string,
      rewriteFeedback?: string,
      modelKey = job.modelKey,
      prices = { input: job.inputPricePerMillion, cached: job.cachedInputPricePerMillion, output: job.outputPricePerMillion },
    ) => {
      if (deadline - Date.now() <= WORKER_DURABLE_WRITE_RESERVE_MS) {
        throw new Error('Worker time budget exhausted before provider request.');
      }
      apiCallSequence++;
      const logicalCallKey = `${job.jobId}:${job.attemptsCount + 1}:${apiCallSequence}`;
      const purpose = rewriteFeedback ? 'rewrite' : provider === job.provider ? 'generation' : 'fallback';

      const result = await withTransaction(async (client) => {
        const existingRes = await client.query<{ call_key: string, status: string, response_text: string | null, created_at: Date, input_tokens: number | null, cached_input_tokens: number | null, output_tokens: number | null }>(
           `SELECT call_key, status, response_text, created_at, input_tokens, cached_input_tokens, output_tokens
            FROM generation_api_calls
            WHERE call_key = $1 OR call_key LIKE $2
            ORDER BY created_at DESC
            LIMIT 1 FOR UPDATE`,
           [logicalCallKey, `${logicalCallKey}:recovery:%`]
        );

        let physicalCallKey = logicalCallKey;

        if (existingRes.rows.length > 0) {
           const existing = existingRes.rows[0];

           if ((existing.status === 'succeeded' || existing.status === 'usage_unknown') && existing.response_text !== null) {
              return {
                 comment: existing.response_text,
                 usage: {
                   inputTokens: existing.input_tokens ?? undefined,
                   cachedInputTokens: existing.cached_input_tokens ?? undefined,
                   outputTokens: existing.output_tokens ?? undefined
                 }
              };
           }

           if (existing.status === 'started') {
              const ageMs = Date.now() - existing.created_at.getTime();
              if (ageMs < 180_000) {
                 throw new Error('DEFERRED_STARTED_CALL');
              } else {
                 await client.query(
                   `UPDATE generation_api_calls SET status = 'failed', failure_kind = 'orphaned_started', finished_at = NOW() WHERE call_key = $1`,
                   [existing.call_key]
                 );
                 physicalCallKey = `${logicalCallKey}:recovery:${randomUUID()}`;
              }
           } else {
              physicalCallKey = `${logicalCallKey}:recovery:${randomUUID()}`;
           }
        }

        await client.query(
          `INSERT INTO generation_api_calls (call_key,campaign_id,campaign_post_id,cycle_id,job_id,purpose,provider,model_key,api_model,status,input_price_per_million,cached_input_price_per_million,output_price_per_million,currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'started',$10,$11,$12,$13)`,
          [physicalCallKey, job.campaignId, job.campaignPostId, job.cycleId, job.jobId, purpose, provider, modelKey, apiModel, prices.input, prices.cached ?? null, prices.output, job.pricingCurrency]
        );
        return { physicalCallKey };
      });

      if ('comment' in result) {
         return result as { comment: string, usage?: { inputTokens?: number, cachedInputTokens?: number, outputTokens?: number } };
      }

      const callKey = result.physicalCallKey;
      try {
        const providerTimeoutMs = Math.floor(deadline - Date.now() - WORKER_DURABLE_WRITE_RESERVE_MS);
        if (providerTimeoutMs <= 0) {
          throw new Error('Worker time budget exhausted before provider request.');
        }
        const generated = await generateSingleComment({ apiModel, provider, postText: job.postText, authorName: job.authorName, authorUsername: job.authorUsername, accessibleContext: job.accessibleContext, direction: job.campaignDirection, plan: job.slotPlan, recentComments, rewriteFeedback, timeoutMs: providerTimeoutMs });
        const callUsage = generated.usage;
        const estimatedCost = callUsage
          ? ((callUsage.inputTokens ?? 0) - (callUsage.cachedInputTokens ?? 0)) * prices.input / 1_000_000 + (callUsage.cachedInputTokens ?? 0) * (prices.cached ?? prices.input) / 1_000_000 + (callUsage.outputTokens ?? 0) * prices.output / 1_000_000
          : null;
        await queryDb(
          `UPDATE generation_api_calls SET status = $2, response_text = $3, input_tokens = $4, cached_input_tokens = $5, output_tokens = $6, estimated_cost = $7, finished_at = NOW() WHERE call_key = $1`,
          [callKey, callUsage ? 'succeeded' : 'usage_unknown', generated.comment, callUsage?.inputTokens ?? null, callUsage?.cachedInputTokens ?? null, callUsage?.outputTokens ?? null, estimatedCost],
        );
        return generated;
      } catch (error) {
        await queryDb(`UPDATE generation_api_calls SET status = 'failed', failure_kind = 'provider_error', finished_at = NOW() WHERE call_key = $1`, [callKey]);
        throw error;
      }
    };
    try {
      const generated = await generate(job.provider as 'openai' | 'deepseek' | 'qwen', job.apiModel);
      rawComment = generated.comment;
      usage = generated.usage;
    } catch (primaryError) {
      // Fallback belongs exclusively to queued production generation. Preview
      // generation calls generateSingleComment directly and has no fallback.
      const fallback = getConfiguredFallbackModel(job.modelKey);
      if (!fallback) throw primaryError;
      const generated = await generate(fallback.provider, fallback.apiModel, undefined, fallback.key, { input: fallback.inputPricePerMillion, cached: fallback.cachedInputPricePerMillion, output: fallback.outputPricePerMillion });
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
      const rewritten = await generate(finalProvider as 'openai' | 'deepseek' | 'qwen', finalApiModel, validationReason, finalModelKey, { input: finalInputPrice, cached: finalCachedInputPrice, output: finalOutputPrice });
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
      const leaseRes = await client.query<{ id: string }>(
        `SELECT id FROM generation_jobs
         WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > NOW()
         FOR UPDATE`,
        [job.jobId, workerId],
      );
      if (leaseRes.rows.length === 0) return;
      // Re-check publication and the same campaign eligibility used to claim
      // the job.  Legacy inactive manual initial cycles must finish, while
      // inactive replenishment cycles remain ineligible.
      const postLockRes = await client.query(
        `SELECT 1
         FROM campaign_posts p
         JOIN campaigns c ON c.id = p.campaign_id
         JOIN generation_cycles cy ON cy.id = $2
         WHERE p.id = $1
           AND (
             c.is_active = true
             OR (c.campaign_type = 'manual' AND cy.cycle_type = 'initial')
           )
           AND p.retired_at IS NULL
           AND (p.expires_at IS NULL OR p.expires_at > NOW())
         FOR SHARE`,
        [job.campaignPostId, job.cycleId]
      );

      if (postLockRes.rows.length === 0) {
        await cancelJobAndCheckCycle(client, job.jobId, job.cycleId, workerId);
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
      const completedRes = await client.query(
        `UPDATE generation_jobs
         SET status = 'completed',
             suggestion_id = $1,
             lease_owner = NULL,
             lease_expires_at = NULL,
             error_message = NULL,
             updated_at = NOW()
         WHERE id = $2 AND status = 'processing' AND lease_owner = $3 AND lease_expires_at > NOW()
         RETURNING id`,
        [suggestionId, job.jobId, workerId]
      );
      if (completedRes.rows.length === 0) return;

      await client.query(
        `INSERT INTO generation_usage_metrics (campaign_id,campaign_post_id,cycle_id,job_id,requested_provider,requested_model_key,final_provider,final_model_key,input_tokens,cached_input_tokens,output_tokens,comments_requested,comments_received,comments_valid,comments_rejected,regenerations,attempts,fallback_used,input_price_per_million,cached_input_price_per_million,output_price_per_million,currency,estimated_cost)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text,$8::text,$9::integer,$10::integer,$11::integer,1,1,1,0,$12::integer,$13::integer,$14::boolean,$15::numeric,$16::numeric,$17::numeric,$18::text,CASE WHEN $9::integer IS NULL AND $10::integer IS NULL AND $11::integer IS NULL THEN NULL ELSE (COALESCE($9::integer,0) - COALESCE($10::integer,0))*$15::numeric/1000000 + COALESCE($10::integer,0)*COALESCE($16::numeric,0)/1000000 + COALESCE($11::integer,0)*$17::numeric/1000000 END)`,
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
    const isDeferred = errorMsg === 'DEFERRED_STARTED_CALL';
    const newAttemptCount = isDeferred ? job.attemptsCount : job.attemptsCount + 1;

    await withTransaction(async (client) => {
      if (newAttemptCount >= 3) {
        // Mark job permanently failed
        const failedRes = await client.query<{ id: string }>(
          `UPDATE generation_jobs
           SET status = 'failed',
               attempts_count = $1,
               error_message = $2,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE id = $3 AND status = 'processing' AND lease_owner = $4 AND lease_expires_at > NOW()
           RETURNING id`,
          [newAttemptCount, errorMsg, job.jobId, workerId]
        );
        if (failedRes.rows.length === 0) return;

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
        const backoffSeconds = isDeferred ? 5 : Math.min(300, Math.pow(2, newAttemptCount) * 5 + Math.floor(Math.random() * 3));
        await client.query(
          `UPDATE generation_jobs
           SET status = 'pending',
               attempts_count = $1,
               next_attempt_at = NOW() + INTERVAL '${backoffSeconds} seconds',
               error_message = $2,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE id = $3 AND status = 'processing' AND lease_owner = $4 AND lease_expires_at > NOW()
           RETURNING id`,
          [newAttemptCount, isDeferred ? 'Deferred due to recent started call' : errorMsg, job.jobId, workerId]
        );
      }
    });

    return { success: false, error: isDeferred ? 'deferred' : errorMsg };
  }
}

async function cancelJobAndCheckCycle(client: PoolClient, jobId: string, cycleId: string, workerId: string) {
  const cancelled = await client.query(
    `UPDATE generation_jobs
     SET status = 'cancelled',
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > NOW()
     RETURNING id`,
    [jobId, workerId]
  );
  if (cancelled.rows.length === 0) return;

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

export async function runGenerationProcessing(
  workerId: string = randomUUID(),
  totalBudgetMs: number = 50000,
  memeCycleId?: string
): Promise<{
  worker: { processed: number; completed: number; failed: number; skipped?: string };
  workerMemes: { processed: number; completed: number; failed: number; skipped?: string };
}> {
  const startTime = Date.now();
  
  // Split budget roughly evenly if both have budget, or give all to one
  const commentBudget = Math.floor(totalBudgetMs / 2);

  const workerResult = commentBudget >= MIN_WORKER_JOB_BUDGET_MS
    ? await processBackgroundQueue(workerId, commentBudget)
    : { processed: 0, completed: 0, failed: 0, skipped: 'insufficient_time_budget' };

  const remainingBudgetMs = Math.max(0, totalBudgetMs - (Date.now() - startTime));

  const workerMemesResult = remainingBudgetMs >= MIN_MEME_WORKER_JOB_BUDGET_MS
    ? await processMemeBackgroundQueue({
        workerId,
        budgetMs: remainingBudgetMs,
        cycleId: memeCycleId,
        maxConcurrency: 3
      })
    : { processed: 0, completed: 0, failed: 0, skipped: 'insufficient_time_budget' };

  return {
    worker: workerResult,
    workerMemes: workerMemesResult
  };
}
