import 'server-only';
import { randomUUID } from 'node:crypto';
import { queryDb, withTransaction } from './db';
import { parseMultipleXUrls, fetchXPosts } from './x-api';
import { normalizeXAccounts } from './x-accounts';
import { checkCampaignSafety } from './openai';
import { generateSecureSlug } from './crypto';
import { generateDeterministicSlotPlans } from './planner';
import { DEFAULT_MODEL_KEY, getAiModel, isProviderConfigured } from './ai/models';
import { generateSingleComment } from './openai';
import { processPerpetualCampaigns, type PerpetualMonitorSummary } from './perpetual-monitor';

function resolveCampaignModel(modelKey?: string) {
  const model = getAiModel(modelKey || DEFAULT_MODEL_KEY);
  if (!model || !model.enabled) throw new Error('Modelo no configurado.');
  if (!isProviderConfigured(model.provider)) throw new Error('El proveedor del modelo seleccionado no está configurado.');
  return model;
}

export interface CampaignSummary {
  id: string;
  internalNumber: number;
  internalId: string; // e.g. "Campaña 001"
  slug: string;
  publicUrl: string;
  direction?: string;
  displayName?: string;
  modelKey: string;
  isActive: boolean;
  safetyAllowed: boolean;
  safetyCategory?: string;
  safetyReason?: string;
  xPosts: { id: string; url: string; isRetired: boolean }[];
  generationProgress: number; // percentage
  validGeneratedCount: number;
  availableCount: number;
  assignedCount: number;
  pendingProcessingJobsCount: number;
  failedJobsCount: number;
  hasUnresolvedFailedCycle: boolean;
  recordedCost: number;
  campaignType: 'manual' | 'perpetual';
  postActiveLifetimeHours?: number;
  xAccounts: {
    id: string;
    username: string;
    usernameNormalized: string;
    isRemoved: boolean;
    createdAt: string;
    removedAt?: string;
    lastCheckpoint?: {
      phase: string;
      severity: 'info' | 'warning' | 'error';
      createdAt: string;
      errorCode?: string;
      errorMessage?: string;
    };
  }[];
  withdrawnCount: number;
  createdAt: string;
}

