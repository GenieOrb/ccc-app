import { beforeEach, describe, expect, it, vi } from 'vitest';

const { processPerpetualCampaigns, reconcileCampaignReplenishment, runGenerationProcessing } = vi.hoisted(() => ({ processPerpetualCampaigns: vi.fn(), reconcileCampaignReplenishment: vi.fn(), runGenerationProcessing: vi.fn() }));

vi.mock('@/lib/config', () => ({ getConfig: () => ({ cronSecret: 'cron-only-secret', internalProcessSecret: '' }) }));
vi.mock('@/lib/crypto', () => ({ safeCompareStrings: (left: string, right: string) => left === right }));
vi.mock('@/lib/perpetual-monitor', () => ({ processPerpetualCampaigns }));
vi.mock('@/lib/worker', () => ({ runGenerationProcessing }));
vi.mock('@/lib/services', () => ({ reconcileCampaignReplenishment }));

import { POST, GET } from './route';

describe('internal generation cron route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processPerpetualCampaigns.mockResolvedValue({ accountsProcessed: 1 });
    reconcileCampaignReplenishment.mockResolvedValue({ checked: 1, errors: [] });
    runGenerationProcessing.mockResolvedValue({ worker: { processed: 0, completed: 0, failed: 0 }, workerMemes: { processed: 1, completed: 1, failed: 0 } });
  });

  it('rejects an invalid token without running either processor', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer wrong' } }));
    expect(response.status).toBe(401);
    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).not.toHaveBeenCalled();
    expect(runGenerationProcessing).not.toHaveBeenCalled();
  });

  it('A. POST dirigido válido: UUID, 200, aisla procesamiento', async () => {
    const validUuid = '11111111-1111-4111-8111-111111111111';
    const response = await POST(new Request('http://localhost/api/internal/generation/process', {
      method: 'POST',
      headers: { authorization: 'Bearer cron-only-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ memeCycleId: validUuid })
    }));

    expect(response.status).toBe(200);
    expect(runGenerationProcessing).toHaveBeenCalledWith(expect.any(String), 50000, validUuid);
    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).not.toHaveBeenCalled();
  });

  it('B. POST con UUID inválido: 400, no procesa nada', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', {
      method: 'POST',
      headers: { authorization: 'Bearer cron-only-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ memeCycleId: 'test-cycle-uuid' })
    }));

    expect(response.status).toBe(400);
    expect(runGenerationProcessing).not.toHaveBeenCalled();
    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).not.toHaveBeenCalled();
  });

  it('C. POST con JSON malformado: 400, no cae silenciosamente a global', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', {
      method: 'POST',
      headers: { authorization: 'Bearer cron-only-secret', 'content-type': 'application/json' },
      body: '{ invalid_json'
    }));

    expect(response.status).toBe(400);
    expect(runGenerationProcessing).not.toHaveBeenCalled();
    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).not.toHaveBeenCalled();
  });

  it('reports directed preview worker failures as a successful execution outcome', async () => {
    runGenerationProcessing.mockResolvedValue({ worker: { processed: 0, completed: 0, failed: 0 }, workerMemes: { processed: 3, completed: 0, failed: 3 } });
    const response = await POST(new Request('http://localhost/api/internal/generation/process', {
      method: 'POST', headers: { authorization: 'Bearer cron-only-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ memeCycleId: '11111111-1111-4111-8111-111111111111' })
    }));
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.workerMemes).toMatchObject({ processed: 3, completed: 0, failed: 3 });
  });

  it('treats a directed 0/0/0 result as a successful no-op', async () => {
    runGenerationProcessing.mockResolvedValue({ worker: { processed: 0, completed: 0, failed: 0 }, workerMemes: { processed: 0, completed: 0, failed: 0 } });
    const response = await POST(new Request('http://localhost/api/internal/generation/process', {
      method: 'POST', headers: { authorization: 'Bearer cron-only-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ memeCycleId: '11111111-1111-4111-8111-111111111111' })
    }));
    expect(response.ok).toBe(true);
    expect((await response.json()).success).toBe(true);
  });

  it.each([null, 42])('rejects memeCycleId=%j without invoking processors', async (memeCycleId) => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', {
      method: 'POST', headers: { authorization: 'Bearer cron-only-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ memeCycleId })
    }));

    expect(response.status).toBe(400);
    expect(runGenerationProcessing).not.toHaveBeenCalled();
    expect(processPerpetualCampaigns).not.toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).not.toHaveBeenCalled();
  });

  it('D. POST sin memeCycleId: modo cron global, 200', async () => {
    const response = await POST(new Request('http://localhost/api/internal/generation/process', {
      method: 'POST',
      headers: { authorization: 'Bearer cron-only-secret', 'content-type': 'application/json' },
      body: JSON.stringify({})
    }));

    expect(response.status).toBe(200);
    expect(runGenerationProcessing).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    expect(processPerpetualCampaigns).toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).toHaveBeenCalled();
  });

  it('E. GET: no lee body, modo cron global, 200', async () => {
    const response = await GET(new Request('http://localhost/api/internal/generation/process', {
      method: 'GET',
      headers: { authorization: 'Bearer cron-only-secret' }
    }));

    expect(response.status).toBe(200);
    expect(runGenerationProcessing).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    expect(processPerpetualCampaigns).toHaveBeenCalled();
    expect(reconcileCampaignReplenishment).toHaveBeenCalled();
  });

  it('passes the remaining budget to runGenerationProcessing in global mode', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(35_000);
    const response = await GET(new Request('http://localhost/api/internal/generation/process', { headers: { authorization: 'Bearer cron-only-secret' } }));
    expect(response.status).toBe(200);
    expect(runGenerationProcessing).toHaveBeenCalledWith(expect.any(String), 15_000);
    now.mockRestore();
  });
});
