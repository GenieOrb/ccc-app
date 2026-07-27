import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryDb, generateSingleComment } = vi.hoisted(() => ({ queryDb: vi.fn(), generateSingleComment: vi.fn() }));

vi.mock('./db', () => ({ queryDb, withTransaction: vi.fn() }));
vi.mock('./openai', () => ({ checkCampaignSafety: vi.fn(), generateSingleComment }));
vi.mock('./x-api', () => ({ parseMultipleXUrls: vi.fn(), fetchXPosts: vi.fn() }));
vi.mock('./x-accounts', () => ({ normalizeXAccounts: vi.fn() }));
vi.mock('./crypto', () => ({ generateSecureSlug: vi.fn() }));
vi.mock('./planner', () => ({ generateDeterministicSlotPlans: () => Array.from({ length: 7 }, (_, index) => ({ slotIndex: index })) }));
vi.mock('./ai/models', () => ({
  DEFAULT_MODEL_KEY: 'test-model',
  getAiModel: () => ({ key: 'test-model', displayName: 'Test model', provider: 'openai', apiModel: 'test-api-model', enabled: true, inputPricePerMillion: 2, cachedInputPricePerMillion: 1, outputPricePerMillion: 4, currency: 'USD', pricingEffectiveAt: '2026-01-01' }),
  isProviderConfigured: () => true,
}));

import { generateCampaignPreview } from './services';

const postRow = { model_key: 'test-model', direction: null, post_id: 'post-1', text_content: 'post body', author_name: 'Author', author_username: 'author', accessible_context: {} };

describe('generateCampaignPreview', () => {
  beforeEach(() => {
    queryDb.mockReset();
    generateSingleComment.mockReset();
  });

  it('does not call a provider or insert a preview if no current post exists', async () => {
    queryDb.mockResolvedValueOnce([]);

    await expect(generateCampaignPreview('campaign-1')).rejects.toThrow('No hay ningún post vigente para generar la preview.');
    expect(generateSingleComment).not.toHaveBeenCalled();
    expect(queryDb).toHaveBeenCalledTimes(1);
  });

  it('generates exactly seven comments in 5+2 batches and persists usage and cost', async () => {
    queryDb.mockImplementation(async (sql: string) => String(sql).includes('RETURNING call_key') ? [{ call_key: 'acquired' }] : []);
    queryDb.mockResolvedValueOnce([postRow]);
    generateSingleComment.mockImplementation(async () => ({ comment: `comment-${generateSingleComment.mock.calls.length}`, usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } }));

    const preview = await generateCampaignPreview('campaign-1');

    expect(preview.comments).toHaveLength(7);
    expect(generateSingleComment).toHaveBeenCalledTimes(7);
    expect(generateSingleComment.mock.calls[5][0].recentComments).toHaveLength(5);
    const insert = queryDb.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO campaign_previews'));
    expect(insert).toBeDefined();
    if (!insert) throw new Error('Preview persistence query was not issued.');
    expect(String(insert[0])).toContain('input_tokens');
    expect(insert[1][6]).toBe(70);
    expect(insert[1][7]).toBe(14);
    expect(insert[1][8]).toBe(35);
    expect(insert[1][9]).toBeCloseTo(0.000266);
    expect(queryDb.mock.calls.filter(([sql]) => String(sql).includes('generation_api_calls') && String(sql).includes("'preview'"))).toHaveLength(7);
  });

  it('does not call the provider when a preview call ledger key conflicts', async () => {
    queryDb.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM campaigns')) return [postRow];
      if (String(sql).includes('RETURNING call_key')) return [];
      return [];
    });

    await expect(generateCampaignPreview('campaign-1')).rejects.toThrow('no pudo generarse');
    expect(generateSingleComment).not.toHaveBeenCalled();
  });
});
