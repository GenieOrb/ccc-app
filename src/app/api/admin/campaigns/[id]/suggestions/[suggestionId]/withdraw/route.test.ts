import { describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, withTransaction, triggerReplenishmentIfNeeded } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(), validateSameOrigin: vi.fn(), withTransaction: vi.fn(), triggerReplenishmentIfNeeded: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/db', () => ({ withTransaction }));
vi.mock('@/lib/services', () => ({ triggerReplenishmentIfNeeded }));

import { POST } from './route';

describe('withdraw suggestion route', () => {
  it('waits for the durable replenishment nudge after committing a withdrawal', async () => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    withTransaction.mockImplementation((operation) => operation({ query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'suggestion-1', status: 'available' }] })
      .mockResolvedValueOnce({ rows: [] }) }));
    let completeNudge: (() => void) | undefined;
    triggerReplenishmentIfNeeded.mockReturnValue(new Promise<void>((resolve) => { completeNudge = resolve; }));

    let settled = false;
    const pending = POST(new Request('http://localhost/api/admin/campaigns/campaign-1/suggestions/suggestion-1/withdraw', { method: 'POST' }), {
      params: Promise.resolve({ id: 'campaign-1', suggestionId: 'suggestion-1' }),
    }).then(() => { settled = true; });
    await vi.waitFor(() => expect(triggerReplenishmentIfNeeded).toHaveBeenCalledWith('campaign-1'));
    expect(settled).toBe(false);
    completeNudge?.();
    await pending;
    expect(settled).toBe(true);
  });
});
