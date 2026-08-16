import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction, deleteBlobStrict } = vi.hoisted(() => ({ queryDb: vi.fn(), withTransaction: vi.fn(), deleteBlobStrict: vi.fn() }));
vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./x-api', () => ({ parseMultipleXUrls: vi.fn(), fetchXPosts: vi.fn(), resolveXUsername: vi.fn() }));
vi.mock('./x-accounts', () => ({ normalizeXAccounts: vi.fn() }));
vi.mock('./openai', () => ({ checkCampaignSafety: vi.fn(), generateSingleComment: vi.fn() }));
vi.mock('./crypto', () => ({ generateSecureSlug: vi.fn() }));
vi.mock('./planner', () => ({ generateDeterministicSlotPlans: vi.fn() }));
vi.mock('./perpetual-monitor', () => ({ processPerpetualCampaigns: vi.fn() }));
vi.mock('./perpetual-scheduler', () => ({ reconcilePerpetualScheduler: vi.fn() }));
vi.mock('./ai/models', () => ({ DEFAULT_MODEL_KEY: 'test-model', getAiModel: vi.fn(), isProviderConfigured: vi.fn() }));
vi.mock('./memes/blob', () => ({ deleteBlobStrict }));

import { assignCommentToVisitor, toggleCampaignStatus } from './services';

describe('assignCommentToVisitor meme cadence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks the campaign and reserves the eligible campaign meme atomically when N=1 is due', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    withTransaction.mockImplementation(async (operation) => operation({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM campaigns WHERE slug')) return { rows: [{ id: 'campaign-1', is_active: true, include_memes: true, meme_every_comments: 1, meme_global_comment_count: 1 }] };
        if (sql.includes('INSERT INTO visitors')) return { rows: [{ id: 'visitor-1' }] };
        if (sql.includes('INSERT INTO visitor_campaign_states')) return { rows: [] };
        if (sql.includes('FROM visitor_campaign_states')) return { rows: [{ active_assignment_id: null }] };
        if (sql.includes('FROM campaign_memes cm')) return { rows: [{ campaign_meme_id: 'campaign-meme-1', campaign_post_id: 'post-1', canonical_url: 'https://x.com/a/status/1', x_post_id: '1' }] };
        if (sql.includes('INSERT INTO campaign_meme_posts')) return { rows: [{ campaign_meme_id: 'campaign-meme-1' }] };
        if (sql.includes('INSERT INTO assignments')) return { rows: [{ id: 'assignment-1' }] };
        if (sql.includes('UPDATE visitor_campaign_states')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('UPDATE campaigns SET meme_global_comment_count')) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    }));

    const result = await assignCommentToVisitor('slug', 'visitor-hash');

    expect(result).toMatchObject({ status: 'success', type: 'meme', assignmentId: 'assignment-1' });
    expect(queries.some(({ sql }) => /FROM campaigns WHERE slug = \$1 FOR UPDATE/.test(sql))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('FROM campaign_memes cm') && sql.includes('ORDER BY random()'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('INSERT INTO campaign_meme_posts'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('campaign_meme_id'))).toBe(true);
  });

  it('keeps meme debt at N=2 when no eligible meme-post pair exists, while NULL disables the meme query', async () => {
    const queries: string[] = [];
    const run = async (memeEveryComments: number | null) => {
      withTransaction.mockImplementationOnce(async (operation) => operation({
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          if (sql.includes('FROM campaigns WHERE slug')) return { rows: [{ id: 'campaign-1', is_active: true, include_memes: true, meme_every_comments: memeEveryComments, meme_global_comment_count: 2 }] };
          if (sql.includes('INSERT INTO visitors')) return { rows: [{ id: 'visitor-1' }] };
          if (sql.includes('INSERT INTO visitor_campaign_states')) return { rows: [] };
          if (sql.includes('FROM visitor_campaign_states')) return { rows: [{ active_assignment_id: null }] };
          if (sql.includes('FROM campaign_memes cm')) return { rows: [] };
          if (sql.includes('FROM suggestions s')) return { rows: [{ suggestion_id: 'suggestion-1', campaign_post_id: 'post-1', comment_text: 'comment', canonical_url: 'https://x.com/a/status/1', x_post_id: '1' }] };
          if (sql.includes('INSERT INTO assignments')) return { rows: [{ id: 'assignment-1' }] };
          if (sql.includes('UPDATE suggestions SET status')) return { rows: [{ id: 'suggestion-1' }] };
          if (sql.includes('UPDATE campaigns')) return { rows: [] };
          if (sql.includes('UPDATE visitor_campaign_states')) return { rows: [{ '?column?': 1 }] };
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
      }));
      return assignCommentToVisitor('slug', 'visitor-hash');
    };

    await expect(run(2)).resolves.toMatchObject({ status: 'success', type: 'comment' });
    expect(queries.some((sql) => sql.includes('FROM campaign_memes cm') && sql.includes('ORDER BY random()'))).toBe(true);
    expect(queries.some((sql) => sql.includes('LEAST(meme_global_comment_count + 1, meme_every_comments)'))).toBe(true);

    queries.length = 0;
    await expect(run(null)).resolves.toMatchObject({ status: 'success', type: 'comment' });
    expect(queries.some((sql) => sql.includes('FROM campaign_memes cm'))).toBe(false);
  });
});

describe('toggleCampaignStatus meme lifecycle', () => {
  it('keeps meme blobs untouched when deactivation is a reversible pause', async () => {
    withTransaction.mockImplementation(async (operation) => operation({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT is_active, campaign_type')) return { rows: [{ is_active: false, campaign_type: 'manual' }] };
        if (sql.includes('UPDATE campaigns SET is_active')) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    }));
    await expect(toggleCampaignStatus('campaign-1', false)).resolves.toBe(false);
    await expect(toggleCampaignStatus('campaign-1', false)).resolves.toBe(false);

    expect(deleteBlobStrict).not.toHaveBeenCalled();
    expect(queryDb).not.toHaveBeenCalled();
  });
});
