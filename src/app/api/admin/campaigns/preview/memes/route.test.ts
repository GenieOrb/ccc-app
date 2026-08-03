import { describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, resolveImageModel } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(),
  validateSameOrigin: vi.fn(),
  resolveImageModel: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/ai/image-models', () => ({ resolveImageModel, createImageModelSnapshot: vi.fn() }));

import { POST } from './route';

describe('POST /api/admin/campaigns/preview/memes', () => {
  it('rechaza porcentajes de marca fuera del rango antes de resolver el modelo', async () => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);

    const response = await POST(new Request('http://localhost/api/admin/campaigns/preview/memes', {
      method: 'POST',
      body: JSON.stringify({
        campaignType: 'manual',
        urlsInput: 'https://x.com/example/status/1',
        memeModelKey: 'gpt-image-2',
        brandVariants: [{ value: 'GenieOrb', percentage: 101 }],
      }),
    }));

    expect(response.status).toBe(400);
    expect(resolveImageModel).not.toHaveBeenCalled();
  });
});
