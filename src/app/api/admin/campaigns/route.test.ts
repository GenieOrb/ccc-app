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
    const valid = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', direction: 'amable', displayName: 'Prueba', modelKey: 'model-a', creationMode: 'active' }) }));
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ success: true, campaign: { id: 'manual-1', campaignType: 'manual' } });
    expect(createCampaign).toHaveBeenCalledWith({ urlsInput: 'https://x.com/a/status/1', direction: 'amable', displayName: 'Prueba', modelKey: 'model-a', brandVariants: undefined, maxCommentsTotal: undefined, isInactive: false });

    const ambiguous = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', accountsInput: '@someone' }) }));
    expect(ambiguous.status).toBe(400);
    expect(createCampaign).toHaveBeenCalledTimes(1);
  });

  it('creates a valid manual campaign with inactive mode and optional parameters', async () => {
    const valid = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', creationMode: 'inactive', brandVariants: [], maxCommentsTotal: 100 }) }));
    expect(valid.status).toBe(200);
    expect(createCampaign).toHaveBeenCalledWith({ urlsInput: 'https://x.com/a/status/1', direction: undefined, displayName: undefined, modelKey: undefined, brandVariants: [], maxCommentsTotal: 100, isInactive: true });
  });

  it('preserves compatibility when creationMode is omitted', async () => {
    const valid = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1' }) }));
    expect(valid.status).toBe(200);
    expect(createCampaign).toHaveBeenCalledWith(expect.objectContaining({ isInactive: false }));
  });

  it('rejects unknown creationMode values', async () => {
    const invalid = await POST(new Request('http://localhost/api/admin/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', creationMode: 'invalid' }) }));
    expect(invalid.status).toBe(400);
  });

  it('returns the awaited initial perpetual synchronization result when active', async () => {
    createPerpetualCampaign.mockResolvedValue({ id: 'perpetual-1', slug: 'perpetual-slug', initialSync: { accountsProcessed: 1, postsImported: 1, errors: [] } });
    const response = await POST(new Request('http://localhost/api/admin/campaigns', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campaignType: 'perpetual', accountsInput: '@author', postActiveLifetimeHours: 24, creationMode: 'active' }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ campaign: { id: 'perpetual-1', campaignType: 'perpetual' }, initialSync: { accountsProcessed: 1, postsImported: 1 } });
    expect(createPerpetualCampaign).toHaveBeenCalledWith(expect.objectContaining({ accountsInput: '@author', postActiveLifetimeHours: 24, isInactive: false }));
  });

  it('returns pending initial sync when a perpetual campaign is saved as inactive', async () => {
    createPerpetualCampaign.mockResolvedValue({ id: 'perpetual-1', slug: 'perpetual-slug', initialSync: null });
    const response = await POST(new Request('http://localhost/api/admin/campaigns', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campaignType: 'perpetual', accountsInput: '@author', postActiveLifetimeHours: 24, creationMode: 'inactive' }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ campaign: { id: 'perpetual-1', campaignType: 'perpetual' }, initialSync: { pending: true } });
    expect(createPerpetualCampaign).toHaveBeenCalledWith(expect.objectContaining({ accountsInput: '@author', postActiveLifetimeHours: 24, isInactive: true }));
  });

  it('propagates an uploaded-meme draft and cadence for manual and perpetual campaigns', async () => {
    createPerpetualCampaign.mockResolvedValue({ id: 'perpetual-1', slug: 'perpetual-slug', initialSync: null });
    const payloads = [
      { campaignType: 'manual', urlsInput: 'https://x.com/a/status/1' },
      { campaignType: 'perpetual', accountsInput: '@author', postActiveLifetimeHours: 24 },
    ];

    for (const payload of payloads) {
      const response = await POST(new Request('http://localhost/api/admin/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, includeMemes: true, draftId: 'draft-1', memeEveryComments: 7 }),
      }));
      expect(response.status).toBe(200);
    }

    expect(createCampaign).toHaveBeenLastCalledWith(expect.objectContaining({ includeMemes: true, draftId: 'draft-1', memeEveryComments: 7 }));
    expect(createPerpetualCampaign).toHaveBeenLastCalledWith(expect.objectContaining({ includeMemes: true, draftId: 'draft-1', memeEveryComments: 7 }));
  });

  it('rejects draft/cadence combinations that cannot create uploaded-meme campaigns', async () => {
    const requests = [
      { campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', includeMemes: false, draftId: 'draft-1' },
      { campaignType: 'perpetual', accountsInput: '@author', postActiveLifetimeHours: 24, includeMemes: true, draftId: 'draft-1', memeEveryComments: 0 },
    ];

    for (const body of requests) {
      const response = await POST(new Request('http://localhost/api/admin/campaigns', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
    }
    expect(createCampaign).not.toHaveBeenCalled();
    expect(createPerpetualCampaign).not.toHaveBeenCalled();
  });

  describe('maxCommentsTotal validation', () => {
    it('accepts a valid maxCommentsTotal', async () => {
      const response = await POST(new Request('http://localhost/api/admin/campaigns', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', maxCommentsTotal: 500 })
      }));
      expect(response.status).toBe(200);
      expect(createCampaign).toHaveBeenCalledWith(expect.objectContaining({ maxCommentsTotal: 500 }));
    });

    it('accepts when maxCommentsTotal is undefined (omitted)', async () => {
      const response = await POST(new Request('http://localhost/api/admin/campaigns', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1' })
      }));
      expect(response.status).toBe(200);
      expect(createCampaign).toHaveBeenCalledWith(expect.objectContaining({ urlsInput: 'https://x.com/a/status/1' }));
    });

    it('rejects invalid maxCommentsTotal values', async () => {
      const invalidValues = [
        0, -1, 1000001, 5.5, '100', null
      ];

      for (const value of invalidValues) {
        const response = await POST(new Request('http://localhost/api/admin/campaigns', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ campaignType: 'manual', urlsInput: 'https://x.com/a/status/1', maxCommentsTotal: value })
        }));
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('El máximo de comentarios debe ser un entero entre 1 y 1.000.000.');
      }
    });
  });
});
