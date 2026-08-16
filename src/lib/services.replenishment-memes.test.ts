import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction } = vi.hoisted(() => ({
  queryDb: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./memes/planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memes/planner')>();
  return { ...actual, generateDeterministicMemeSlotPlans: vi.fn(actual.generateDeterministicMemeSlotPlans) };
});
vi.mock('./ai/models', () => ({
  DEFAULT_MODEL_KEY: 'test-model',
  getAiModel: () => ({ key: 'test-model', enabled: true, provider: 'openai', apiModel: 'test-model' }),
  isProviderConfigured: () => true,
}));

import { generateDeterministicMemeSlotPlans } from './memes/planner';
import { triggerReplenishmentIfNeeded } from './services';

const generateMemePlans = vi.mocked(generateDeterministicMemeSlotPlans);

type CampaignType = 'manual' | 'perpetual';
type RecordedQuery = { sql: string; params?: unknown[] };

describe('triggerReplenishmentIfNeeded meme job contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<CampaignType>(['manual', 'perpetual'])(
    'does not create image-generation cycles or jobs for %s replenishment',
    async (campaignType) => {
      const assetRows = [
        {
          id: 'asset-logo',
          asset_type: 'logo',
          appearance_percentage: 100,
          instruction: 'Keep the logo unchanged',
          storage_key: 'campaigns/campaign-1/logo.png',
          mime_type: 'image/png',
          sha256_hash: 'logo-sha256',
          width: 512,
          height: 512,
        },
        {
          id: 'asset-character',
          asset_type: 'character',
          appearance_percentage: 100,
          instruction: 'Place the character beside the logo',
          storage_key: 'campaigns/campaign-1/character.png',
          mime_type: 'image/png',
          sha256_hash: 'character-sha256',
          width: 768,
          height: 1024,
        },
      ];
      const queries: RecordedQuery[] = [];

      queryDb.mockResolvedValueOnce([{
        campaign_type: campaignType,
        replenishment_threshold: 5,
        replenishment_size: 1,
        model_key: 'test-model',
        max_comments_total: null,
        brand_variants: [{ value: 'GenieOrb\u2122', percentage: 100 }],
        include_memes: true,
        meme_percentage: 100,
        meme_model_key: 'gemini-3.1-flash-image',
      }]);
      withTransaction.mockImplementationOnce(async (operation) => operation({
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes('SELECT 1 FROM campaigns')) return { rows: [{ id: 'campaign-1' }] };
          if (sql.includes('SELECT id FROM campaign_posts')) return { rows: [{ id: 'post-1' }] };
          if (sql.includes('SELECT 1 FROM campaign_posts')) return { rows: [{ id: 'post-1' }] };
          if (sql.includes('FROM suggestions')) return { rows: [{ count: '0' }] };
          if (sql.includes('FROM generation_cycles')) return { rows: [] };
          if (sql.includes('INSERT INTO generation_cycles')) return { rows: [{ id: `comment-cycle-${campaignType}` }] };
          if (sql.includes('INSERT INTO generation_jobs')) return { rows: [] };
          if (sql.includes('FROM memes')) return { rows: [{ count: '0' }] };
          if (sql.includes('FROM meme_generation_cycles')) return { rows: [] };
          if (sql.includes('FROM meme_assets')) return { rows: assetRows };
          if (sql.includes('INSERT INTO meme_generation_cycles')) return { rows: [{ id: `meme-cycle-${campaignType}` }] };
          if (sql.includes('INSERT INTO meme_generation_jobs')) return { rows: [] };
          throw new Error(`Unexpected SQL in test: ${sql}`);
        }),
      } as never));

      await triggerReplenishmentIfNeeded('campaign-1');

      expect(queries.some(({ sql }) => sql.includes('INSERT INTO meme_generation_cycles'))).toBe(false);
      expect(queries.some(({ sql }) => sql.includes('INSERT INTO meme_generation_jobs'))).toBe(false);
      expect(generateMemePlans).not.toHaveBeenCalled();
    },
  );
});
