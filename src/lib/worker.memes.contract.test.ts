import { describe, expect, it, vi } from 'vitest';

const { queryDb, withTransaction, performMemeAnalysis, normalizeMemeCaptions, resolveMemeAnalysisModel, generateMemeImage, validateMemeImage, uploadGeneratedMeme, getMemeBlobBuffer, deleteBlob } = vi.hoisted(() => ({
  queryDb: vi.fn(),
  withTransaction: vi.fn(),
  performMemeAnalysis: vi.fn(),
  normalizeMemeCaptions: vi.fn((textQuantity: string, captions: string[]) => textQuantity === 'no_text' ? [] : captions.slice(0, 1)),
  resolveMemeAnalysisModel: vi.fn(() => 'authoritative-analysis-model'),
  generateMemeImage: vi.fn(),
  validateMemeImage: vi.fn(),
  uploadGeneratedMeme: vi.fn(),
  getMemeBlobBuffer: vi.fn(),
  deleteBlob: vi.fn(),
}));

vi.mock('./db', () => ({ queryDb, withTransaction }));
vi.mock('./memes/analysis', () => ({ performMemeAnalysis, normalizeMemeCaptions, resolveMemeAnalysisModel }));
vi.mock('./memes/generation', () => ({ generateMemeImage }));
vi.mock('./memes/validation', () => ({ validateMemeImage }));
vi.mock('./memes/blob', () => ({ uploadGeneratedMeme, getMemeBlobBuffer, deleteBlob }));

import { processMemeBackgroundQueue } from './worker.memes';

