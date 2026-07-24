import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { safeCompareStrings } from '@/lib/crypto';
import { processBackgroundQueue } from '@/lib/worker';

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

  if (!config.internalProcessSecret || !token) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const isValidInternal = safeCompareStrings(token, config.internalProcessSecret);
  const isValidCron = config.cronSecret ? safeCompareStrings(token, config.cronSecret) : false;

  if (!isValidInternal && !isValidCron) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const result = await processBackgroundQueue();
    return NextResponse.json(
      { success: true, ...result },
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
