import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth', () => ({
  isAdminAuthenticated: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  queryDb: vi.fn(),
}));

describe('Costs Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 if not authenticated', async () => {
    vi.mocked(isAdminAuthenticated).mockResolvedValue(false);
    const res = await GET() as NextResponse;
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should return 500 on db error safely sanitized', async () => {
    vi.mocked(isAdminAuthenticated).mockResolvedValue(true);
    vi.mocked(queryDb).mockRejectedValue(new Error('DB Error'));
    const res = await GET() as NextResponse;
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('DB Error');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should return correctly summed costs', async () => {
    vi.mocked(isAdminAuthenticated).mockResolvedValue(true);
    vi.mocked(queryDb).mockResolvedValue([{
      ai_cost: '10.50',
      ai_memes_cost: '2.00',
      x_cost: '2.00',
      unknown_ai: '0',
      unknown_x: '0'
    }]);

    const res = await GET() as NextResponse;
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toEqual({
      periodDays: 30,
      currency: "USD",
      aiCost: 10.50,
      aiMemesCost: 2.00,
      xCost: 2.00,
      totalCost: 14.50,
      costIsComplete: true,
      unknownAiCostCalls: 0,
      unknownXCostCalls: 0
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should handle unknown costs gracefully', async () => {
    vi.mocked(isAdminAuthenticated).mockResolvedValue(true);
    vi.mocked(queryDb).mockResolvedValue([{
      ai_cost: '0',
      ai_memes_cost: null,
      x_cost: null,
      unknown_ai: '1',
      unknown_x: '5'
    }]);

    const res = await GET() as NextResponse;
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toEqual({
      periodDays: 30,
      currency: "USD",
      aiCost: 0,
      aiMemesCost: 0,
      xCost: 0,
      totalCost: 0,
      costIsComplete: false,
      unknownAiCostCalls: 1,
      unknownXCostCalls: 5
    });
  });
});
