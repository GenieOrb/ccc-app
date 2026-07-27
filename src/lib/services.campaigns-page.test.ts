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
});
