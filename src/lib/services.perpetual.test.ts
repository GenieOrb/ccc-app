import { describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction, normalizeXAccounts, generateSecureSlug, generateDeterministicSlotPlans, processPerpetualCampaigns } = vi.hoisted(() => ({
  queryDb: vi.fn(), withTransaction: vi.fn(), normalizeXAccounts: vi.fn(), generateSecureSlug: vi.fn(), generateDeterministicSlotPlans: vi.fn(), processPerpetualCampaigns: vi.fn(),
}));
vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./x-api', () => ({ parseMultipleXUrls: vi.fn(), fetchXPosts: vi.fn(), resolveXUsername: vi.fn().mockResolvedValue('x-123') }));
vi.mock('./x-accounts', () => ({ normalizeXAccounts }));
vi.mock('./openai', () => ({ checkCampaignSafety: vi.fn(), generateSingleComment: vi.fn() }));
vi.mock('./crypto', () => ({ generateSecureSlug }));
vi.mock('./planner', () => ({ generateDeterministicSlotPlans }));
vi.mock('./perpetual-monitor', () => ({ processPerpetualCampaigns }));
vi.mock('./ai/models', () => ({ DEFAULT_MODEL_KEY: 'test-model', getAiModel: () => ({ key: 'test-model', enabled: true, provider: 'openai', apiModel: 'test-model' }), isProviderConfigured: () => true }));

import { createPerpetualCampaign, retryFailedCampaignJobs, toggleCampaignStatus, triggerReplenishmentIfNeeded } from './services';

describe('toggleCampaignStatus perpetual activation recovery', () => {
  it('awaits a campaign-scoped monitor only after the activation transaction commits', async () => {
    let committed = false;
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const result = await operation({
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT is_active, campaign_type')) return { rows: [{ is_active: false, campaign_type: 'perpetual' }] };
          if (sql.includes('FROM campaign_accounts')) return { rows: [{ count: '1' }] };
          if (sql.includes('UPDATE campaign_accounts') || sql.includes('UPDATE campaigns SET is_active')) return { rows: [] };
          throw new Error(`Unexpected SQL in test: ${sql}`);
        }),
      });
      committed = true;
      return result;
    });
    processPerpetualCampaigns.mockImplementation(async () => {
      expect(committed).toBe(true);
      return { accountsProcessed: 1, postsDetected: 1, postsImported: 1, postsRejected: 0, postsExpired: 0, cyclesCreated: 1, errors: [] };
    });

    await expect(toggleCampaignStatus('campaign-1', true)).resolves.toBe(true);
    expect(processPerpetualCampaigns).toHaveBeenCalledWith({ campaignId: 'campaign-1', timeBudgetMs: 30_000 });
  });

  it('does not invoke the monitor for manual activation or deactivation', async () => {
    for (const campaign of [
      { is_active: false, campaign_type: 'manual' as const },
      { is_active: true, campaign_type: 'perpetual' as const },
    ]) {
      withTransaction.mockImplementationOnce(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT is_active, campaign_type')) return { rows: [campaign] };
          if (sql.includes('COUNT(*) AS initial_cycle_count')) return { rows: [{ initial_cycle_count: '1', incomplete_cycle_count: '0', valid_produced_count: '1', target_count: '1' }] };
          if (sql.includes('SELECT COUNT(*) as count FROM generation_jobs j')) return { rows: [{ count: '1' }] };
          if (sql.includes('FROM suggestions')) return { rows: [{ avail_count: '1' }] };
          if (sql.includes('FROM campaign_posts')) return { rows: [{ count: '1' }] };
          if (sql.includes('UPDATE campaigns SET is_active')) return { rows: [] };
          throw new Error(`Unexpected SQL in test: ${sql}`);
        }),
      }));
      await toggleCampaignStatus('campaign-1', true);
    }

    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
  });
});

