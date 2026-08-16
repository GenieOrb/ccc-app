import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, cancelCampaign } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(), validateSameOrigin: vi.fn(), cancelCampaign: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/services', () => ({ cancelCampaign }));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 'campaign-1' }) };
const request = () => new Request('http://localhost/api/admin/campaigns/campaign-1/cancel', { method: 'POST' });

describe('campaign cancellation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    cancelCampaign.mockResolvedValue({
      cancelledAt: '2026-08-16T12:34:56.000Z', cleanupPending: false,
      attemptedCount: 1, retiredCount: 1, failedCount: 0,
    });
  });

  it('requires admin authentication and same-origin before cancellation', async () => {
    isAdminAuthenticated.mockResolvedValueOnce(false);
    expect((await POST(request(), context)).status).toBe(401);
    expect(cancelCampaign).not.toHaveBeenCalled();

    isAdminAuthenticated.mockResolvedValueOnce(true);
    validateSameOrigin.mockReturnValueOnce(false);
    expect((await POST(request(), context)).status).toBe(403);
    expect(cancelCampaign).not.toHaveBeenCalled();
  });

  it('returns an observable successful cancellation', async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true, cancelled: true, cleanupPending: false, retiredCount: 1, failedCount: 0,
    });
    expect(cancelCampaign).toHaveBeenCalledWith('campaign-1');
  });

  it('does not confirm success while blob cleanup remains pending', async () => {
    cancelCampaign.mockResolvedValueOnce({
      cancelledAt: '2026-08-16T12:34:56.000Z', cleanupPending: true,
      attemptedCount: 1, retiredCount: 0, failedCount: 1,
    });
    const response = await POST(request(), context);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false, cancelled: true, cleanupPending: true, failedCount: 1,
    });
  });
});
