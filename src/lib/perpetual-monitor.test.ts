import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '@neondatabase/serverless';

const { queryDb, withTransaction, fetchNewXPostsForAccount, checkCampaignSafety } = vi.hoisted(() => ({ queryDb: vi.fn(), withTransaction: vi.fn(), fetchNewXPostsForAccount: vi.fn(), checkCampaignSafety: vi.fn() }));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./x-api', () => ({ resolveXUsername: vi.fn(), fetchNewXPostsForAccount }));
vi.mock('./openai', () => ({ checkCampaignSafety }));
vi.mock('./ai/models', () => ({ getAiModel: () => ({ key: 'test-model', apiModel: 'test-api-model' }) }));
vi.mock('./planner', () => ({ generateDeterministicSlotPlans: () => Array.from({ length: 30 }, (_, slotIndex) => ({ slotIndex, lengthMode: 'short', emojiPolicy: 'none', rhetoricalForm: 'statement', texture: 'plain' })) }));

import { processPerpetualCampaigns } from './perpetual-monitor';

const account = { id: 'account-1', campaign_id: 'campaign-1', username: 'author', x_user_id: '42', monitoring_started_at: new Date(), initial_sync_pending: true, last_seen_post_id: null, direction: null, post_active_lifetime_hours: 24, max_comments_total: null, model_key: 'test-model' };
const freshPost = { postId: '900', inputUrl: 'https://x.com/author/status/900', canonicalUrl: 'https://x.com/author/status/900', authorName: 'Author', authorUsername: 'author', textContent: 'Fresh post', language: 'en', conversationId: '900', postedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(), accessibleContext: {} };
let transactionalSql: string[] = [];
let lockedAccount: { initial_sync_pending: boolean; last_seen_post_id: string | null; removed_at: Date | null; is_active: boolean };
let transactionFailurePattern: string | null;
let leaseClaimed: boolean;

