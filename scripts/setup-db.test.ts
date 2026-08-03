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

  it('memes has exact constraints', async () => {
    const res = await databasePool!.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'memes' AND column_name IN ('id', 'campaign_id', 'campaign_post_id', 'job_id', 'status', 'storage_url', 'sha256_hash')
    `);
    expect(res.rows).toHaveLength(7);
  });
});
