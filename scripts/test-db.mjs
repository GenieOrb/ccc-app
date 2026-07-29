import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const adminUrl = process.env.GENIEORB_TEST_ADMIN_URL;
const databaseUrl = process.env.GENIEORB_TEST_DATABASE_URL;
if (!adminUrl || !databaseUrl) throw new Error('GENIEORB_TEST_ADMIN_URL and GENIEORB_TEST_DATABASE_URL are required.');

const assertLocal = (raw) => {
  const url = new URL(raw);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('test:db only permits a local PostgreSQL host.');
  return url;
};
const admin = assertLocal(adminUrl);
const base = assertLocal(databaseUrl);
const dbName = `genieorb_test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
let adminClient;
let testClient;

try {
  adminClient = new Client({ connectionString: admin.toString() });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${dbName}"`);
  base.pathname = `/${dbName}`;
  testClient = new Client({ connectionString: base.toString() });
  await testClient.connect();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = await fs.readFile(path.join(here, 'setup-db.sql'), 'utf8');
  await testClient.query(schema);
  await testClient.query(schema);

  const snapshotTriggers = await testClient.query(`
    SELECT t.tgname, p.proname
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgname IN ('trigger_generation_cycle_snapshot', 'trigger_generation_job_snapshot')
      AND NOT t.tgisinternal
    ORDER BY t.tgname
  `);
  if (snapshotTriggers.rowCount !== 2
    || snapshotTriggers.rows[0].proname !== 'fill_generation_cycle_model_snapshot'
    || snapshotTriggers.rows[1].proname !== 'fill_generation_job_model_snapshot') {
    throw new Error('generation snapshot triggers must use distinct strict functions.');
  }

  const campaign = await testClient.query(`INSERT INTO campaigns (slug, campaign_type, is_active, model_key) VALUES ('db-contract', 'manual', true, 'gpt-5.4') RETURNING id`);
  const campaignId = campaign.rows[0].id;
  const account = await testClient.query(
    `INSERT INTO campaign_accounts (campaign_id,username,username_normalized,x_user_id)
     VALUES ($1,'db_author','db_author','db-x-user')
     RETURNING id, initial_sync_pending`,
    [campaignId],
  );
  const accountId = account.rows[0].id;
  if (account.rows[0].initial_sync_pending !== true) throw new Error('campaign_accounts initial_sync_pending must default to true.');
  await testClient.query(`UPDATE campaign_accounts SET last_seen_post_id='999' WHERE id=$1`, [accountId]);
  const pendingAfterCursor = await testClient.query(`SELECT initial_sync_pending FROM campaign_accounts WHERE id=$1`, [accountId]);
  if (pendingAfterCursor.rows[0].initial_sync_pending !== true) throw new Error('Advancing last_seen_post_id must not implicitly complete initial sync.');
  await testClient.query(`UPDATE campaign_accounts SET initial_sync_pending=false WHERE id=$1`, [accountId]);
  const completedAccount = await testClient.query(`SELECT initial_sync_pending,last_seen_post_id FROM campaign_accounts WHERE id=$1`, [accountId]);
  if (completedAccount.rows[0].initial_sync_pending !== false || completedAccount.rows[0].last_seen_post_id !== '999') {
    throw new Error('campaign_accounts must persist initial sync completion independently from its cursor.');
  }
  const post = await testClient.query(`INSERT INTO campaign_posts (campaign_id,x_post_id,input_url,canonical_url,text_content) VALUES ($1,'1','https://x.com/a/status/1','https://x.com/a/status/1','db contract post') RETURNING id`, [campaignId]);
  const postId = post.rows[0].id;
  const cycle = await testClient.query(`INSERT INTO generation_cycles (campaign_id,campaign_post_id,cycle_type,target_count,status,model_key,model_name) VALUES ($1,$2,'initial',1,'pending','gpt-5.4','gpt-5.4') RETURNING id`, [campaignId, postId]);
  const cycleSnapshot = await testClient.query(`SELECT model_key,provider,api_model,input_price_per_million,cached_input_price_per_million,output_price_per_million,pricing_currency FROM generation_cycles WHERE id=$1`, [cycle.rows[0].id]);
  const expectedSnapshot = { model_key: 'gpt-5.4', provider: 'openai', api_model: 'gpt-5.4', input_price_per_million: '2.500000', cached_input_price_per_million: '0.250000', output_price_per_million: '15.000000', pricing_currency: 'USD' };
  for (const [field, expected] of Object.entries(expectedSnapshot)) {
    if (String(cycleSnapshot.rows[0][field]) !== expected) throw new Error(`generation cycle snapshot ${field} must exactly match the campaign model.`);
  }
  const job = await testClient.query(`INSERT INTO generation_jobs (cycle_id,campaign_id,campaign_post_id,slot_index,slot_plan,length_mode,emoji_policy,rhetorical_form,texture,status,model_name,prompt_version,model_key,provider,api_model,input_price_per_million,cached_input_price_per_million,output_price_per_million,pricing_currency) VALUES ($1,$2,$3,0,'{}','ultra_short','no_emoji','statement','plain','pending','wrong',1,'wrong','wrong','wrong',999,999,999,'wrong') RETURNING id`, [cycle.rows[0].id, campaignId, postId]);
  const jobSnapshot = await testClient.query(`SELECT model_key,provider,api_model,input_price_per_million,cached_input_price_per_million,output_price_per_million,pricing_currency FROM generation_jobs WHERE id=$1`, [job.rows[0].id]);
  for (const [field, expected] of Object.entries(expectedSnapshot)) {
    if (String(jobSnapshot.rows[0][field]) !== expected) throw new Error(`generation job snapshot ${field} must exactly inherit its cycle snapshot.`);
  }
  const untouched = await testClient.query(`SELECT model_key FROM campaigns WHERE id=$1`, [campaignId]);
  if (untouched.rows[0].model_key !== 'gpt-5.4') throw new Error('Snapshot checks must not mutate existing campaign data.');
  await testClient.query(`INSERT INTO generation_jobs (cycle_id,campaign_id,campaign_post_id,slot_index,slot_plan,length_mode,emoji_policy,rhetorical_form,texture,status,model_name,prompt_version) VALUES ('00000000-0000-0000-0000-000000000001',$1,$2,1,'{}','ultra_short','no_emoji','statement','plain','pending','gpt-5.4',1)`, [campaignId, postId]).then(
    () => { throw new Error('generation_jobs must reject a missing cycle snapshot.'); },
    (error) => { if (!String(error.message).includes('generation cycle')) throw error; },
  );
  await testClient.query(`INSERT INTO generation_api_calls (call_key,campaign_id,purpose,provider,model_key,api_model,status) VALUES ('db-contract-call',$1,'generation','openai','gpt-5.4','gpt-5.4','started')`, [campaignId]);
  await testClient.query(`INSERT INTO generation_api_calls (call_key,campaign_id,purpose,provider,model_key,api_model,status) VALUES ('db-contract-call',$1,'generation','openai','gpt-5.4','gpt-5.4','started') ON CONFLICT (call_key) DO NOTHING`, [campaignId]);
  const calls = await testClient.query(`SELECT count(*)::int AS count FROM generation_api_calls WHERE call_key='db-contract-call'`);
  if (calls.rows[0].count !== 1) throw new Error('generation_api_calls call_key is not idempotent.');
  await testClient.query(
    `INSERT INTO x_api_calls (call_key,operation,campaign_id,campaign_account_id,status,http_status,finished_at)
     VALUES ('db-contract-x-call','timeline_lookup',$1,$2,'succeeded',200,NOW())`,
    [campaignId, accountId],
  );
  await testClient.query(
    `INSERT INTO x_api_calls (call_key,operation,campaign_id,campaign_account_id,status)
     VALUES ('db-contract-x-call','timeline_lookup',$1,$2,'started')
     ON CONFLICT (call_key) DO NOTHING`,
    [campaignId, accountId],
  );
  const xCalls = await testClient.query(
    `SELECT campaign_id::text AS campaign_id, campaign_account_id::text AS campaign_account_id, status
     FROM x_api_calls WHERE call_key='db-contract-x-call'`,
  );
  if (
    xCalls.rowCount !== 1
    || xCalls.rows[0].campaign_id !== campaignId
    || xCalls.rows[0].campaign_account_id !== accountId
    || xCalls.rows[0].status !== 'succeeded'
  ) {
    throw new Error('x_api_calls must be idempotent and retain campaign/account attribution.');
  }
  console.log('test:db passed');
} finally {
  if (testClient) await testClient.end().catch(() => undefined);
  if (adminClient) {
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await adminClient.end().catch(() => undefined);
  }
}
