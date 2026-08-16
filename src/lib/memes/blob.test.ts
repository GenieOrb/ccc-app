import { beforeEach, describe, expect, it, vi } from 'vitest';

const { del } = vi.hoisted(() => ({ del: vi.fn() }));

vi.mock('@vercel/blob', () => ({
  put: vi.fn(),
  del,
  head: vi.fn(),
  get: vi.fn(),
}));

import { deleteBlob, deleteBlobStrict } from './blob';

describe('Blob deletion contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates provider deletion failures from the strict helper', async () => {
    const providerError = new Error('provider unavailable');
    del.mockRejectedValueOnce(providerError);

    await expect(deleteBlobStrict('memes/assets/asset.png')).rejects.toBe(providerError);
  });

  it('keeps the existing tolerant helper non-throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    del.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(deleteBlob('memes/assets/asset.png')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
