import { describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction, generateSingleComment, computeNormalizedHash, normalizeCommentText, validateCommentLocally } = vi.hoisted(() => ({
  queryDb: vi.fn(), withTransaction: vi.fn(), generateSingleComment: vi.fn(),
  computeNormalizedHash: vi.fn(), normalizeCommentText: vi.fn(), validateCommentLocally: vi.fn(),
}));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./openai', () => ({ generateSingleComment }));
vi.mock('./ai/models', () => ({ getConfiguredFallbackModel: vi.fn() }));
vi.mock('./validator', () => ({ computeNormalizedHash, normalizeCommentText, validateCommentLocally }));

import { MIN_WORKER_JOB_BUDGET_MS, processBackgroundQueue } from './worker';

describe('manual generation queue gating', () => {
  it('permits an inactive manual initial cycle to be claimed, but not its replenishment cycles', async () => {
    const queries: string[] = [];
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }),
    }));

    await processBackgroundQueue('worker-test', MIN_WORKER_JOB_BUDGET_MS);

    const claimQuery = queries[0].replace(/\s+/g, ' ');
    expect(claimQuery).toMatch(/\( c\.is_active = true OR \(c\.campaign_type = 'manual' AND cy\.cycle_type = 'initial'\) \)/);
    expect(claimQuery).toContain("cy.status IN ('pending', 'processing')");
  });

  it('uses the same manual-initial eligibility after leasing before publishing', async () => {
    const queries: string[] = [];
    queryDb.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT comment_text')) return [];
      if (sql.includes('SELECT id FROM campaign_posts')) return [{ id: 'post-1' }];
      if (sql.includes('INSERT INTO generation_api_calls')) return [{ call_key: 'job-1:1:1' }];
      return [];
    });
    generateSingleComment.mockResolvedValue({ comment: 'A valid comment', usage: {} });
    validateCommentLocally.mockReturnValue({ valid: true });
    normalizeCommentText.mockReturnValue('a valid comment');
    computeNormalizedHash.mockReturnValue('hash');
    withTransaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => operation({
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM generation_jobs j')) return { rows: [{
          job_id: 'job-1', cycle_id: 'cycle-1', campaign_id: 'campaign-1', campaign_post_id: 'post-1',
          slot_index: 0, slot_plan: {}, attempts_count: 0, post_text: 'Post', author_name: 'Author',
          author_username: 'author', accessible_context: {}, direction: null, model_key: 'model', provider: 'openai',
          api_model: 'model', input_price_per_million: 0, cached_input_price_per_million: null,
          output_price_per_million: 0, pricing_currency: 'USD',
        }] };
        if (sql.includes('WHERE id = $1 AND status = \'processing\'')) return { rows: [{ id: 'job-1' }] };
        if (sql.includes('FROM campaign_posts p')) return { rows: [] };
        return { rows: [] };
      }),
    }));

    await processBackgroundQueue('worker-test', MIN_WORKER_JOB_BUDGET_MS);

    const postLockQuery = queries.find((sql) => sql.includes('FROM campaign_posts p'))!.replace(/\s+/g, ' ');
    expect(postLockQuery).toMatch(/JOIN generation_cycles cy ON cy\.id = \$2/);
    expect(postLockQuery).toMatch(/\( c\.is_active = true OR \(c\.campaign_type = 'manual' AND cy\.cycle_type = 'initial'\) \)/);
  });
});
