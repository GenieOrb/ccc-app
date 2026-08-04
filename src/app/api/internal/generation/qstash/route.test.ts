import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verify, reconcilePerpetualScheduler, runGlobalGenerationProcessing } = vi.hoisted(() => ({
  verify: vi.fn(),
  reconcilePerpetualScheduler: vi.fn(),
  runGlobalGenerationProcessing: vi.fn(),
}));

vi.mock('@upstash/qstash', () => ({
  Receiver: class { verify = verify; },
}));
vi.mock('@/lib/config', () => ({
  getConfig: () => ({ qstashCurrentSigningKey: 'current', qstashNextSigningKey: 'next' }),
}));
vi.mock('@/lib/generation-processing', () => ({ runGlobalGenerationProcessing }));
vi.mock('@/lib/perpetual-scheduler', () => ({ reconcilePerpetualScheduler }));

import { POST } from './route';

describe('QStash generation callback', () => {
  beforeEach(() => {
    verify.mockReset();
    reconcilePerpetualScheduler.mockReset();
    runGlobalGenerationProcessing.mockReset();
  });

  it('reconciles and runs the local processing callback after a valid QStash signature with an active campaign', async () => {
    verify.mockResolvedValue(true);
    reconcilePerpetualScheduler.mockResolvedValue({ action: 'unchanged', scheduleId: 'genieorb-perpetual-generation-v1' });
    runGlobalGenerationProcessing.mockResolvedValue({ processed: 1 });

    const response = await POST(new Request('http://localhost/api/internal/generation/qstash', {
      method: 'POST', headers: { 'upstash-signature': 'local-signature' }, body: '{}',
    }));

    expect(response.status).toBe(200);
    expect(reconcilePerpetualScheduler).toHaveBeenCalledTimes(1);
    expect(runGlobalGenerationProcessing).toHaveBeenCalledTimes(1);
    expect(reconcilePerpetualScheduler.mock.invocationCallOrder[0]).toBeLessThan(runGlobalGenerationProcessing.mock.invocationCallOrder[0]);
  });

  it('stops after reconciliation when no perpetual campaign is active', async () => {
    verify.mockResolvedValue(true);
    reconcilePerpetualScheduler.mockResolvedValue({ action: 'deleted', scheduleId: null });

    const response = await POST(new Request('http://localhost/api/internal/generation/qstash', {
      method: 'POST', headers: { 'upstash-signature': 'local-signature' }, body: '{}',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, inactive: true });
    expect(reconcilePerpetualScheduler).toHaveBeenCalledTimes(1);
    expect(runGlobalGenerationProcessing).not.toHaveBeenCalled();
  });

  it('does not run processing when signature verification fails', async () => {
    verify.mockResolvedValue(false);
    const response = await POST(new Request('http://localhost/api/internal/generation/qstash', {
      method: 'POST', headers: { 'upstash-signature': 'bad-signature' }, body: '{}',
    }));
    expect(response.status).toBe(401);
    expect(reconcilePerpetualScheduler).not.toHaveBeenCalled();
    expect(runGlobalGenerationProcessing).not.toHaveBeenCalled();
  });
});
