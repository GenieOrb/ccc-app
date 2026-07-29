import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

if (process.env.GENIEORB_ALLOW_TRANSACTIONAL_NEON_TEST !== '1') {
  throw new Error(
    'Refusing to load DATABASE_URL or connect to Neon. Set GENIEORB_ALLOW_TRANSACTIONAL_NEON_TEST=1 to run this transactional verification.',
  );
}

neonConfig.webSocketConstructor = ws;

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envPath = path.join(here, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const match = fs.readFileSync(envPath, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (match) {
      const raw = match[1].trim();
      process.env.DATABASE_URL = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    }
  }
}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL environment variable is missing.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const suffix = randomUUID().replaceAll('-', '');

try {
  await client.query('BEGIN');
  const triggers = await client.query(`
    SELECT t.tgname, p.proname
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgname IN ('trigger_generation_cycle_snapshot', 'trigger_generation_job_snapshot')
      AND NOT t.tgisinternal
    ORDER BY t.tgname
  `);
  if (triggers.rowCount !== 2
    || triggers.rows[0].proname !== 'fill_generation_cycle_model_snapshot'
    || triggers.rows[1].proname !== 'fill_generation_job_model_snapshot') {
    throw new Error('Generation snapshot triggers are not installed with their separate functions.');
  }

  const campaign = await client.query(
    `INSERT INTO campaigns (slug,campaign_type,is_active,model_key)
     VALUES ($1,'manual',true,'gpt-5.4') RETURNING id`,
    [`db-verify-${suffix}`],
  );
  const campaignId = campaign.rows[0].id;
  const post = await client.query(
    `INSERT INTO campaign_posts (campaign_id,x_post_id,input_url,canonical_url,text_content)
     VALUES ($1,$2,$3,$3,'Transactional DB trigger verification') RETURNING id`,
    [campaignId, `db-${suffix}`, `https://example.invalid/status/${suffix}`],
  );
  const postId = post.rows[0].id;
  const cycle = await client.query(
    `INSERT INTO generation_cycles (campaign_id,campaign_post_id,cycle_type,target_count,status,model_key,model_name)
     VALUES ($1,$2,'initial',1,'pending','gpt-5.4','gpt-5.4') RETURNING id`,
    [campaignId, postId],
  );
  const cycleId = cycle.rows[0].id;
  await client.query(
    `INSERT INTO generation_jobs
       (cycle_id,campaign_id,campaign_post_id,slot_index,slot_plan,length_mode,emoji_policy,rhetorical_form,texture,status,model_name,prompt_version)
     VALUES ($1,$2,$3,0,'{}','ultra_short','no_emoji','statement','plain','pending','wrong',1)`,
    [cycleId, campaignId, postId],
  );
  const job = await client.query(
    `SELECT j.model_key,j.provider,j.api_model,c.model_key AS cycle_model_key,c.provider AS cycle_provider,c.api_model AS cycle_api_model
     FROM generation_jobs j JOIN generation_cycles c ON c.id=j.cycle_id
     WHERE j.cycle_id=$1`,
    [cycleId],
  );
  if (job.rowCount !== 1 || job.rows[0].model_key !== job.rows[0].cycle_model_key
    || job.rows[0].provider !== job.rows[0].cycle_provider
    || job.rows[0].api_model !== job.rows[0].cycle_api_model) {
    throw new Error('Generation job did not inherit the cycle snapshot.');
  }
  await client.query('ROLLBACK');
  console.log('Transactional trigger verification passed and rolled back.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
