import { describe, expect, it, vi } from 'vitest';

const { queryDb } = vi.hoisted(() => ({ queryDb: vi.fn() }));
vi.mock('./db', () => ({ queryDb, withTransaction: vi.fn() }));

import { getCampaignsPage } from './services';

describe('getCampaignsPage', () => {
  it('clamps pages and passes deterministic LIMIT/OFFSET metadata to the database', async () => {
    queryDb.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) AS total')) return [{ total: '25' }];
      if (sql.includes('FROM campaigns')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await getCampaignsPage('https://app.example/', 99, 10.9);
    expect(result).toEqual({ items: [], page: 3, pageSize: 10, total: 25, totalPages: 3 });
    const campaignQuery = queryDb.mock.calls.find(([sql]) => String(sql).includes('ORDER BY internal_number DESC'));
    expect(campaignQuery?.[1]).toEqual([10, 20]);
    expect(campaignQuery?.[0]).toContain('LIMIT $1 OFFSET $2');
  });

  it('uses page one and a minimum page size for invalid lower bounds', async () => {
    queryDb.mockImplementation(async (sql: string) => sql.includes('COUNT(*) AS total') ? [{ total: '0' }] : []);
    const result = await getCampaignsPage('https://app.example', -4, 0);
    expect(result).toMatchObject({ page: 1, pageSize: 1, total: 0, totalPages: 1 });
    const campaignQuery = queryDb.mock.calls.find(([sql]) => String(sql).includes('ORDER BY internal_number DESC'));
    expect(campaignQuery?.[1]).toEqual([1, 0]);
  });

  it('includes accumulated recorded costs from usage metrics and API calls', async () => {
    queryDb.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) AS total')) return [{ total: '1' }];
      if (sql.includes('FROM campaigns')) return [{
        id: 'campaign-1', internal_number: 1, slug: 'slug', campaign_type: 'manual', post_active_lifetime_hours: null,
        direction: null, display_name: null, model_key: 'gpt-5.4', is_active: true, safety_allowed: true,
        safety_category: null, safety_reason: null, initial_size: 1, created_at: new Date('2026-01-01T00:00:00Z'),
      }];
      if (sql.includes('FROM campaign_posts')) return [];
      if (sql.includes('FROM generation_usage_metrics')) return [{
        valid_generated: '1', available: '1', assigned: '0', withdrawn: '0', pending_processing_jobs: '0', failed_jobs: '0',
        has_failed_cycle: false, recorded_cost: '0.12500000',
      }];
      if (sql.includes('FROM campaign_accounts')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await getCampaignsPage('https://app.example', 1, 10);

    expect(result.items[0].recordedCost).toBe(0.125);
    const costQuery = queryDb.mock.calls.find(([sql]) => String(sql).includes('generation_usage_metrics'))?.[0] as string;
    expect(costQuery).toContain('generation_api_calls');
    expect(costQuery).toContain('estimated_cost IS NOT NULL');
  });
});
