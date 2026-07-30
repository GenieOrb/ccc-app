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
  await testClient.query(`DROP INDEX IF EXISTS campaign_accounts_poll_lease_idx`);
  await testClient.query(`ALTER TABLE campaign_accounts DROP COLUMN IF EXISTS poll_lease_owner`);
  await testClient.query(`ALTER TABLE campaign_accounts DROP COLUMN IF EXISTS poll_lease_expires_at`);
  await testClient.query(schema);
  const pollLeaseUpgrade = await testClient.query(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'campaign_accounts' AND column_name = 'poll_lease_owner') AS has_owner,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'campaign_accounts' AND column_name = 'poll_lease_expires_at') AS has_expiry,
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'campaign_accounts_poll_lease_idx') AS has_index
  `);
  if (!pollLeaseUpgrade.rows[0].has_owner || !pollLeaseUpgrade.rows[0].has_expiry || !pollLeaseUpgrade.rows[0].has_index) {
    throw new Error('setup-db must upgrade campaign_accounts poll lease columns before creating their index.');
  }

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
  const legacyAmbiguousCursorAdvance = `
    UPDATE campaign_accounts
    SET last_seen_post_id = CASE
      WHEN last_seen_post_id IS NULL OR CAST($1 AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC) THEN $1
      ELSE last_seen_post_id
    END
    WHERE id = $2
    RETURNING last_seen_post_id
  `;
  const nullableCompletionCursorAdvance = `
    UPDATE campaign_accounts
    SET last_seen_post_id = CASE
      WHEN $1::TEXT IS NOT NULL
        AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
        THEN $1::TEXT
      ELSE last_seen_post_id
    END,
    initial_sync_pending = false
    WHERE id = $2
    RETURNING last_seen_post_id, initial_sync_pending
  `;
  const recoveryCursorAdvance = `
    UPDATE campaign_accounts
    SET last_seen_post_id = CASE
      WHEN last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC) THEN $1::TEXT
      ELSE last_seen_post_id
    END
    WHERE id = $2
    RETURNING last_seen_post_id
  `;
  const ongoingCursorAdvance = `
    UPDATE campaign_accounts
    SET last_seen_post_id = $1::TEXT
    WHERE id = $2
      AND (last_seen_post_id IS NULL OR CAST($1::TEXT AS NUMERIC) > CAST(last_seen_post_id AS NUMERIC))
    RETURNING last_seen_post_id
  `;
  await testClient.query('BEGIN');
  try {
    await testClient.query(
      `INSERT INTO campaign_posts (campaign_id,campaign_account_id,x_post_id,input_url,canonical_url,text_content)
      VALUES ($1,$2,'cursor-contract-rollback','https://x.com/db_author/status/cursor-contract','https://x.com/db_author/status/cursor-contract','cursor transaction contract')`,
      [campaignId, accountId],
    );
    await testClient.query(legacyAmbiguousCursorAdvance, ['1000', accountId]);
    await testClient.query('ROLLBACK');
    throw new Error('legacy ambiguous cursor CASE must fail with PostgreSQL 42804.');
  } catch (error) {
    await testClient.query('ROLLBACK');
    if (error.code !== '42804') throw error;
  }
  const partialRows = await testClient.query(
    `SELECT count(*)::int AS count FROM campaign_posts WHERE campaign_account_id=$1 AND x_post_id='cursor-contract-rollback'`,
    [accountId],
  );
  if (partialRows.rows[0].count !== 0) throw new Error('cursor update failure must roll back every partial post insert.');
  console.log('cursor contract rollback verified: PostgreSQL 42804 and partial rows=0');

  await testClient.query('BEGIN');
  try {
    const committedPost = await testClient.query(
      `INSERT INTO campaign_posts (campaign_id,campaign_account_id,x_post_id,input_url,canonical_url,text_content)
       VALUES ($1,$2,'cursor-contract-commit','https://x.com/db_author/status/cursor-contract-commit','https://x.com/db_author/status/cursor-contract-commit','cursor commit contract')
       RETURNING id`,
      [campaignId, accountId],
    );
    const committedCycle = await testClient.query(
      `INSERT INTO generation_cycles (campaign_id,campaign_post_id,cycle_type,target_count,status,model_key,model_name)
       VALUES ($1,$2,'initial',1,'pending','gpt-5.4','gpt-5.4')
       RETURNING id`,
      [campaignId, committedPost.rows[0].id],
    );
    await testClient.query(
      `INSERT INTO generation_jobs (cycle_id,campaign_id,campaign_post_id,slot_index,slot_plan,length_mode,emoji_policy,rhetorical_form,texture,status,model_name,prompt_version)
       VALUES ($1,$2,$3,0,'{}','ultra_short','no_emoji','statement','plain','pending','gpt-5.4',1)`,
      [committedCycle.rows[0].id, campaignId, committedPost.rows[0].id],
    );
    const committedCursor = await testClient.query(nullableCompletionCursorAdvance, ['2000', accountId]);
    if (
      committedCursor.rowCount !== 1
      || committedCursor.rows[0].last_seen_post_id !== '2000'
      || committedCursor.rows[0].initial_sync_pending !== false
    ) {
      throw new Error('nullable completion cursor must advance as TEXT inside the durable transaction.');
    }
    await testClient.query('COMMIT');
  } catch (error) {
    await testClient.query('ROLLBACK');
    throw error;
  }
  const committedChain = await testClient.query(
    `SELECT
       (SELECT count(*)::int FROM campaign_posts WHERE campaign_account_id=$1 AND x_post_id='cursor-contract-commit') AS post_count,
       (SELECT count(*)::int FROM generation_cycles gc
        JOIN campaign_posts cp ON cp.id=gc.campaign_post_id
        WHERE cp.campaign_account_id=$1 AND cp.x_post_id='cursor-contract-commit') AS cycle_count,
       (SELECT count(*)::int FROM generation_jobs gj
        JOIN campaign_posts cp ON cp.id=gj.campaign_post_id
        WHERE cp.campaign_account_id=$1 AND cp.x_post_id='cursor-contract-commit') AS job_count,
       ca.last_seen_post_id,
       pg_typeof(ca.last_seen_post_id)::text AS cursor_type,
       ca.initial_sync_pending
     FROM campaign_accounts ca
     WHERE ca.id=$1`,
    [accountId],
  );
  const committed = committedChain.rows[0];
  if (
    committedChain.rowCount !== 1
    || committed.post_count !== 1
    || committed.cycle_count !== 1
    || committed.job_count !== 1
    || committed.last_seen_post_id !== '2000'
    || committed.cursor_type !== 'text'
    || committed.initial_sync_pending !== false
  ) {
    throw new Error('cursor transaction must commit exactly one post, cycle, job, and TEXT cursor.');
  }

  const nullCompletionCursor = await testClient.query(nullableCompletionCursorAdvance, [null, accountId]);
  if (
    nullCompletionCursor.rowCount !== 1
    || nullCompletionCursor.rows[0].last_seen_post_id !== '2000'
    || nullCompletionCursor.rows[0].initial_sync_pending !== false
  ) {
    throw new Error('nullable completion cursor must retain its durable TEXT cursor for a null candidate.');
  }
  const recoveryAdvance = await testClient.query(recoveryCursorAdvance, ['2100', accountId]);
  if (recoveryAdvance.rowCount !== 1 || recoveryAdvance.rows[0].last_seen_post_id !== '2100') {
    throw new Error('recovery CASE cursor must advance to the greater TEXT post id.');
  }
  const recoveryNonRegression = await testClient.query(recoveryCursorAdvance, ['2050', accountId]);
  if (recoveryNonRegression.rowCount !== 1 || recoveryNonRegression.rows[0].last_seen_post_id !== '2100') {
    throw new Error('recovery CASE cursor must return one row without regressing.');
  }
  const ongoingAdvance = await testClient.query(ongoingCursorAdvance, ['2200', accountId]);
  if (ongoingAdvance.rowCount !== 1 || ongoingAdvance.rows[0].last_seen_post_id !== '2200') {
    throw new Error('ongoing direct cursor must advance to the greater TEXT post id.');
  }
  const ongoingNonRegression = await testClient.query(ongoingCursorAdvance, ['2150', accountId]);
  if (ongoingNonRegression.rowCount !== 0) throw new Error('ongoing direct cursor must update no row for an older post id.');
  const finalCursor = await testClient.query(
    `SELECT last_seen_post_id, pg_typeof(last_seen_post_id)::text AS cursor_type FROM campaign_accounts WHERE id=$1`,
    [accountId],
  );
  if (
    finalCursor.rowCount !== 1
    || finalCursor.rows[0].last_seen_post_id !== '2200'
    || finalCursor.rows[0].cursor_type !== 'text'
  ) {
    throw new Error('all cursor forms must preserve the exact non-regressing TEXT cursor.');
  }
  await testClient.query(
    `UPDATE campaign_accounts SET initial_sync_pending=true, last_seen_post_id=NULL WHERE id=$1`,
    [accountId],
  );
  const perpetualPostInsert = `
    INSERT INTO campaign_posts (campaign_id,campaign_account_id,x_post_id,input_url,canonical_url,text_content)
    VALUES ($1,$2,$3,$4,$4,'perpetual upsert contract')
    ON CONFLICT (campaign_account_id, x_post_id) WHERE campaign_account_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  const perpetualPostValues = [campaignId, accountId, 'perpetual-contract', 'https://x.com/db_author/status/perpetual-contract'];
  const firstPerpetualInsert = await testClient.query(perpetualPostInsert, perpetualPostValues);
  if (firstPerpetualInsert.rowCount !== 1) throw new Error('perpetual post first insert must insert exactly one row.');
  const duplicatePerpetualInsert = await testClient.query(perpetualPostInsert, perpetualPostValues);
  if (duplicatePerpetualInsert.rowCount !== 0) throw new Error('perpetual post duplicate must insert no rows.');
  await testClient.query(`UPDATE campaign_posts SET retired_at=NOW() WHERE id=$1`, [firstPerpetualInsert.rows[0].id]);
  const retiredPerpetualRetry = await testClient.query(perpetualPostInsert, perpetualPostValues);
  if (retiredPerpetualRetry.rowCount !== 0) throw new Error('retired perpetual post retry must remain a no-op.');

  const firstManualPost = await testClient.query(
    `INSERT INTO campaign_posts (campaign_id,x_post_id,input_url,canonical_url,text_content)
     VALUES ($1,'manual-reinsert','https://x.com/manual/status/reinsert','https://x.com/manual/status/reinsert','manual control') RETURNING id`,
    [campaignId],
  );
  await testClient.query(`UPDATE campaign_posts SET retired_at=NOW() WHERE id=$1`, [firstManualPost.rows[0].id]);
  const manualReinsert = await testClient.query(
    `INSERT INTO campaign_posts (campaign_id,x_post_id,input_url,canonical_url,text_content)
     VALUES ($1,'manual-reinsert','https://x.com/manual/status/reinsert','https://x.com/manual/status/reinsert','manual control') RETURNING id`,
    [campaignId],
  );
  if (manualReinsert.rowCount !== 1) throw new Error('retired manual post must remain reinsertable.');
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
