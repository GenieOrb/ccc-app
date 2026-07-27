import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, processBackgroundQueue } = vi.hoisted(() => ({ isAdminAuthenticated: vi.fn(), validateSameOrigin: vi.fn(), processBackgroundQueue: vi.fn() }));
vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/worker', () => ({ processBackgroundQueue }));

import { POST } from './route';

describe('admin generation processor origin protection', () => {
  beforeEach(() => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    processBackgroundQueue.mockResolvedValue({ processed: 0, completed: 0, failed: 0 });
  });

  it('rejects an authenticated request from an invalid origin without running the worker', async () => {
    validateSameOrigin.mockReturnValue(false);
    const response = await POST(new Request('http://localhost/api/admin/generation/process', { method: 'POST' }));
    expect(response.status).toBe(403);
    expect(processBackgroundQueue).not.toHaveBeenCalled();
  });

  it('runs the worker only after authentication and origin validation', async () => {
    const response = await POST(new Request('http://localhost/api/admin/generation/process', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(processBackgroundQueue).toHaveBeenCalledOnce();
  });
});
