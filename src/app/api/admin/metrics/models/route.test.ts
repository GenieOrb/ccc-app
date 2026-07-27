import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, queryDb } = vi.hoisted(() => ({ isAdminAuthenticated: vi.fn(), queryDb: vi.fn() }));
vi.mock('@/lib/auth', () => ({ isAdminAuthenticated }));
vi.mock('@/lib/db', () => ({ queryDb }));
import { GET } from './route';

describe('model metrics route', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not query aggregate accounting without admin authentication', async () => {
    isAdminAuthenticated.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(queryDb).not.toHaveBeenCalled();
  });

  it('returns ledger-backed metrics without caching', async () => {
    isAdminAuthenticated.mockResolvedValue(true);
    queryDb.mockResolvedValue([{ modelKey: 'gpt-5.4-mini', estimatedCost: '0.00001234', inputTokens: 12, outputTokens: 3 }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ models: [{ modelKey: 'gpt-5.4-mini', estimatedCost: '0.00001234', inputTokens: 12, outputTokens: 3 }] });
    const sql = String(queryDb.mock.calls[0][0]);
    expect(sql).toContain('generation_api_calls');
    expect(sql).toContain("purpose IN ('generation','rewrite','fallback','preview')");
  });
});
