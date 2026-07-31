import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PoolClient } from '@neondatabase/serverless';
import { triggerReplenishmentIfNeeded } from './services';
import { queryDb, withTransaction } from './db';
import { generateDeterministicSlotPlans } from './planner';

vi.mock('./db', () => ({
  queryDb: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('./planner', () => ({
  generateDeterministicSlotPlans: vi.fn(),
}));
vi.mock('./ai/models', () => ({
  DEFAULT_MODEL_KEY: 'test',
  getAiModel: vi.fn(() => ({ key: 'test', enabled: true, provider: 'openai', apiModel: 'test-model' })),
  isProviderConfigured: vi.fn(() => true)
}));

describe('triggerReplenishmentIfNeeded (limits & concurrency)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('respects max_comments_total by generating exactly the remaining capacity', async () => {
    const mockQueryDb = vi.mocked(queryDb);
    const mockWithTransaction = vi.mocked(withTransaction);
    const mockGenerateDeterministicSlotPlans = vi.mocked(generateDeterministicSlotPlans);

    mockQueryDb.mockResolvedValueOnce([{
      campaign_type: 'manual',
      replenishment_threshold: 5,
      replenishment_size: 10,
      model_key: 'test',
      max_comments_total: 100,
      brand_variants: []
    }]);

    const mockClient = { query: vi.fn() };
    mockWithTransaction.mockImplementation(async (cb) => {
      const typedClient = mockClient as unknown as PoolClient;
      return cb(typedClient);
    });

    mockClient.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // FOR UPDATE lock
    mockClient.query.mockResolvedValueOnce({ rows: [{ current_total: '93' }] }); // Usage
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'post-1' }] }); // Posts
    mockClient.query.mockResolvedValueOnce({ rows: [{ count: '2' }] }); // Available count
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // No pending cycles
    mockClient.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // Post lock
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'cycle-1' }] }); // Insert cycle

    mockGenerateDeterministicSlotPlans.mockReturnValue(Array.from({ length: 7 }, (_, i) => ({
      slotIndex: i, assignedPostId: 'post-1', lengthMode: 'normal', emojiPolicy: 'none', rhetoricalForm: 'statement', texture: 'neutral'
    })));

    await triggerReplenishmentIfNeeded('camp-1');

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('current_total'),
      ['camp-1']
    );

    expect(mockGenerateDeterministicSlotPlans).toHaveBeenCalledWith(['post-1'], 7, []);

    // Cycle is created with target_count = 7
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO generation_cycles'),
      ['camp-1', 'post-1', 7, 'test', expect.any(String)]
    );
  });

  it('skips replenishment if max_comments_total is reached', async () => {
    const mockQueryDb = vi.mocked(queryDb);
    const mockWithTransaction = vi.mocked(withTransaction);

    mockQueryDb.mockResolvedValueOnce([{
      campaign_type: 'manual',
      replenishment_threshold: 5,
      replenishment_size: 10,
      model_key: 'test',
      max_comments_total: 100,
      brand_variants: []
    }]);

    const mockClient = { query: vi.fn() };
    mockWithTransaction.mockImplementation(async (cb) => {
      const typedClient = mockClient as unknown as PoolClient;
      return cb(typedClient);
    });

    mockClient.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // FOR UPDATE lock
    mockClient.query.mockResolvedValueOnce({ rows: [{ current_total: '100' }] }); // Usage

    await triggerReplenishmentIfNeeded('camp-1');

    expect(mockClient.query).not.toHaveBeenCalledWith(
      expect.stringContaining('campaign_posts'),
      ['camp-1']
    );
  });
});
