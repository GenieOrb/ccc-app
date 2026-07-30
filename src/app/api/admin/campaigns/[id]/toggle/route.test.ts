import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, toggleCampaignStatus } = vi.hoisted(() => ({ isAdminAuthenticated: vi.fn(), validateSameOrigin: vi.fn(), toggleCampaignStatus: vi.fn() }));
vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/services', () => ({ toggleCampaignStatus }));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 'campaign-1' }) };

describe('campaign toggle route', () => {
  beforeEach(() => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    toggleCampaignStatus.mockResolvedValue(false);
  });

  it('persists and returns the server status only for an authenticated same-origin request', async () => {
    const response = await POST(new Request('http://localhost/api/admin/campaigns/campaign-1/toggle', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, isActive: false });
    expect(toggleCampaignStatus).toHaveBeenCalledWith('campaign-1');
  });

  it('does not return activation success until the service finishes its recovery work', async () => {
    let finishRecovery!: (isActive: boolean) => void;
    toggleCampaignStatus.mockReturnValue(new Promise((resolve) => { finishRecovery = resolve; }));
    const pending = POST(new Request('http://localhost/api/admin/campaigns/campaign-1/toggle', { method: 'POST' }), context);

    await vi.waitFor(() => expect(toggleCampaignStatus).toHaveBeenCalledWith('campaign-1'));
    finishRecovery(true);

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, isActive: true });
  });

  it('rejects cross-origin requests before touching campaign state', async () => {
    validateSameOrigin.mockReturnValue(false);
    const response = await POST(new Request('http://localhost/api/admin/campaigns/campaign-1/toggle', { method: 'POST' }), context);
    expect(response.status).toBe(403);
    expect(toggleCampaignStatus).not.toHaveBeenCalled();
  });
});