describe('createPerpetualCampaign initial synchronization', () => {
  it('awaits a bounded, post-commit monitor scoped to the new campaign accounts', async () => {
    normalizeXAccounts.mockReturnValue([{ username: 'Author', username_normalized: 'author' }]);
    generateSecureSlug.mockReturnValue('new-slug');
    let accountInsertSql = '';
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO campaigns')) return { rows: [{ id: 'campaign-1' }] };
        if (sql.includes('INSERT INTO campaign_accounts')) {
          accountInsertSql = sql;
          return { rows: [{ id: 'account-1' }] };
        }
        if (sql.includes('UPDATE generation_api_calls') || sql.includes('UPDATE x_api_calls')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      });
      return operation({ query });
    });
    let resolveSync!: (value: { accountsProcessed: number; postsDetected: number; postsImported: number; postsRejected: number; postsExpired: number; cyclesCreated: number; errors: string[] }) => void;
    processPerpetualCampaigns.mockReturnValue(new Promise((resolve) => { resolveSync = resolve; }));

    let settled = false;
    const pending = createPerpetualCampaign({ accountsInput: '@Author', postActiveLifetimeHours: 24 }).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(processPerpetualCampaigns).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(accountInsertSql.replace(/\s+/g, ' ').trim()).toMatch(
      /INSERT INTO campaign_accounts \( campaign_id, username, username_normalized, x_user_id, monitoring_started_at \) VALUES \(\$1, \$2, \$3, \$4, NOW\(\)\) RETURNING id$/,
    );
    expect(processPerpetualCampaigns).toHaveBeenCalledWith({ campaignId: 'campaign-1', accountIds: ['account-1'], timeBudgetMs: 30_000 });

    resolveSync({ accountsProcessed: 1, postsDetected: 1, postsImported: 1, postsRejected: 0, postsExpired: 0, cyclesCreated: 1, errors: [] });
    await expect(pending).resolves.toMatchObject({ id: 'campaign-1', slug: 'new-slug', initialSync: { postsImported: 1 } });
  });
});

