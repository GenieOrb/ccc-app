import { describe, expect, it, vi } from 'vitest';

const { processMemeBackgroundQueue } = vi.hoisted(() => ({
  processMemeBackgroundQueue: vi.fn()
}));

vi.mock('./worker.memes', () => ({
  MIN_MEME_WORKER_JOB_BUDGET_MS: 25_000,
  processMemeBackgroundQueue
}));

vi.mock('./db', () => ({
  queryDb: vi.fn(),
  withTransaction: vi.fn()
}));

vi.mock('./openai', () => ({
  generateSingleComment: vi.fn()
}));

vi.mock('./ai/models', () => ({
  getConfiguredFallbackModel: vi.fn()
}));

import { runGenerationProcessing } from './worker';

describe('runGenerationProcessing meme previews', () => {
  it('processes directed meme previews concurrently', async () => {
    processMemeBackgroundQueue.mockResolvedValue({ processed: 3, completed: 3, failed: 0 });

    await runGenerationProcessing('worker-1', 50_000, 'cycle-1');

    expect(processMemeBackgroundQueue).toHaveBeenCalledWith({
      workerId: 'worker-1',
      budgetMs: 50_000,
      cycleId: 'cycle-1',
      maxConcurrency: 3,
      maxJobs: 3
    });
  });
});
