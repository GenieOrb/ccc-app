import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, withTransaction, deleteBlobStrict, clientQuery } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(),
  validateSameOrigin: vi.fn(),
  withTransaction: vi.fn(),
  deleteBlobStrict: vi.fn(),
  clientQuery: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/db', () => ({ withTransaction }));
vi.mock('@/lib/memes/blob', () => ({ deleteBlobStrict }));

import { DELETE, PATCH } from './route';

const params = { params: Promise.resolve({ draftId: 'draft-1', assetId: 'asset-1' }) };

function patchRequest() {
  return new Request('http://localhost', {
    method: 'PATCH',
    body: JSON.stringify({ assetType: 'logo', percentage: 10, instruction: '' }),
    headers: { 'content-type': 'application/json' },
  });
}

describe('PATCH and DELETE meme draft assets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    withTransaction.mockImplementation(async (operation: (client: { query: typeof clientQuery }) => unknown) => operation({ query: clientQuery }));
  });

  it.each([
    ['PATCH', (request: Request) => PATCH(request, params), patchRequest()],
    ['DELETE', (request: Request) => DELETE(request, params), new Request('http://localhost', { method: 'DELETE' })],
  ])('%s rejects an inactive or converted draft before asset or Blob work', async (_method, handler, request) => {
    clientQuery.mockResolvedValue({ rows: [] });

    const response = await handler(request);

    expect(response.status).toBe(409);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('FROM meme_drafts'), ['draft-1']);
    expect(clientQuery.mock.calls.some(([sql]) => /meme_assets/i.test(String(sql)))).toBe(false);
    expect(deleteBlobStrict).not.toHaveBeenCalled();
  });

  it('DELETE rejects a campaign meme sharing its storage key without updating, deleting, or deleting its Blob', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
      if (sql.includes('FROM meme_assets')) return { rows: [{ id: 'asset-1', storage_key: 'private/shared.png', storage_url: 'https://blob/shared.png', sha256_hash: 'hash-1' }] };
      if (sql.includes('FROM campaign_memes')) return { rows: [{ id: 'campaign-meme-1' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const response = await DELETE(new Request('http://localhost', { method: 'DELETE' }), params);

    expect(response.status).toBe(409);
    const sql = clientQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toMatch(/meme_drafts[\s\S]*FOR UPDATE/);
    expect(sql).toMatch(/meme_assets[\s\S]*FOR UPDATE/);
    expect(sql).toContain('storage_key = $1 OR sha256_hash = $2');
    expect(sql).not.toMatch(/UPDATE\s+meme_assets|DELETE\s+FROM\s+meme_assets/);
    expect(deleteBlobStrict).not.toHaveBeenCalled();
  });

  it('DELETE retains legacy references as a transactional retirement and never deletes their Blob', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
      if (sql.includes('FROM meme_assets')) return { rows: [{ id: 'asset-1', storage_key: 'private/legacy.png', storage_url: 'https://blob/legacy.png', sha256_hash: 'hash-1' }] };
      if (sql.includes('FROM campaign_memes')) return { rows: [] };
      if (sql.includes('meme_generation_jobs')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM memes')) return { rows: [] };
      if (sql.includes('UPDATE meme_assets')) return { rows: [{ id: 'asset-1' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const response = await DELETE(new Request('http://localhost', { method: 'DELETE' }), params);

    expect(response.status).toBe(200);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("SET status = 'retired'"))).toBe(true);
    expect(deleteBlobStrict).not.toHaveBeenCalled();
  });
});
