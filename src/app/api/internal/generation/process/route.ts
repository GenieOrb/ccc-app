import { NextResponse } from 'next/server';
import { isAuthorizedInternalProcessRequest } from '@/lib/internal-process-auth';
import { runGenerationProcessing } from '@/lib/worker';
import { processPerpetualCampaigns } from '@/lib/perpetual-monitor';
import { reconcileCampaignReplenishment } from '@/lib/services';
import { randomUUID } from 'node:crypto';

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
          memeCycleId = body.memeCycleId;
        }
      } catch {
        // body could be empty or non-JSON
      }
    }

    const startPerpetual = Date.now();
    // Le damos 15 segundos al monitor de campañas perpetuas
    const perpetualResult = await processPerpetualCampaigns(30000);
    const replenishmentResult = await reconcileCampaignReplenishment();

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
  } catch {
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
