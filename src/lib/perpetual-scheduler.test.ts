import { describe, expect, it, vi } from 'vitest';
import { reconcilePerpetualScheduler } from './perpetual-scheduler';

const SCHEDULE_ID = 'genieorb-perpetual-generation-v1';

function dependencies(options: { active: boolean; scheduleId?: string | null; schedules?: Partial<{ create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }> } ) {
  let scheduleId = options.scheduleId ?? null;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('EXISTS')) return { rows: [{ active: options.active }] };
    if (sql.startsWith('SELECT schedule_id')) return { rows: [{ schedule_id: scheduleId }] };
    if (sql.startsWith('UPDATE perpetual_scheduler_state SET schedule_id = $1')) scheduleId = params?.[0] as string;
    if (sql.startsWith('UPDATE perpetual_scheduler_state SET schedule_id = NULL')) scheduleId = null;
    return { rows: [] };
  });
  const schedules = {
    create: vi.fn().mockResolvedValue({ scheduleId: SCHEDULE_ID }),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ scheduleId: SCHEDULE_ID }),
    ...options.schedules,
  };
  return {
    deps: {
      client: { schedules },
      withTransaction: async <T>(operation: (db: { query: typeof query }) => Promise<T>) => operation({ query }),
      withSchedulerLock: async <T>(operation: () => Promise<T>) => operation(),
      appBaseUrl: 'https://app.example',
    },
    query,
    schedules,
    currentScheduleId: () => scheduleId,
  };
}

describe('reconcilePerpetualScheduler', () => {
  it('creates exactly one ten-minute schedule for active perpetual campaigns', async () => {
    const missing = Object.assign(new Error('missing'), { status: 404 });
    const state = dependencies({ active: true, schedules: { get: vi.fn().mockRejectedValue(missing) } });

    await expect(reconcilePerpetualScheduler(state.deps)).resolves.toEqual({ action: 'created', scheduleId: SCHEDULE_ID });

    expect(state.query).toHaveBeenCalledWith(expect.stringContaining('SET schedule_id = $1'), [SCHEDULE_ID]);
    expect(state.schedules.create).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: SCHEDULE_ID,
      cron: '*/10 * * * *',
      destination: 'https://app.example/api/internal/generation/qstash',
    }));
  });

  it('keeps the intended ID in durable state when creation fails so a later reconciliation can recover it', async () => {
    const missing = Object.assign(new Error('missing'), { status: 404 });
    const state = dependencies({ active: true, schedules: { get: vi.fn().mockRejectedValue(missing), create: vi.fn().mockRejectedValue(new Error('offline')) } });

    await expect(reconcilePerpetualScheduler(state.deps)).rejects.toThrow('offline');

    expect(state.currentScheduleId()).toBe(SCHEDULE_ID);
  });

  it('does not create again when the durable intended ID already exists remotely', async () => {
    const state = dependencies({ active: true, scheduleId: SCHEDULE_ID });

    await expect(reconcilePerpetualScheduler(state.deps)).resolves.toEqual({ action: 'unchanged', scheduleId: SCHEDULE_ID });

    expect(state.schedules.get).toHaveBeenCalledWith(SCHEDULE_ID);
    expect(state.schedules.create).not.toHaveBeenCalled();
  });

  it('retries only when the canonical remote schedule is missing', async () => {
    const missing = Object.assign(new Error('missing'), { status: 404 });
    const state = dependencies({ active: true, scheduleId: SCHEDULE_ID, schedules: { get: vi.fn().mockRejectedValue(missing) } });

    await reconcilePerpetualScheduler(state.deps);

    expect(state.schedules.create).toHaveBeenCalledTimes(1);
  });

  it('propagates non-404 failures while checking the canonical remote schedule', async () => {
    const unavailable = Object.assign(new Error('unavailable'), { status: 503 });
    const state = dependencies({ active: true, schedules: { get: vi.fn().mockRejectedValue(unavailable) } });

    await expect(reconcilePerpetualScheduler(state.deps)).rejects.toThrow('unavailable');
    expect(state.schedules.create).not.toHaveBeenCalled();
  });

  it('deletes the canonical schedule even when the durable state is empty', async () => {
    const state = dependencies({ active: false, scheduleId: null });

    await expect(reconcilePerpetualScheduler(state.deps)).resolves.toEqual({ action: 'deleted', scheduleId: null });

    expect(state.schedules.delete).toHaveBeenCalledWith(SCHEDULE_ID);
    expect(state.currentScheduleId()).toBeNull();
  });

  it('clears durable state only after QStash confirms deletion or reports 404', async () => {
    const unavailable = Object.assign(new Error('unavailable'), { status: 503 });
    const state = dependencies({ active: false, scheduleId: SCHEDULE_ID, schedules: { delete: vi.fn().mockRejectedValue(unavailable) } });

    await expect(reconcilePerpetualScheduler(state.deps)).rejects.toThrow('unavailable');

    expect(state.currentScheduleId()).toBe(SCHEDULE_ID);
  });

  it('treats an already removed canonical schedule as deleted', async () => {
    const missing = Object.assign(new Error('missing'), { status: 404 });
    const state = dependencies({ active: false, scheduleId: SCHEDULE_ID, schedules: { delete: vi.fn().mockRejectedValue(missing) } });

    await expect(reconcilePerpetualScheduler(state.deps)).resolves.toEqual({ action: 'deleted', scheduleId: null });

    expect(state.currentScheduleId()).toBeNull();
  });
});
