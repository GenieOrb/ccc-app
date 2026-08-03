import { describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction, performMemeAnalysis, generateMemeImage, validateMemeImage, uploadGeneratedMeme } = vi.hoisted(() => ({
  queryDb: vi.fn(),
  withTransaction: vi.fn(),
  performMemeAnalysis: vi.fn(),
  generateMemeImage: vi.fn(),
  validateMemeImage: vi.fn(),
  uploadGeneratedMeme: vi.fn(),
}));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./memes/analysis', () => ({ performMemeAnalysis }));
vi.mock('./memes/generation', () => ({ generateMemeImage }));
vi.mock('./memes/validation', () => ({ validateMemeImage }));
vi.mock('./memes/blob', () => ({ uploadGeneratedMeme, getMemeBlobBuffer: vi.fn(), deleteBlob: vi.fn() }));

import { processMemeBackgroundQueue } from './worker.memes';

describe('meme validation API-call contract', () => {
  it('keeps succeeded initial validation on the historical key and records revalidation with an allowed distinct key', async () => {
    const apiCallInserts: unknown[][] = [];
    const succeededCallKeys: string[] = [];
    let claimed = false;

    queryDb.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM memes')) return [];
      if (sql.includes('INSERT INTO meme_api_calls')) {
        apiCallInserts.push(params!);
        return [{ id: 'api-call' }];
      }
      if (sql.includes('UPDATE meme_api_calls') && params?.[0] === 'succeeded') {
        succeededCallKeys.push(params[3] as string);
        return [];
      }
      if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('lease_owner')) return [{ id: 'job-1' }];
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string) => {
        if (sql.includes('FROM meme_generation_jobs j')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: [{
            job_id: 'job-1', cycle_id: 'cycle-1', campaign_id: 'campaign-1', draft_id: 'draft-1',
            campaign_post_id: null, slot_index: 0, slot_plan: { textQuantity: 'no_text' }, deterministic_dimensions: {},
            asset_snapshot: null, model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' },
            attempts_count: 0, post_text: 'Post', author_name: 'Author', author_username: 'author',
            accessible_context: {}, direction: 'Direction', cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
          }] };
        }
        if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
        if (sql.includes('SELECT target_count, status FROM meme_generation_cycles')) return { rows: [{ target_count: 1, status: 'processing' }] };
        return { rows: [{ id: 'ok' }] };
      },
    }));
    performMemeAnalysis.mockResolvedValue({ immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', requires_asset: false });
    generateMemeImage.mockResolvedValue({ imageBuffer: Buffer.from('image'), mimeType: 'image/png', cost: '0', width: 1, height: 1 });
    validateMemeImage.mockResolvedValueOnce({ is_valid: false, reason: 'too busy' }).mockResolvedValueOnce({ is_valid: true, reason: 'clean' });
    uploadGeneratedMeme.mockResolvedValue({ url: 'local://meme', pathname: 'meme', contentType: 'image/png', sizeBytes: 5, sha256Hash: 'hash' });

    await processMemeBackgroundQueue({ workerId: 'worker-1', budgetMs: 60_000, maxJobs: 1 });

    const validationCalls = apiCallInserts.filter((params) => params[5] === 'validation');
    expect(validationCalls).toHaveLength(2);
    expect(validationCalls.map((params) => params[0])).toEqual(['job-1:1:validation', 'job-1:1:validation:revalidation']);
    expect(succeededCallKeys).toEqual(expect.arrayContaining(['job-1:1:validation', 'job-1:1:validation:revalidation']));
  });
});
