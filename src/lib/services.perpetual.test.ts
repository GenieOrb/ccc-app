import { describe, expect, it, vi } from 'vitest';

const { withTransaction, normalizeXAccounts, generateSecureSlug, processPerpetualCampaigns } = vi.hoisted(() => ({
  withTransaction: vi.fn(), normalizeXAccounts: vi.fn(), generateSecureSlug: vi.fn(), processPerpetualCampaigns: vi.fn(),
}));
vi.mock('./db', () => ({ queryDb: vi.fn(), withTransaction }));
vi.mock('./x-api', () => ({ parseMultipleXUrls: vi.fn(), fetchXPosts: vi.fn() }));
vi.mock('./x-accounts', () => ({ normalizeXAccounts }));
vi.mock('./openai', () => ({ checkCampaignSafety: vi.fn(), generateSingleComment: vi.fn() }));
vi.mock('./crypto', () => ({ generateSecureSlug }));
vi.mock('./planner', () => ({ generateDeterministicSlotPlans: vi.fn() }));
vi.mock('./perpetual-monitor', () => ({ processPerpetualCampaigns }));
vi.mock('./ai/models', () => ({ DEFAULT_MODEL_KEY: 'test-model', getAiModel: () => ({ key: 'test-model', enabled: true, provider: 'openai', apiModel: 'test-model' }), isProviderConfigured: () => true }));

import { createPerpetualCampaign } from './services';

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
      /INSERT INTO campaign_accounts \( campaign_id, username, username_normalized \) VALUES \(\$1, \$2, \$3\) RETURNING id$/,
    );
    expect(processPerpetualCampaigns).toHaveBeenCalledWith({ campaignId: 'campaign-1', accountIds: ['account-1'], timeBudgetMs: 12_000 });

    resolveSync({ accountsProcessed: 1, postsDetected: 1, postsImported: 1, postsRejected: 0, postsExpired: 0, cyclesCreated: 1, errors: [] });
    await expect(pending).resolves.toMatchObject({ id: 'campaign-1', slug: 'new-slug', initialSync: { postsImported: 1 } });
  });
});
