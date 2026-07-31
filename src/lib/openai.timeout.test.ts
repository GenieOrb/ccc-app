import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { chatCreate, queryDb, responsesParse } = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  queryDb: vi.fn(),
  responsesParse: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { parse: responsesParse };
    chat = { completions: { create: chatCreate } };
  },
}));
vi.mock('./config', () => ({
  getConfig: () => ({
    openaiApiKey: 'test-key',
    openaiModel: 'test-model',
  }),
}));
vi.mock('./db', () => ({ queryDb }));

import { checkCampaignSafety, generateSingleComment } from './openai';

describe('bounded provider requests', () => {
  beforeEach(() => {
    queryDb.mockResolvedValue([]);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
  });

  afterEach(() => vi.restoreAllMocks());

  it('disables retries and applies the monitor safety timeout', async () => {
    responsesParse.mockResolvedValue({
      output_parsed: { allowed: true, category: 'safe', reason: 'safe' },
    });

    await checkCampaignSafety(
      ['post'],
      undefined,
      { campaignId: 'campaign-1', campaignAccountId: 'account-1' },
      321,
    );

    expect(responsesParse.mock.calls[0][1]).toEqual({ timeout: 321, maxRetries: 0 });
  });

  it('records a provider failure and applies local safety screening instead of throwing', async () => {
    responsesParse.mockRejectedValue(new Error('provider unavailable'));

    await expect(checkCampaignSafety(['A harmless post'], 'be constructive')).resolves.toMatchObject({
      allowed: true,
      category: 'local_safety_screen',
    });
    expect(queryDb.mock.calls.some(([sql]) => String(sql).includes("status='failed',failure_kind='provider_error'"))).toBe(true);
  });

  it('disables retries and applies the worker generation timeout', async () => {
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"comment":"Useful response"}' } }],
    });

    await generateSingleComment({
      apiModel: 'test-model',
      provider: 'openai',
      postText: 'A post',
      authorName: 'Author',
      authorUsername: 'author',
      accessibleContext: {},
      plan: {
        slotIndex: 0,
        lengthMode: 'normal',
        emojiPolicy: 'no_emoji',
        rhetoricalForm: 'direct_reaction',
        texture: 'plain',
        deliveryOrder: 0,
        assignedPostId: 'post-1',
        emotionalTone: 'neutral',
        expressionMode: 'direct',
        punctuationMode: 'standard',
        capitalizationMode: 'standard',
        syntaxMode: 'standard',
        firstPersonSubfamily: 'none'
      },
      recentComments: [],
      timeoutMs: 654,
    });

    expect(chatCreate.mock.calls[0][1]).toEqual({ timeout: 654, maxRetries: 0 });
  });
});
