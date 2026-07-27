import 'server-only';
import { queryDb, withTransaction } from './db';
import { checkCampaignSafety } from './openai';
import { resolveXUsername, fetchNewXPostsForAccount } from './x-api';
import { randomUUID } from 'crypto';
import { generateDeterministicSlotPlans } from './planner';
import { getAiModel } from './ai/models';

interface PerpetualMonitorSummary {
  accountsProcessed: number;
  postsDetected: number;
  postsImported: number;
  postsRejected: number;
  postsExpired: number;
  cyclesCreated: number;
  errors: string[];
}

interface AccountRow {
  id: string;
  campaign_id: string;
  username: string;
  x_user_id: string | null;
  monitoring_started_at: Date;
  last_seen_post_id: string | null;
  direction: string | null;
  post_active_lifetime_hours: number | null;
  model_key: string;
}

export async function processPerpetualCampaigns(timeBudgetMs: number = 20000): Promise<PerpetualMonitorSummary> {
  const summary: PerpetualMonitorSummary = {
    accountsProcessed: 0,
    postsDetected: 0,
    postsImported: 0,
    postsRejected: 0,
    postsExpired: 0,
    cyclesCreated: 0,
    errors: [],
  };

  const startTime = Date.now();

  // 1. Expirar posts antiguos (que ya superaron su expires_at y no están retirados)
  try {
    await withTransaction(async (client) => {
      // Marcar como retirados
      const retiredRes = await client.query<{ id: string }>(`
        UPDATE campaign_posts
        SET retired_at = NOW()
        WHERE expires_at <= NOW() AND retired_at IS NULL
        RETURNING id
      `);

      summary.postsExpired += retiredRes.rowCount || 0;

      if ((retiredRes.rowCount || 0) > 0) {
        const retiredPostIds = retiredRes.rows.map((r) => r.id);

        // Retirar sugerencias disponibles
        await client.query(`
          UPDATE suggestions
          SET status = 'withdrawn', withdrawn_at = NOW()
          WHERE status = 'available' AND campaign_post_id = ANY($1)
        `, [retiredPostIds]);

        // Cancelar jobs pendientes/procesando
        await client.query(`
          UPDATE generation_jobs
          SET status = 'cancelled', updated_at = NOW()
          WHERE status IN ('pending', 'processing') AND campaign_post_id = ANY($1)
        `, [retiredPostIds]);

        // Expiration is terminal cancellation, never successful completion.
        await client.query(`
          UPDATE generation_cycles
          SET status = 'cancelled', finished_at = NOW()
          WHERE status IN ('pending', 'processing') AND campaign_post_id = ANY($1)
        `, [retiredPostIds]);
      }
    });
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    summary.errors.push(`Error al expirar posts: ${errorMsg}`);
  }

  // 2. Seleccionar cuentas activas para hacer polling.
  const accountsRows = await queryDb<AccountRow>(`
    SELECT ca.id, ca.campaign_id, ca.username, ca.x_user_id, ca.monitoring_started_at, ca.last_seen_post_id, c.direction, c.post_active_lifetime_hours, c.model_key
    FROM campaign_accounts ca
    JOIN campaigns c ON ca.campaign_id = c.id
    WHERE ca.removed_at IS NULL AND c.is_active = true AND c.campaign_type = 'perpetual'
    ORDER BY ca.last_polled_at ASC NULLS FIRST
    LIMIT 10
  `);

  for (const account of accountsRows) {
    if (Date.now() - startTime >= timeBudgetMs) {
      break;
    }

    try {
      summary.accountsProcessed++;

      let xUserId = account.x_user_id;
      if (!xUserId) {
        xUserId = await resolveXUsername(account.username);
        await queryDb('UPDATE campaign_accounts SET x_user_id = $1 WHERE id = $2', [xUserId, account.id]);
      }

      const fetchedPosts = await fetchNewXPostsForAccount(xUserId, account.last_seen_post_id);
      // Initial recovery deliberately imports only the most recent eligible post.
      const newPosts = !account.last_seen_post_id && fetchedPosts.length > 1 ? [fetchedPosts.reduce((latest, post) => BigInt(post.postId) > BigInt(latest.postId) ? post : latest)] : fetchedPosts;

      if (newPosts.length > 0) {
        summary.postsDetected += newPosts.length;
        let highestPostId = account.last_seen_post_id;

        for (const post of newPosts) {
          const safetyResult = await checkCampaignSafety([post.textContent], account.direction || undefined);
          if (!safetyResult.allowed) {
            summary.postsRejected++;
            highestPostId = post.postId;
            await queryDb('UPDATE campaign_accounts SET last_seen_post_id = $1 WHERE id = $2 AND (last_seen_post_id IS NULL OR CAST($1 AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))', [highestPostId, account.id]);
            continue;
          }

          await withTransaction(async (client) => {
            const lockRes = await client.query<{ last_seen_post_id: string | null; removed_at: Date | null; is_active: boolean }>(
              `SELECT ca.last_seen_post_id, ca.removed_at, c.is_active
               FROM campaign_accounts ca
               JOIN campaigns c ON ca.campaign_id = c.id
               WHERE ca.id = $1 FOR UPDATE`,
              [account.id]
            );

            const currentData = lockRes.rows[0];
            if (!currentData || currentData.removed_at !== null || !currentData.is_active) {
              return; // Account removed or campaign inactive, skip
            }
            if (currentData.last_seen_post_id && BigInt(post.postId) <= BigInt(currentData.last_seen_post_id)) {
              return; // Post ya fue procesado o el cursor está por delante
            }
            // lockRes is intentionally used for concurrency control (locking)

            const existingPost = await client.query<{ id: string }>('SELECT id FROM campaign_posts WHERE campaign_account_id = $1 AND x_post_id = $2', [account.id, post.postId]);

            if (existingPost.rowCount === 0) {
              const publishedAt = post.postedAt ? new Date(post.postedAt) : new Date();
              const expiresAt = account.post_active_lifetime_hours
                ? new Date(publishedAt.getTime() + account.post_active_lifetime_hours * 3600 * 1000)
                : null;

              // Recovery deliberately reaches backwards for the latest eligible
              // post, but an expired post must never create inventory or jobs.
              if (expiresAt && expiresAt <= new Date()) {
                highestPostId = post.postId;
                await client.query(
                  'UPDATE campaign_accounts SET last_seen_post_id = $1 WHERE id = $2 AND (last_seen_post_id IS NULL OR CAST($1 AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))',
                  [highestPostId, account.id]
                );
                return;
              }

              const insertRes = await client.query<{ id: string }>(`
                INSERT INTO campaign_posts (
                  campaign_id, campaign_account_id, x_post_id, input_url, canonical_url,
                  author_name, author_username, text_content, language, conversation_id,
                  posted_at, accessible_context, expires_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (campaign_account_id, x_post_id) DO NOTHING
                RETURNING id
              `, [
                account.campaign_id, account.id, post.postId, post.inputUrl, post.canonicalUrl,
                post.authorName, post.authorUsername, post.textContent, post.language, post.conversationId,
                publishedAt, post.accessibleContext, expiresAt
              ]);

              if ((insertRes.rowCount || 0) > 0) {
                const newCampaignPostId = insertRes.rows[0].id;
                summary.postsImported++;
                const model = getAiModel(account.model_key);
                if (!model) throw new Error('La campaÃ±a no tiene un modelo vÃ¡lido para generar el snapshot.');

                const cycleId = randomUUID();
                await client.query(`
                  INSERT INTO generation_cycles (id, campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, model_name)
                  VALUES ($1, $2, $3, 'initial', 30, 'pending', $4, $5)
                `, [cycleId, account.campaign_id, newCampaignPostId, model.key, model.apiModel]);
                for (const plan of generateDeterministicSlotPlans([newCampaignPostId], 30)) {
                  await client.query(`INSERT INTO generation_jobs (cycle_id,campaign_id,campaign_post_id,slot_index,slot_plan,length_mode,emoji_policy,rhetorical_form,texture,status,model_name,prompt_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,1)`, [cycleId, account.campaign_id, newCampaignPostId, plan.slotIndex, JSON.stringify(plan), plan.lengthMode, plan.emojiPolicy, plan.rhetoricalForm, plan.texture, model.apiModel]);
                }
                summary.cyclesCreated++;
              }
            }

            highestPostId = post.postId;
            await client.query('UPDATE campaign_accounts SET last_seen_post_id = $1 WHERE id = $2 AND (last_seen_post_id IS NULL OR CAST($1 AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))', [highestPostId, account.id]);
          });
        }
      }

      await queryDb('UPDATE campaign_accounts SET last_polled_at = NOW() WHERE id = $1', [account.id]);

    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      summary.errors.push(`Fallo parcial cuenta ${account.username}: ${errorMsg}`);
      try { await queryDb('UPDATE campaign_accounts SET last_polled_at = NOW() WHERE id = $1', [account.id]); } catch { /* Ignore secondary fail */ }
    }
  }

  return summary;
}
