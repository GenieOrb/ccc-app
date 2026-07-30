import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAdminAuthenticated, validateSameOrigin, parseMultipleXUrls, fetchXPosts, checkCampaignSafety, withTransaction, generateDeterministicSlotPlans } = vi.hoisted(() => ({
  isAdminAuthenticated: vi.fn(),
  validateSameOrigin: vi.fn(),
  parseMultipleXUrls: vi.fn(),
  fetchXPosts: vi.fn(),
  checkCampaignSafety: vi.fn(),
  withTransaction: vi.fn(),
  generateDeterministicSlotPlans: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ isAdminAuthenticated, validateSameOrigin }));
vi.mock('@/lib/x-api', () => ({ parseMultipleXUrls, fetchXPosts }));
vi.mock('@/lib/openai', () => ({ checkCampaignSafety }));
vi.mock('@/lib/db', () => ({ withTransaction }));
vi.mock('@/lib/planner', () => ({ generateDeterministicSlotPlans }));
vi.mock('@/lib/ai/models', () => ({ getAiModel: () => ({ key: 'test-model', enabled: true, apiModel: 'test-model' }) }));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 'campaign-1' }) };
const post = {
  postId: '900', inputUrl: 'https://x.com/a/status/900', canonicalUrl: 'https://x.com/a/status/900',
  authorName: 'Author', authorUsername: 'author', textContent: 'Post text', language: 'en',
  conversationId: '900', postedAt: null, accessibleContext: {},
};

describe('add campaign posts route', () => {
  beforeEach(() => {
    isAdminAuthenticated.mockResolvedValue(true);
    validateSameOrigin.mockReturnValue(true);
    parseMultipleXUrls.mockReturnValue([{ postId: '900' }]);
    fetchXPosts.mockResolvedValue([post]);
    checkCampaignSafety.mockResolvedValue({ allowed: true });
    generateDeterministicSlotPlans.mockReturnValue(Array.from({ length: 30 }, (_, slotIndex) => ({
      assignedPostId: 'post-1', slotIndex, lengthMode: 'normal', emojiPolicy: 'no_emoji',
      rhetoricalForm: 'direct_reaction', texture: 'plain', deliveryOrder: slotIndex,
    })));
    withTransaction.mockImplementation((operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<Response>) => operation({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM campaigns')) return { rows: [{ id: 'campaign-1', direction: 'be constructive', campaign_type: 'manual', model_key: 'test-model' }] };
        if (sql.includes('SELECT x_post_id')) return { rows: [] };
        if (sql.includes('INSERT INTO campaign_posts')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('INSERT INTO generation_cycles')) return { rows: [{ id: 'cycle-1' }] };
        return { rows: [] };
      }),
    }));
  });

  it('attributes the add-post preflight to its campaign', async () => {
    const response = await POST(new Request('http://localhost/api/admin/campaigns/campaign-1/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urlsInput: 'https://x.com/a/status/900' }),
    }), context);

    expect(response.status).toBe(200);
    expect(fetchXPosts).toHaveBeenCalledWith([{ postId: '900' }], { campaignId: 'campaign-1' });
    expect(checkCampaignSafety).toHaveBeenCalledWith(['Post text'], 'be constructive', { campaignId: 'campaign-1' });
  });

  it('atomically queues an initial per-post inventory', async () => {
    const queries: string[] = [];
    withTransaction.mockImplementation((operation: (client: { query: ReturnType<typeof vi.fn> }) => Promise<Response>) => operation({
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM campaigns')) return { rows: [{ id: 'campaign-1', direction: null, campaign_type: 'manual', model_key: 'test-model' }] };
        if (sql.includes('SELECT x_post_id')) return { rows: [] };
        if (sql.includes('INSERT INTO campaign_posts')) return { rows: [{ id: 'post-1' }] };
        if (sql.includes('INSERT INTO generation_cycles')) return { rows: [{ id: 'cycle-1' }] };
        return { rows: [] };
      }),
    }));

    const response = await POST(new Request('http://localhost/api/admin/campaigns/campaign-1/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urlsInput: 'https://x.com/a/status/900' }),
    }), context);

    expect(response.status).toBe(200);
    expect(queries.filter((sql) => sql.includes('INSERT INTO generation_cycles'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('INSERT INTO generation_jobs'))).toHaveLength(30);
  });
});
