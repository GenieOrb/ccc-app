import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { safeCompareStrings } from '@/lib/crypto';
import { MIN_WORKER_JOB_BUDGET_MS, processBackgroundQueue } from '@/lib/worker';
import { processPerpetualCampaigns } from '@/lib/perpetual-monitor';
import { reconcileCampaignReplenishment } from '@/lib/services';
import { MIN_MEME_WORKER_JOB_BUDGET_MS, processMemeBackgroundQueue } from '@/lib/worker.memes';
import { randomUUID } from 'node:crypto';

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
    const perpetualResult = await processPerpetualCampaigns(30000);
    const replenishmentResult = await reconcileCampaignReplenishment();

    // El worker puede usar el resto del tiempo hasta llegar cerca de los 60s
    let workerBudgetMs = Math.max(0, 50000 - (Date.now() - startPerpetual));

    // Split budget roughly evenly if both have budget, or give all to one
    const commentBudget = Math.floor(workerBudgetMs / 2);
    const workerId = randomUUID();

    const workerResult = commentBudget >= MIN_WORKER_JOB_BUDGET_MS
      ? await processBackgroundQueue(workerId, commentBudget)
      : { processed: 0, completed: 0, failed: 0, skipped: 'insufficient_time_budget' };

    workerBudgetMs = Math.max(0, 50000 - (Date.now() - startPerpetual));

    const workerMemesResult = workerBudgetMs >= MIN_MEME_WORKER_JOB_BUDGET_MS
      ? await processMemeBackgroundQueue(workerId, workerBudgetMs)
      : { processed: 0, completed: 0, failed: 0, skipped: 'insufficient_time_budget' };

    return NextResponse.json(
      {
        success: true,
        monitor: perpetualResult,
        replenishment: replenishmentResult,
        worker: workerResult,
        workerMemes: workerMemesResult
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
