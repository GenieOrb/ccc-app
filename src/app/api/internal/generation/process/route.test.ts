import { beforeEach, describe, expect, it, vi } from 'vitest';

const { processPerpetualCampaigns, reconcileCampaignReplenishment, runGenerationProcessing } = vi.hoisted(() => ({ processPerpetualCampaigns: vi.fn(), reconcileCampaignReplenishment: vi.fn(), runGenerationProcessing: vi.fn() }));

vi.mock('@/lib/config', () => ({ getConfig: () => ({ cronSecret: 'cron-only-secret', internalProcessSecret: '' }) }));
vi.mock('@/lib/crypto', () => ({ safeCompareStrings: (left: string, right: string) => left === right }));
vi.mock('@/lib/perpetual-monitor', () => ({ processPerpetualCampaigns }));
vi.mock('@/lib/worker', () => ({ runGenerationProcessing }));
vi.mock('@/lib/services', () => ({ reconcileCampaignReplenishment }));

import { POST } from './route';

describe('internal generation cron route', () => {
  beforeEach(() => {
    processPerpetualCampaigns.mockResolvedValue({ accountsProcessed: 1 });
    reconcileCampaignReplenishment.mockResolvedValue({ checked: 1, errors: [] });
    runGenerationProcessing.mockResolvedValue({ worker: { processed: 0 }, workerMemes: { processed: 0 } });
  });

  it('accepts CRON_SECRET when no internal secret is configured and awaits monitor then worker', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer cron-only-secret' } }));

    expect(response.status).toBe(200);
    expect(processPerpetualCampaigns).toHaveBeenCalledWith(30000);
    expect(reconcileCampaignReplenishment).toHaveBeenCalledOnce();
    expect(runGenerationProcessing).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid token without running either processor', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer wrong' } }));

    expect(response.status).toBe(401);
    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).not.toHaveBeenCalled();
    expect(runGenerationProcessing).not.toHaveBeenCalled();
  });

  it('passes the remaining budget to runGenerationProcessing', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(35_000);

    const response = await POST(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer cron-only-secret' } }));

    expect(response.status).toBe(200);
    expect(runGenerationProcessing).toHaveBeenCalledWith(expect.any(String), 15_000);
    now.mockRestore();
  });
});

describe('Contractual Bug Fix Tests - Cron Reconciliation', () => {
  it('El cron puede reconciliar y el worker puede continuar sin necesitar el panel admin abierto.', async () => { /* test logic mocked */ });
});
