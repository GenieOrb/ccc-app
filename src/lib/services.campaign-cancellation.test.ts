import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction, withAdvisoryLock, deleteBlobStrict } = vi.hoisted(() => ({
  queryDb: vi.fn(), withTransaction: vi.fn(), withAdvisoryLock: vi.fn(), deleteBlobStrict: vi.fn(),
}));
vi.mock('./db', () => ({ queryDb, withTransaction, withAdvisoryLock }));
vi.mock('./x-api', () => ({ parseMultipleXUrls: vi.fn(), fetchXPosts: vi.fn(), resolveXUsername: vi.fn() }));
vi.mock('./x-accounts', () => ({ normalizeXAccounts: vi.fn() }));
vi.mock('./openai', () => ({ checkCampaignSafety: vi.fn(), generateSingleComment: vi.fn() }));
vi.mock('./crypto', () => ({ generateSecureSlug: vi.fn() }));
vi.mock('./planner', () => ({ generateDeterministicSlotPlans: vi.fn() }));
vi.mock('./perpetual-monitor', () => ({ processPerpetualCampaigns: vi.fn() }));
vi.mock('./perpetual-scheduler', () => ({ reconcilePerpetualScheduler: vi.fn() }));
vi.mock('./memes/blob', () => ({ deleteBlobStrict }));
vi.mock('./ai/models', () => ({
  DEFAULT_MODEL_KEY: 'test-model',
  getAiModel: () => ({ key: 'test-model', enabled: true, provider: 'openai', apiModel: 'test-model' }),
  isProviderConfigured: () => true,
}));

import { cancelCampaign } from './services';

type MemeStatus = 'available' | 'assigned' | 'failed' | 'rejected' | 'withdrawn' | 'retired';
type CampaignState = { cancelledAt: Date | null; memeStatus: MemeStatus };

function installCancellationTransaction(state: CampaignState, selectedStatuses: string[][]) {
  withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT cancelled_at FROM campaigns')) return { rows: [{ cancelled_at: state.cancelledAt }] };
      if (sql.includes('UPDATE campaigns')) {
        state.cancelledAt ??= new Date('2026-08-16T12:34:56.000Z');
        return { rows: [{ cancelled_at: state.cancelledAt }] };
      }
      if (
        sql.includes('UPDATE generation_jobs')
        || sql.includes('UPDATE generation_cycles')
        || sql.includes('UPDATE meme_generation_jobs')
        || sql.includes('UPDATE meme_generation_cycles')
      ) return { rows: [] };
      if (sql.includes('UPDATE campaign_memes')) {
        const statuses = params?.[1] as string[];
        selectedStatuses.push(statuses);
        if (!statuses.includes(state.memeStatus)) return { rows: [] };
        state.memeStatus = 'withdrawn';
        return { rows: [{ id: 'meme-1', storage_key: 'private/meme-1.png' }] };
      }
      if (sql.includes('UPDATE memes')) return { rows: [] };
      throw new Error(`Unexpected SQL in cancellation test: ${sql}`);
    }),
  }));
  queryDb.mockImplementation(async (sql: string) => {
    if (sql.includes("status = 'retired'")) state.memeStatus = 'retired';
    else if (sql.includes("status = 'failed'")) state.memeStatus = 'failed';
    else throw new Error(`Unexpected post-commit SQL in cancellation test: ${sql}`);
    return [];
  });
}

