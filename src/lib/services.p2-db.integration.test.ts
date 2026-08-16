import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { deleteBlobStrict } = vi.hoisted(() => ({ deleteBlobStrict: vi.fn() }));
vi.mock('./memes/blob', () => ({ deleteBlobStrict }));

const { Pool } = pg;
const adminUrl = process.env.GENIEORB_TEST_ADMIN_URL;
const databaseUrl = process.env.GENIEORB_TEST_DATABASE_URL;
const hasTestDatabaseUrls = Boolean(adminUrl && databaseUrl);
const describeWithTestDatabase = hasTestDatabaseUrls ? describe : describe.skip;
const databaseName = `genieorb_p2_behavior_${randomUUID().replaceAll('-', '')}`;

let adminPool: pg.Pool | undefined;
let databasePool: pg.Pool | undefined;
let assignCommentToVisitor: typeof import('./services').assignCommentToVisitor;
let cancelCampaign: typeof import('./services').cancelCampaign;

function localUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('P2 integration tests only permit an isolated local PostgreSQL database.');
  }
  return url;
}

async function insertCampaign(slug: string, includeMemes = true) {
  const result = await databasePool!.query<{ id: string }>(
    `INSERT INTO campaigns (slug, is_active, include_memes, meme_every_comments, meme_global_comment_count, replenishment_threshold)
     VALUES ($1, true, $2, 2, 0, 999)
     RETURNING id`,
    [slug, includeMemes],
  );
  return result.rows[0].id;
}

async function insertPostWithSuggestion(campaignId: string, suffix: string) {
  const post = await databasePool!.query<{ id: string }>(
    `INSERT INTO campaign_posts (campaign_id, x_post_id, input_url, canonical_url, text_content)
     VALUES ($1, $2, $3, $3, $4) RETURNING id`,
    [campaignId, suffix, `https://x.com/p2/status/${suffix}`, `post ${suffix}`],
  );
  const postId = post.rows[0].id;
  const cycle = await databasePool!.query<{ id: string }>(
    `INSERT INTO generation_cycles (campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, model_name)
     VALUES ($1, $2, 'initial', 1, 'completed', 'gpt-5.4', 'gpt-5.4') RETURNING id`,
    [campaignId, postId],
  );
  const job = await databasePool!.query<{ id: string }>(
    `INSERT INTO generation_jobs (cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan, length_mode, emoji_policy, rhetorical_form, texture, status, model_name, prompt_version)
     VALUES ($1, $2, $3, 0, '{}', 'ultra_short', 'no_emoji', 'statement', 'plain', 'completed', 'gpt-5.4', 1)
     RETURNING id`,
    [cycle.rows[0].id, campaignId, postId],
  );
  await databasePool!.query(
    `INSERT INTO suggestions (campaign_id, campaign_post_id, cycle_id, job_id, comment_text, normalized_hash, slot_plan, status, delivery_order)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', 'available', 0)`,
    [campaignId, postId, cycle.rows[0].id, job.rows[0].id, `comment ${suffix}`, `hash-${campaignId}-${suffix}`],
  );
  return postId;
}

async function insertCampaignMeme(campaignId: string, suffix: string) {
  const meme = await databasePool!.query<{ id: string }>(
    `INSERT INTO campaign_memes (campaign_id, storage_provider, storage_key, storage_url, mime_type, size_bytes, sha256_hash, status)
     VALUES ($1, 'test', $2, $3, 'image/png', 1, $4, 'available') RETURNING id`,
    [campaignId, `private/p2-${suffix}.png`, `https://blob.invalid/p2-${suffix}.png`, `p2-${suffix}`],
  );
  return meme.rows[0].id;
}

