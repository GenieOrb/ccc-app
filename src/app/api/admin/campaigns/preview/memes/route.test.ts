import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { isAdminAuthenticated, validateSameOrigin, resolveImageModel, createImageModelSnapshot, withTransaction, clientQuery, fetchXPosts, generateDeterministicMemeSlotPlans } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(),
  validateSameOrigin: vi.fn(),
  resolveImageModel: vi.fn(),
  createImageModelSnapshot: vi.fn(),
  withTransaction: vi.fn(),
  clientQuery: vi.fn(),
  fetchXPosts: vi.fn(),
  generateDeterministicMemeSlotPlans: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/ai/image-models', () => ({ resolveImageModel, createImageModelSnapshot }));
vi.mock('@/lib/db', () => ({ withTransaction }));
vi.mock('@/lib/x-api', () => ({ parseMultipleXUrls: vi.fn(() => ['https://x.com/example/status/1']), fetchXPosts, resolveXUsername: vi.fn(), fetchNewXPostsForAccount: vi.fn() }));
vi.mock('@/lib/x-accounts', () => ({ normalizeXAccounts: vi.fn() }));
vi.mock('@/lib/memes/planner', () => ({ generateDeterministicMemeSlotPlans }));
vi.mock('@/lib/internal-process-auth', () => ({ buildInternalProcessAuthorizationHeader: vi.fn(() => 'Bearer test') }));

import { isSuccessfulPreviewTrigger, POST } from './route';
import { getMemeTemplatesForProvider } from '@/lib/memes/templates';

describe('POST /api/admin/campaigns/preview/memes', () => {
  const draftId = '11111111-1111-4111-8111-111111111111';
  const cycleId = '22222222-2222-4222-8222-222222222222';
  const requestBody = { campaignType: 'manual', urlsInput: 'https://x.com/example/status/1', memeModelKey: 'gpt-image-2', draftId };

  beforeEach(() => {
    vi.clearAllMocks();
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    resolveImageModel.mockReturnValue({ key: 'gpt-image-2', provider: 'openai', apiModel: 'gpt-image-2' });
    createImageModelSnapshot.mockReturnValue({});
    fetchXPosts.mockResolvedValue([{ postId: 'post-1', textContent: 'post', authorName: 'Author', authorUsername: 'author', accessibleContext: null }]);
    generateDeterministicMemeSlotPlans.mockReturnValue([]);
    withTransaction.mockImplementation(async (callback: (client: { query: typeof clientQuery }) => unknown) => callback({ query: clientQuery }));
    vi.stubGlobal('fetch', vi.fn());
  });

  it('rejects a non-ok trigger or a trigger body without success: true', () => {
    expect(isSuccessfulPreviewTrigger(false, { success: true })).toBe(false);
    expect(isSuccessfulPreviewTrigger(true, { success: false })).toBe(false);
    expect(isSuccessfulPreviewTrigger(true, { success: true })).toBe(true);
  });

  it('rechaza porcentajes de marca fuera del rango antes de resolver el modelo', async () => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);

    const response = await POST(new Request('http://localhost/api/admin/campaigns/preview/memes', {
      method: 'POST',
      body: JSON.stringify({
        campaignType: 'manual',
        urlsInput: 'https://x.com/example/status/1',
        memeModelKey: 'gpt-image-2',
        brandVariants: [{ value: 'GenieOrb', percentage: 101 }],
      }),
    }));

    expect(response.status).toBe(400);
    expect(resolveImageModel).not.toHaveBeenCalled();
  });

  it('reuses a processing cycle and retriggers the internal worker', async () => {
    const digest = createHash('sha256').update(JSON.stringify({
      campaignType: 'manual', sourcePostId: 'post-1', postText: 'post', authorName: 'Author', authorUsername: 'author', accessibleContext: null,
      direction: 'Sin dirección específica.', memeModelKey: 'gpt-image-2', brandVariants: [], plannerVersion: 3,
    })).digest('hex');
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, inputs_digest FROM meme_drafts')) return { rowCount: 1, rows: [{ id: draftId, inputs_digest: digest }] };
      if (sql.includes('SELECT id, status FROM meme_generation_cycles')) return { rowCount: 1, rows: [{ id: cycleId, status: 'processing' }] };
      return { rowCount: 1, rows: [] };
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true })));

    const response = await POST(new Request('http://localhost/api/admin/campaigns/preview/memes', { method: 'POST', body: JSON.stringify(requestBody) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, draftId, cycleId, status: 'processing' });
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost/api/internal/generation/process',
      expect.objectContaining({ body: JSON.stringify({ memeCycleId: cycleId }) })
    );
  });

  it('returns retryable durable identifiers when triggering a pending cycle fails', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, inputs_digest FROM meme_drafts')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO meme_drafts')) return { rowCount: 1, rows: [{ id: draftId }] };
      if (sql.includes('INSERT INTO meme_generation_cycles')) return { rowCount: 1, rows: [{ id: cycleId }] };
      return { rowCount: 0, rows: [] };
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 502 }));

    const response = await POST(new Request('http://localhost/api/admin/campaigns/preview/memes', { method: 'POST', body: JSON.stringify(requestBody) }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ draftId, cycleId, status: 'pending', retryable: true });
  });

  it('creates exactly three jobs for slots 0, 1 and 2 in the same preview cycle and triggers that cycle', async () => {
    const jobInserts: unknown[][] = [];
    generateDeterministicMemeSlotPlans.mockReturnValue([
      { slotIndex: 0 },
      { slotIndex: 1 },
      { slotIndex: 2 },
    ]);
    clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, inputs_digest FROM meme_drafts')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO meme_drafts')) return { rowCount: 1, rows: [{ id: draftId }] };
      if (sql.includes('INSERT INTO meme_generation_cycles')) return { rowCount: 1, rows: [{ id: cycleId }] };
      if (sql.includes('SELECT id, asset_type')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO meme_generation_jobs')) {
        jobInserts.push(params || []);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: true })));

    await POST(new Request('http://localhost/api/admin/campaigns/preview/memes', { method: 'POST', body: JSON.stringify(requestBody) }));

    const openAiTemplateIds = getMemeTemplatesForProvider('openai').map((template) => template.id);
    expect(new Set(openAiTemplateIds).size).toBe(openAiTemplateIds.length);
    expect(generateDeterministicMemeSlotPlans).toHaveBeenCalledTimes(1);
    expect(generateDeterministicMemeSlotPlans.mock.calls[0][6]).toEqual(openAiTemplateIds);
    expect(jobInserts).toHaveLength(3);
    expect(jobInserts.map((params) => params.slice(0, 3))).toEqual([
      [cycleId, draftId, 0],
      [cycleId, draftId, 1],
      [cycleId, draftId, 2],
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost/api/internal/generation/process',
      expect.objectContaining({ body: JSON.stringify({ memeCycleId: cycleId }) })
    );
  });
});
