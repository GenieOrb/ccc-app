import 'server-only';
import { Client } from '@upstash/qstash';
import { getConfig } from './config';
import { withAdvisoryLock, withTransaction as databaseTransaction } from './db';

const CRON = '*/10 * * * *';
const SCHEDULER_LOCK_ID = 684210;
const SCHEDULE_ID = 'genieorb-perpetual-generation-v1';
type DbClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ active?: boolean; schedule_id?: string | null }> }> };
type ScheduleClient = { schedules: { create: (request: { scheduleId: string; destination: string; cron: string; method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ scheduleId: string }>; delete: (id: string) => Promise<void>; get: (id: string) => Promise<unknown> } };
type Dependencies = { client?: ScheduleClient; withTransaction?: <T>(operation: (client: DbClient) => Promise<T>) => Promise<T>; withSchedulerLock?: <T>(operation: () => Promise<T>) => Promise<T>; appBaseUrl?: string };

function qstashClient(): ScheduleClient {
  const config = getConfig();
  if (!config.qstashToken) throw new Error('QSTASH_TOKEN is not configured.');
  return new Client({ token: config.qstashToken });
}

export async function reconcilePerpetualScheduler(deps: Dependencies = {}): Promise<{ action: 'created' | 'deleted' | 'unchanged'; scheduleId: string | null }> {
  const transaction = deps.withTransaction ?? databaseTransaction as Dependencies['withTransaction'];
  const schedulerLock = deps.withSchedulerLock ?? ((operation) => withAdvisoryLock(SCHEDULER_LOCK_ID, operation));

  return schedulerLock(async () => {
    const state = await transaction!(async (db) => {
    const active = await db.query("SELECT EXISTS (SELECT 1 FROM campaigns WHERE campaign_type = 'perpetual' AND is_active = true) AS active");
    const saved = await db.query('SELECT schedule_id FROM perpetual_scheduler_state WHERE singleton = true FOR UPDATE');
    return { active: Boolean(active.rows[0]?.active), scheduleId: saved.rows[0]?.schedule_id ?? null };
    });
    const destination = `${(deps.appBaseUrl ?? getConfig().appBaseUrl).replace(/\/$/, '')}/api/internal/generation/qstash`;
    const client = deps.client ?? qstashClient();
    if (state.active) {
      // Persist the deterministic ID before talking to QStash. If the process
      // dies after QStash creates it, the next reconciliation can inspect and
      // recover the same schedule instead of creating a duplicate.
      await transaction!(async (db) => {
        await db.query('UPDATE perpetual_scheduler_state SET schedule_id = $1, updated_at = NOW() WHERE singleton = true', [SCHEDULE_ID]);
      });

      try {
        await client.schedules.get(SCHEDULE_ID);
        return { action: 'unchanged', scheduleId: SCHEDULE_ID };
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }

      await client.schedules.create({ scheduleId: SCHEDULE_ID, destination, cron: CRON, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { action: 'created', scheduleId: SCHEDULE_ID };
    }

    // Always remove our canonical schedule, even if a previous crash left the
    // durable row empty. This recovers an orphan without waking Neon later.
    try {
      await client.schedules.delete(SCHEDULE_ID);
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
    await transaction!(async (db) => { await db.query('UPDATE perpetual_scheduler_state SET schedule_id = NULL, updated_at = NOW() WHERE singleton = true'); });
    return { action: 'deleted', scheduleId: null };
  });
}

function statusCode(error: unknown): number | undefined {
  return error instanceof Error && 'status' in error ? (error as Error & { status?: number }).status : undefined;
}
