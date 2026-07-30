import { describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction } = vi.hoisted(() => ({ queryDb: vi.fn(), withTransaction: vi.fn() }));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./openai', () => ({ generateSingleComment: vi.fn() }));
vi.mock('./ai/models', () => ({ getConfiguredFallbackModel: vi.fn() }));
vi.mock('./validator', () => ({ computeNormalizedHash: vi.fn(), normalizeCommentText: vi.fn(), validateCommentLocally: vi.fn() }));

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
});
