import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  isAdminAuthenticated: vi.fn(async () => true)
}));

vi.mock('@/lib/db', () => ({
  queryDb: vi.fn()
}));

import { GET } from './route';
import { queryDb } from '@/lib/db';

const mockQueryDb = vi.mocked(queryDb);

describe('GET /api/admin/meme-drafts/[draftId]/status', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const validDraftId = '94ac4268-7a9c-456d-8c6d-975cc4b59627';
  const validCycleId = '11111111-2222-3333-4444-555555555555';

  it('returns 400 if cycleId is missing or invalid', async () => {
    const req = new Request(`http://localhost/api/admin/meme-drafts/${validDraftId}/status`);
    const res = await GET(req, { params: Promise.resolve({ draftId: validDraftId }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('inválidos');
  });

  it('returns 404 if cycle is not found for draft', async () => {
    mockQueryDb.mockResolvedValueOnce([]);

    const req = new Request(`http://localhost/api/admin/meme-drafts/${validDraftId}/status?cycleId=${validCycleId}`);
    const res = await GET(req, { params: Promise.resolve({ draftId: validDraftId }) });

    expect(res.status).toBe(404);
  });

  it('returns status strictly filtered by cycleId and safely parses pre-parsed JSONB slot_plan', async () => {
    mockQueryDb
      // 1. cycle query
      .mockResolvedValueOnce([
        {
          id: validCycleId,
          status: 'completed',
          target_count: 3,
          model_key: 'gemini-3.1-flash-image',
          provider: 'google',
          api_model: 'gemini-3.1-flash-image',
          error_message: null,
          updated_at: '2026-08-02T22:00:00Z'
        }
      ])
      // 2. jobs query
      .mockResolvedValueOnce([
        { id: 'job-1', status: 'completed', error_message: null },
        { id: 'job-2', status: 'completed', error_message: null },
        { id: 'job-3', status: 'completed', error_message: null }
      ])
      // 3. memes query (pre-parsed slot_plan object returned by pg driver)
      .mockResolvedValueOnce([
        { id: 'meme-1', mime_type: 'image/png', slot_plan: { slotIndex: 0, textPolicy: 'no_text' } }
      ]);

    const req = new Request(`http://localhost/api/admin/meme-drafts/${validDraftId}/status?cycleId=${validCycleId}`);
    const res = await GET(req, { params: Promise.resolve({ draftId: validDraftId }) });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.draftId).toBe(validDraftId);
    expect(data.cycleId).toBe(validCycleId);
    expect(data.completedCount).toBe(3);
    expect(data.terminal).toBe(true);
    expect(data.memes).toHaveLength(1);
    expect(data.memes[0].plan.slotIndex).toBe(0);
    expect(data.memes[0].url).toContain(`/api/admin/meme-drafts/${validDraftId}/memes/meme-1/view`);
  });

  it('logs sanitized error and returns 500 when database throws an exception', async () => {
    mockQueryDb.mockRejectedValueOnce(new Error('DB Connection Refused'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = new Request(`http://localhost/api/admin/meme-drafts/${validDraftId}/status?cycleId=${validCycleId}`);
    const res = await GET(req, { params: Promise.resolve({ draftId: validDraftId }) });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('No se pudo consultar el estado de la preview.');
    expect(consoleSpy).toHaveBeenCalledWith('Meme preview status failed', expect.objectContaining({
      draftId: validDraftId,
      cycleId: validCycleId,
      errorMessage: 'DB Connection Refused'
    }));

    consoleSpy.mockRestore();
  });
});