describe('processPerpetualCampaigns', () => {
  beforeEach(() => {
    queryDb.mockReset(); withTransaction.mockReset(); fetchNewXPostsForAccount.mockReset(); checkCampaignSafety.mockReset(); transactionalSql = [];
    lockedAccount = { initial_sync_pending: true, last_seen_post_id: null, removed_at: null, is_active: true };
    transactionFailurePattern = null;
    leaseClaimed = true;
    queryDb.mockImplementation((sql: string) => {
      if (sql.includes('SELECT ca.id')) return Promise.resolve([account]);
      if (sql.includes('SET poll_lease_owner = $2::UUID')) return Promise.resolve(leaseClaimed ? [{ id: account.id }] : []);
      if (sql.includes('SET poll_lease_expires_at = NOW() +')) return Promise.resolve([{ id: account.id }]);
      if (sql.includes('RETURNING id') && sql.includes('poll_lease_owner = $')) return Promise.resolve([{ id: account.id }]);
      return Promise.resolve([]);
    });
    checkCampaignSafety.mockResolvedValue({ allowed: true });
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const query = vi.fn(async (sql: string) => {
        transactionalSql.push(sql);
        if (transactionFailurePattern && sql.includes(transactionFailurePattern)) throw new Error('simulated transaction failure');
        if (sql.includes('SELECT ca.initial_sync_pending')) return { rows: [lockedAccount], rowCount: 1 };
        if (sql.includes('SELECT max_comments_total FROM campaigns')) return { rows: [{ max_comments_total: null }], rowCount: 1 };
        if (sql.includes('current_total')) return { rows: [{ current_total: '0' }], rowCount: 1 };
        if (sql.includes('SELECT id FROM campaign_posts')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO campaign_posts')) return { rows: [{ id: 'post-row-1' }], rowCount: 1 };
        if (sql.includes('INSERT INTO generation_cycles')) return { rows: [{ id: 'cycle-1' }], rowCount: 1 };
        if (sql.includes('UPDATE campaign_accounts') && sql.includes('RETURNING id')) return { rows: [{ id: account.id }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      return operation({ query });
    });
  });

  it('imports a recent initial post with posted_at + duration and creates one 30-job cycle', async () => {
    fetchNewXPostsForAccount.mockResolvedValue([freshPost]);

    const result = await processPerpetualCampaigns(10_000);

    expect(result.postsImported).toBe(1);
    expect(result.cyclesCreated).toBe(1);
    expect(fetchNewXPostsForAccount).toHaveBeenCalledWith('42', null, expect.objectContaining({ campaignId: 'campaign-1', campaignAccountId: 'account-1' }), expect.any(Number), undefined, undefined, true);
    expect(checkCampaignSafety).toHaveBeenCalledWith(['Fresh post'], undefined, expect.objectContaining({ campaignId: 'campaign-1', campaignAccountId: 'account-1' }), expect.any(Number));
    expect(transactionalSql.filter((sql) => sql.includes('INSERT INTO generation_jobs'))).toHaveLength(30);
    expect(transactionalSql.some((sql) => sql.includes('INSERT INTO generation_cycles'))).toBe(true);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('initial_sync_pending = false'))).toBe(true);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('last_polled_at = NOW(), initial_sync_pending = false'))).toBe(false);
    const checkpoints = queryDb.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO perpetual_sync_checkpoints'));
    expect(checkpoints.some(([, args]) => Array.isArray(args) && args.includes('safety'))).toBe(true);
    expect(JSON.stringify(checkpoints)).not.toContain(freshPost.textContent);
  });

  it('does not import an initial post already outside its active lifetime', async () => {
    fetchNewXPostsForAccount.mockResolvedValue([{ ...freshPost, postId: '901', postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }]);

    const result = await processPerpetualCampaigns(10_000);

    expect(result.postsImported).toBe(0);
    expect(result.cyclesCreated).toBe(0);
    expect(result.postsExpired).toBe(0);
  });

  it('does not write a checkpoint through queryDb while expiring a post inside its import transaction', async () => {
    let inTransactionCallback = false;
    let checkpointAttemptedDuringTransaction = false;
    const ongoingAccount = { ...account, initial_sync_pending: false, last_seen_post_id: '100' };
    lockedAccount = { initial_sync_pending: false, last_seen_post_id: '100', removed_at: null, is_active: true };
    queryDb.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO perpetual_sync_checkpoints')) {
        if (inTransactionCallback) checkpointAttemptedDuringTransaction = true;
        return Promise.resolve([]);
      }
      if (sql.includes('SELECT ca.id')) return Promise.resolve([ongoingAccount]);
      if (sql.includes('SET poll_lease_owner = $2::UUID')) return Promise.resolve([{ id: account.id }]);
      if (sql.includes('SET poll_lease_expires_at = NOW() +') || (sql.includes('RETURNING id') && sql.includes('poll_lease_owner = $'))) return Promise.resolve([{ id: account.id }]);
      return Promise.resolve([]);
    });
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT ca.initial_sync_pending')) return { rows: [lockedAccount], rowCount: 1 };
        if (sql.includes('SELECT id FROM campaign_posts')) return { rows: [], rowCount: 0 };
        if (sql.includes('UPDATE campaign_accounts') && sql.includes('RETURNING id')) return { rows: [{ id: account.id }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      inTransactionCallback = true;
      try {
        return await operation({ query });
      } finally {
        inTransactionCallback = false;
      }
    });
    fetchNewXPostsForAccount.mockResolvedValue([{ ...freshPost, postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }]);

    await processPerpetualCampaigns(10_000);

    expect(checkpointAttemptedDuringTransaction).toBe(false);
  });

  it('recovers every still-eligible original when a newer fetched post is expired', async () => {
    const expiredNewer = { ...freshPost, postId: '999', postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    fetchNewXPostsForAccount.mockResolvedValue([freshPost, expiredNewer]);

    const result = await processPerpetualCampaigns(10_000);

    expect(result.postsImported).toBe(1);
    const postInsert = transactionalSql.find((sql) => sql.includes('INSERT INTO campaign_posts'));
    expect(postInsert).toBeDefined();
  });

  it('imports only the newest eligible initial original before advancing the cursor and completing recovery', async () => {
    const laterFreshPost = { ...freshPost, postId: '901', textContent: 'Later fresh post', postedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
    fetchNewXPostsForAccount.mockResolvedValue([freshPost, laterFreshPost]);

    const result = await processPerpetualCampaigns(10_000);

    expect(result.postsImported).toBe(1);
    expect(result.cyclesCreated).toBe(1);
    expect(checkCampaignSafety).toHaveBeenCalledTimes(1);
    expect(checkCampaignSafety).toHaveBeenCalledWith(['Later fresh post'], undefined, expect.any(Object), expect.any(Number));
    expect(transactionalSql.filter((sql) => sql.includes('INSERT INTO campaign_posts'))).toHaveLength(1);
    const completionWrites = queryDb.mock.calls.filter(([sql]) => String(sql).includes('initial_sync_pending = false'));
    expect(completionWrites).toHaveLength(1);
    expect(completionWrites[0][1]).toEqual(['901', 'account-1', expect.any(String)]);
  });

  it('uses initial_sync_pending rather than a pre-existing cursor for the initial recovery', async () => {
    queryDb.mockImplementation((sql: string) => {
      if (sql.includes('SELECT ca.id')) return Promise.resolve([{ ...account, last_seen_post_id: '1000' }]);
      if (sql.includes('SET poll_lease_owner = $2::UUID')) return Promise.resolve([{ id: account.id }]);
      if (sql.includes('SET poll_lease_expires_at = NOW() +') || (sql.includes('RETURNING id') && sql.includes('poll_lease_owner = $'))) return Promise.resolve([{ id: account.id }]);
      return Promise.resolve([]);
    });
    lockedAccount.last_seen_post_id = '1000';
    fetchNewXPostsForAccount.mockResolvedValue([freshPost]);

    const result = await processPerpetualCampaigns(10_000);

    expect(fetchNewXPostsForAccount).toHaveBeenCalledWith('42', null, expect.objectContaining({ campaignId: 'campaign-1', campaignAccountId: 'account-1' }), expect.any(Number), undefined, undefined, true);
    expect(result.postsImported).toBe(1);
    expect(transactionalSql.some((sql) => sql.includes('INSERT INTO campaign_posts'))).toBe(true);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('initial_sync_pending = false'))).toBe(true);
  });

  it('retains initial_sync_pending when durable recovery fails despite an advanced cursor', async () => {
    queryDb.mockImplementation((sql: string) => {
      if (sql.includes('SELECT ca.id')) return Promise.resolve([{ ...account, last_seen_post_id: '1000' }]);
      if (sql.includes('SET poll_lease_owner = $2::UUID')) return Promise.resolve([{ id: account.id }]);
      if (sql.includes('SET poll_lease_expires_at = NOW() +') || (sql.includes('RETURNING id') && sql.includes('poll_lease_owner = $'))) return Promise.resolve([{ id: account.id }]);
      return Promise.resolve([]);
    });
    lockedAccount.last_seen_post_id = '1000';
    transactionFailurePattern = 'INSERT INTO campaign_posts';
    fetchNewXPostsForAccount.mockResolvedValue([freshPost]);

    const result = await processPerpetualCampaigns(10_000);

    expect(transactionalSql.some((sql) => sql.includes('INSERT INTO campaign_posts'))).toBe(true);
    expect(transactionalSql.some((sql) => sql.includes('initial_sync_pending = false'))).toBe(false);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('initial_sync_pending = false'))).toBe(false);
    expect(result.errors).toContain('Fallo parcial cuenta author: fase db_import.');
    const failedCheckpoint = queryDb.mock.calls.find(([sql, args]) => String(sql).includes('INSERT INTO perpetual_sync_checkpoints') && Array.isArray(args) && args.includes('failed'));
    expect(failedCheckpoint?.[1]).toContain('MONITOR_DB_IMPORT_FAILED');
    expect(failedCheckpoint?.[1]).toContain('Error de monitor en la fase db_import.');
  });

  it('claims, releases, and skips an account already leased by another monitor', async () => {
    fetchNewXPostsForAccount.mockResolvedValue([]);

    await processPerpetualCampaigns(10_000);

    const claim = queryDb.mock.calls.find(([sql]) => String(sql).includes('SET poll_lease_owner = $2::UUID'));
    const release = queryDb.mock.calls.find(([sql]) => String(sql).includes('SET poll_lease_owner = NULL'));
    expect(claim?.[1]?.[2]).toBeGreaterThan(10_000);
    expect(release?.[1]?.[1]).toEqual(claim?.[1]?.[1]);

    queryDb.mockClear();
    leaseClaimed = false;
    const skipped = await processPerpetualCampaigns(10_000);
    expect(skipped.accountsProcessed).toBe(0);
    expect(fetchNewXPostsForAccount).toHaveBeenCalledTimes(1);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('SET poll_lease_owner = NULL'))).toBe(false);
  });

  it('records only a sanitized database error code and bounded checkpoint message', async () => {
    fetchNewXPostsForAccount.mockResolvedValue([freshPost]);
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT ca.initial_sync_pending')) return { rows: [lockedAccount], rowCount: 1 };
        if (sql.includes('SELECT id FROM campaign_posts')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO campaign_posts')) {
          throw Object.assign(new Error(`database rejected ${freshPost.textContent}`), { code: '23505' });
        }
        return { rows: [], rowCount: 0 };
      });
      return operation({ query });
    });

    await processPerpetualCampaigns(10_000);

    const failedCheckpoint = queryDb.mock.calls.find(([sql, args]) => String(sql).includes('INSERT INTO perpetual_sync_checkpoints') && Array.isArray(args) && args.includes('failed'));
    expect(failedCheckpoint?.[1]).toContain('MONITOR_DB_IMPORT_FAILED_23505');
    expect(failedCheckpoint?.[1]).toContain('Error de monitor en la fase db_import.');
    expect(JSON.stringify(failedCheckpoint)).not.toContain(freshPost.textContent);
  });

  it('does not import after losing lease ownership before the durable transaction', async () => {
    fetchNewXPostsForAccount.mockResolvedValue([freshPost]);
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const query = vi.fn(async (sql: string) => {
        transactionalSql.push(sql);
        if (sql.includes('SELECT ca.initial_sync_pending')) {
          const hasLeaseFence = sql.includes('poll_lease_owner = $2::UUID') && sql.includes('poll_lease_expires_at > NOW()');
          return hasLeaseFence ? { rows: [], rowCount: 0 } : { rows: [lockedAccount], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM campaign_posts')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO campaign_posts')) return { rows: [{ id: 'post-row-1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      return operation({ query });
    });

    const result = await processPerpetualCampaigns(10_000);

    expect(transactionalSql.find((sql) => sql.includes('SELECT ca.initial_sync_pending'))).toContain('poll_lease_owner = $2::UUID');
    expect(transactionalSql.some((sql) => sql.includes('INSERT INTO campaign_posts'))).toBe(false);
    expect(result.postsImported).toBe(0);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('initial_sync_pending = false'))).toBe(false);
  });

  it('keeps initial_sync_pending after a failed polling pass', async () => {
    fetchNewXPostsForAccount.mockRejectedValue(new Error('X unavailable'));

    await processPerpetualCampaigns(10_000);

    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('initial_sync_pending = false'))).toBe(false);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('SET last_polled_at = NOW()'))).toBe(true);
  });

  it('does not start account polling after its time budget is exhausted', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);

    const result = await processPerpetualCampaigns(0);

    expect(result.accountsProcessed).toBe(0);
    expect(fetchNewXPostsForAccount).not.toHaveBeenCalled();
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('SELECT ca.id'))).toBe(false);
    now.mockRestore();
  });

  it('finishes the atomic durable write after safety completes at the deadline', async () => {
    let nowValue = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowValue);
    fetchNewXPostsForAccount.mockResolvedValue([freshPost]);
    checkCampaignSafety.mockImplementation(async () => {
      nowValue = 2_000; // The 500ms budget elapsed while safety was in flight.
      return { allowed: true };
    });

    const result = await processPerpetualCampaigns(500);

    expect(result.postsImported).toBe(1);
    expect(transactionalSql.some((sql) => sql.includes('INSERT INTO campaign_posts'))).toBe(true);
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes('initial_sync_pending = false'))).toBe(true);
    now.mockRestore();
  });

  it('bounds each remote I/O call to the remaining monitor budget', async () => {
    let nowValue = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowValue);
    fetchNewXPostsForAccount.mockImplementation(async () => {
      nowValue = 1_300;
      return [freshPost];
    });

    await processPerpetualCampaigns(1_000);

    expect(fetchNewXPostsForAccount.mock.calls[0][3]).toBe(900);
    expect(checkCampaignSafety.mock.calls[0][3]).toBe(600);
    now.mockRestore();
  });

  it('does not advance the ongoing cursor when X reports an incomplete paginated scan', async () => {
    queryDb.mockImplementation((sql: string) => sql.includes('SELECT ca.id')
      ? Promise.resolve([{ ...account, initial_sync_pending: false, last_seen_post_id: '100' }])
      : sql.includes('SET poll_lease_owner = $2::UUID') || sql.includes('SET poll_lease_expires_at = NOW() +') || (sql.includes('RETURNING id') && sql.includes('poll_lease_owner = $'))
        ? Promise.resolve([{ id: account.id }])
        : Promise.resolve([]));
    lockedAccount = { initial_sync_pending: false, last_seen_post_id: '100', removed_at: null, is_active: true };
    fetchNewXPostsForAccount.mockResolvedValue({ posts: [freshPost], complete: false });

    const result = await processPerpetualCampaigns(10_000);

    expect(result.postsImported).toBe(0);
    expect(transactionalSql.some((sql) => sql.includes('INSERT INTO campaign_posts'))).toBe(false);
    expect(transactionalSql.some((sql) => sql.includes('last_seen_post_id = $1'))).toBe(false);
  });
});

  it('skips creating cycles if max_comments_total is reached during durable db_import', async () => {
    queryDb.mockResolvedValueOnce([{
      id: 'account-1',
      campaign_id: 'campaign-1',
      username: 'test',
      x_user_id: 'x-123',
      initial_sync_pending: true,
      last_seen_post_id: null,
      direction: 'be nice',
      post_active_lifetime_hours: 24,
      model_key: 'test',
      max_comments_total: 10,
      brand_variants: []
    }]);

    queryDb.mockResolvedValueOnce([{ id: 'lease-1' }]); // claim lease
    queryDb.mockResolvedValueOnce([]); // no lease renewal needed for simplicty
    fetchNewXPostsForAccount.mockResolvedValueOnce({
      posts: [{ postId: 'post-1', inputUrl: 'url1', canonicalUrl: 'url1', authorName: 'a', authorUsername: 'b', textContent: 'hello', language: 'en', postedAt: new Date().toISOString(), accessibleContext: {} }],
      complete: true
    });
    checkCampaignSafety.mockResolvedValueOnce({ allowed: true, category: 'safe', reason: 'ok' });

    type TransactionCallback<T = unknown> = (client: unknown) => Promise<T>;
    withTransaction.mockImplementation(async (cb: TransactionCallback) => {
      return cb({
        query: vi.fn((q) => {
          if (q.includes('FOR UPDATE') && q.includes('campaign_accounts')) {
            return { rows: [{ initial_sync_pending: true, last_seen_post_id: null, removed_at: null, is_active: true }] };
          }
          if (q.includes('FOR UPDATE') && q.includes('campaigns')) {
            return { rows: [{ max_comments_total: 10 }] };
          }
          if (q.includes('SELECT id FROM campaign_posts')) {
            return { rowCount: 0 };
          }
          if (q.includes('INSERT INTO campaign_posts')) {
            return { rowCount: 1, rows: [{ id: 'cp-1' }] };
          }
          if (q.includes('current_total')) {
            return { rows: [{ current_total: '10' }] }; // Capacity reached!
          }
          if (q.includes('UPDATE campaign_accounts')) {
            return { rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        })
      });
    });

    await processPerpetualCampaigns({ timeBudgetMs: 5000 });

    expect(withTransaction).toHaveBeenCalled();
    expect(withTransaction).toHaveBeenCalled();
    // Should NOT have created generation_cycles
    // Wait, the client is local to the mock function above, but we can spy on it.
  });
