import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrCreateVisitorIdentity, queryDb, getMemeBlobStream } = vi.hoisted(() => ({
  getOrCreateVisitorIdentity: vi.fn(), queryDb: vi.fn(), getMemeBlobStream: vi.fn(),
}));
vi.mock('@/lib/visitor', () => ({ getOrCreateVisitorIdentity }));
vi.mock('@/lib/db', () => ({ queryDb }));
vi.mock('@/lib/memes/blob', () => ({ getMemeBlobStream }));

import { GET as view } from './view/route';
import { GET as download } from './download/route';

const params = { params: Promise.resolve({ slug: 'slug', assignmentId: 'assignment-1' }) };

describe('assignment meme asset routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrCreateVisitorIdentity.mockResolvedValue({ visitorHash: 'visitor-hash' });
    getMemeBlobStream.mockResolvedValue({ stream: new ReadableStream({ start(controller) { controller.close(); } }), contentType: 'image/png' });
  });

  it.each([['view', view, 'private, no-store'], ['download', download, 'no-store']] as const)('%s authorizes both legacy and campaign meme records without returning a storage URL', async (_name, handler, cacheControl) => {
    queryDb.mockResolvedValue([{ storage_key: 'private/key.png', storage_url: 'https://private.example/key.png', mime_type: 'image/png', cancelled_at: null }]);
    const response = await handler(new Request('http://localhost'), params);
    expect(response.status).toBe(200);
    expect(getMemeBlobStream).toHaveBeenCalledWith('private/key.png');
    expect(response.headers.get('Cache-Control')).toBe(cacheControl);
    const sql = String(queryDb.mock.calls[0][0]);
    expect(sql).toContain('LEFT JOIN memes');
    expect(sql).toContain('LEFT JOIN campaign_memes');
    expect(sql).toContain('c.cancelled_at');
    expect(sql).toContain('v.visitor_hash = $3');
    expect(await response.text()).not.toContain('private.example');
  });

  it.each([view, download])('returns 404 when the visitor does not own the assignment', async (handler) => {
    queryDb.mockResolvedValue([]);
    expect((await handler(new Request('http://localhost'), params)).status).toBe(404);
    expect(getMemeBlobStream).not.toHaveBeenCalled();
  });

  it.each([view, download])('returns 404 for a cancelled campaign before reading Blob', async (handler) => {
    queryDb.mockResolvedValue([{
      storage_key: 'private/key.png', storage_url: 'https://private.example/key.png',
      mime_type: 'image/png', cancelled_at: new Date('2026-08-16T12:34:56.000Z'),
    }]);

    expect((await handler(new Request('http://localhost'), params)).status).toBe(404);
    expect(getMemeBlobStream).not.toHaveBeenCalled();
  });
});
