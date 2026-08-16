import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const adminUrl = process.env.GENIEORB_TEST_ADMIN_URL;
const databaseUrl = process.env.GENIEORB_TEST_DATABASE_URL;
const hasTestDatabaseUrls = Boolean(adminUrl && databaseUrl);
const describeWithTestDatabase = hasTestDatabaseUrls ? describe : describe.skip;
const databaseName = `genieorb_setup_test_${randomUUID().replaceAll('-', '')}`;
let adminPool: pg.Pool | undefined;
let databasePool: pg.Pool | undefined;

function localUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Test database URLs must use PostgreSQL.');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('setup-db.test.ts only permits a local PostgreSQL host.');
  }
  return url;
}

describeWithTestDatabase('Database Migration', () => {
  beforeAll(async () => {
    const adminConnection = localUrl(adminUrl!);
    const databaseConnection = localUrl(databaseUrl!);
    databaseConnection.pathname = `/${databaseName}`;

    adminPool = new Pool({ connectionString: adminConnection.toString() });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);

    databasePool = new Pool({ connectionString: databaseConnection.toString() });
    const schema = await readFile(resolve(process.cwd(), 'scripts', 'setup-db.sql'), 'utf8');
    await databasePool.query(schema);
  });

  afterAll(async () => {
    await databasePool?.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  });

  it('debe tener constraint fk_assignments_meme_compound', async () => {
    const res = await databasePool!.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'fk_assignments_meme_compound'
    `);
    expect(res.rows).toHaveLength(1);
  });

  it('assignments schema allows content_type meme or comment', async () => {
    const res = await databasePool!.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'assignments' AND column_name IN ('content_type', 'meme_id')
    `);
    expect(res.rows).toHaveLength(2);
  });

  it('campaigns schema has meme_percentage and include_memes', async () => {
    const res = await databasePool!.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'campaigns' AND column_name IN ('include_memes', 'meme_percentage')
    `);
    expect(res.rows).toHaveLength(2);
  });

  it('adds a nullable cancellation timestamp idempotently without losing its value', async () => {
    const column = await databasePool!.query(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'campaigns'
        AND column_name = 'cancelled_at'
    `);
    expect(column.rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);

    const campaign = await databasePool!.query(`
      INSERT INTO campaigns (slug, cancelled_at)
      VALUES ($1, '2026-08-16T12:34:56.000Z'::timestamptz)
      RETURNING id
    `, [`cancelled-at-${randomUUID()}`]);

    const schema = await readFile(resolve(process.cwd(), 'scripts', 'setup-db.sql'), 'utf8');
    await expect(databasePool!.query(schema)).resolves.toBeDefined();

    const persisted = await databasePool!.query(
      `SELECT cancelled_at FROM campaigns WHERE id = $1`,
      [campaign.rows[0].id],
    );
    expect(persisted.rows[0].cancelled_at.toISOString()).toBe('2026-08-16T12:34:56.000Z');
  });

  it('memes has exact constraints', async () => {
    const res = await databasePool!.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'memes' AND column_name IN ('id', 'campaign_id', 'campaign_post_id', 'job_id', 'status', 'storage_url', 'sha256_hash')
    `);
    expect(res.rows).toHaveLength(7);
  });

  it('adds campaign meme cadence and an atomic non-negative global counter', async () => {
    const campaign = await databasePool!.query(`
      INSERT INTO campaigns (slug, meme_every_comments, meme_global_comment_count)
      VALUES ($1, 2, 0)
      RETURNING id
    `, [`meme-cadence-${randomUUID()}`]);
    const campaignId = campaign.rows[0].id as string;

    await expect(databasePool!.query(`
      INSERT INTO campaigns (slug, meme_every_comments)
      VALUES ($1, NULL)
    `, [`meme-cadence-null-${randomUUID()}`])).resolves.toBeDefined();
    await expect(databasePool!.query(`
      INSERT INTO campaigns (slug, meme_every_comments)
      VALUES ($1, 0)
    `, [`meme-cadence-zero-${randomUUID()}`])).rejects.toThrow();
    await expect(databasePool!.query(`
      INSERT INTO campaigns (slug, meme_every_comments)
      VALUES ($1, -1)
    `, [`meme-cadence-negative-${randomUUID()}`])).rejects.toThrow();

    await expect(databasePool!.query(`
      UPDATE campaigns
      SET meme_global_comment_count = -1
      WHERE id = $1
    `, [campaignId])).rejects.toThrow();

    const increments = await Promise.all([
      databasePool!.query(`
        UPDATE campaigns
        SET meme_global_comment_count = meme_global_comment_count + 1
        WHERE id = $1
        RETURNING meme_global_comment_count
      `, [campaignId]),
      databasePool!.query(`
        UPDATE campaigns
        SET meme_global_comment_count = meme_global_comment_count + 1
        WHERE id = $1
        RETURNING meme_global_comment_count
      `, [campaignId]),
    ]);

    expect(increments.map((result) => result.rows[0].meme_global_comment_count).sort()).toEqual([1, 2]);
  });

  it('stores campaign memes, permits reuse across posts, and rejects a duplicate post history', async () => {
    const campaign = await databasePool!.query(`
      INSERT INTO campaigns (slug)
      VALUES ($1)
      RETURNING id
    `, [`campaign-meme-${randomUUID()}`]);
    const campaignId = campaign.rows[0].id as string;
    const [firstPost, secondPost] = await Promise.all([1, 2].map((number) => databasePool!.query(`
      INSERT INTO campaign_posts (campaign_id, x_post_id, input_url, canonical_url, text_content)
      VALUES ($1, $2, $3, $3, 'test post')
      RETURNING id
    `, [campaignId, `meme-post-${number}-${randomUUID()}`, `https://example.test/${number}`])));
    const meme = await databasePool!.query(`
      INSERT INTO campaign_memes (
        campaign_id, storage_provider, storage_key, storage_url, mime_type,
        size_bytes, width, height, sha256_hash, status
      ) VALUES ($1, 'test', $2, 'https://example.test/meme.png', 'image/png', 1, 1, 1, $3, 'available')
      RETURNING id
    `, [campaignId, `meme/${randomUUID()}`, randomUUID().replaceAll('-', '')]);
    const memeId = meme.rows[0].id as string;

    const visitorWithoutHistory = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`visitor-without-history-${randomUUID()}`]);
    await expect(databasePool!.query(`
      INSERT INTO assignments (campaign_id, visitor_id, campaign_post_id, suggestion_id, content_type, campaign_meme_id)
      VALUES ($1, $2, $3, NULL, 'meme', $4)
    `, [campaignId, visitorWithoutHistory.rows[0].id, firstPost.rows[0].id, memeId])).rejects.toThrow();

    await databasePool!.query(`
      INSERT INTO campaign_meme_posts (campaign_meme_id, campaign_post_id, campaign_id)
      VALUES ($1, $2, $4), ($1, $3, $4)
    `, [memeId, firstPost.rows[0].id, secondPost.rows[0].id, campaignId]);
    await expect(databasePool!.query(`
      INSERT INTO campaign_meme_posts (campaign_meme_id, campaign_post_id, campaign_id)
      VALUES ($1, $2, $3)
    `, [memeId, firstPost.rows[0].id, campaignId])).rejects.toThrow();

    const visitor = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`visitor-${randomUUID()}`]);
    await expect(databasePool!.query(`
      INSERT INTO assignments (campaign_id, visitor_id, campaign_post_id, suggestion_id, content_type, campaign_meme_id)
      VALUES ($1, $2, $3, NULL, 'meme', $4)
    `, [campaignId, visitor.rows[0].id, firstPost.rows[0].id, memeId])).resolves.toBeDefined();

    const secondVisitor = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`visitor-duplicate-history-${randomUUID()}`]);
    await expect(databasePool!.query(`
      INSERT INTO assignments (campaign_id, visitor_id, campaign_post_id, suggestion_id, content_type, campaign_meme_id)
      VALUES ($1, $2, $3, NULL, 'meme', $4)
    `, [campaignId, secondVisitor.rows[0].id, firstPost.rows[0].id, memeId])).rejects.toThrow();
  });

  it('rejects campaign meme history that crosses campaigns', async () => {
    const [firstCampaign, secondCampaign] = await Promise.all([1, 2].map((number) => databasePool!.query(`
      INSERT INTO campaigns (slug) VALUES ($1) RETURNING id
    `, [`history-campaign-${number}-${randomUUID()}`])));
    const firstCampaignId = firstCampaign.rows[0].id as string;
    const secondCampaignId = secondCampaign.rows[0].id as string;
    const meme = await databasePool!.query(`
      INSERT INTO campaign_memes (
        campaign_id, storage_provider, storage_key, storage_url, mime_type,
        size_bytes, sha256_hash
      ) VALUES ($1, 'test', $2, 'https://example.test/cross-campaign.png', 'image/png', 1, $3)
      RETURNING id
    `, [firstCampaignId, `meme/${randomUUID()}`, randomUUID().replaceAll('-', '')]);
    const post = await databasePool!.query(`
      INSERT INTO campaign_posts (campaign_id, x_post_id, input_url, canonical_url, text_content)
      VALUES ($1, $2, $3, $3, 'test post')
      RETURNING id
    `, [secondCampaignId, `cross-campaign-post-${randomUUID()}`, 'https://example.test/cross-campaign']);

    await expect(databasePool!.query(`
      INSERT INTO campaign_meme_posts (campaign_meme_id, campaign_post_id, campaign_id)
      VALUES ($1, $2, $3)
    `, [meme.rows[0].id, post.rows[0].id, firstCampaignId])).rejects.toThrow();
  });

  it('rejects duplicate active hashes within one campaign but allows them across campaigns', async () => {
    const [firstCampaign, secondCampaign] = await Promise.all([1, 2].map((number) => databasePool!.query(`
      INSERT INTO campaigns (slug) VALUES ($1) RETURNING id
    `, [`hash-campaign-${number}-${randomUUID()}`])));
    const hash = randomUUID().replaceAll('-', '');
    const insertMeme = (campaignId: string, suffix: string) => databasePool!.query(`
      INSERT INTO campaign_memes (
        campaign_id, storage_provider, storage_key, storage_url, mime_type,
        size_bytes, sha256_hash, status
      ) VALUES ($1, 'test', $2, $3, 'image/png', 1, $4, 'available')
    `, [campaignId, `meme/${suffix}`, `https://example.test/${suffix}.png`, hash]);

    await expect(insertMeme(firstCampaign.rows[0].id as string, randomUUID())).resolves.toBeDefined();
    await expect(insertMeme(firstCampaign.rows[0].id as string, randomUUID())).rejects.toThrow();
    await expect(insertMeme(secondCampaign.rows[0].id as string, randomUUID())).resolves.toBeDefined();
  });

  it('preserves legacy assignment ownership and enforces exactly one meme source', async () => {
    const campaign = await databasePool!.query(`
      INSERT INTO campaigns (slug)
      VALUES ($1)
      RETURNING id
    `, [`legacy-assignment-${randomUUID()}`]);
    const campaignId = campaign.rows[0].id as string;
    const post = await databasePool!.query(`
      INSERT INTO campaign_posts (campaign_id, x_post_id, input_url, canonical_url, text_content)
      VALUES ($1, $2, $3, $3, 'legacy assignment post')
      RETURNING id
    `, [campaignId, `legacy-post-${randomUUID()}`, 'https://example.test/legacy-assignment']);
    const postId = post.rows[0].id as string;
    const memeCycle = await databasePool!.query(`
      INSERT INTO meme_generation_cycles (
        campaign_id, campaign_post_id, cycle_type, target_count, status,
        model_key, provider, api_model, planner_version, pricing_snapshot
      ) VALUES ($1, $2, 'initial', 2, 'completed', 'test-model', 'test', 'test-model', 1, '{}'::jsonb)
      RETURNING id
    `, [campaignId, postId]);
    const memeCycleId = memeCycle.rows[0].id as string;

    const insertLegacyMeme = async (slotIndex: number) => {
      const job = await databasePool!.query(`
        INSERT INTO meme_generation_jobs (
          cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan,
          deterministic_dimensions, model_snapshot, status
        ) VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'completed')
        RETURNING id
      `, [memeCycleId, campaignId, postId, slotIndex]);
      const meme = await databasePool!.query(`
        INSERT INTO memes (
          campaign_id, campaign_post_id, job_id, status, storage_provider,
          storage_key, storage_url, mime_type, size_bytes, width, height,
          sha256_hash, slot_plan, model_key, delivery_order
        ) VALUES (
          $1, $2, $3, 'assigned', 'test', $4, $5, 'image/png', 1, 1, 1,
          $6, '{}'::jsonb, 'test-model', $7
        )
        RETURNING id
      `, [
        campaignId,
        postId,
        job.rows[0].id,
        `legacy/${randomUUID()}`,
        `https://example.test/legacy-${slotIndex}.png`,
        randomUUID().replaceAll('-', ''),
        slotIndex,
      ]);
      return meme.rows[0].id as string;
    };

    const legacyMemeId = await insertLegacyMeme(0);
    const xorMemeId = await insertLegacyMeme(1);
    const legacyVisitor = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`legacy-visitor-${randomUUID()}`]);
    const legacyAssignment = await databasePool!.query(`
      INSERT INTO assignments (
        campaign_id, visitor_id, campaign_post_id, suggestion_id,
        content_type, meme_id, campaign_meme_id
      ) VALUES ($1, $2, $3, NULL, 'meme', $4, NULL)
      RETURNING id
    `, [campaignId, legacyVisitor.rows[0].id, postId, legacyMemeId]);

    const schema = await readFile(resolve(process.cwd(), 'scripts', 'setup-db.sql'), 'utf8');
    await databasePool!.query(schema);

    const migratedLegacyAssignment = await databasePool!.query(`
      SELECT meme_id, campaign_meme_id
      FROM assignments
      WHERE id = $1
    `, [legacyAssignment.rows[0].id]);
    expect(migratedLegacyAssignment.rows[0]).toEqual({
      meme_id: legacyMemeId,
      campaign_meme_id: null,
    });

    const bothIdsVisitor = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`both-meme-ids-${randomUUID()}`]);
    await expect(databasePool!.query(`
      INSERT INTO assignments (
        campaign_id, visitor_id, campaign_post_id, suggestion_id,
        content_type, meme_id, campaign_meme_id
      ) VALUES ($1, $2, $3, NULL, 'meme', $4, $4)
    `, [campaignId, bothIdsVisitor.rows[0].id, postId, xorMemeId])).rejects.toThrow();

    const noIdsVisitor = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`no-meme-ids-${randomUUID()}`]);
    await expect(databasePool!.query(`
      INSERT INTO assignments (
        campaign_id, visitor_id, campaign_post_id, suggestion_id,
        content_type, meme_id, campaign_meme_id
      ) VALUES ($1, $2, $3, NULL, 'meme', NULL, NULL)
    `, [campaignId, noIdsVisitor.rows[0].id, postId])).rejects.toThrow();

    const commentCycle = await databasePool!.query(`
      INSERT INTO generation_cycles (campaign_id, campaign_post_id, cycle_type, status)
      VALUES ($1, $2, 'initial', 'completed')
      RETURNING id
    `, [campaignId, postId]);
    const commentJob = await databasePool!.query(`
      INSERT INTO generation_jobs (
        cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan,
        length_mode, emoji_policy, rhetorical_form, texture, status
      ) VALUES (
        $1, $2, $3, 0, '{}'::jsonb, 'normal', 'no_emoji', 'statement', 'plain', 'completed'
      )
      RETURNING id
    `, [commentCycle.rows[0].id, campaignId, postId]);
    const suggestion = await databasePool!.query(`
      INSERT INTO suggestions (
        campaign_id, campaign_post_id, cycle_id, job_id, comment_text,
        normalized_hash, slot_plan, status, delivery_order
      ) VALUES ($1, $2, $3, $4, 'valid comment', $5, '{}'::jsonb, 'available', 1)
      RETURNING id
    `, [campaignId, postId, commentCycle.rows[0].id, commentJob.rows[0].id, randomUUID()]);
    const commentWithMemeVisitor = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`comment-with-meme-${randomUUID()}`]);
    await expect(databasePool!.query(`
      INSERT INTO assignments (
        campaign_id, visitor_id, campaign_post_id, suggestion_id,
        content_type, meme_id, campaign_meme_id
      ) VALUES ($1, $2, $3, $4, 'comment', NULL, $5)
    `, [campaignId, commentWithMemeVisitor.rows[0].id, postId, suggestion.rows[0].id, xorMemeId])).rejects.toThrow();

    const reusableVisitor = await databasePool!.query(`
      INSERT INTO visitors (visitor_hash) VALUES ($1) RETURNING id
    `, [`reusable-only-${randomUUID()}`]);
    await expect(databasePool!.query(`
      INSERT INTO assignments (
        campaign_id, visitor_id, campaign_post_id, suggestion_id,
        content_type, meme_id, campaign_meme_id
      ) VALUES ($1, $2, $3, NULL, 'meme', NULL, $4)
    `, [campaignId, reusableVisitor.rows[0].id, postId, xorMemeId])).resolves.toBeDefined();
  });

  it('remains idempotent when the schema is applied a second time', async () => {
    const schema = await readFile(resolve(process.cwd(), 'scripts', 'setup-db.sql'), 'utf8');
    await expect(databasePool!.query(schema)).resolves.toBeDefined();
  });
});
