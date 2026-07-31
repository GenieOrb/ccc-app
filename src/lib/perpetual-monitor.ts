import 'server-only';
import { queryDb, withTransaction } from './db';
import { checkCampaignSafety } from './openai';
import { resolveXUsername, fetchNewXPostsForAccount } from './x-api';
import { randomUUID } from 'crypto';
import { generateDeterministicSlotPlans } from './planner';
import { getAiModel } from './ai/models';

export interface PerpetualMonitorSummary {
  accountsProcessed: number;
  postsDetected: number;
  postsImported: number;
  postsRejected: number;
  postsExpired: number;
  cyclesCreated: number;
  errors: string[];
}

export interface PerpetualMonitorOptions {
  timeBudgetMs?: number;
  campaignId?: string;
  accountIds?: string[];
}

interface AccountRow {
  id: string;
  campaign_id: string;
  username: string;
  x_user_id: string | null;
  monitoring_started_at: Date;
  initial_sync_pending: boolean;
  last_seen_post_id: string | null;
  direction: string | null;
  post_active_lifetime_hours: number | null;
  model_key: string;
  brand_variants: unknown;
}

type CheckpointPhase = 'monitor' | 'account' | 'x_timeline' | 'post_selection' | 'safety' | 'db_import' | 'cycle' | 'jobs' | 'cursor' | 'completed' | 'failed';
type CheckpointDetails = Record<string, boolean | number>;

function getSafeDatabaseErrorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? code.toUpperCase()
    : undefined;
}

class PollLeaseLostError extends Error {}

function assertPollLeaseMutation(rows: unknown[]): void {
  if (rows.length === 0) throw new PollLeaseLostError();
}

async function renewPollLease(accountId: string, runId: string, leaseDurationMs: number): Promise<void> {
  const renewed = await queryDb<{ id: string }>(
    `UPDATE campaign_accounts
     SET poll_lease_expires_at = NOW() + ($3::BIGINT * INTERVAL '1 millisecond')
     WHERE id = $1
       AND poll_lease_owner = $2::UUID
       AND poll_lease_expires_at > NOW()
     RETURNING id`,
    [accountId, runId, leaseDurationMs],
  );
  assertPollLeaseMutation(renewed);
}

