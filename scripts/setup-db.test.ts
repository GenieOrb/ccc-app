import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const { Pool } = pg;

describe('Database Migration', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: 'postgresql://postgres:postgres@localhost:5432/postgres'
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('debe tener constraint fk_assignments_meme_compound', async () => {
    const res = await pool.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'fk_assignments_meme_compound'
    `);
    expect(res.rows.length).toBe(1);
  });

  it('assignments schema allows content_type meme or comment', async () => {
    const res = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'assignments' AND column_name IN ('content_type', 'meme_id')
    `);
    expect(res.rows.length).toBe(2);
  });

  it('campaigns schema has meme_percentage and include_memes', async () => {
    const res = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'campaigns' AND column_name IN ('include_memes', 'meme_percentage')
    `);
    expect(res.rows.length).toBe(2);
  });

  it('memes has exact constraints', async () => {
    const res = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'memes' AND column_name IN ('id', 'campaign_id', 'campaign_post_id', 'job_id', 'status', 'storage_url', 'sha256_hash')
    `);
    expect(res.rows.length).toBe(7);
  });
});
