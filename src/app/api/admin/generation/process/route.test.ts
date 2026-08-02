import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, runGenerationProcessing } = vi.hoisted(() => ({ isAdminAuthenticated: vi.fn(), validateSameOrigin: vi.fn(), runGenerationProcessing: vi.fn() }));
vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/worker', () => ({ runGenerationProcessing }));

import { POST } from './route';

describe('admin generation processor origin protection', () => {
  beforeEach(() => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    runGenerationProcessing.mockResolvedValue({ worker: { processed: 0 }, workerMemes: { processed: 0 } });
  });

  it('rejects an authenticated request from an invalid origin without running the worker', async () => {
    validateSameOrigin.mockReturnValue(false);
    const response = await POST(new Request('http://localhost/api/admin/generation/process', { method: 'POST' }));
    expect(response.status).toBe(403);
    expect(runGenerationProcessing).not.toHaveBeenCalled();
  });

  it('runs the worker only after authentication and origin validation', async () => {
    const response = await POST(new Request('http://localhost/api/admin/generation/process', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(runGenerationProcessing).toHaveBeenCalledOnce();
  });
});