// The audit payload intentionally accepts no post content, URLs, provider
// responses, or raw errors. Checkpoint persistence is always outside imports.
async function writeCheckpoint(
  account: Pick<AccountRow, 'id' | 'campaign_id'>,
  runId: string,
  phase: CheckpointPhase,
  severity: 'info' | 'warning' | 'error' = 'info',
  details: CheckpointDetails = {},
  errorCode?: string,
  errorMessage?: string,
) {
  try {
    await queryDb(
      `INSERT INTO perpetual_sync_checkpoints
       (campaign_id, campaign_account_id, run_id, phase, severity, details, error_code, error_message)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [account.campaign_id, account.id, runId, phase, severity, JSON.stringify(details), errorCode ?? null, errorMessage ?? null],
    );
  } catch {
    // Do not fail monitoring during a rolling migration or an audit DB outage.
  }
}

export async function processPerpetualCampaigns(options: number | PerpetualMonitorOptions = 20000): Promise<PerpetualMonitorSummary> {
  const { timeBudgetMs = 20000, campaignId, accountIds } = typeof options === 'number'
    ? { timeBudgetMs: options }
    : options;
  const summary: PerpetualMonitorSummary = {
    accountsProcessed: 0,
    postsDetected: 0,
    postsImported: 0,
    postsRejected: 0,
    postsExpired: 0,
    cyclesCreated: 0,
    errors: [],
  };
  const runId = randomUUID();

  const startTime = Date.now();
  const deadline = startTime + Math.max(0, timeBudgetMs);
  const durableWriteReserveMs = Math.min(1_000, Math.max(0, Math.floor(timeBudgetMs / 10)));
  // This outlives the serverless monitor budget with write slack, while a
  // crashed invocation can still be recovered after a bounded delay.
  const pollLeaseDurationMs = Math.max(30_000, timeBudgetMs + 15_000);
  const ioDeadline = deadline - durableWriteReserveMs;
  const hasTimeRemaining = () => Date.now() < deadline;
  const hasIoTimeRemaining = () => Date.now() < ioDeadline;
  const boundedIoTimeoutMs = (maximumMs: number) => Math.max(1, Math.min(maximumMs, Math.floor(ioDeadline - Date.now())));

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

  if (!hasTimeRemaining()) return summary;

  // 2. Seleccionar cuentas activas para hacer polling.
  const scopedAccountIds = accountIds?.filter(Boolean) ?? [];
  if (accountIds && scopedAccountIds.length === 0) return summary;
  const accountsRows = await queryDb<AccountRow>(`
    SELECT ca.id, ca.campaign_id, ca.username, ca.x_user_id, ca.monitoring_started_at, ca.initial_sync_pending, ca.last_seen_post_id, c.direction, c.post_active_lifetime_hours, c.model_key, c.brand_variants
    FROM campaign_accounts ca
    JOIN campaigns c ON ca.campaign_id = c.id
    WHERE ca.removed_at IS NULL AND c.is_active = true AND c.campaign_type = 'perpetual'
      AND ($1::UUID IS NULL OR ca.campaign_id = $1)
      AND (cardinality($2::UUID[]) = 0 OR ca.id = ANY($2::UUID[]))
    ORDER BY ca.initial_sync_pending DESC, ca.last_polled_at ASC NULLS FIRST
    LIMIT 10
  `, [campaignId ?? null, scopedAccountIds]);

  for (const account of accountsRows) {
    if (!hasTimeRemaining()) {
      break;
    }

    let phase: CheckpointPhase = 'monitor';
    let leaseClaimed = false;
    try {
      // Claim before any network work so concurrent cron/scoped invocations
      // cannot independently import the same account.
      const claimed = await queryDb<{ id: string }>(
        `UPDATE campaign_accounts
         SET poll_lease_owner = $2::UUID,
             poll_lease_expires_at = NOW() + ($3::BIGINT * INTERVAL '1 millisecond')
         WHERE id = $1
           AND (poll_lease_owner IS NULL OR poll_lease_expires_at IS NULL OR poll_lease_expires_at <= NOW())
         RETURNING id`,
        [account.id, runId, pollLeaseDurationMs],
      );
      if (claimed.length === 0) continue;
      leaseClaimed = true;
      summary.accountsProcessed++;
      await writeCheckpoint(account, runId, 'monitor', 'info', { scoped: Boolean(campaignId || accountIds?.length) });
      phase = 'account';
      await writeCheckpoint(account, runId, phase);

      let xUserId = account.x_user_id;
      if (!xUserId) {
        if (!hasIoTimeRemaining()) break;
        await renewPollLease(account.id, runId, pollLeaseDurationMs);
        xUserId = await resolveXUsername(
          account.username,
          { campaignId: account.campaign_id, campaignAccountId: account.id },
          boundedIoTimeoutMs(10_000),
        );
        assertPollLeaseMutation(await queryDb<{ id: string }>(
          `UPDATE campaign_accounts
           SET x_user_id = $1
           WHERE id = $2
             AND poll_lease_owner = $3::UUID
             AND poll_lease_expires_at > NOW()
           RETURNING id`,
          [xUserId, account.id, runId],
        ));
      }

      // The durable flag, not the incidental cursor value, defines whether this
      // account is still performing its initial recovery. A cursor can
      // have been advanced by a partial prior attempt, while the flag remains
      // pending until a whole polling pass succeeds.
      if (!hasIoTimeRemaining()) break;
      const isInitialRecovery = account.initial_sync_pending;
      phase = 'x_timeline';
      await writeCheckpoint(account, runId, phase);
      await renewPollLease(account.id, runId, pollLeaseDurationMs);
      const timelineResult = await fetchNewXPostsForAccount(
        xUserId,
        isInitialRecovery ? null : account.last_seen_post_id,
        { campaignId: account.campaign_id, campaignAccountId: account.id },
        boundedIoTimeoutMs(15_000),
        undefined,
        undefined,
        isInitialRecovery,
      );
      // Keep the durable cursor unchanged when X could not finish the bounded
      // scan. Retrying from that cursor is safe because inserts are idempotent.
      if (!Array.isArray(timelineResult) && !timelineResult.complete) {
        summary.errors.push(`Escaneo incompleto de X para cuenta ${account.username}; se reintentarÃ¡ desde el cursor actual.`);
        continue;
      }
      const fetchedPosts = Array.isArray(timelineResult) ? timelineResult : timelineResult.posts;
      // Initial recovery is bounded to X's first page and imports only its
      // newest original that is still within the campaign lifetime.
      const initialEligiblePosts = isInitialRecovery
        ? fetchedPosts.filter((post) => {
            if (!account.post_active_lifetime_hours || !post.postedAt) return true;
            const postedAt = new Date(post.postedAt);
            return !Number.isNaN(postedAt.getTime()) && postedAt.getTime() + account.post_active_lifetime_hours * 3600 * 1000 > Date.now();
          })
        : fetchedPosts;
      const newPosts = isInitialRecovery
        ? initialEligiblePosts.slice(-1)
        : initialEligiblePosts;
      phase = 'post_selection';
      await writeCheckpoint(account, runId, phase, 'info', { fetched: fetchedPosts.length, selected: newPosts.length, initialRecovery: isInitialRecovery });

      if (isInitialRecovery && newPosts.length === 0) {
        const highestExpiredPostId = fetchedPosts.length > 0
          ? fetchedPosts.reduce((latest, post) => BigInt(post.postId) > BigInt(latest.postId) ? post : latest).postId
          : null;
        assertPollLeaseMutation(await queryDb<{ id: string }>(
          `UPDATE campaign_accounts
           SET last_seen_post_id = CASE
                 WHEN $1::TEXT IS NOT NULL
                  AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
                 THEN $1::TEXT
                 ELSE last_seen_post_id
               END,
               initial_sync_pending = false
           WHERE id = $2 AND initial_sync_pending = true
             AND poll_lease_owner = $3::UUID
             AND poll_lease_expires_at > NOW()
           RETURNING id`,
          [highestExpiredPostId, account.id, runId],
        ));
      }

      if (newPosts.length > 0) {
        summary.postsDetected += newPosts.length;
        let highestPostId = account.last_seen_post_id;
        let completedInitialRecovery = isInitialRecovery;

        for (const post of newPosts) {
          if (!hasIoTimeRemaining()) {
            completedInitialRecovery = false;
            break;
          }
          // Once safety has completed, this transaction is the durable
          // consequence of that decision. Do not strand a reviewed post just
          // because the deadline passed while the safety check was in flight.
          phase = 'safety';
          await writeCheckpoint(account, runId, phase);
          await renewPollLease(account.id, runId, pollLeaseDurationMs);
          const safetyResult = await checkCampaignSafety(
            [post.textContent],
            account.direction || undefined,
            { campaignId: account.campaign_id, campaignAccountId: account.id },
            boundedIoTimeoutMs(60_000),
          );
          if (!safetyResult.allowed) {
            summary.postsRejected++;
            highestPostId = post.postId;
            assertPollLeaseMutation(await queryDb<{ id: string }>(
              isInitialRecovery
                ? `UPDATE campaign_accounts
                   SET last_seen_post_id = CASE
                         WHEN last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC) THEN $1::TEXT
                         ELSE last_seen_post_id
                        END
                   WHERE id = $2 AND initial_sync_pending = true
                     AND poll_lease_owner = $3::UUID
                     AND poll_lease_expires_at > NOW()
                   RETURNING id`
                : `UPDATE campaign_accounts SET last_seen_post_id = $1::TEXT
                   WHERE id = $2
                     AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
                     AND poll_lease_owner = $3::UUID
                     AND poll_lease_expires_at > NOW()
                   RETURNING id`,
              [highestPostId, account.id, runId],
            ));
            continue;
          }

          phase = 'db_import';
          await writeCheckpoint(account, runId, phase);
          await renewPollLease(account.id, runId, pollLeaseDurationMs);
          const durableResult = await withTransaction(async (client): Promise<{ imported: boolean; cycleCreated: boolean }> => {
            const lockRes = await client.query<{ initial_sync_pending: boolean; last_seen_post_id: string | null; removed_at: Date | null; is_active: boolean }>(
              `SELECT ca.initial_sync_pending, ca.last_seen_post_id, ca.removed_at, c.is_active
               FROM campaign_accounts ca
               JOIN campaigns c ON ca.campaign_id = c.id
               WHERE ca.id = $1
                 AND ca.poll_lease_owner = $2::UUID
                 AND ca.poll_lease_expires_at > NOW()
               FOR UPDATE`,
              [account.id, runId]
            );

            const currentData = lockRes.rows[0];
            if (!currentData) throw new PollLeaseLostError();
            if (currentData.removed_at !== null || !currentData.is_active) {
              return { imported: false, cycleCreated: false }; // Account removed or campaign inactive, skip
            }
            if (isInitialRecovery && !currentData.initial_sync_pending) {
              return { imported: false, cycleCreated: false }; // Another monitor completed recovery while X was being queried.
            }
            const recoveringUnderLock = isInitialRecovery && currentData.initial_sync_pending;
            if (!recoveringUnderLock && currentData.last_seen_post_id && BigInt(post.postId) <= BigInt(currentData.last_seen_post_id)) {
              return { imported: false, cycleCreated: false }; // Post ya fue procesado o el cursor está por delante
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
                const cursorRes = await client.query(
                  recoveringUnderLock
                    ? `UPDATE campaign_accounts
                       SET last_seen_post_id = CASE
                             WHEN last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC) THEN $1::TEXT
                             ELSE last_seen_post_id
                            END
                       WHERE id = $2
                         AND poll_lease_owner = $3::UUID
                         AND poll_lease_expires_at > NOW()
                       RETURNING id`
                    : `UPDATE campaign_accounts SET last_seen_post_id = $1::TEXT
                       WHERE id = $2
                         AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
                         AND poll_lease_owner = $3::UUID
                         AND poll_lease_expires_at > NOW()
                       RETURNING id`,
                  [highestPostId, account.id, runId]
                );
                if ((cursorRes.rowCount || 0) === 0) throw new PollLeaseLostError();
                return { imported: false, cycleCreated: false };
              }

              const insertRes = await client.query<{ id: string }>(`
                INSERT INTO campaign_posts (
                  campaign_id, campaign_account_id, x_post_id, input_url, canonical_url,
                  author_name, author_username, text_content, language, conversation_id,
                  posted_at, accessible_context, expires_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (campaign_account_id, x_post_id) WHERE campaign_account_id IS NOT NULL DO NOTHING
                RETURNING id
              `, [
                account.campaign_id, account.id, post.postId, post.inputUrl, post.canonicalUrl,
                post.authorName, post.authorUsername, post.textContent, post.language, post.conversationId,
                publishedAt, post.accessibleContext, expiresAt
              ]);

              if ((insertRes.rowCount || 0) > 0) {
                const newCampaignPostId = insertRes.rows[0].id;
                const model = getAiModel(account.model_key);
                if (!model) throw new Error('La campaÃ±a no tiene un modelo vÃ¡lido para generar el snapshot.');

                const cycleId = randomUUID();
                await client.query(`
                  INSERT INTO generation_cycles (id, campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, model_name)
                  VALUES ($1, $2, $3, 'initial', 30, 'pending', $4, $5)
                `, [cycleId, account.campaign_id, newCampaignPostId, model.key, model.apiModel]);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                for (const plan of generateDeterministicSlotPlans([newCampaignPostId], 30, (account.brand_variants as any) || [])) {
                  await client.query(`INSERT INTO generation_jobs (cycle_id,campaign_id,campaign_post_id,slot_index,slot_plan,length_mode,emoji_policy,rhetorical_form,texture,status,model_name,prompt_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,1)`, [cycleId, account.campaign_id, newCampaignPostId, plan.slotIndex, JSON.stringify(plan), plan.lengthMode, plan.emojiPolicy, plan.rhetoricalForm, plan.texture, model.apiModel]);
                }
                const cursorRes = await client.query(
                  recoveringUnderLock
                    ? `UPDATE campaign_accounts
                       SET last_seen_post_id = CASE
                             WHEN last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC) THEN $1::TEXT
                             ELSE last_seen_post_id
                            END
                       WHERE id = $2
                         AND poll_lease_owner = $3::UUID
                         AND poll_lease_expires_at > NOW()
                       RETURNING id`
                    : `UPDATE campaign_accounts SET last_seen_post_id = $1::TEXT
                       WHERE id = $2
                         AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
                         AND poll_lease_owner = $3::UUID
                         AND poll_lease_expires_at > NOW()
                       RETURNING id`,
                  [post.postId, account.id, runId],
                );
                if ((cursorRes.rowCount || 0) === 0) throw new PollLeaseLostError();
                return { imported: true, cycleCreated: true };
              }
            }

            highestPostId = post.postId;
            const cursorRes = await client.query(
              recoveringUnderLock
                ? `UPDATE campaign_accounts
                   SET last_seen_post_id = CASE
                         WHEN last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC) THEN $1::TEXT
                         ELSE last_seen_post_id
                        END
                   WHERE id = $2
                     AND poll_lease_owner = $3::UUID
                     AND poll_lease_expires_at > NOW()
                   RETURNING id`
                : `UPDATE campaign_accounts SET last_seen_post_id = $1::TEXT
                   WHERE id = $2
                     AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
                     AND poll_lease_owner = $3::UUID
                     AND poll_lease_expires_at > NOW()
                   RETURNING id`,
              [highestPostId, account.id, runId],
            );
            if ((cursorRes.rowCount || 0) === 0) throw new PollLeaseLostError();
            return { imported: false, cycleCreated: false };
          });
          // Increment only after the fenced transaction commits. A lease-loss
          // rollback must never be reported as a durable import or cycle.
          if (durableResult.imported) {
            summary.postsImported++;
            highestPostId = post.postId;
          }
          if (durableResult.cycleCreated) summary.cyclesCreated++;
          // These occur after the import transaction has committed, so audit
          // writes cannot contend with its fenced account lock.
          await writeCheckpoint(account, runId, 'cycle', 'info', { created: durableResult.cycleCreated });
          await writeCheckpoint(account, runId, 'jobs', 'info', { imported: durableResult.imported });
          phase = 'cursor';
          await writeCheckpoint(account, runId, phase);
        }

        // Partial initial batches are retried from the beginning. Only after
        // every fetched eligible original has been durably handled may the
        // independent completion flag be cleared.
        if (isInitialRecovery && completedInitialRecovery) {
          assertPollLeaseMutation(await queryDb<{ id: string }>(
            `UPDATE campaign_accounts
             SET last_seen_post_id = CASE
                   WHEN $1::TEXT IS NOT NULL
                    AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
                   THEN $1::TEXT
                   ELSE last_seen_post_id
                 END,
                 initial_sync_pending = false
             WHERE id = $2 AND initial_sync_pending = true
               AND poll_lease_owner = $3::UUID
               AND poll_lease_expires_at > NOW()
             RETURNING id`,
            [highestPostId, account.id, runId],
          ));
        }
      }

      assertPollLeaseMutation(await queryDb<{ id: string }>(
        `UPDATE campaign_accounts
         SET last_polled_at = NOW()
         WHERE id = $1
           AND poll_lease_owner = $2::UUID
           AND poll_lease_expires_at > NOW()
         RETURNING id`,
        [account.id, runId],
      ));
      await writeCheckpoint(account, runId, 'completed', 'info', { imported: summary.postsImported > 0 });

    } catch (error: unknown) {
      if (error instanceof PollLeaseLostError) continue;
      const databaseErrorCode = getSafeDatabaseErrorCode(error);
      summary.errors.push(`Fallo parcial cuenta ${account.username}: fase ${phase}${databaseErrorCode ? ` (${databaseErrorCode})` : ''}.`);
      await writeCheckpoint(
        account,
        runId,
        'failed',
        'error',
        {},
        `MONITOR_${phase.toUpperCase()}_FAILED${databaseErrorCode ? `_${databaseErrorCode}` : ''}`,
        `Error de monitor en la fase ${phase}.`,
      );
      try {
        await queryDb(
          `UPDATE campaign_accounts
           SET last_polled_at = NOW()
           WHERE id = $1
             AND poll_lease_owner = $2::UUID
             AND poll_lease_expires_at > NOW()
           RETURNING id`,
          [account.id, runId],
        );
      } catch { /* Ignore secondary fail */ }
    } finally {
      if (leaseClaimed) {
        try {
          await queryDb(
            `UPDATE campaign_accounts
             SET poll_lease_owner = NULL, poll_lease_expires_at = NULL
             WHERE id = $1 AND poll_lease_owner = $2::UUID`,
            [account.id, runId],
          );
        } catch {
          // Expiry is the recovery path if this release write fails.
        }
      }
    }
  }

  return summary;
}