export interface CampaignsPage {
  items: CampaignSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function getCampaignsPage(
  appBaseUrl: string,
  page: number,
  pageSize: number
): Promise<CampaignsPage> {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const [{ total }] = await queryDb<{ total: string }>(`SELECT COUNT(*) AS total FROM campaigns`);
  const campaignTotal = Number.parseInt(total, 10) || 0;
  const totalPages = Math.max(1, Math.ceil(campaignTotal / safePageSize));
  const safePage = Math.min(totalPages, Math.max(1, Math.floor(page)));
  const offset = (safePage - 1) * safePageSize;

  const campaigns = await queryDb<{
    id: string;
    internal_number: number;
    slug: string;
    campaign_type: 'manual' | 'perpetual';
    post_active_lifetime_hours: number | null;
    direction: string | null;
    display_name: string | null;
    model_key: string;
    is_active: boolean;
    safety_allowed: boolean;
    safety_category: string | null;
    safety_reason: string | null;
    initial_size: number;
    created_at: Date;
  }>(
    `SELECT id, internal_number, slug, campaign_type, post_active_lifetime_hours, direction, display_name, model_key, is_active, safety_allowed, safety_category, safety_reason, initial_size, created_at
     FROM campaigns
     ORDER BY internal_number DESC
     LIMIT $1 OFFSET $2`,
    [safePageSize, offset]
  );

  const results: CampaignSummary[] = [];

  for (const c of campaigns) {
    const posts = await queryDb<{ id: string; canonical_url: string; retired_at: string | null }>(
      `SELECT id, canonical_url, retired_at FROM campaign_posts WHERE campaign_id = $1 ORDER BY created_at ASC`,
      [c.id]
    );

    const counts = await queryDb<{
      valid_generated: string;
      available: string;
      assigned: string;
      withdrawn: string;
      pending_processing_jobs: string;
      failed_jobs: string;
      has_failed_cycle: boolean;
      recorded_cost: string | null;
    }>(
      `SELECT 
         (SELECT COUNT(*) FROM suggestions WHERE campaign_id = $1) as valid_generated,
         (SELECT COUNT(*) FROM suggestions WHERE campaign_id = $1 AND status = 'available') as available,
         (SELECT COUNT(*) FROM suggestions WHERE campaign_id = $1 AND status = 'assigned') as assigned,
         (SELECT COUNT(*) FROM suggestions WHERE campaign_id = $1 AND status = 'withdrawn') as withdrawn,
         (SELECT COUNT(*) FROM generation_jobs WHERE campaign_id = $1 AND status IN ('pending', 'processing')) as pending_processing_jobs,
         (SELECT COUNT(*) FROM generation_jobs WHERE campaign_id = $1 AND status = 'failed') as failed_jobs,
         EXISTS (SELECT 1 FROM generation_cycles WHERE campaign_id = $1 AND status = 'failed') as has_failed_cycle,
         COALESCE((SELECT SUM(estimated_cost) FROM generation_usage_metrics WHERE campaign_id = $1 AND estimated_cost IS NOT NULL), 0)
         + COALESCE((SELECT SUM(estimated_cost) FROM generation_api_calls WHERE campaign_id = $1 AND estimated_cost IS NOT NULL), 0) as recorded_cost`,
      [c.id]
    );

    const countData = counts[0] || {
      valid_generated: '0',
      available: '0',
      assigned: '0',
      withdrawn: '0',
      pending_processing_jobs: '0',
      failed_jobs: '0',
      has_failed_cycle: false,
      recorded_cost: '0',
    };

    const validGen = parseInt(countData.valid_generated, 10);
    const avail = parseInt(countData.available, 10);
    const assig = parseInt(countData.assigned, 10);
    const withdrawn = parseInt(countData.withdrawn || '0', 10);
    const pendProcJobs = parseInt(countData.pending_processing_jobs, 10);
    const failJobs = parseInt(countData.failed_jobs, 10);
    const recordedCost = Number(countData.recorded_cost) || 0;

    const internalId = `Campaña ${String(c.internal_number).padStart(3, '0')}`;
    const publicUrl = `${appBaseUrl.replace(/\/+$/, '')}/comment/${c.slug}`;

    const progress = Math.min(100, Math.round((validGen / Math.max(1, c.initial_size)) * 100));

    const accounts = await queryDb<{
      id: string;
      username: string;
      username_normalized: string;
      created_at: string;
      removed_at: string | null;
      checkpoint_phase: string | null;
      checkpoint_severity: 'info' | 'warning' | 'error' | null;
      checkpoint_created_at: string | null;
      checkpoint_error_code: string | null;
      checkpoint_error_message: string | null;
    }>(
      `SELECT ca.id, ca.username, ca.username_normalized, ca.created_at, ca.removed_at,
              checkpoint.phase AS checkpoint_phase, checkpoint.severity AS checkpoint_severity,
              checkpoint.created_at AS checkpoint_created_at, checkpoint.error_code AS checkpoint_error_code,
              checkpoint.error_message AS checkpoint_error_message
       FROM campaign_accounts ca
       LEFT JOIN LATERAL (
         SELECT phase, severity, created_at, error_code, error_message
         FROM perpetual_sync_checkpoints
         WHERE campaign_account_id = ca.id
         ORDER BY created_at DESC
         LIMIT 1
       ) checkpoint ON true
       WHERE ca.campaign_id = $1
       ORDER BY ca.created_at ASC`,
      [c.id]
    );

    results.push({
      id: c.id,
      internalNumber: c.internal_number,
      internalId,
      slug: c.slug,
      campaignType: c.campaign_type,
      postActiveLifetimeHours: c.post_active_lifetime_hours ?? undefined,
      publicUrl,
      direction: c.direction || undefined,
      displayName: c.display_name || undefined,
      modelKey: c.model_key,
      isActive: c.is_active,
      safetyAllowed: c.safety_allowed,
      safetyCategory: c.safety_category || undefined,
      safetyReason: c.safety_reason || undefined,
      xPosts: posts.map((p) => ({ id: p.id, url: p.canonical_url, isRetired: p.retired_at !== null })),
      xAccounts: accounts.map(a => ({
        id: a.id,
        username: a.username,
        usernameNormalized: a.username_normalized,
        isRemoved: a.removed_at !== null,
        createdAt: new Date(a.created_at).toISOString(),
        removedAt: a.removed_at ? new Date(a.removed_at).toISOString() : undefined,
        lastCheckpoint: a.checkpoint_phase && a.checkpoint_severity && a.checkpoint_created_at ? {
          phase: a.checkpoint_phase,
          severity: a.checkpoint_severity,
          createdAt: new Date(a.checkpoint_created_at).toISOString(),
          errorCode: a.checkpoint_error_code || undefined,
          errorMessage: a.checkpoint_error_message || undefined,
        } : undefined,
      })),
      generationProgress: progress,
      validGeneratedCount: validGen,
      availableCount: avail,
      assignedCount: assig,
      pendingProcessingJobsCount: pendProcJobs,
      failedJobsCount: failJobs,
      hasUnresolvedFailedCycle: countData.has_failed_cycle,
      recordedCost,
      withdrawnCount: withdrawn,
      createdAt: new Date(c.created_at).toISOString(),
    });
  }

  return { items: results, page: safePage, pageSize: safePageSize, total: campaignTotal, totalPages };
}

export async function getAllCampaigns(appBaseUrl: string): Promise<CampaignSummary[]> {
  const [{ total }] = await queryDb<{ total: string }>(`SELECT COUNT(*) AS total FROM campaigns`);
  const totalCount = Number.parseInt(total, 10) || 0;
  const result = await getCampaignsPage(appBaseUrl, 1, Math.max(1, totalCount));
  return result.items;
}

export async function createCampaign(params: {
  urlsInput: string;
  direction?: string;
  displayName?: string;
  modelKey?: string;
  brandVariants?: { value: string; percentage: number }[];
}): Promise<{ id: string; slug: string }> {
  // 1. Validate & deduplicate X URLs
  const extractedUrls = parseMultipleXUrls(params.urlsInput);
  const model = resolveCampaignModel(params.modelKey);
  const displayName = params.displayName?.trim() || null;
  if (displayName && displayName.length > 120) throw new Error('El nombre no puede superar 120 caracteres.');

  // 2. Fetch posts from X API
  const fetchedPosts = await fetchXPosts(extractedUrls);

  // 3. Safety Preflight via OpenAI
  const postsTexts = fetchedPosts.map((fp) => fp.textContent);
  const safetyResult = await checkCampaignSafety(postsTexts, params.direction);

  if (!safetyResult.allowed) {
    throw new Error(
      `La campaña fue rechazada por la política de seguridad. Categoria: ${safetyResult.category}. Motivo: ${safetyResult.reason}`
    );
  }

  // 4. Generate random slug
  const slug = generateSecureSlug(16);

  // 5. Execute transactional campaign creation
  const created = await withTransaction(async (client) => {
    // Insert Campaign
    const campRes = await client.query<{ id: string }>(
      `INSERT INTO campaigns (
         slug, campaign_type, direction, post_active_lifetime_hours, is_active, safety_allowed, safety_category, safety_reason,
         initial_size, replenishment_threshold, replenishment_size, display_name, model_key, brand_variants
       ) VALUES (
         $1, 'manual', $2, NULL, true, true, $3, $4, 30, 5, 10, $5, $6, $7::jsonb
       ) RETURNING id`,
      [slug, params.direction || null, safetyResult.category, safetyResult.reason, displayName, model.key, JSON.stringify(params.brandVariants || [])]
    );
    const campaignId = campRes.rows[0].id;

    // Insert Campaign Posts and collect IDs
    const campaignPostIds: string[] = [];
    for (const fp of fetchedPosts) {
      const postRes = await client.query<{ id: string }>(
        `INSERT INTO campaign_posts (
           campaign_id, x_post_id, input_url, canonical_url, author_name, author_username,
           text_content, language, conversation_id, posted_at, accessible_context
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
         ) RETURNING id`,
        [
          campaignId,
          fp.postId,
          fp.inputUrl,
          fp.canonicalUrl,
          fp.authorName,
          fp.authorUsername,
          fp.textContent,
          fp.language,
          fp.conversationId,
          fp.postedAt ? new Date(fp.postedAt) : null,
          JSON.stringify(fp.accessibleContext),
        ]
      );
      campaignPostIds.push(postRes.rows[0].id);
    }

    for (const campaignPostId of campaignPostIds) {
      const slotPlans = generateDeterministicSlotPlans([campaignPostId], 30, params.brandVariants || []);
      const cycleRes = await client.query<{ id: string }>(
        `INSERT INTO generation_cycles (
            campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, model_name, prompt_version
         ) VALUES (
            $1, $2, 'initial', 30, 'pending', $3, $4, 1
         ) RETURNING id`,
        [campaignId, campaignPostId, model.key, model.apiModel]
      );
      const cycleId = cycleRes.rows[0].id;

      for (const plan of slotPlans) {
        await client.query(
          `INSERT INTO generation_jobs (
             cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan,
             length_mode, emoji_policy, rhetorical_form, texture, status,
             model_name, prompt_version
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, 1
           )`,
          [
            cycleId, campaignId, plan.assignedPostId, plan.slotIndex, JSON.stringify(plan),
            plan.lengthMode, plan.emojiPolicy, plan.rhetoricalForm, plan.texture, model.apiModel,
          ]
        );
      }
    }

    return { id: campaignId, slug };
  });

  return created;
}

export async function toggleCampaignStatus(campaignId: string): Promise<boolean> {
  const result = await withTransaction(async (client) => {
    const campRes = await client.query<{ is_active: boolean; campaign_type: 'manual' | 'perpetual' }>(
      `SELECT is_active, campaign_type FROM campaigns WHERE id = $1 FOR UPDATE`,
      [campaignId]
    );
    if (campRes.rows.length === 0) {
      throw new Error('Campaña no encontrada.');
    }

    const currentStatus = campRes.rows[0].is_active;
    const campaignType = campRes.rows[0].campaign_type;

    if (!currentStatus) {
      if (campaignType === 'manual') {
        // Trying to activate: check if initial cycle generated its target count, and at least 1 comment is available.
        const cycleRes = await client.query<{
          initial_cycle_count: string;
          incomplete_cycle_count: string;
          valid_produced_count: string;
          target_count: string;
        }>(
          `SELECT
             COUNT(*) AS initial_cycle_count,
             COUNT(*) FILTER (WHERE status <> 'completed') AS incomplete_cycle_count,
             COALESCE(SUM(valid_produced_count), 0) AS valid_produced_count,
             COALESCE(SUM(target_count), 0) AS target_count
           FROM generation_cycles
           WHERE campaign_id = $1 AND cycle_type = 'initial'`,
          [campaignId]
        );

        const cycle = cycleRes.rows[0];
        if (!cycle || Number(cycle.initial_cycle_count) === 0 || Number(cycle.incomplete_cycle_count) > 0) {
          throw new Error('No se puede activar: ciclo inicial inexistente o incompleto.');
        }

        if (Number(cycle.valid_produced_count) < Number(cycle.target_count)) {
          throw new Error('No se puede activar: ciclo inicial sin haber producido el objetivo.');
        }

        const availRes = await client.query<{ avail_count: string }>(
          `SELECT COUNT(*) as avail_count FROM suggestions WHERE campaign_id = $1 AND status = 'available'`,
          [campaignId]
        );
        const avail = parseInt(availRes.rows[0]?.avail_count || '0', 10);

        if (avail < 1) {
          throw new Error('No se puede activar: ausencia de comentarios disponibles.');
        }
      } else {
        // Perpetual campaign activation logic
        const accountsRes = await client.query<{ count: string }>(
          `SELECT COUNT(*) FROM campaign_accounts WHERE campaign_id = $1 AND removed_at IS NULL`,
          [campaignId]
        );
        const activeAccountsCount = parseInt(accountsRes.rows[0]?.count || '0', 10);
        
        if (activeAccountsCount < 1) {
          throw new Error('No se puede activar: debe tener al menos una cuenta de X activa.');
        }
        await client.query(
          `UPDATE campaign_accounts ca
           SET last_seen_post_id = NULL, initial_sync_pending = true, last_polled_at = NULL
           WHERE ca.campaign_id = $1 AND ca.removed_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM campaign_posts p
               WHERE p.campaign_account_id = ca.id AND p.retired_at IS NULL
                 AND (p.expires_at IS NULL OR p.expires_at > NOW())
             )`,
          [campaignId]
        );
      }

      await client.query(`UPDATE campaigns SET is_active = true, updated_at = NOW() WHERE id = $1`, [
        campaignId,
      ]);
      return { isActive: true, synchronizePerpetualCampaign: campaignType === 'perpetual' };
    } else {
      await client.query(`UPDATE campaigns SET is_active = false, updated_at = NOW() WHERE id = $1`, [
        campaignId,
      ]);
      return { isActive: false, synchronizePerpetualCampaign: false };
    }
  });

  // This must run after the activation transaction has committed: the monitor
  // reads the campaign's active state and imports the first posts immediately.
  if (result.synchronizePerpetualCampaign) {
    await processPerpetualCampaigns({ campaignId, timeBudgetMs: 30_000 });
  }

  return result.isActive;
}

export async function retryFailedCampaignJobs(campaignId: string): Promise<void> {
  await withTransaction(async (client) => {
    const campaignRes = await client.query<{ id: string }>(
      `SELECT id FROM campaigns WHERE id = $1 FOR UPDATE`,
      [campaignId]
    );
    if (campaignRes.rows.length === 0) return;

    // Find a cycle that has failed jobs, prioritizing 'initial' over others, oldest first.
    const cycleRes = await client.query<{ id: string }>(
      `SELECT id 
       FROM generation_cycles 
       WHERE campaign_id = $1 
         AND EXISTS (
           SELECT 1 FROM generation_jobs 
           WHERE cycle_id = generation_cycles.id AND status = 'failed'
         )
       ORDER BY CASE WHEN cycle_type = 'initial' THEN 0 ELSE 1 END ASC, created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [campaignId]
    );

    if (cycleRes.rows.length === 0) return;

    const cycleId = cycleRes.rows[0].id;

    // Reset all failed jobs in cycle to pending
    await client.query(
      `UPDATE generation_jobs 
       SET status = 'pending',
           attempts_count = 0,
           error_message = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = NOW(),
           updated_at = NOW()
       WHERE cycle_id = $1 AND status = 'failed'`,
      [cycleId]
    );

    // Reset cycle status to processing
    await client.query(
      `UPDATE generation_cycles 
       SET status = 'processing',
           error_message = NULL,
           finished_at = NULL
       WHERE id = $1`,
      [cycleId]
    );
  });

}

export async function triggerReplenishmentIfNeeded(campaignId: string): Promise<void> {
  // Determine campaign type first outside transaction for fast paths
  const campTypeRes = await queryDb<{ campaign_type: string, replenishment_threshold: number, replenishment_size: number, model_key: string, brand_variants: unknown }>(
    `SELECT campaign_type, replenishment_threshold, replenishment_size, model_key, brand_variants FROM campaigns WHERE id = $1 AND is_active = true`,
    [campaignId]
  );
  if (campTypeRes.length === 0) return;
  const campaignInfo = campTypeRes[0];
  const threshold = campaignInfo.replenishment_threshold;
  const repSize = campaignInfo.replenishment_size;
  const model = resolveCampaignModel(campaignInfo.model_key);

  if (campaignInfo.campaign_type === 'manual') {
    try {
      await withTransaction(async (client) => {
        const campaignLock = await client.query(`SELECT 1 FROM campaigns WHERE id = $1 AND is_active = true FOR UPDATE`, [campaignId]);
        if (campaignLock.rows.length === 0) return;
        const postRows = await client.query<{ id: string }>(
          `SELECT id FROM campaign_posts WHERE campaign_id = $1 AND retired_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at ASC`,
          [campaignId]
        );
        for (const { id: postId } of postRows.rows) {
          const availRowsLock = await client.query<{ count: string }>(
            `SELECT COUNT(*) as count FROM suggestions WHERE campaign_id = $1 AND campaign_post_id = $2 AND status = 'available'`,
            [campaignId, postId]
          );
          if (parseInt(availRowsLock.rows[0]?.count || '0', 10) > threshold) continue;

          const checkRes = await client.query(
            `SELECT 1 FROM generation_cycles WHERE campaign_id = $1 AND campaign_post_id = $2 AND status IN ('pending', 'processing', 'failed') LIMIT 1`,
            [campaignId, postId]
          );
          if (checkRes.rows.length > 0) continue;

          await client.query(`SELECT 1 FROM campaign_posts WHERE id = $1 FOR UPDATE`, [postId]);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slotPlans = generateDeterministicSlotPlans([postId], repSize, (campaignInfo.brand_variants as any) || []);
          const cycleRes = await client.query<{ id: string }>(
            `INSERT INTO generation_cycles (
              campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, model_name, prompt_version
           ) VALUES (
              $1, $2, 'replenishment', $3, 'pending', $4, $5, 1
           ) RETURNING id`,
            [campaignId, postId, repSize, model.key, model.apiModel]
          );
          const cycleId = cycleRes.rows[0].id;

          for (const plan of slotPlans) {
            await client.query(
              `INSERT INTO generation_jobs (
                 cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan,
                 length_mode, emoji_policy, rhetorical_form, texture, status,
                 model_name, prompt_version
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, 1
               )`,
              [
                cycleId, campaignId, plan.assignedPostId, plan.slotIndex, JSON.stringify(plan),
                plan.lengthMode, plan.emojiPolicy, plan.rhetoricalForm, plan.texture, model.apiModel,
              ]
            );
          }
        }
      });

  } catch {
    // Ignore duplicate cycle creation conflicts gracefully
  }
} else {
  // Perpetual campaigns replenishment logic (per-post)
  try {
    await withTransaction(async (client) => {
      const campaignLock = await client.query(`SELECT 1 FROM campaigns WHERE id = $1 AND is_active = true FOR UPDATE`, [campaignId]);
      if (campaignLock.rows.length === 0) return;
      // Get all current non-retired posts for this campaign
      const postRows = await client.query<{ id: string }>(
        `SELECT id FROM campaign_posts WHERE campaign_id = $1 AND retired_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
        [campaignId]
      );
      if (postRows.rows.length === 0) return;
      const campaignPostIds = postRows.rows.map((p) => p.id);

      for (const postId of campaignPostIds) {
        // Maintain campaign -> post -> cycle locking for concurrent replenishment.
        await client.query(`SELECT 1 FROM campaign_posts WHERE id = $1 FOR UPDATE`, [postId]);

        const availRowsLock = await client.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM suggestions WHERE campaign_id = $1 AND campaign_post_id = $2 AND status = 'available'`,
          [campaignId, postId]
        );
        const availableCountLock = parseInt(availRowsLock.rows[0]?.count || '0', 10);
        if (availableCountLock > threshold) continue;

        const checkRes = await client.query(
          `SELECT 1 FROM generation_cycles WHERE campaign_id = $1 AND campaign_post_id = $2 AND status IN ('pending', 'processing') LIMIT 1`,
          [campaignId, postId]
        );
        if (checkRes.rows.length > 0) continue;

        const failedCycleRes = await client.query<{ id: string }>(
          `SELECT id
           FROM generation_cycles
           WHERE campaign_id = $1
             AND campaign_post_id = $2
             AND status = 'failed'
             AND EXISTS (
               SELECT 1 FROM generation_jobs
               WHERE cycle_id = generation_cycles.id AND status = 'failed'
             )
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE`,
          [campaignId, postId]
        );
        if (failedCycleRes.rows.length > 0) {
          const cycleId = failedCycleRes.rows[0].id;
          await client.query(
            `UPDATE generation_jobs
             SET status = 'pending',
                 attempts_count = 0,
                 error_message = NULL,
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 next_attempt_at = NOW(),
                 updated_at = NOW()
             WHERE cycle_id = $1 AND status = 'failed'`,
            [cycleId]
          );
          await client.query(
            `UPDATE generation_cycles
             SET status = 'processing', error_message = NULL, finished_at = NULL
             WHERE id = $1`,
            [cycleId]
          );
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slotPlans = generateDeterministicSlotPlans([postId], repSize, (campaignInfo.brand_variants as any) || []);
        if (slotPlans.length === 0) continue;

        const cycleRes = await client.query<{ id: string }>(
          `INSERT INTO generation_cycles (
              campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, model_name, prompt_version
           ) VALUES (
              $1, $2, 'replenishment', $3, 'pending', $4, $5, 1
           ) RETURNING id`,
           [campaignId, postId, repSize, model.key, model.apiModel]
        );
        const cycleId = cycleRes.rows[0].id;

        for (const plan of slotPlans) {
          await client.query(
            `INSERT INTO generation_jobs (
               cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan,
               length_mode, emoji_policy, rhetorical_form, texture, status,
               model_name, prompt_version
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, 1
             )`,
            [
              cycleId,
              campaignId,
              plan.assignedPostId,
              plan.slotIndex,
              JSON.stringify(plan),
              plan.lengthMode,
              plan.emojiPolicy,
              plan.rhetoricalForm,
              plan.texture,
               model.apiModel,
            ]
          );
        }
      }
    });

  } catch {
    // Ignore concurrency conflicts
  }
}
}

export type AssignmentResponse =
  | { status: 'success'; assignmentId: string; comment: string; postUrl: string }
  | { status: 'expired' }
  | { status: 'unavailable' }
  | { status: 'generating'; retryAfterMs: number }
  | { status: 'no_inventory' }
  | { status: 'rate_limited' };

type InternalAssignmentResponse = 
  | { status: 'success'; assignmentId: string; comment: string; postUrl: string; isNewAssignment?: boolean; campaignId?: string }
  | { status: 'expired' }
  | { status: 'unavailable' }
  | { status: 'no_inventory'; campaignId: string }
  | { status: 'rate_limited' };

export async function assignCommentToVisitor(
  slug: string,
  visitorHash: string,
  checkRateLimit?: () => Promise<boolean>
): Promise<AssignmentResponse> {
  const txResult = await withTransaction<InternalAssignmentResponse>(async (client) => {
    // 1. Fetch campaign by slug FOR SHARE
    const campaignRows = await client.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM campaigns WHERE slug = $1 FOR SHARE`,
      [slug]
    );

    if (campaignRows.rows.length === 0 || !campaignRows.rows[0].is_active) {
      return { status: 'expired' };
    }

    const campaignId = campaignRows.rows[0].id;
    // 2. Ensure visitor record exists
    const visitorRes = await client.query<{ id: string }>(
      `INSERT INTO visitors (visitor_hash)
       VALUES ($1)
       ON CONFLICT (visitor_hash) DO UPDATE SET visitor_hash = EXCLUDED.visitor_hash
       RETURNING id`,
      [visitorHash]
    );
    const visitorId = visitorRes.rows[0].id;

    // 3. Upsert visitor_campaign_states and lock it
    await client.query(
      `INSERT INTO visitor_campaign_states (campaign_id, visitor_id)
       VALUES ($1, $2)
       ON CONFLICT (campaign_id, visitor_id) DO NOTHING`,
      [campaignId, visitorId]
    );

    const stateRes = await client.query<{ active_assignment_id: string | null }>(
      `SELECT active_assignment_id
       FROM visitor_campaign_states
       WHERE campaign_id = $1 AND visitor_id = $2
       FOR UPDATE`,
      [campaignId, visitorId]
    );

    const activeAssignmentId = stateRes.rows[0].active_assignment_id;

    // 4. If there's an active assignment, return it directly
    if (activeAssignmentId) {
      const existingRes = await client.query<{
        comment_text: string;
        canonical_url: string;
      }>(
        `SELECT s.comment_text, p.canonical_url
         FROM assignments a
         JOIN suggestions s ON a.suggestion_id = s.id
         JOIN campaign_posts p ON a.campaign_post_id = p.id
         WHERE a.id = $1`,
        [activeAssignmentId]
      );
      
      if (existingRes.rows.length > 0) {
        const row = existingRes.rows[0];
        return {
          status: 'success',
          assignmentId: activeAssignmentId,
          comment: row.comment_text,
          postUrl: row.canonical_url,
        };
      }
    }

    // 5. No active assignment. Check if there are any valid unseen posts
    const unseenPostRes = await client.query<{ id: string }>(
      `SELECT cp.id
       FROM campaign_posts cp
       WHERE cp.campaign_id = $1 
         AND cp.retired_at IS NULL
         AND (cp.expires_at IS NULL OR cp.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM assignments a 
           WHERE a.campaign_id = cp.campaign_id 
             AND a.visitor_id = $2 
             AND a.campaign_post_id = cp.id
         )
       LIMIT 1`,
      [campaignId, visitorId]
    );

    if (unseenPostRes.rows.length === 0) {
      return { status: 'unavailable' };
    }

    // 6. Select available suggestion FOR UPDATE SKIP LOCKED. Polling with no
    // inventory must not consume the assignment rate-limit budget.
    const suggestionRes = await client.query<{
      suggestion_id: string;
      campaign_post_id: string;
      comment_text: string;
      canonical_url: string;
    }>(
      `SELECT s.id as suggestion_id, s.campaign_post_id, s.comment_text, p.canonical_url
       FROM suggestions s
       JOIN campaign_posts p ON s.campaign_post_id = p.id
       WHERE s.campaign_id = $1 AND s.status = 'available' AND p.retired_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > NOW())
       AND NOT EXISTS (
           SELECT 1 FROM assignments a 
           WHERE a.campaign_id = s.campaign_id 
             AND a.visitor_id = $2 
             AND a.campaign_post_id = s.campaign_post_id
       )
       ORDER BY p.posted_at DESC NULLS LAST, p.created_at DESC, s.delivery_order ASC, s.created_at ASC
       LIMIT 1
       FOR UPDATE OF s SKIP LOCKED`,
      [campaignId, visitorId]
    );

    if (suggestionRes.rows.length === 0) {
      return { status: 'no_inventory', campaignId };
    }

    // 7. Apply the assignment limit only after an actual comment is available.
    if (checkRateLimit && !(await checkRateLimit())) return { status: 'rate_limited' };

    const claimedSuggestion = suggestionRes.rows[0];

    // 8. Create Assignment record
    const insertAssignmentRes = await client.query<{ id: string }>(
      `INSERT INTO assignments (campaign_id, visitor_id, campaign_post_id, suggestion_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [campaignId, visitorId, claimedSuggestion.campaign_post_id, claimedSuggestion.suggestion_id]
    );

    const newAssignmentId = insertAssignmentRes.rows[0].id;

    // 9. Update Suggestion status to assigned Conditionally
    const updateSuggRes = await client.query(
      `UPDATE suggestions
       SET status = 'assigned', assigned_at = NOW()
       WHERE id = $1 AND status = 'available'
       RETURNING id`,
      [claimedSuggestion.suggestion_id]
    );

    if (updateSuggRes.rows.length !== 1) {
      throw new Error('Failed to update suggestion status securely');
    }

    // 10. Update visitor_campaign_states with active assignment Conditionally
    const updateStateRes = await client.query(
      `UPDATE visitor_campaign_states
       SET active_assignment_id = $1, updated_at = NOW()
       WHERE campaign_id = $2 AND visitor_id = $3 AND active_assignment_id IS NULL
       RETURNING 1`,
      [newAssignmentId, campaignId, visitorId]
    );

    if (updateStateRes.rows.length !== 1) {
      throw new Error('Failed to assign active assignment state securely');
    }

    return {
      status: 'success',
      assignmentId: newAssignmentId,
      comment: claimedSuggestion.comment_text,
      postUrl: claimedSuggestion.canonical_url,
      isNewAssignment: true,
      campaignId,
    };
  });

  if ((txResult.status === 'success' && txResult.isNewAssignment) || txResult.status === 'no_inventory') {
    if (txResult.campaignId) {
      // This is deliberately awaited: serverless requests may discard detached
      // promises. A later cron reconciliation remains the durable fallback.
      await triggerReplenishmentIfNeeded(txResult.campaignId).catch(() => undefined);
    }
  }

  // Map to public AssignmentResponse
  if (txResult.status === 'success') {
    return {
      status: 'success',
      assignmentId: txResult.assignmentId,
      comment: txResult.comment,
      postUrl: txResult.postUrl,
    };
  }
  
  if (txResult.status === 'no_inventory') {
    const queued = await queryDb<{ count: string }>(`SELECT COUNT(*) AS count FROM generation_jobs j JOIN campaign_posts p ON p.id=j.campaign_post_id WHERE j.campaign_id = $1 AND j.status IN ('pending','processing') AND p.retired_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > NOW())`, [txResult.campaignId]);
    if (Number(queued[0]?.count || 0) > 0) return { status: 'generating', retryAfterMs: 2500 };
    return { status: 'no_inventory' };
  }

  return txResult;
}

export async function createPerpetualCampaign(params: {
  accountsInput: string;
  direction?: string;
  postActiveLifetimeHours: number;
  displayName?: string;
  modelKey?: string;
  brandVariants?: { value: string; percentage: number }[];
}): Promise<{ id: string; slug: string; initialSync: PerpetualMonitorSummary }> {
  const normalizedAccounts = normalizeXAccounts(params.accountsInput);
  const model = resolveCampaignModel(params.modelKey);
  const displayName = params.displayName?.trim() || null;
  if (displayName && displayName.length > 120) throw new Error('El nombre no puede superar 120 caracteres.');

  if (params.postActiveLifetimeHours < 1 || params.postActiveLifetimeHours > 720 || !Number.isInteger(params.postActiveLifetimeHours)) {
    throw new Error('La duración de los posts debe ser un número entero entre 1 y 720 horas.');
  }

  const slug = generateSecureSlug(16);

  const created = await withTransaction(async (client) => {
    // Insert Campaign
    const campRes = await client.query<{ id: string }>(
      `INSERT INTO campaigns (
         slug, campaign_type, direction, post_active_lifetime_hours, is_active, safety_allowed,
         initial_size, replenishment_threshold, replenishment_size, display_name, model_key, brand_variants
       ) VALUES (
         $1, 'perpetual', $2, $3, true, true, 30, 5, 10, $4, $5, $6::jsonb
       ) RETURNING id`,
      [slug, params.direction || null, params.postActiveLifetimeHours, displayName, model.key, JSON.stringify(params.brandVariants || [])]
    );
    const campaignId = campRes.rows[0].id;

    const accountIds: string[] = [];
    for (const acc of normalizedAccounts) {
      const accountRes = await client.query<{ id: string }>(
        `INSERT INTO campaign_accounts (
           campaign_id, username, username_normalized
         ) VALUES ($1, $2, $3)
         RETURNING id`,
        [campaignId, acc.username, acc.username_normalized]
      );
      accountIds.push(accountRes.rows[0].id);
    }

    return { id: campaignId, slug, accountIds };
  });
  // This runs only after the campaign/accounts transaction commits. It is
  // awaited because serverless runtimes may discard detached work; cron keeps
  // reconciling every perpetual account if this bounded nudge is incomplete.
  const initialSync = await processPerpetualCampaigns({
    campaignId: created.id,
    accountIds: created.accountIds,
    timeBudgetMs: 30_000,
  });
  return { id: created.id, slug: created.slug, initialSync };
}

/** Durable cron-side reconciler. Request paths may nudge replenishment, but
 * this scan guarantees it does not depend on serverless background work. */
export async function reconcileCampaignReplenishment(limit = 50): Promise<{ checked: number; errors: string[] }> {
  const campaigns = await queryDb<{ id: string }>(
    `SELECT id FROM campaigns WHERE is_active = true ORDER BY updated_at ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
  const errors: string[] = [];
  for (const campaign of campaigns) {
    try {
      await triggerReplenishmentIfNeeded(campaign.id);
    } catch {
      errors.push(campaign.id);
    }
  }
  return { checked: campaigns.length, errors };
}

export async function generateCampaignPreview(campaignId: string) {
  const rows = await queryDb<{ model_key: string; direction: string | null; brand_variants: unknown; post_id: string; text_content: string; author_name: string | null; author_username: string | null; accessible_context: unknown }>(
    `SELECT c.model_key,c.direction,c.brand_variants,p.id post_id,p.text_content,p.author_name,p.author_username,p.accessible_context
     FROM campaigns c JOIN campaign_posts p ON p.campaign_id=c.id
     WHERE c.id=$1 AND p.retired_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>NOW())
     ORDER BY p.posted_at DESC NULLS LAST,p.created_at DESC LIMIT 1`, [campaignId]);
  if (!rows[0]) throw new Error('No hay ningún post vigente para generar la preview.');
  const row = rows[0]; const model = resolveCampaignModel(row.model_key);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plans = generateDeterministicSlotPlans([row.post_id], 7, (row.brand_variants as any) || []);
  const comments: string[] = []; let errorMessage: string | null = null;
  let inputTokens: number | null = 0;
  let cachedInputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  const previewExecutionId = randomUUID();
  try {
    // Preview follows the same 5+2 batch boundary as production while never
    // falling back to a different model.
    for (const batch of [plans.slice(0, 5), plans.slice(5)]) {
      const generated = await Promise.all(batch.map(async (plan) => {
        const callKey = `preview:${previewExecutionId}:${plan.slotIndex}`;
        const acquired = await queryDb<{ call_key: string }>(
          `INSERT INTO generation_api_calls (call_key,campaign_id,campaign_post_id,purpose,provider,model_key,api_model,status,input_price_per_million,cached_input_price_per_million,output_price_per_million,currency)
           VALUES ($1,$2,$3,'preview',$4,$5,$6,'started',$7,$8,$9,$10)
           ON CONFLICT (call_key) DO NOTHING
           RETURNING call_key`,
          [callKey, campaignId, row.post_id, model.provider, model.key, model.apiModel, model.inputPricePerMillion, model.cachedInputPricePerMillion ?? null, model.outputPricePerMillion, model.currency],
        );
        if (Array.isArray(acquired) && acquired.length === 0) {
          throw new Error('AI preview call acquisition conflict; no durable result is available.');
        }
        try {
          const generatedComment = await generateSingleComment({ apiModel: model.apiModel, provider: model.provider, postText: row.text_content, authorName: row.author_name || '', authorUsername: row.author_username || '', accessibleContext: (row.accessible_context as Record<string, unknown>) || {}, direction: row.direction || undefined, plan, recentComments: [...comments] });
          const callUsage = generatedComment.usage;
          const callCost = callUsage
            ? ((callUsage.inputTokens ?? 0) - (callUsage.cachedInputTokens ?? 0)) * model.inputPricePerMillion / 1_000_000 + (callUsage.cachedInputTokens ?? 0) * (model.cachedInputPricePerMillion ?? model.inputPricePerMillion) / 1_000_000 + (callUsage.outputTokens ?? 0) * model.outputPricePerMillion / 1_000_000
            : null;
          await queryDb(`UPDATE generation_api_calls SET status = $2,input_tokens = $3,cached_input_tokens = $4,output_tokens = $5,estimated_cost = $6,finished_at = NOW() WHERE call_key = $1`, [callKey, callUsage ? 'succeeded' : 'usage_unknown', callUsage?.inputTokens ?? null, callUsage?.cachedInputTokens ?? null, callUsage?.outputTokens ?? null, callCost]);
          return generatedComment;
        } catch (error) {
          await queryDb(`UPDATE generation_api_calls SET status = 'failed',failure_kind = 'provider_error',finished_at = NOW() WHERE call_key = $1`, [callKey]);
          throw error;
        }
      }));
      comments.push(...generated.map((item) => item.comment));
      for (const item of generated) {
        if (!item.usage) {
          inputTokens = null;
          cachedInputTokens = null;
          outputTokens = null;
          continue;
        }
        if (inputTokens !== null) inputTokens += item.usage.inputTokens ?? 0;
        if (cachedInputTokens !== null) cachedInputTokens += item.usage.cachedInputTokens ?? 0;
        if (outputTokens !== null) outputTokens += item.usage.outputTokens ?? 0;
      }
    }
  } catch { errorMessage = `La preview con ${model.displayName} no pudo generarse.`; }
  const estimatedCost = inputTokens === null || cachedInputTokens === null || outputTokens === null
    ? null
    : ((inputTokens - cachedInputTokens) * model.inputPricePerMillion + cachedInputTokens * (model.cachedInputPricePerMillion ?? model.inputPricePerMillion) + outputTokens * model.outputPricePerMillion) / 1_000_000;
  await queryDb(`INSERT INTO campaign_previews (campaign_id,campaign_post_id,model_key,provider,api_model,comments,input_tokens,cached_input_tokens,output_tokens,estimated_cost,error_message,input_price_per_million,cached_input_price_per_million,output_price_per_million,currency,pricing_effective_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [campaignId,row.post_id,model.key,model.provider,model.apiModel,JSON.stringify(comments),inputTokens,cachedInputTokens,outputTokens,estimatedCost,errorMessage,model.inputPricePerMillion,model.cachedInputPricePerMillion ?? null,model.outputPricePerMillion,model.currency,model.pricingEffectiveAt]);
  if (errorMessage) throw new Error(errorMessage);
  return { postId: row.post_id, modelKey: model.key, provider: model.provider, comments };
}

export async function listCampaignPreviews(campaignId: string) {
  return queryDb(`SELECT id,campaign_post_id,model_key,provider,api_model,comments,input_tokens,cached_input_tokens,output_tokens,estimated_cost,error_message,created_at FROM campaign_previews WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 30`, [campaignId]);
}

export async function addAccountsToCampaign(campaignId: string, accountsInput: string): Promise<{ addedAccounts: Array<{ id: string; username: string; usernameNormalized: string; isRemoved: boolean; createdAt: string; removedAt: undefined }>; initialSync: PerpetualMonitorSummary }> {
  const normalizedAccounts = normalizeXAccounts(accountsInput);

  const addedAccounts = await withTransaction<Array<{ id: string; username: string; usernameNormalized: string; isRemoved: boolean; createdAt: string; removedAt: undefined }>>(async (client) => {
    const campRes = await client.query<{ campaign_type: string }>(
      `SELECT campaign_type FROM campaigns WHERE id = $1 FOR UPDATE`,
      [campaignId]
    );

    if (campRes.rows.length === 0) {
      throw new Error('Campaña no encontrada.');
    }

    if (campRes.rows[0].campaign_type !== 'perpetual') {
      throw new Error('Solo se pueden añadir cuentas a campañas perpetuas.');
    }

    const addedAccounts = [];

    for (const acc of normalizedAccounts) {
      // Check if it already exists and is active
      const existingRes = await client.query<{ id: string }>(
        `SELECT id FROM campaign_accounts 
         WHERE campaign_id = $1 AND username_normalized = $2 AND removed_at IS NULL`,
        [campaignId, acc.username_normalized]
      );

      if (existingRes.rows.length === 0) {
        const insertRes = await client.query<{ id: string; username: string; username_normalized: string; created_at: Date; removed_at: Date | null }>(
          `INSERT INTO campaign_accounts (campaign_id, username, username_normalized, x_user_id, monitoring_started_at)
           VALUES ($1, $2, $3, $4, NOW())
           RETURNING id, username, username_normalized, created_at, removed_at`,
          [campaignId, acc.username, acc.username_normalized, null]
        );
        addedAccounts.push({
          id: insertRes.rows[0].id,
          username: insertRes.rows[0].username,
          usernameNormalized: insertRes.rows[0].username_normalized,
          isRemoved: false,
          createdAt: new Date(insertRes.rows[0].created_at).toISOString(),
          removedAt: undefined
        });
      }
    }

    return addedAccounts;
  });
  const initialSync = addedAccounts.length > 0
    ? await processPerpetualCampaigns({ campaignId, accountIds: addedAccounts.map((account) => account.id), timeBudgetMs: 30_000 })
    : { accountsProcessed: 0, postsDetected: 0, postsImported: 0, postsRejected: 0, postsExpired: 0, cyclesCreated: 0, errors: [] };
  return { addedAccounts, initialSync };
}

export async function removeAccountFromCampaign(campaignId: string, accountId: string) {
  return await withTransaction(async (client) => {
    const campRes = await client.query<{ campaign_type: string }>(
      `SELECT campaign_type FROM campaigns WHERE id = $1 FOR UPDATE`,
      [campaignId]
    );

    if (campRes.rows.length === 0) {
      throw new Error('Campaña no encontrada.');
    }

    if (campRes.rows[0].campaign_type !== 'perpetual') {
      throw new Error('Las campañas manuales no gestionan cuentas.');
    }

    const updateRes = await client.query(
      `UPDATE campaign_accounts 
       SET removed_at = NOW() 
       WHERE id = $1 AND campaign_id = $2 AND removed_at IS NULL 
       RETURNING id`,
      [accountId, campaignId]
    );

    if (updateRes.rows.length !== 1) {
      throw new Error('La cuenta no pertenece a esta campaña, o ya estaba retirada.');
    }

    return { success: true };
  });
}

export async function updateCampaignDuration(campaignId: string, postActiveLifetimeHours: number) {
  if (postActiveLifetimeHours < 1 || postActiveLifetimeHours > 720 || !Number.isInteger(postActiveLifetimeHours)) {
    throw new Error('La duración de los posts debe ser un número entero entre 1 y 720 horas.');
  }

  return await withTransaction(async (client) => {
    const campRes = await client.query<{ campaign_type: string }>(
      `SELECT campaign_type FROM campaigns WHERE id = $1 FOR UPDATE`,
      [campaignId]
    );

    if (campRes.rows.length === 0) {
      throw new Error('Campaña no encontrada.');
    }

    if (campRes.rows[0].campaign_type !== 'perpetual') {
      throw new Error('Solo se puede cambiar la duración automática de posts en campañas perpetuas.');
    }

    await client.query(
      `UPDATE campaigns SET post_active_lifetime_hours = $1, updated_at = NOW() WHERE id = $2`,
      [postActiveLifetimeHours, campaignId]
    );

    // Recalcular expiración
    await client.query(
      `UPDATE campaign_posts 
       SET expires_at = COALESCE(posted_at, created_at) + interval '1 hour' * $1
       WHERE campaign_id = $2 AND retired_at IS NULL`,
      [postActiveLifetimeHours, campaignId]
    );

    // Retirar instantáneamente los que quedaron expirados
    const retired = await client.query<{ id: string }>(
      `UPDATE campaign_posts 
       SET retired_at = NOW() 
       WHERE campaign_id = $1 AND retired_at IS NULL AND expires_at <= NOW()`,
      [campaignId]
    );
    if (retired.rows.length) {
      const ids = retired.rows.map((post) => post.id);
      await client.query(`UPDATE suggestions SET status='withdrawn', withdrawn_at=NOW() WHERE campaign_post_id=ANY($1) AND status='available'`, [ids]);
      await client.query(`UPDATE generation_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL, updated_at=NOW() WHERE campaign_post_id=ANY($1) AND status IN ('pending','processing')`, [ids]);
      await client.query(`UPDATE generation_cycles SET status='cancelled', finished_at=NOW() WHERE campaign_post_id=ANY($1) AND status IN ('pending','processing')`, [ids]);
    }

    return { success: true };
  });
}
