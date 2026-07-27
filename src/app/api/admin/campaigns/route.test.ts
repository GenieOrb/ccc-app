import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, getConfig, getCampaignsPage, createCampaign, createPerpetualCampaign } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(), validateSameOrigin: vi.fn(), getConfig: vi.fn(), getCampaignsPage: vi.fn(), createCampaign: vi.fn(), createPerpetualCampaign: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/config', () => ({ getConfig }));
vi.mock('@/lib/services', () => ({ getCampaignsPage, createCampaign, createPerpetualCampaign }));

import { GET, POST } from './route';

describe('admin campaigns route', () => {
  beforeEach(() => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    getConfig.mockReturnValue({ appBaseUrl: 'http://localhost' });
    getCampaignsPage.mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, totalPages: 1 });
    createCampaign.mockResolvedValue({ id: 'manual-1', slug: 'manual-slug' });
  });

  it('requires authentication for GET and POST before reading or mutating campaigns', async () => {
    isAdminAuthenticated.mockResolvedValue(false);
    const get = await GET(new Request('http://localhost/api/admin/campaigns?page=1'));
    const post = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', body: '{}' }));
    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
    expect(getCampaignsPage).not.toHaveBeenCalled();
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it('uses a validated page and returns the paged contract', async () => {
    getCampaignsPage.mockResolvedValue({ items: [{ id: 'c1' }], page: 2, pageSize: 10, total: 13, totalPages: 2 });
    const response = await GET(new Request('http://localhost/api/admin/campaigns?page=2'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ page: 2, total: 13, totalPages: 2 });
    expect(getCampaignsPage).toHaveBeenCalledWith('http://localhost', 2, 10);
  });

  it('rejects a cross-origin POST before calling creation services', async () => {
    validateSameOrigin.mockReturnValue(false);
    const response = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1' }) }));
    expect(response.status).toBe(403);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it('creates a valid manual campaign and rejects ambiguous manual payloads', async () => {
    const valid = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', direction: 'amable', displayName: 'Prueba', modelKey: 'model-a' }) }));
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ success: true, campaign: { id: 'manual-1', campaignType: 'manual' } });
    expect(createCampaign).toHaveBeenCalledWith({ urlsInput: 'https://x.com/a/status/1', direction: 'amable', displayName: 'Prueba', modelKey: 'model-a' });

    const ambiguous = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', accountsInput: '@someone' }) }));
    expect(ambiguous.status).toBe(400);
    expect(createCampaign).toHaveBeenCalledTimes(1);
  });
});