describe('meme validation API-call contract', () => {
  async function runPostUploadFenceScenario({
    draftId,
    leaseMatches,
    eligibilityMatches,
    cancellationMatches,
  }: {
    draftId: string | null;
    leaseMatches: boolean;
    eligibilityMatches: boolean;
    cancellationMatches: boolean;
  }) {
    let claimed = false;
    const transactionQueries: Array<{ sql: string; params: unknown[] | undefined }> = [];

    queryDb.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM memes')) return [];
      if (sql.includes('INSERT INTO meme_api_calls')) return [{ id: 'api-call' }];
      if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('lease_owner')) return [{ id: params?.[0] }];
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string, params?: unknown[]) => {
        transactionQueries.push({ sql, params });
        if (sql.includes('UPDATE meme_generation_jobs j')) return { rows: [] };
        if (sql.includes('FROM meme_generation_jobs j')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: [{
            job_id: 'job-fenced', cycle_id: 'cycle-fenced', campaign_id: draftId ? null : 'campaign-fenced', draft_id: draftId,
            campaign_post_id: draftId ? null : 'post-fenced', slot_index: 0, slot_plan: { textQuantity: 'no_text' },
            deterministic_dimensions: {}, asset_snapshot: null,
            model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' }, attempts_count: 0,
            post_text: 'Post', author_name: 'Author', author_username: 'author', accessible_context: {}, direction: 'Direction',
            cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
          }] };
        }
        if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('FOR UPDATE')) {
          return { rows: leaseMatches ? [{ id: 'job-fenced' }] : [] };
        }
        if (sql.includes('SELECT id FROM meme_drafts') || sql.includes('FROM campaign_posts p')) {
          return { rows: eligibilityMatches ? [{ id: draftId || 'post-fenced' }] : [] };
        }
        if (sql.includes("SET status = 'cancelled'")) {
          return { rows: cancellationMatches ? [{ id: 'job-fenced' }] : [] };
        }
        if (sql.includes('SELECT target_count, status FROM meme_generation_cycles')) {
          return { rows: [{ target_count: 1, status: 'processing' }] };
        }
        if (sql.includes('SELECT id, status, slot_index FROM meme_generation_jobs')) {
          return { rows: [{ id: 'job-fenced', status: 'cancelled', slot_index: 0 }] };
        }
        if (sql.includes('SELECT m.job_id FROM memes')) return { rows: [] };
        return { rows: [{ id: 'ok' }] };
      },
    }));
    performMemeAnalysis.mockResolvedValue({ immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', requires_asset: false });
    generateMemeImage.mockResolvedValue({ imageBuffer: Buffer.from('image'), mimeType: 'image/png', cost: '0', width: 1, height: 1 });
    uploadGeneratedMeme.mockResolvedValue({ url: 'local://fenced-meme', pathname: 'fenced-meme', contentType: 'image/png', sizeBytes: 5, sha256Hash: 'hash' });

    const result = await processMemeBackgroundQueue({ workerId: 'worker-fenced', budgetMs: 60_000, maxJobs: 1 });
    return { result, transactionQueries };
  }

  it.each([
    { label: 'draft', draftId: 'draft-fenced', lockSql: "SELECT id FROM meme_drafts WHERE id = $1 AND status = 'active' AND expires_at > NOW()", error: 'Draft expired' },
    { label: 'campaign post', draftId: null, lockSql: 'FROM campaign_posts p', error: 'Post retired' },
  ])('fences $label cancellation, clears its own lease, cleans its blob, and recalculates after the confirmed transition', async ({ draftId, lockSql, error }) => {
    const { result, transactionQueries } = await runPostUploadFenceScenario({
      draftId,
      leaseMatches: true,
      eligibilityMatches: false,
      cancellationMatches: true,
    });

    expect(result).toMatchObject({ processed: 1, completed: 0, failed: 1 });
    expect(transactionQueries.some(({ sql }) => sql.includes(lockSql))).toBe(true);
    const cancellation = transactionQueries.find(({ sql }) => sql.includes("SET status = 'cancelled'") && sql.includes('WHERE id = $1'));
    expect(cancellation?.sql).toContain('lease_owner = NULL');
    expect(cancellation?.sql).toContain('lease_expires_at = NULL');
    expect(cancellation?.sql).toContain("status = 'processing' AND lease_owner = $2 AND lease_expires_at > NOW()");
    expect(cancellation?.sql).toContain('RETURNING id');
    expect(cancellation?.params).toEqual(['job-fenced', 'worker-fenced', error]);
    expect(deleteBlob).toHaveBeenCalledWith('local://fenced-meme');
    expect(transactionQueries.some(({ sql }) => sql.includes('SELECT target_count, status FROM meme_generation_cycles'))).toBe(true);
    expect(transactionQueries.some(({ sql }) => sql.includes('UPDATE meme_generation_cycles') && sql.includes('valid_produced_count'))).toBe(true);
  });

  it('treats a missing post-upload lease as lease_lost, cleans the blob, and leaves the foreign job and cycle untouched', async () => {
    const { result, transactionQueries } = await runPostUploadFenceScenario({
      draftId: 'draft-fenced',
      leaseMatches: false,
      eligibilityMatches: false,
      cancellationMatches: false,
    });

    expect(result).toMatchObject({ processed: 1, completed: 0, failed: 1 });
    expect(deleteBlob).toHaveBeenCalledWith('local://fenced-meme');
    expect(transactionQueries.some(({ sql }) => sql.includes("SET status = 'cancelled'") && sql.includes('WHERE id = $1'))).toBe(false);
    expect(transactionQueries.some(({ sql }) => sql.includes("SET status = 'completed'"))).toBe(false);
    expect(transactionQueries.some(({ sql }) => sql.includes('SELECT target_count, status FROM meme_generation_cycles'))).toBe(false);
  });

  it('treats an unmatched fenced cancellation as lease_lost, cleans the blob, and does not recalculate a foreign cycle', async () => {
    const { result, transactionQueries } = await runPostUploadFenceScenario({
      draftId: null,
      leaseMatches: true,
      eligibilityMatches: false,
      cancellationMatches: false,
    });

    expect(result).toMatchObject({ processed: 1, completed: 0, failed: 1 });
    expect(deleteBlob).toHaveBeenCalledWith('local://fenced-meme');
    const cancellation = transactionQueries.find(({ sql }) => sql.includes("SET status = 'cancelled'") && sql.includes('WHERE id = $1'));
    expect(cancellation?.sql).toContain("status = 'processing' AND lease_owner = $2 AND lease_expires_at > NOW()");
    expect(cancellation?.sql).toContain('RETURNING id');
    expect(transactionQueries.some(({ sql }) => sql.includes('SELECT target_count, status FROM meme_generation_cycles'))).toBe(false);
  });

  it('never claims a campaign meme job once its campaign is cancelled, even if a legacy draft remains active', async () => {
    const queries: string[] = [];
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    }));

    await expect(processMemeBackgroundQueue({ workerId: 'worker-cancelled', budgetMs: 60_000, maxJobs: 1 })).resolves.toMatchObject({ processed: 0 });

    const claimQuery = queries.find((sql) => sql.includes('FROM meme_generation_jobs j'))!.replace(/\s+/g, ' ');
    expect(claimQuery).toContain('c.cancelled_at IS NULL');
  });

  it('cancels only expired or inactive draft jobs before claiming, then recalculates each affected directed cycle once', async () => {
    const transactionQueries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const recalculatedCycles: string[] = [];

    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string, params?: unknown[]) => {
        transactionQueries.push({ sql, params });
        if (sql.includes("UPDATE meme_generation_jobs j\n       SET status = 'cancelled'")) {
          return { rows: [{ cycle_id: 'preview-cycle' }, { cycle_id: 'preview-cycle' }] };
        }
        if (sql.includes('SELECT target_count, status FROM meme_generation_cycles')) {
          recalculatedCycles.push(params?.[0] as string);
          return { rows: [{ target_count: 1, status: 'processing' }] };
        }
        if (sql.includes('SELECT id, status, slot_index FROM meme_generation_jobs')) return { rows: [{ id: 'cancelled-job', status: 'cancelled', slot_index: 0 }] };
        if (sql.includes('SELECT m.job_id FROM memes')) return { rows: [] };
        if (sql.includes('FROM meme_generation_jobs j')) return { rows: [] };
        return { rows: [{ id: 'ok' }] };
      },
    }));

    await expect(processMemeBackgroundQueue({ workerId: 'worker-expiry', budgetMs: 60_000, cycleId: 'preview-cycle', maxJobs: 1 })).resolves.toMatchObject({ processed: 0 });

    const cleanup = transactionQueries.find(({ sql }) => sql.includes("UPDATE meme_generation_jobs j\n       SET status = 'cancelled'"));
    expect(cleanup?.sql).toContain("j.draft_id IS NOT NULL");
    expect(cleanup?.sql).toContain("md.status <> 'active' OR md.expires_at <= NOW()");
    expect(cleanup?.sql).toContain("j.status = 'pending' OR (j.status = 'processing' AND j.lease_expires_at < NOW())");
    expect(cleanup?.sql).toContain('lease_owner = NULL');
    expect(cleanup?.sql).toContain('lease_expires_at = NULL');
    expect(cleanup?.sql).toContain('RETURNING j.cycle_id');
    expect(cleanup?.params).toEqual(['preview-cycle']);
    expect(recalculatedCycles).toEqual(['preview-cycle']);
  });

  it('does not let the meme error handler overwrite a cancelled job or another worker lease', async () => {
    const errorUpdates: Array<{ sql: string; params: unknown[] | undefined }> = [];
    let claimed = false;
    queryDb.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SET status = CASE WHEN $1::boolean THEN 'failed' ELSE 'pending' END")) errorUpdates.push({ sql, params });
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string) => {
        if (sql.includes('FROM meme_generation_jobs j')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: [{
            job_id: 'job-foreign-lease', cycle_id: 'cycle-1', campaign_id: 'campaign-1', draft_id: null,
            campaign_post_id: 'post-1', slot_index: 0, slot_plan: { textQuantity: 'no_text' }, deterministic_dimensions: {}, asset_snapshot: null,
            model_snapshot: { key: '', provider: '', apiModel: '' }, attempts_count: 0,
            post_text: 'Post', author_name: 'Author', author_username: 'author', accessible_context: {}, direction: 'Direction',
            cycle_model_key: '', cycle_provider: '', cycle_api_model: '',
          }] };
        }
        return { rows: [] };
      },
    }));

    await processMemeBackgroundQueue({ workerId: 'worker-current', budgetMs: 60_000, maxJobs: 1 });

    expect(errorUpdates).toHaveLength(1);
    expect(errorUpdates[0].sql).toContain("status = 'processing' AND lease_owner = $6 AND lease_expires_at > NOW()");
    expect(errorUpdates[0].sql).toContain('c.cancelled_at IS NULL');
    expect(errorUpdates[0].params?.[5]).toBe('worker-current');
  });

  it('rolls back and cleans the blob when the fenced meme completion update loses the job after insert', async () => {
    let claimed = false;
    const writes: string[] = [];
    queryDb.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM memes')) return [];
      if (sql.includes('INSERT INTO meme_api_calls')) return [{ id: 'api-call' }];
      if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('lease_owner')) return [{ id: 'job-1' }];
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string) => {
        writes.push(sql);
        if (sql.includes('FROM meme_generation_jobs j')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: [{
            job_id: 'job-1', cycle_id: 'cycle-1', campaign_id: 'campaign-1', draft_id: 'draft-1', campaign_post_id: null,
            slot_index: 0, slot_plan: { textQuantity: 'no_text' }, deterministic_dimensions: {}, asset_snapshot: null,
            model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' }, attempts_count: 0,
            post_text: 'Post', author_name: 'Author', author_username: 'author', accessible_context: {}, direction: 'Direction',
            cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
          }] };
        }
        if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'job-1' }] };
        if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
        if (sql.includes('INSERT INTO memes')) return { rows: [{ id: 'meme-1' }] };
        if (sql.includes("UPDATE meme_generation_jobs\n           SET status = 'completed'")) return { rows: [] };
        return { rows: [{ id: 'ok' }] };
      },
    }));
    performMemeAnalysis.mockResolvedValue({ immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', requires_asset: false });
    generateMemeImage.mockResolvedValue({ imageBuffer: Buffer.from('image'), mimeType: 'image/png', cost: '0', width: 1, height: 1 });
    uploadGeneratedMeme.mockResolvedValue({ url: 'local://meme', pathname: 'meme', contentType: 'image/png', sizeBytes: 5, sha256Hash: 'hash' });

    await expect(processMemeBackgroundQueue({ workerId: 'worker-1', budgetMs: 60_000, maxJobs: 1 })).resolves.toMatchObject({ processed: 1, completed: 0, failed: 1 });
    expect(writes.some((sql) => sql.includes('INSERT INTO memes'))).toBe(true);
    expect(deleteBlob).toHaveBeenCalledWith('local://meme');
  });

  it('does not count an existing meme as complete when its fenced completion update loses the job', async () => {
    let claimed = false;
    const completionUpdates: string[] = [];
    queryDb.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM memes')) return [{ id: 'meme-1' }];
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string) => {
        if (sql.includes('FROM meme_generation_jobs j')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: [{
            job_id: 'job-existing', cycle_id: 'cycle-1', campaign_id: 'campaign-1', draft_id: 'draft-1', campaign_post_id: null,
            slot_index: 0, slot_plan: { textQuantity: 'no_text' }, deterministic_dimensions: {}, asset_snapshot: null,
            model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' }, attempts_count: 0,
            post_text: 'Post', author_name: 'Author', author_username: 'author', accessible_context: {}, direction: 'Direction',
            cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
          }] };
        }
        if (sql.includes("UPDATE meme_generation_jobs\n           SET status = 'completed'")) {
          completionUpdates.push(sql);
          return { rows: [] };
        }
        return { rows: [{ id: 'ok' }] };
      },
    }));

    await expect(processMemeBackgroundQueue({ workerId: 'worker-existing', budgetMs: 60_000, maxJobs: 1 })).resolves.toMatchObject({ processed: 1, completed: 0, failed: 1 });
    expect(performMemeAnalysis).not.toHaveBeenCalled();
    expect(completionUpdates).toHaveLength(1);
    expect(completionUpdates[0]).toContain("EXISTS (SELECT 1 FROM meme_drafts md WHERE md.id = meme_generation_jobs.draft_id AND md.status = 'active' AND md.expires_at > NOW())");
  });

  it('claims and completes all three directed preview slots despite future retry timestamps', async () => {
    type JobState = { id: string; slotIndex: number; status: 'pending' | 'processing' | 'completed'; leaseOwner: string | null; leaseValid: boolean; nextAttemptFuture: boolean };
    type ClaimQuery = { sql: string; where: string; params: unknown[] };
    const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const extractWhere = (sql: string) => sql.match(/\bWHERE\b.*?\bORDER BY\b/)?.[0] ?? '';
    const globalClaimWhereContract = /^WHERE\s+\(\s*\(j\.status = 'pending'\s+AND\s+j\.next_attempt_at <= NOW\(\)\)\s+OR\s+\(j\.status = 'processing'\s+AND\s+j\.lease_expires_at < NOW\(\)\)\s*\)\s+AND\s+\(\s*\(c\.is_active = true\)\s+OR\s+\(md\.status = 'active'\s+AND\s+md\.expires_at > NOW\(\)\)\s*\)\s+AND\s+\(j\.campaign_id IS NULL OR c\.cancelled_at IS NULL\)\s+ORDER BY$/;
    const directedClaimWhereContract = /^WHERE\s+\(\s*\(j\.status = 'pending'\s+AND\s+\(\s*j\.next_attempt_at <= NOW\(\)\s+OR\s+\(j\.draft_id IS NOT NULL\s+AND\s+cy\.cycle_type = 'preview'\)\s*\)\)\s+OR\s+\(j\.status = 'processing'\s+AND\s+j\.lease_expires_at < NOW\(\)\)\s*\)\s+AND\s+\(\s*\(c\.is_active = true\)\s+OR\s+\(md\.status = 'active'\s+AND\s+md\.expires_at > NOW\(\)\)\s*\)\s+AND\s+\(j\.campaign_id IS NULL OR c\.cancelled_at IS NULL\)\s+AND\s+j\.cycle_id = \$1\s+ORDER BY$/;
    const jobs: JobState[] = [0, 1, 2].map((slotIndex) => ({ id: `job-${slotIndex + 1}`, slotIndex, status: 'pending', leaseOwner: null, leaseValid: false, nextAttemptFuture: true }));
    const memes: Array<{ job_id: string }> = [];
    const cycle = { id: 'preview-cycle', status: 'processing', validProducedCount: 0, completedJobsCount: 0, failedJobsCount: 0 };
    const claimQueries: ClaimQuery[] = [];
    const mutations: string[] = [];
    const rowFor = (job: JobState) => ({
      job_id: job.id, cycle_id: cycle.id, campaign_id: null, draft_id: 'draft-1', campaign_post_id: null,
      slot_index: job.slotIndex, slot_plan: { textQuantity: 'no_text' }, deterministic_dimensions: {}, asset_snapshot: null,
      model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' }, attempts_count: 0,
      post_text: 'Post', author_name: 'Author', author_username: 'author', accessible_context: {}, direction: 'Direction',
      cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
    });
    queryDb.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM memes')) return memes.filter((m) => m.job_id === params?.[0]).map((_, index) => ({ id: `meme-${index}` }));
      if (sql.includes('INSERT INTO meme_api_calls')) return [{ id: 'api-call' }];
      if (sql.includes('UPDATE meme_api_calls')) return [];
      if (sql.includes("UPDATE meme_generation_jobs\n     SET lease_expires_at")) {
        const job = jobs.find((candidate) => candidate.id === params?.[0] && candidate.leaseOwner === params?.[1] && candidate.status === 'processing');
        if (job) job.leaseValid = true;
        return job ? [{ id: job.id }] : [];
      }
      if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('lease_owner')) {
        const job = jobs.find((candidate) => candidate.id === params?.[0] && candidate.leaseOwner === params?.[1] && candidate.status === 'processing' && candidate.leaseValid);
        return job ? [{ id: job.id }] : [];
      }
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM meme_generation_jobs j')) {
          const normalizedSql = normalizeSql(sql);
          const claim = { sql: normalizedSql, where: extractWhere(normalizedSql), params: [...(params ?? [])] };
          claimQueries.push(claim);
          const directed = claim.params.length === 1 && claim.params[0] === cycle.id;
          const global = claim.params.length === 0;
          if (!((directed && directedClaimWhereContract.test(claim.where)) || (global && globalClaimWhereContract.test(claim.where)))) {
            throw new Error(`Unexpected claim SQL contract: ${JSON.stringify(claim)}`);
          }
          const job = jobs.find((candidate) => (
            candidate.status === 'pending'
              ? (!candidate.nextAttemptFuture || directed)
              : candidate.status === 'processing' && !candidate.leaseValid
          ));
          return { rows: job ? [rowFor(job)] : [] };
        }
        if (sql.includes("UPDATE meme_generation_jobs\n       SET status = 'processing'")) {
          const job = jobs.find((candidate) => candidate.id === params?.[2]);
          if (job) { job.status = 'processing'; job.leaseOwner = params?.[0] as string; job.leaseValid = true; mutations.push(`claim:${job.id}`); }
          return { rows: [] };
        }
        if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('FOR UPDATE')) {
          const job = jobs.find((candidate) => candidate.id === params?.[0] && candidate.status === 'processing' && candidate.leaseOwner === params?.[1] && candidate.leaseValid);
          return { rows: job ? [{ id: job.id }] : [] };
        }
        if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
        if (sql.includes('INSERT INTO memes')) { memes.push({ job_id: params?.[3] as string }); mutations.push(`meme:${params?.[3]}`); return { rows: [{ id: `meme-${memes.length}` }] }; }
        if (sql.includes("UPDATE meme_generation_jobs\n           SET status = 'completed'")) {
          const job = jobs.find((candidate) => candidate.id === params?.[1]);
          if (job) { job.status = 'completed'; job.leaseOwner = null; job.leaseValid = false; mutations.push(`complete:${job.id}`); }
          return { rows: job ? [{ id: job.id }] : [] };
        }
        if (sql.includes('SELECT target_count, status FROM meme_generation_cycles')) return { rows: [{ target_count: 3, status: cycle.status }] };
        if (sql.includes('SELECT id, status, slot_index FROM meme_generation_jobs')) return { rows: jobs.map((job) => ({ id: job.id, status: job.status, slot_index: job.slotIndex })) };
        if (sql.includes('SELECT m.job_id FROM memes')) return { rows: memes };
        if (sql.includes('UPDATE meme_generation_cycles')) {
          cycle.validProducedCount = params?.[0] as number; cycle.completedJobsCount = params?.[1] as number; cycle.failedJobsCount = params?.[2] as number; cycle.status = params?.[3] as string;
          mutations.push(`cycle:${cycle.status}`); return { rows: [{ id: cycle.id }] };
        }
        return { rows: [{ id: 'ok' }] };
      },
    }));
    performMemeAnalysis.mockResolvedValue({ immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', requires_asset: false });
    generateMemeImage.mockResolvedValue({ imageBuffer: Buffer.from('ai-image'), mimeType: 'image/png', cost: '0.03', width: 1024, height: 1024 });
    uploadGeneratedMeme.mockResolvedValue({ url: 'local://meme', pathname: 'meme', contentType: 'image/png', sizeBytes: 5, sha256Hash: 'hash' });

    const result = await processMemeBackgroundQueue({ workerId: 'worker-1', budgetMs: 60_000, cycleId: 'preview-cycle', maxConcurrency: 3, maxJobs: 3 });

    expect(result).toMatchObject({ processed: 3, completed: 3, failed: 0 });
    expect(claimQueries).toHaveLength(3);
    for (const claim of claimQueries) {
      expect(claim.where).toMatch(directedClaimWhereContract);
      expect(claim.params).toEqual([cycle.id]);
    }
    expect(mutations).toEqual(expect.arrayContaining(['claim:job-1', 'claim:job-2', 'claim:job-3', 'complete:job-1', 'complete:job-2', 'complete:job-3', 'cycle:completed']));
    expect(jobs.map((job) => job.status)).toEqual(['completed', 'completed', 'completed']);
    expect(new Set(memes.map((meme) => meme.job_id))).toEqual(new Set(['job-1', 'job-2', 'job-3']));
    expect(cycle).toMatchObject({ status: 'completed', validProducedCount: 3, completedJobsCount: 3, failedJobsCount: 0 });

    for (const job of jobs) {
      job.status = 'pending';
      job.leaseOwner = null;
      job.leaseValid = false;
      job.nextAttemptFuture = true;
    }
    const beforeGlobal = JSON.stringify({ jobs, memes, cycle });
    expect(await processMemeBackgroundQueue({ workerId: 'worker-2', budgetMs: 60_000, maxJobs: 3 })).toMatchObject({ processed: 0, completed: 0, failed: 0 });
    const globalClaim = claimQueries.at(-1)!;
    expect(globalClaim.where).toMatch(globalClaimWhereContract);
    expect(globalClaim.sql).not.toMatch(/\bj\.cycle_id\s*=\s*\$\d+/);
    expect(globalClaim.params).toEqual([]);
    expect(JSON.stringify({ jobs, memes, cycle })).toBe(beforeGlobal);

    jobs[0] = { ...jobs[0], status: 'processing', leaseOwner: 'other-worker', leaseValid: true };
    jobs[1] = { ...jobs[1], status: 'completed' };
    jobs[2] = { ...jobs[2], status: 'completed' };
    const beforeLease = JSON.stringify({ jobs, memes, cycle });
    expect(await processMemeBackgroundQueue({ workerId: 'worker-3', budgetMs: 60_000, cycleId: cycle.id, maxJobs: 1 })).toMatchObject({ processed: 0, completed: 0, failed: 0 });
    const directedLeaseClaim = claimQueries.at(-1)!;
    expect(directedLeaseClaim.where).toMatch(directedClaimWhereContract);
    expect(directedLeaseClaim.params).toEqual([cycle.id]);
    expect(JSON.stringify({ jobs, memes, cycle })).toBe(beforeLease);
  });

  it('completes a non-preview cycle when every one of its ten target jobs persists a meme', async () => {
    const targetCount = 10;
    const jobs = Array.from({ length: targetCount }, (_, slotIndex) => ({ id: `standard-job-${slotIndex + 1}`, slotIndex, status: 'pending', leaseOwner: null as string | null, leaseValid: false }));
    const memes: Array<{ job_id: string }> = [];
    const cycle = { id: 'standard-cycle', status: 'processing', validProducedCount: 0, completedJobsCount: 0, failedJobsCount: 0 };

    queryDb.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM memes')) return memes.filter((meme) => meme.job_id === params?.[0]).map((_, index) => ({ id: `meme-${index}` }));
      if (sql.includes('INSERT INTO meme_api_calls') || sql.includes('UPDATE meme_api_calls')) return [];
      if (sql.includes('lease_expires_at')) return [{ id: params?.[0] }];
      if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('lease_owner')) return [{ id: params?.[0] }];
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM meme_generation_jobs j')) {
          const job = jobs.find((candidate) => candidate.status === 'pending');
          return { rows: job ? [{
            job_id: job.id, cycle_id: cycle.id, campaign_id: 'campaign-1', draft_id: null, campaign_post_id: null, slot_index: job.slotIndex,
            slot_plan: { textQuantity: 'no_text' }, deterministic_dimensions: {}, asset_snapshot: null,
            model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' }, attempts_count: 0,
            post_text: 'Post', author_name: 'Author', author_username: 'author', accessible_context: {}, direction: 'Direction',
            cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
          }] : [] };
        }
        if (sql.includes("UPDATE meme_generation_jobs\n       SET status = 'processing'")) {
          const job = jobs.find((candidate) => candidate.id === params?.[2]);
          if (job) { job.status = 'processing'; job.leaseOwner = params?.[0] as string; job.leaseValid = true; }
          return { rows: [] };
        }
        if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('FOR UPDATE')) return { rows: [{ id: params?.[0] }] };
        if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [] };
        if (sql.includes('INSERT INTO memes')) { memes.push({ job_id: params?.[3] as string }); return { rows: [{ id: `meme-${memes.length}` }] }; }
        if (sql.includes("UPDATE meme_generation_jobs\n           SET status = 'completed'")) {
          const job = jobs.find((candidate) => candidate.id === params?.[1]);
          if (job) job.status = 'completed';
          return { rows: [{ id: params?.[1] }] };
        }
        if (sql.includes('SELECT target_count, status FROM meme_generation_cycles')) return { rows: [{ target_count: targetCount, status: cycle.status }] };
        if (sql.includes('SELECT id, status, slot_index FROM meme_generation_jobs')) return { rows: jobs };
        if (sql.includes('SELECT m.job_id FROM memes')) return { rows: memes };
        if (sql.includes('UPDATE meme_generation_cycles')) {
          cycle.validProducedCount = params?.[0] as number; cycle.completedJobsCount = params?.[1] as number; cycle.failedJobsCount = params?.[2] as number; cycle.status = params?.[3] as string;
          return { rows: [{ id: cycle.id }] };
        }
        return { rows: [{ id: 'ok' }] };
      },
    }));
    performMemeAnalysis.mockResolvedValue({ immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', requires_asset: false });
    generateMemeImage.mockResolvedValue({ imageBuffer: Buffer.from('ai-image'), mimeType: 'image/png', cost: '0', width: 1024, height: 1024 });
    uploadGeneratedMeme.mockResolvedValue({ url: 'local://meme', pathname: 'meme', contentType: 'image/png', sizeBytes: 5, sha256Hash: 'hash' });

    const result = await processMemeBackgroundQueue({ workerId: 'worker-1', budgetMs: 60_000, cycleId: cycle.id, maxConcurrency: targetCount, maxJobs: targetCount });

    expect(result).toMatchObject({ processed: targetCount, completed: targetCount, failed: 0 });
    expect(cycle).toMatchObject({ status: 'completed', validProducedCount: targetCount, completedJobsCount: targetCount, failedJobsCount: 0 });
    expect(new Set(memes.map((meme) => meme.job_id)).size).toBe(targetCount);
  });

  it('passes the planned brand context to analysis and persists its entity evidence in the final slot plan', async () => {
    let claimed = false;
    let insertedSlotPlan: unknown;
    const checkpointUpdates: string[] = [];
    queryDb.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM memes')) return [];
      if (sql.includes('INSERT INTO meme_api_calls')) return [{ id: 'api-call' }];
      if (sql.includes('UPDATE meme_api_calls SET error_message = $1 WHERE call_key = $2')) {
        checkpointUpdates.push(String(params?.[0]));
        return [];
      }
      if (sql.includes('SELECT id FROM meme_generation_jobs') && sql.includes('lease_owner')) return [{ id: 'job-1' }];
      return [];
    });
    withTransaction.mockImplementation(async (operation: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => operation({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM meme_generation_jobs j')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: [{
            job_id: 'job-1', cycle_id: 'cycle-1', campaign_id: 'campaign-1', draft_id: 'draft-1', campaign_post_id: null, slot_index: 0,
            slot_plan: { textQuantity: 'no_text', brandText: 'GenieOrb', requiresAsset: true, templateId: 'off_vs_on_transformation', templateVersion: 1 }, deterministic_dimensions: {},
            asset_snapshot: {
              primaryAsset: { id: 'primary', assetType: 'logo', instruction: 'Primary instruction', storageKey: 'primary-key', mimeType: 'image/png' },
              secondaryAsset: { id: 'secondary', assetType: 'product', instruction: 'Secondary instruction', storageKey: 'secondary-key', mimeType: 'image/jpeg' },
            },
            model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' }, attempts_count: 0, post_text: 'Gemini is now part of the post',
            author_name: 'Author', author_username: 'author', accessible_context: {}, direction: 'Direction', cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
          }] };
        }
        if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
        if (sql.includes('SELECT target_count, status FROM meme_generation_cycles')) return { rows: [{ target_count: 1, status: 'processing' }] };
        if (sql.includes('INSERT INTO memes')) {
          insertedSlotPlan = JSON.parse(params?.[12] as string);
        }
        return { rows: [{ id: 'ok' }] };
      },
    }));
    performMemeAnalysis.mockResolvedValue({ captions: ['AI CAPTION'], entityEvidence: { externalLogoIntent: true, entities: [{ canonicalEntity: 'Gemini', postJustification: 'Gemini' }, { canonicalEntity: 'Google', postJustification: 'missing' }] } });
    const primaryReference = Buffer.from('primary-reference');
    const secondaryReference = Buffer.from('secondary-reference');
    getMemeBlobBuffer.mockImplementation(async (key: string) => key === 'primary-key' ? primaryReference : secondaryReference);
    const aiImageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZJwAAAABJRU5ErkJggg==', 'base64');
    generateMemeImage.mockResolvedValue({ imageBuffer: aiImageBuffer, mimeType: 'image/png', cost: '0', width: 1, height: 1 });
    validateMemeImage.mockResolvedValue({ is_valid: true, reason: 'clean' });
    uploadGeneratedMeme.mockResolvedValue({ url: 'local://meme', pathname: 'meme', contentType: 'image/png', sizeBytes: 5, sha256Hash: 'hash' });

    await processMemeBackgroundQueue({ workerId: 'worker-1', budgetMs: 60_000, maxJobs: 1 });

    expect(performMemeAnalysis).toHaveBeenCalledWith(expect.objectContaining({ brandContext: 'GenieOrb', textQuantity: 'no_text' }), expect.any(Object));
    expect(performMemeAnalysis.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ modelName: 'authoritative-analysis-model' }));
    const analysisInsert = queryDb.mock.calls.find(([sql, params]) => typeof sql === 'string' && sql.includes('INSERT INTO meme_api_calls') && params?.[5] === 'analysis');
    expect(analysisInsert?.[1]?.[7]).toBe('authoritative-analysis-model');
    expect(analysisInsert?.[1]?.[8]).toBe('authoritative-analysis-model');
    expect(insertedSlotPlan).toMatchObject({ analysisEvidence: { externalLogoIntent: true } });
    expect(generateMemeImage).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: expect.any(String) }),
      expect.objectContaining({ captions: expect.any(Array) }),
      'image-model',
      [
        expect.objectContaining({ buffer: primaryReference, instruction: 'Primary instruction', assetType: 'logo' }),
        expect.objectContaining({ buffer: secondaryReference, instruction: 'Secondary instruction', assetType: 'product' }),
      ],
      undefined,
      expect.any(Object)
    );
    const generationInsert = queryDb.mock.calls.find(([sql, params]) => typeof sql === 'string' && sql.includes('INSERT INTO meme_api_calls') && params?.[5] === 'generation');
    expect(generationInsert?.[0]).toContain('reference_images_count, resolution, error_message');
    expect(generationInsert?.[1]?.[11]).toBe(3);
    expect(generationInsert?.[1]?.[12]).toBe('1024x1024');
    expect(generationInsert?.[1]?.[13]).toContain('checkpoint=ai_started');
    expect(checkpointUpdates).toHaveLength(3);
    const checkpointMessages = [String(generationInsert?.[1]?.[13]), ...checkpointUpdates];
    expect(checkpointMessages.map((message) => message.split(';')[0])).toEqual([
      'checkpoint=ai_started',
      'checkpoint=ai_output_binary_valid',
      'checkpoint=blob_uploaded',
      'checkpoint=db_persisted',
    ]);
    expect(checkpointMessages.every((message) => message.includes('template=off_vs_on_transformation'))).toBe(true);
    expect(uploadGeneratedMeme.mock.calls.at(-1)?.[0]).toBe(aiImageBuffer);
  });

  it('does not block template memes on remote validation or regeneration', async () => {
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
            campaign_post_id: null, slot_index: 0, slot_plan: { textQuantity: 'short_text' }, deterministic_dimensions: {},
            asset_snapshot: null, model_snapshot: { key: 'image-model', provider: 'google', apiModel: 'image-model' },
            attempts_count: 0, post_text: 'Post', author_name: 'Author', author_username: 'author',
            accessible_context: {}, direction: 'SECRET direction must not leak', cycle_model_key: 'image-model', cycle_provider: 'google', cycle_api_model: 'image-model',
          }] };
        }
        if (sql.includes('SELECT id FROM meme_drafts')) return { rows: [{ id: 'draft-1' }] };
        if (sql.includes('SELECT target_count, status FROM meme_generation_cycles')) return { rows: [{ target_count: 1, status: 'processing' }] };
        return { rows: [{ id: 'ok' }] };
      },
    }));
    performMemeAnalysis.mockRejectedValue(new Error('analysis unavailable'));
    generateMemeImage.mockResolvedValue({ imageBuffer: Buffer.from('image'), mimeType: 'image/png', cost: '0', width: 1, height: 1 });
    validateMemeImage.mockResolvedValueOnce({ is_valid: false, reason: 'too busy' }).mockResolvedValueOnce({ is_valid: true, reason: 'clean' });
    uploadGeneratedMeme.mockResolvedValue({ url: 'local://meme', pathname: 'meme', contentType: 'image/png', sizeBytes: 5, sha256Hash: 'hash' });

    await processMemeBackgroundQueue({ workerId: 'worker-1', budgetMs: 60_000, maxJobs: 1 });

    const fallbackAnalysis = generateMemeImage.mock.calls.at(-1)?.[1];
    expect(fallbackAnalysis).toMatchObject({ captions: [] });
    expect(JSON.stringify(fallbackAnalysis)).not.toContain('SECRET');
    expect(fallbackAnalysis?.immediate_joke).not.toContain('Plantilla clasica');

    const validationCalls = apiCallInserts.filter((params) => params[5] === 'validation');
    const regenerationCalls = apiCallInserts.filter((params) => params[5] === 'regeneration');
    expect(validationCalls).toHaveLength(0);
    expect(regenerationCalls).toHaveLength(0);
    expect(validateMemeImage).not.toHaveBeenCalled();
    // Local template rendering is still generation work and must use a
    // purpose accepted by meme_api_calls.
    expect(succeededCallKeys).toEqual(expect.arrayContaining(['job-1:1:analysis', 'job-1:1:generation']));
  });
});