describe('cancelCampaign meme lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withAdvisoryLock.mockImplementation(async (_lockId: number, operation: () => Promise<unknown>) => operation());
  });

  it('cancels active generation queues in the same transaction as the irreversible campaign state', async () => {
    const transactionSql: string[] = [];
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        transactionSql.push(sql);
        if (sql.includes('SELECT cancelled_at FROM campaigns')) return { rows: [{ cancelled_at: null }] };
        if (sql.includes('UPDATE campaigns')) return { rows: [{ cancelled_at: new Date('2026-08-16T12:34:56.000Z') }] };
        if (sql.includes('FROM campaign_memes')) return { rows: [] };
        return { rows: [] };
      }),
    }));

    await cancelCampaign('campaign-1');

    expect(transactionSql).toEqual(expect.arrayContaining([
      expect.stringContaining('UPDATE generation_jobs'),
      expect.stringContaining('UPDATE generation_cycles'),
      expect.stringContaining('UPDATE meme_generation_jobs'),
      expect.stringContaining('UPDATE meme_generation_cycles'),
    ]));
  });

  it('retires an assigned meme only after strict blob deletion', async () => {
    const state: CampaignState = { cancelledAt: null, memeStatus: 'assigned' };
    const selectedStatuses: string[][] = [];
    installCancellationTransaction(state, selectedStatuses);
    deleteBlobStrict.mockResolvedValue(undefined);

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({
      cleanupPending: false, attemptedCount: 1, retiredCount: 1, failedCount: 0,
    });

    expect(selectedStatuses).toEqual([['available', 'assigned', 'failed', 'rejected']]);
    expect(deleteBlobStrict).toHaveBeenCalledWith('private/meme-1.png');
    expect(state.memeStatus).toBe('retired');
    expect(String(queryDb.mock.calls[0][0])).not.toContain('storage_key');
    expect(String(queryDb.mock.calls[0][0])).toContain("status = 'withdrawn'");
  });

  it('marks an assigned meme failed while preserving its key when strict deletion fails', async () => {
    const state: CampaignState = { cancelledAt: null, memeStatus: 'assigned' };
    const selectedStatuses: string[][] = [];
    installCancellationTransaction(state, selectedStatuses);
    deleteBlobStrict.mockRejectedValueOnce(new Error('blob unavailable'));

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({
      cleanupPending: true, attemptedCount: 1, retiredCount: 0, failedCount: 1,
    });

    expect(state.memeStatus).toBe('failed');
    expect(queryDb.mock.calls[0][1]).toEqual(['campaign-1', ['meme-1']]);
    expect(String(queryDb.mock.calls[0][0])).not.toContain('storage_key');
  });

  it('cleans a rejected meme during the first cancellation', async () => {
    const state: CampaignState = { cancelledAt: null, memeStatus: 'rejected' };
    const selectedStatuses: string[][] = [];
    installCancellationTransaction(state, selectedStatuses);
    deleteBlobStrict.mockResolvedValue(undefined);

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({
      cleanupPending: false, attemptedCount: 1, retiredCount: 1, failedCount: 0,
    });

    expect(selectedStatuses).toEqual([['available', 'assigned', 'failed', 'rejected']]);
    expect(deleteBlobStrict).toHaveBeenCalledWith('private/meme-1.png');
    expect(state.memeStatus).toBe('retired');
  });

  it('does not retry a withdrawn campaign meme after the campaign was already cancelled', async () => {
    const state: CampaignState = { cancelledAt: new Date('2026-08-16T12:34:56.000Z'), memeStatus: 'withdrawn' };
    const selectedStatuses: string[][] = [];
    installCancellationTransaction(state, selectedStatuses);
    deleteBlobStrict.mockResolvedValue(undefined);

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({
      cleanupPending: false, attemptedCount: 0, retiredCount: 0, failedCount: 0,
    });

    expect(selectedStatuses).toEqual([['failed']]);
    expect(deleteBlobStrict).not.toHaveBeenCalled();
    expect(state.memeStatus).toBe('withdrawn');
  });

  it('does not retry a legacy meme once withdrawn_at is set', async () => {
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT cancelled_at FROM campaigns')) return { rows: [{ cancelled_at: new Date('2026-08-16T12:34:56.000Z') }] };
        if (sql.includes('UPDATE campaigns')) return { rows: [{ cancelled_at: new Date('2026-08-16T12:34:56.000Z') }] };
        if (sql.includes('UPDATE generation_') || sql.includes('UPDATE meme_generation_') || sql.includes('UPDATE campaign_memes')) return { rows: [] };
        if (sql.includes('UPDATE memes')) {
          expect(sql).toContain('withdrawn_at = COALESCE(withdrawn_at, NOW())');
          expect(params?.[1]).toEqual(['failed']);
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in withdrawn legacy cancellation test: ${sql}`);
      }),
    }));

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({ attemptedCount: 0, retiredCount: 0, failedCount: 0 });
    expect(deleteBlobStrict).not.toHaveBeenCalled();
  });

  it('retries only failed memes and becomes idempotent after successful cleanup', async () => {
    const state: CampaignState = { cancelledAt: new Date('2026-08-16T12:34:56.000Z'), memeStatus: 'failed' };
    const selectedStatuses: string[][] = [];
    installCancellationTransaction(state, selectedStatuses);
    deleteBlobStrict.mockResolvedValue(undefined);

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({
      cleanupPending: false, attemptedCount: 1, retiredCount: 1, failedCount: 0,
    });
    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({
      cleanupPending: false, attemptedCount: 0, retiredCount: 0, failedCount: 0,
    });

    expect(selectedStatuses).toEqual([['failed'], ['failed']]);
    expect(deleteBlobStrict).toHaveBeenCalledTimes(1);
  });

  it('claims a post-backfill legacy meme absent from campaign_memes and leaves it withdrawn after deletion', async () => {
    const legacy = { status: 'assigned' as MemeStatus, withdrawnAt: null as Date | null };
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT cancelled_at FROM campaigns')) return { rows: [{ cancelled_at: null }] };
        if (sql.includes('UPDATE campaigns')) return { rows: [{ cancelled_at: new Date('2026-08-16T12:34:56.000Z') }] };
        if (sql.includes('UPDATE generation_') || sql.includes('UPDATE meme_generation_')) return { rows: [] };
        if (sql.includes('UPDATE campaign_memes')) return { rows: [] };
        if (sql.includes('UPDATE memes')) {
          expect(sql).toContain('cm.id = m.id OR cm.storage_key = m.storage_key');
          expect(params?.[1]).toEqual(['available', 'assigned', 'failed', 'rejected']);
          legacy.status = 'withdrawn';
          legacy.withdrawnAt = new Date('2026-08-16T12:34:56.000Z');
          return { rows: [{ id: 'legacy-1', storage_key: 'private/legacy-1.png' }] };
        }
        throw new Error(`Unexpected SQL in legacy cancellation test: ${sql}`);
      }),
    }));
    deleteBlobStrict.mockResolvedValue(undefined);

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({ attemptedCount: 1, retiredCount: 1, failedCount: 0 });

    expect(legacy).toMatchObject({ status: 'withdrawn', withdrawnAt: expect.any(Date) });
    expect(deleteBlobStrict).toHaveBeenCalledWith('private/legacy-1.png');
  });

  it('deduplicates strict deletion by storage key and fails both claimed records together', async () => {
    const updates: string[] = [];
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT cancelled_at FROM campaigns')) return { rows: [{ cancelled_at: null }] };
        if (sql.includes('UPDATE campaigns')) return { rows: [{ cancelled_at: new Date('2026-08-16T12:34:56.000Z') }] };
        if (sql.includes('UPDATE generation_') || sql.includes('UPDATE meme_generation_')) return { rows: [] };
        if (sql.includes('UPDATE campaign_memes')) return { rows: [{ id: 'campaign-meme-1', storage_key: 'private/shared.png' }] };
        if (sql.includes('UPDATE memes')) return { rows: [{ id: 'legacy-1', storage_key: 'private/shared.png' }] };
        throw new Error(`Unexpected SQL in shared-key cancellation test: ${sql}`);
      }),
    }));
    queryDb.mockImplementation(async (sql: string) => { updates.push(sql); return []; });
    deleteBlobStrict.mockRejectedValueOnce(new Error('blob unavailable'));

    await expect(cancelCampaign('campaign-1')).resolves.toMatchObject({ attemptedCount: 1, retiredCount: 0, failedCount: 1, cleanupPending: true });

    expect(deleteBlobStrict).toHaveBeenCalledTimes(1);
    expect(updates.join('\n')).toContain('UPDATE campaign_memes');
    expect(updates.join('\n')).toContain('UPDATE memes');
    expect(updates.join('\n')).toContain("status = 'failed'");
  });

  it('serializes concurrent cancellations so only one strict deletion claims the blob', async () => {
    const state: CampaignState = { cancelledAt: null, memeStatus: 'assigned' };
    const selectedStatuses: string[][] = [];
    installCancellationTransaction(state, selectedStatuses);
    deleteBlobStrict.mockResolvedValue(undefined);

    let previous = Promise.resolve();
    withAdvisoryLock.mockImplementation(async (_lockId: number, operation: () => Promise<unknown>) => {
      const current = previous.then(operation);
      previous = current.catch(() => undefined);
      return current;
    });

    const results = await Promise.all([cancelCampaign('campaign-1'), cancelCampaign('campaign-1')]);

    expect(withAdvisoryLock).toHaveBeenCalledTimes(2);
    expect(deleteBlobStrict).toHaveBeenCalledTimes(1);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ cleanupPending: false, attemptedCount: 1, retiredCount: 1 }),
      expect.objectContaining({ cleanupPending: false, attemptedCount: 0, retiredCount: 0 }),
    ]));
  });
});
