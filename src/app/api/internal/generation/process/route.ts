import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { safeCompareStrings } from '@/lib/crypto';
import { processBackgroundQueue } from '@/lib/worker';
import { processPerpetualCampaigns } from '@/lib/perpetual-monitor';
import { reconcileCampaignReplenishment } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handleProcess(req: Request) {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const token = authHeader.substring(7).trim();
  const config = getConfig();

  if (!token || (!config.internalProcessSecret && !config.cronSecret)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const isValidInternal = config.internalProcessSecret ? safeCompareStrings(token, config.internalProcessSecret) : false;
  const isValidCron = config.cronSecret ? safeCompareStrings(token, config.cronSecret) : false;

  if (!isValidInternal && !isValidCron) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const startPerpetual = Date.now();
    // Le damos 15 segundos al monitor de campañas perpetuas
    const perpetualResult = await processPerpetualCampaigns(15000);
    const replenishmentResult = await reconcileCampaignReplenishment();

    // El worker puede usar el resto del tiempo hasta llegar cerca de los 60s
    const workerBudgetMs = Math.max(0, 50000 - (Date.now() - startPerpetual));
    const workerResult = await processBackgroundQueue(undefined, workerBudgetMs);

    return NextResponse.json(
      {
        success: true,
        monitor: perpetualResult,
        replenishment: replenishmentResult,
        worker: workerResult
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
