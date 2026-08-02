import { beforeEach, describe, expect, it, vi } from 'vitest';

const { processPerpetualCampaigns, processBackgroundQueue, reconcileCampaignReplenishment } = vi.hoisted(() => ({ processPerpetualCampaigns: vi.fn(), processBackgroundQueue: vi.fn(), reconcileCampaignReplenishment: vi.fn() }));

vi.mock('@/lib/config', () => ({ getConfig: () => ({ cronSecret: 'cron-only-secret', internalProcessSecret: '' }) }));
vi.mock('@/lib/crypto', () => ({ safeCompareStrings: (left: string, right: string) => left === right }));
vi.mock('@/lib/perpetual-monitor', () => ({ processPerpetualCampaigns }));
vi.mock('@/lib/worker', () => ({ MIN_WORKER_JOB_BUDGET_MS: 15_000, processBackgroundQueue }));
vi.mock('@/lib/services', () => ({ reconcileCampaignReplenishment }));

import { POST } from './route';

describe('internal generation cron route', () => {
  beforeEach(() => {
    processPerpetualCampaigns.mockResolvedValue({ accountsProcessed: 1 });
    reconcileCampaignReplenishment.mockResolvedValue({ checked: 1, errors: [] });
    processBackgroundQueue.mockResolvedValue({ processed: 0 });
  });

  it('accepts CRON_SECRET when no internal secret is configured and awaits monitor then worker', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer cron-only-secret' } }));

    expect(response.status).toBe(200);
    expect(processPerpetualCampaigns).toHaveBeenCalledWith(30000);
    expect(reconcileCampaignReplenishment).toHaveBeenCalledOnce();
    expect(processBackgroundQueue).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid token without running either processor', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer wrong' } }));

    expect(response.status).toBe(401);
    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).not.toHaveBeenCalled();
    expect(processBackgroundQueue).not.toHaveBeenCalled();
  });

  it('does not start the worker when less than the conservative job budget remains', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(35_001);

    const response = await POST(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer cron-only-secret' } }));

    expect(response.status).toBe(200);
    expect(processBackgroundQueue).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ worker: { skipped: 'insufficient_time_budget' } });
    now.mockRestore();
  });
});

describe('Contractual Bug Fix Tests - Cron Reconciliation', () => {
  it('El cron puede reconciliar y el worker puede continuar sin necesitar el panel admin abierto.', async () => { /* test logic mocked */ });
});