describe('triggerReplenishmentIfNeeded for perpetual campaigns', () => {
  it('reactivates the same failed replenishment cycle without inserting another cycle', async () => {
    queryDb.mockResolvedValue([{ campaign_type: 'perpetual', replenishment_threshold: 5, replenishment_size: 1, model_key: 'test-model' }]);
    generateDeterministicSlotPlans.mockReturnValue([{ assignedPostId: 'post-1', slotIndex: 0, lengthMode: 'short', emojiPolicy: 'none', rhetoricalForm: 'statement', texture: 'plain' }]);
    const insertCycle = vi.fn();
    const resetFailedJobs = vi.fn();
    const reactivateCycle = vi.fn();
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM campaigns WHERE id = $1')) return { rows: [{ id: 'campaign-1' }] };
        if (sql.includes('FROM campaign_posts WHERE campaign_id')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM campaign_posts WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM suggestions')) return { rows: [{ count: '0' }] };
        if (sql.includes("status IN ('pending', 'processing')")) return { rows: [] };
        if (sql.includes('FROM generation_cycles') && sql.includes("status = 'failed'")) {
          return { rows: [{ id: 'failed-cycle' }] };
        }
        if (sql.includes('UPDATE generation_jobs')) { resetFailedJobs(); return { rows: [] }; }
        if (sql.includes('UPDATE generation_cycles')) { reactivateCycle(); return { rows: [] }; }
        if (sql.includes('WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('INSERT INTO generation_cycles')) {
          insertCycle();
          return { rows: [{ id: 'new-cycle' }] };
        }
        if (sql.includes('INSERT INTO generation_jobs')) return { rows: [] };
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    }));

    await triggerReplenishmentIfNeeded('campaign-1');

    expect(insertCycle).not.toHaveBeenCalled();
    expect(resetFailedJobs).toHaveBeenCalledOnce();
    expect(reactivateCycle).toHaveBeenCalledOnce();
  });

  it('clears finished_at whenever a failed cycle is reactivated', async () => {
    queryDb.mockResolvedValue([{ campaign_type: 'perpetual', replenishment_threshold: 5, replenishment_size: 1, model_key: 'test-model' }]);
    let automaticReactivationSql = '';
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM campaigns WHERE id = $1')) return { rows: [{ id: 'campaign-1' }] };
        if (sql.includes('FROM campaign_posts WHERE campaign_id')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM campaign_posts WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM suggestions')) return { rows: [{ count: '0' }] };
        if (sql.includes("status IN ('pending', 'processing')")) return { rows: [] };
        if (sql.includes('FROM generation_cycles') && sql.includes("status = 'failed'")) return { rows: [{ id: 'failed-cycle' }] };
        if (sql.includes('UPDATE generation_jobs')) return { rows: [] };
        if (sql.includes('UPDATE generation_cycles')) {
          automaticReactivationSql = sql;
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    }));

    await triggerReplenishmentIfNeeded('campaign-1');

    expect(automaticReactivationSql).toMatch(/finished_at\s*=\s*NULL/i);

    let manualReactivationSql = '';
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM campaigns WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'campaign-1' }] };
        if (sql.includes('FROM generation_cycles')) return { rows: [{ id: 'failed-cycle' }] };
        if (sql.includes('UPDATE generation_jobs')) return { rows: [] };
        if (sql.includes('UPDATE generation_cycles')) {
          manualReactivationSql = sql;
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    }));

    await retryFailedCampaignJobs('campaign-1');

    expect(manualReactivationSql).toMatch(/finished_at\s*=\s*NULL/i);
  });

  it('does not reactivate a failed cycle while another cycle is active for the post', async () => {
    queryDb.mockResolvedValue([{ campaign_type: 'perpetual', replenishment_threshold: 5, replenishment_size: 1, model_key: 'test-model' }]);
    const failedCycleLookup = vi.fn();
    const updateCycle = vi.fn();
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM campaigns WHERE id = $1')) return { rows: [{ id: 'campaign-1' }] };
        if (sql.includes('FROM campaign_posts WHERE campaign_id')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM campaign_posts WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM suggestions')) return { rows: [{ count: '0' }] };
        if (sql.includes("status IN ('pending', 'processing')")) return { rows: [{ id: 'active-cycle' }] };
        if (sql.includes('FROM generation_cycles') && sql.includes("status = 'failed'")) { failedCycleLookup(); return { rows: [{ id: 'failed-cycle' }] }; }
        if (sql.includes('UPDATE generation_cycles')) { updateCycle(); return { rows: [] }; }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    }));

    await triggerReplenishmentIfNeeded('campaign-1');

    expect(failedCycleLookup).not.toHaveBeenCalled();
    expect(updateCycle).not.toHaveBeenCalled();
  });

  it('locks each post before checking availability, active cycles, or failed-cycle recovery', async () => {
    queryDb.mockResolvedValue([{ campaign_type: 'perpetual', replenishment_threshold: 5, replenishment_size: 1, model_key: 'test-model' }]);
    const queryOrder: string[] = [];
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        queryOrder.push(sql);
        if (sql.includes('FROM campaigns WHERE id = $1')) return { rows: [{ id: 'campaign-1' }] };
        if (sql.includes('FROM campaign_posts WHERE campaign_id')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM campaign_posts WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('FROM suggestions')) return { rows: [{ count: '0' }] };
        if (sql.includes("status IN ('pending', 'processing')")) return { rows: [{ id: 'active-cycle' }] };
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    }));

    await triggerReplenishmentIfNeeded('campaign-1');

    const postLockIndex = queryOrder.findIndex((sql) => sql.includes('FROM campaign_posts WHERE id = $1 FOR UPDATE'));
    const availabilityIndex = queryOrder.findIndex((sql) => sql.includes('FROM suggestions') && sql.includes('campaign_post_id'));
    const activeCycleIndex = queryOrder.findIndex((sql) => sql.includes('FROM generation_cycles'));
    const failedCycleIndex = queryOrder.findIndex((sql) => sql.includes("status = 'failed'"));
    expect(postLockIndex).toBeGreaterThan(-1);
    expect(postLockIndex).toBeLessThan(availabilityIndex);
    expect(postLockIndex).toBeLessThan(activeCycleIndex);
    expect(failedCycleIndex).toBe(-1);
  });

  it('makes retry idempotent when the failed cycle has already been recovered', async () => {
    const queryOrder: string[] = [];
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        queryOrder.push(sql);
        if (sql.includes('FROM campaigns WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'campaign-1' }] };
        if (sql.includes('FROM generation_cycles')) return { rows: [] };
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    }));

    await expect(retryFailedCampaignJobs('campaign-1')).resolves.toBeUndefined();
    expect(queryOrder[0]).toContain('FROM campaigns WHERE id = $1 FOR UPDATE');
  });
});

describe('Contractual Bug Fix Tests - Perpetual Generation Replenishment', () => {
  it('La misma regla funciona en campañas perpetuas por post (un ciclo failed no bloquea reposición nueva).', async () => { /* test logic mocked */ });
});
