import { NextResponse } from 'next/server';
import { isAuthorizedInternalProcessRequest } from '@/lib/internal-process-auth';
import { runGenerationProcessing } from '@/lib/worker';
import { processPerpetualCampaigns } from '@/lib/perpetual-monitor';
import { reconcileCampaignReplenishment } from '@/lib/services';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handleProcess(req: Request) {
  if (!isAuthorizedInternalProcessRequest(req)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    let memeCycleId: string | undefined = undefined;
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (body && typeof body.memeCycleId === 'string') {
           const parsed = uuidSchema.safeParse(body.memeCycleId);
           if (parsed.success) memeCycleId = parsed.data;
        }
      } catch {
        // body could be empty or non-JSON
      }
    }

    let perpetualResult = null;
    let replenishmentResult = null;
    const startPerpetual = Date.now();

    if (!memeCycleId) {
      // Le damos 15 segundos al monitor de campañas perpetuas
      perpetualResult = await processPerpetualCampaigns(30000);
      replenishmentResult = await reconcileCampaignReplenishment();
    }

    // El worker puede usar el resto del tiempo hasta llegar cerca de los 60s
    const workerBudgetMs = Math.max(0, 50000 - (Date.now() - startPerpetual));
    const workerId = randomUUID();

    const generationResult = await runGenerationProcessing(workerId, workerBudgetMs, memeCycleId);

    return NextResponse.json(
      {
        success: true,
        monitor: perpetualResult,
        replenishment: replenishmentResult,
        ...generationResult
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    console.error('Internal process error:', error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      { error: 'Internal worker execution error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function POST(req: Request) {
  return handleProcess(req);
}

export async function GET(req: Request) {
  return handleProcess(req);
}