describeWithTestDatabase('P2 real PostgreSQL assignment and cancellation behavior', () => {
  beforeAll(async () => {
    const adminConnection = localUrl(adminUrl!);
    const databaseConnection = localUrl(databaseUrl!);
    databaseConnection.pathname = `/${databaseName}`;
    adminPool = new Pool({ connectionString: adminConnection.toString() });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    databasePool = new Pool({ connectionString: databaseConnection.toString() });
    await databasePool.query(await readFile(resolve(process.cwd(), 'scripts', 'setup-db.sql'), 'utf8'));

    // db.ts deliberately reads DATABASE_URL lazily. Point the real service at
    // this test-only database before loading it; no database calls are mocked.
    process.env.DATABASE_URL = databaseConnection.toString();
    ({ assignCommentToVisitor, cancelCampaign } = await import('./services'));
    deleteBlobStrict.mockResolvedValue(undefined);
  }, 30_000);

  afterAll(async () => {
    await databasePool?.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  }, 30_000);

  it('delivers two global comments at N=2, then reuses one meme on different posts without repeating a meme/post pair', async () => {
    const slug = `p2-cadence-${randomUUID()}`;
    const campaignId = await insertCampaign(slug);
    const postOne = await insertPostWithSuggestion(campaignId, '101');
    const postTwo = await insertPostWithSuggestion(campaignId, '102');
    const memeId = await insertCampaignMeme(campaignId, 'cadence');

    await expect(assignCommentToVisitor(slug, 'p2-visitor-one')).resolves.toMatchObject({ status: 'success', type: 'comment' });
    await expect(assignCommentToVisitor(slug, 'p2-visitor-two')).resolves.toMatchObject({ status: 'success', type: 'comment' });
    const afterComments = await databasePool!.query<{ meme_global_comment_count: number }>(
      `SELECT meme_global_comment_count FROM campaigns WHERE id = $1`, [campaignId],
    );
    expect(afterComments.rows[0].meme_global_comment_count).toBe(2);

    const firstMeme = await assignCommentToVisitor(slug, 'p2-visitor-three');
    await databasePool!.query(
      `UPDATE campaigns SET meme_global_comment_count = meme_every_comments WHERE id = $1`,
      [campaignId],
    );
    const secondMeme = await assignCommentToVisitor(slug, 'p2-visitor-four');
    expect(firstMeme).toMatchObject({ status: 'success', type: 'meme' });
    expect(secondMeme).toMatchObject({ status: 'success', type: 'meme' });

    const history = await databasePool!.query<{ campaign_post_id: string }>(
      `SELECT campaign_post_id FROM campaign_meme_posts WHERE campaign_meme_id = $1 ORDER BY campaign_post_id`, [memeId],
    );
    expect(history.rows.map((row) => row.campaign_post_id).sort()).toEqual([postOne, postTwo].sort());
    const duplicatePair = await databasePool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM campaign_meme_posts WHERE campaign_meme_id = $1 AND campaign_post_id = $2`,
      [memeId, history.rows[0].campaign_post_id],
    );
    expect(duplicatePair.rows[0].count).toBe('1');
    const afterMemes = await databasePool!.query<{ meme_global_comment_count: number }>(
      `SELECT meme_global_comment_count FROM campaigns WHERE id = $1`, [campaignId],
    );
    expect(afterMemes.rows[0].meme_global_comment_count).toBe(0);
  });

  it('preserves a due meme debt when no meme/post pair is eligible', async () => {
    const slug = `p2-debt-${randomUUID()}`;
    const campaignId = await insertCampaign(slug);
    await insertPostWithSuggestion(campaignId, '201');
    await insertPostWithSuggestion(campaignId, '202');
    await insertPostWithSuggestion(campaignId, '203');

    await assignCommentToVisitor(slug, 'p2-debt-one');
    await assignCommentToVisitor(slug, 'p2-debt-two');
    await expect(assignCommentToVisitor(slug, 'p2-debt-three')).resolves.toMatchObject({ status: 'success', type: 'comment' });
    const campaign = await databasePool!.query<{ meme_global_comment_count: number }>(
      `SELECT meme_global_comment_count FROM campaigns WHERE id = $1`, [campaignId],
    );
    expect(campaign.rows[0].meme_global_comment_count).toBe(2);
  });

  it('serializes concurrent cancellation, makes queues terminal, and cleans a claimed meme once', async () => {
    const slug = `p2-cancel-${randomUUID()}`;
    const campaignId = await insertCampaign(slug);
    const postId = await insertPostWithSuggestion(campaignId, '301');
    const cycle = await databasePool!.query<{ id: string }>(
      `INSERT INTO meme_generation_cycles (campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, provider, api_model, planner_version, pricing_snapshot)
       VALUES ($1, $2, 'initial', 1, 'processing', 'test', 'test', 'test', 1, '{}') RETURNING id`,
      [campaignId, postId],
    );
    await databasePool!.query(
      `INSERT INTO meme_generation_jobs (cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan, deterministic_dimensions, model_snapshot, status)
       VALUES ($1, $2, $3, 0, '{}', '{}', '{}', 'processing')`,
      [cycle.rows[0].id, campaignId, postId],
    );
    await databasePool!.query(`UPDATE generation_cycles SET status = 'processing' WHERE campaign_id = $1`, [campaignId]);
    await databasePool!.query(`UPDATE generation_jobs SET status = 'processing' WHERE campaign_id = $1`, [campaignId]);
    const memeId = await insertCampaignMeme(campaignId, 'cancel');
    await databasePool!.query(`UPDATE campaign_memes SET status = 'rejected' WHERE id = $1`, [memeId]);
    deleteBlobStrict.mockClear();

    const results = await Promise.all([cancelCampaign(campaignId), cancelCampaign(campaignId)]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptedCount: 1, retiredCount: 1, failedCount: 0 }),
      expect.objectContaining({ attemptedCount: 0, retiredCount: 0, failedCount: 0 }),
    ]));
    expect(deleteBlobStrict).toHaveBeenCalledTimes(1);

    const terminal = await databasePool!.query<{ cancelled_at: Date | null; is_active: boolean; generation_job: string; generation_cycle: string; meme_job: string; meme_cycle: string; meme_status: string }>(
      `SELECT c.cancelled_at, c.is_active,
         (SELECT status FROM generation_jobs WHERE campaign_id = c.id LIMIT 1) AS generation_job,
         (SELECT status FROM generation_cycles WHERE campaign_id = c.id LIMIT 1) AS generation_cycle,
         (SELECT status FROM meme_generation_jobs WHERE campaign_id = c.id LIMIT 1) AS meme_job,
         (SELECT status FROM meme_generation_cycles WHERE campaign_id = c.id LIMIT 1) AS meme_cycle,
         (SELECT status FROM campaign_memes WHERE id = $2) AS meme_status
       FROM campaigns c WHERE c.id = $1`,
      [campaignId, memeId],
    );
    expect(terminal.rows[0]).toMatchObject({ is_active: false, generation_job: 'cancelled', generation_cycle: 'cancelled', meme_job: 'cancelled', meme_cycle: 'cancelled', meme_status: 'retired' });
    expect(terminal.rows[0].cancelled_at).toBeInstanceOf(Date);
  });
});
