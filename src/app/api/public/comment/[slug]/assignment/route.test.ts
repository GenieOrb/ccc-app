import { beforeEach, describe, expect, it, vi } from 'vitest';

const { validateSameOrigin, getOrCreateVisitorIdentity, checkPublicAssignmentRateLimit, extractClientIp, assignCommentToVisitor } = vi.hoisted(() => ({
  validateSameOrigin: vi.fn(), getOrCreateVisitorIdentity: vi.fn(), checkPublicAssignmentRateLimit: vi.fn(), extractClientIp: vi.fn(), assignCommentToVisitor: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ validateSameOrigin }));
vi.mock('@/lib/visitor', () => ({ getOrCreateVisitorIdentity }));
vi.mock('@/lib/rate-limit', () => ({ checkPublicAssignmentRateLimit, extractClientIp }));
vi.mock('@/lib/services', () => ({ assignCommentToVisitor }));
import { POST } from './route';

const params = { params: Promise.resolve({ slug: 'public-slug' }) };
const request = () => new Request('http://localhost/api/public/comment/public-slug/assignment', { method: 'POST', headers: { Origin: 'http://localhost' } });

describe('public assignment route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateSameOrigin.mockReturnValue(true);
    getOrCreateVisitorIdentity.mockResolvedValue({ visitorHash: 'visitor-hash' });
    extractClientIp.mockReturnValue('127.0.0.1');
    checkPublicAssignmentRateLimit.mockResolvedValue({ allowed: true });
  });

  it('rejects a cross-origin request before visitor or assignment work', async () => {
    validateSameOrigin.mockReturnValue(false);
    const response = await POST(request(), params);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: 'error', message: 'Please try again' });
    expect(assignCommentToVisitor).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 200, { status: 'expired' }],
    ['unavailable', 200, { status: 'unavailable', message: 'This link is currently unavailable. Please try again later.' }],
    ['no_inventory', 503, { status: 'no_inventory', message: 'Please try again' }],
    ['generating', 200, { status: 'generating', retryAfterMs: 750 }],
    ['rate_limited', 429, { status: 'rate_limited', message: 'Please try again' }],
  ])('maps %s without exposing internals', async (status, code, body) => {
    assignCommentToVisitor.mockResolvedValue(status === 'generating' ? { status, retryAfterMs: 750 } : { status });
    const response = await POST(request(), params);
    expect(response.status).toBe(code);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns only the assigned public fields and supplies a deferred rate-limit check', async () => {
    assignCommentToVisitor.mockResolvedValue({ status: 'success', assignmentId: 'assignment-1', comment: 'Comentario', postUrl: 'https://x.com/user/status/1' });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'success', assignmentId: 'assignment-1', comment: 'Comentario', postUrl: 'https://x.com/user/status/1' });
    expect(assignCommentToVisitor).toHaveBeenCalledWith('public-slug', 'visitor-hash', expect.any(Function));
    const rateCheck = assignCommentToVisitor.mock.calls[0][2];
    await expect(rateCheck()).resolves.toBe(true);
    expect(checkPublicAssignmentRateLimit).toHaveBeenCalledWith('127.0.0.1');
  });

  it('sanitizes unexpected service failures', async () => {
    assignCommentToVisitor.mockRejectedValue(new Error('database detail'));
    const response = await POST(request(), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error', message: 'Please try again' });
  });
});
