import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, queryDb, withTransaction, uploadMemeAsset, deleteBlob, deleteBlobStrict, clientQuery } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(),
  validateSameOrigin: vi.fn(),
  queryDb: vi.fn(),
  withTransaction: vi.fn(),
  uploadMemeAsset: vi.fn(),
  deleteBlob: vi.fn(),
  deleteBlobStrict: vi.fn(),
  clientQuery: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/db', () => ({ queryDb, withTransaction }));
vi.mock('@/lib/memes/blob', () => ({ uploadMemeAsset, deleteBlob, deleteBlobStrict }));
vi.mock('sharp', () => ({
  default: vi.fn(() => {
    const image = {
      metadata: vi.fn().mockResolvedValue({ width: 10, height: 10 }),
      rotate: vi.fn(() => image),
      png: vi.fn(() => image),
      toBuffer: vi.fn().mockResolvedValue(Buffer.from('safe-png')),
    };
    return image;
  }),
}));

import { POST } from './route';

function uploadRequest(draftId: string) {
  const file = {
    size: 3,
    type: 'image/png',
    arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
  };
  return {
    formData: vi.fn().mockResolvedValue({
      get: (name: string) => name === 'file' ? file : name === 'draftId' ? draftId : null,
    }),
  } as unknown as Request;
}

describe('POST /api/admin/meme-drafts/assets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    uploadMemeAsset.mockResolvedValue({ pathname: 'draft-1/asset.png', url: 'https://blob.test/asset.png' });
    deleteBlob.mockResolvedValue(undefined);
    deleteBlobStrict.mockResolvedValue(undefined);
    queryDb.mockResolvedValue([{ id: 'asset-1' }]);
    withTransaction.mockImplementation(async (operation: (client: { query: typeof clientQuery }) => unknown) => operation({ query: clientQuery }));
  });

  it.each(['converted', 'expired', 'missing'])(
    'compensates the uploaded blob and returns 409 when the draft becomes %s before persistence',
    async () => {
      clientQuery.mockResolvedValue({ rows: [] });

      const response = await POST(uploadRequest('draft-1'));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expect.any(String), cleanupPending: false });
      expect(withTransaction).toHaveBeenCalledTimes(1);
      expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['draft-1']);
      expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO meme_assets'))).toBe(false);
      expect(deleteBlobStrict).toHaveBeenCalledWith('draft-1/asset.png');
      expect(deleteBlob).not.toHaveBeenCalled();
    },
  );

  it('locks and persists against the draft it creates when draftId is omitted', async () => {
    queryDb.mockResolvedValueOnce([{ id: 'created-draft' }]);
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [{ id: 'created-draft' }] };
      if (sql.includes('INSERT INTO meme_assets')) return { rows: [{ id: 'asset-1' }] };
      return { rows: [] };
    });

    const response = await POST(uploadRequest(''));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ draftId: 'created-draft', assetId: 'asset-1' });
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['created-draft']);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO meme_assets'), expect.arrayContaining(['created-draft']));
  });

  it('removes only the newly created empty draft when its first Blob upload fails', async () => {
    queryDb
      .mockResolvedValueOnce([{ id: 'created-draft' }])
      .mockResolvedValueOnce([]);
    uploadMemeAsset.mockRejectedValueOnce(new Error('blob unavailable'));

    const response = await POST(uploadRequest(''));

    expect(response.status).toBe(500);
    expect(queryDb).toHaveBeenCalledTimes(2);
    const [cleanupSql, cleanupParams] = queryDb.mock.calls[1];
    expect(cleanupSql).toMatch(/DELETE\s+FROM\s+meme_drafts/i);
    expect(cleanupSql).toMatch(/NOT\s+EXISTS[\s\S]*FROM\s+meme_assets/i);
    expect(cleanupParams).toEqual(['created-draft']);
  });

  it('never removes a pre-existing draft when its Blob upload fails', async () => {
    uploadMemeAsset.mockRejectedValueOnce(new Error('blob unavailable'));

    const response = await POST(uploadRequest('existing-draft'));

    expect(response.status).toBe(500);
    expect(queryDb.mock.calls.some(([sql]) => /DELETE\s+FROM\s+meme_drafts/i.test(String(sql)))).toBe(false);
  });

  it('reports pending cleanup after persistence fails and strict Blob deletion also fails', async () => {
    const oversizedMessage = 'x'.repeat(2_000);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
      if (sql.includes('INSERT INTO meme_assets')) throw new Error('database unavailable');
      return { rows: [] };
    });
    deleteBlobStrict.mockRejectedValueOnce(new Error(oversizedMessage));

    const response = await POST(uploadRequest('draft-1'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: expect.any(String), cleanupPending: true });
    expect(deleteBlobStrict).toHaveBeenCalledWith('draft-1/asset.png');
    expect(deleteBlob).not.toHaveBeenCalled();
    const cleanupLog = errorSpy.mock.calls.find(([message]) => message === 'Blob cleanup failed');
    expect(cleanupLog).toBeDefined();
    expect(String((cleanupLog?.[1] as { message?: string })?.message)).not.toBe(oversizedMessage);
    expect(String((cleanupLog?.[1] as { message?: string })?.message).length).toBeLessThanOrEqual(240);
    errorSpy.mockRestore();
  });

  it('keeps the conflict status and reports pending cleanup when strict Blob deletion fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clientQuery.mockResolvedValue({ rows: [] });
    deleteBlobStrict.mockRejectedValueOnce(new Error('delete unavailable'));

    const response = await POST(uploadRequest('draft-1'));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.any(String), cleanupPending: true });
    expect(deleteBlobStrict).toHaveBeenCalledWith('draft-1/asset.png');
    expect(deleteBlob).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
