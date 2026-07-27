import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, generateCampaignPreview, listCampaignPreviews } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(), validateSameOrigin: vi.fn(), generateCampaignPreview: vi.fn(), listCampaignPreviews: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/services', () => ({ generateCampaignPreview, listCampaignPreviews }));
import { GET, POST } from './route';

const params = { params: Promise.resolve({ id: 'campaign-1' }) };
const request = () => new Request('http://localhost/api/admin/campaigns/campaign-1/preview', { method: 'POST', headers: { Origin: 'http://localhost' } });

describe('campaign preview route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
  });

  it('requires admin authentication for history and generation', async () => {
    isAdminAuthenticated.mockResolvedValue(false);
    expect((await GET(request(), params)).status).toBe(401);
    expect((await POST(request(), params)).status).toBe(401);
    expect(listCampaignPreviews).not.toHaveBeenCalled();
    expect(generateCampaignPreview).not.toHaveBeenCalled();
  });

  it('returns persisted preview history without caching', async () => {
    listCampaignPreviews.mockResolvedValue([{ id: 'preview-1' }]);
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ previews: [{ id: 'preview-1' }] });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(listCampaignPreviews).toHaveBeenCalledWith('campaign-1');
  });

  it('enforces Origin before invoking generation', async () => {
    validateSameOrigin.mockReturnValue(false);
    const response = await POST(request(), params);
    expect(response.status).toBe(403);
    expect(generateCampaignPreview).not.toHaveBeenCalled();
  });

  it('returns the generated preview and sanitizes a service failure', async () => {
    generateCampaignPreview.mockResolvedValue({ postId: 'post-1', comments: ['one'] });
    const success = await POST(request(), params);
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ success: true, preview: { postId: 'post-1', comments: ['one'] } });
    expect(generateCampaignPreview).toHaveBeenCalledWith('campaign-1');

    generateCampaignPreview.mockRejectedValue(new Error('No hay ningún post vigente para generar la preview.'));
    const failure = await POST(request(), params);
    expect(failure.status).toBe(400);
    expect((await failure.json()).error).toBe('No hay ningún post vigente para generar la preview.');
  });
});
