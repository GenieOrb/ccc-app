import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction } = vi.hoisted(() => ({
  queryDb: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./ai/models', () => ({
  DEFAULT_MODEL_KEY: 'test-model',
  getAiModel: () => ({ key: 'test-model', enabled: true, provider: 'openai', apiModel: 'test-model' }),
  isProviderConfigured: () => true,
}));

import { triggerReplenishmentIfNeeded } from './services';

type CampaignType = 'manual' | 'perpetual';
type RecordedQuery = { sql: string; params?: unknown[] };

describe('triggerReplenishmentIfNeeded meme job contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<CampaignType>(['manual', 'perpetual'])(
    'persists brand and immutable primary/secondary asset snapshots for %s replenishment',
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

      const memeJobInserts = queries.filter(({ sql }) => sql.includes('INSERT INTO meme_generation_jobs'));
      expect(memeJobInserts).toHaveLength(1);
      const memeJob = memeJobInserts[0];
      expect(memeJob.sql).toContain('asset_snapshot');

      assetRows[0].instruction = 'mutated after insert';
      assetRows[1].storage_key = 'mutated/after-insert.png';

      expect(JSON.parse(String(memeJob.params?.[4]))).toMatchObject({
        assignedPostId: 'post-1',
        assetId: 'asset-logo',
        secondaryAssetId: 'asset-character',
        brandText: 'GenieOrb\u2122',
      });
      expect(JSON.parse(String(memeJob.params?.[7]))).toEqual({
        primaryAsset: {
          id: 'asset-logo',
          assetType: 'logo',
          appearancePercentage: 100,
          instruction: 'Keep the logo unchanged',
          storageKey: 'campaigns/campaign-1/logo.png',
          mimeType: 'image/png',
          sha256: 'logo-sha256',
          width: 512,
          height: 512,
        },
        secondaryAsset: {
          id: 'asset-character',
          assetType: 'character',
          appearancePercentage: 100,
          instruction: 'Place the character beside the logo',
          storageKey: 'campaigns/campaign-1/character.png',
          mimeType: 'image/png',
          sha256: 'character-sha256',
          width: 768,
          height: 1024,
        },
      });
    },
  );
});
