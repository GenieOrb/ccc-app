import { afterEach, describe, expect, it, vi } from 'vitest';
const { queryDb } = vi.hoisted(() => ({ queryDb: vi.fn().mockResolvedValue([]) }));
vi.mock('./db', () => ({ queryDb }));
import { fetchNewXPostsForAccount, parseAndValidateXUrl, parseMultipleXUrls } from './x-api';

afterEach(() => vi.unstubAllGlobals());

describe('manual X URL validation', () => {
  it('accepts x.com and twitter.com status URLs with query strings', () => {
    expect(parseAndValidateXUrl('https://twitter.com/user/status/123?x=1').postId).toBe('123');
    expect(parseAndValidateXUrl('https://x.com/user/status/456/').canonicalUrl).toBe('https://x.com/i/status/456');
  });

  it('rejects account URLs without producing partial input', () => {
    expect(() => parseMultipleXUrls('https://x.com/user,https://x.com/other/status/123')).toThrow('Estas en campaña manual, debes poner posts, no cuentas.');
  });
});

describe('perpetual X ingestion contract', () => {
  it('requests remote exclusions and defensively excludes replies and retweets while retaining quotes', async () => {
    process.env.X_BEARER_TOKEN = 'test-token';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: '101', text: 'reply', in_reply_to_user_id: '42', author_id: '42', created_at: '2026-01-01T00:00:00.000Z' },
        { id: '102', text: 'retweet', author_id: '42', referenced_tweets: [{ type: 'retweeted', id: '1' }], created_at: '2026-01-01T00:00:00.000Z' },
        { id: '103', text: 'quote', author_id: '42', referenced_tweets: [{ type: 'quoted', id: '2' }], created_at: '2026-01-01T00:00:00.000Z' },
      ],
      includes: { users: [{ id: '42', name: 'Author', username: 'author' }], tweets: [{ id: '2', text: 'quoted text', author_id: '42' }] },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const posts = await fetchNewXPostsForAccount('42', '100');

    expect(posts.map((post) => post.postId)).toEqual(['103']);
    const requestUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(requestUrl.searchParams.get('exclude')).toBe('replies,retweets');
    expect(requestUrl.searchParams.get('since_id')).toBe('100');
    expect(queryDb.mock.calls[0][0]).toContain('INSERT INTO x_api_calls');
    expect(queryDb.mock.calls[0][1][1]).toBe('timeline_lookup');
    expect(String(queryDb.mock.calls.at(-1)?.[0])).toContain('UPDATE x_api_calls');
  });
});
