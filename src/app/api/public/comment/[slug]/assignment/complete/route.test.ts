import { beforeEach, describe, expect, it, vi } from 'vitest';

const { validateSameOrigin, getOrCreateVisitorIdentity, withTransaction } = vi.hoisted(() => ({
  validateSameOrigin: vi.fn(), getOrCreateVisitorIdentity: vi.fn(), withTransaction: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ validateSameOrigin }));
vi.mock('@/lib/visitor', () => ({ getOrCreateVisitorIdentity }));
vi.mock('@/lib/db', () => ({ withTransaction }));
import { POST } from './route';

const assignmentId = '00000000-0000-4000-8000-000000000001';
const params = { params: Promise.resolve({ slug: 'public-slug' }) };
const request = (body: unknown = { assignmentId }) => new Request('http://localhost/api/public/comment/public-slug/assignment/complete', { method: 'POST', headers: { Origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('public assignment completion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateSameOrigin.mockReturnValue(true);
    getOrCreateVisitorIdentity.mockResolvedValue({ visitorHash: 'visitor-hash' });
  });

  it('rejects cross-origin and malformed assignment ids before DB work', async () => {
    validateSameOrigin.mockReturnValue(false);
    expect((await POST(request(), params)).status).toBe(403);
    expect(withTransaction).not.toHaveBeenCalled();
    validateSameOrigin.mockReturnValue(true);
    expect((await POST(request({ assignmentId: 'not-a-uuid' }), params)).status).toBe(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 200, { status: 'expired' }],
    ['error', 400, { status: 'error', message: 'Please try again' }],
  ])('maps durable %s result without details', async (status, code, body) => {
    withTransaction.mockResolvedValue({ status });
    const response = await POST(request(), params);
    expect(response.status).toBe(code);
    expect(await response.json()).toEqual(body);
  });

  it('returns the canonical URL only after transaction success', async () => {
    withTransaction.mockResolvedValue({ status: 'success', canonicalUrl: 'https://x.com/user/status/1' });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'success', canonicalUrl: 'https://x.com/user/status/1' });
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transaction failures', async () => {
    withTransaction.mockRejectedValue(new Error('raw database failure'));
    const response = await POST(request(), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error', message: 'Please try again' });
  });
});
