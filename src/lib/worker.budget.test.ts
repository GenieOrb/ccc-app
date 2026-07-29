import { describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction } = vi.hoisted(() => ({
  queryDb: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./openai', () => ({ generateSingleComment: vi.fn() }));
vi.mock('./ai/models', () => ({ getConfiguredFallbackModel: vi.fn() }));
vi.mock('./validator', () => ({
  computeNormalizedHash: vi.fn(),
  normalizeCommentText: vi.fn(),
  validateCommentLocally: vi.fn(),
}));

import { MIN_WORKER_JOB_BUDGET_MS, processBackgroundQueue } from './worker';

describe('processBackgroundQueue time budget', () => {
  it('does not query or claim a job below the minimum safe job budget', async () => {
    const result = await processBackgroundQueue('worker-test', MIN_WORKER_JOB_BUDGET_MS - 1);

    expect(result).toEqual({ processed: 0, completed: 0, failed: 0 });
    expect(withTransaction).not.toHaveBeenCalled();
    expect(queryDb).not.toHaveBeenCalled();
  });
});
