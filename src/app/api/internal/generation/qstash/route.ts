import { NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getConfig } from '@/lib/config';
import { runGlobalGenerationProcessing } from '@/lib/generation-processing';
import { reconcilePerpetualScheduler } from '@/lib/perpetual-scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const config = getConfig();
  if (!config.qstashCurrentSigningKey || !config.qstashNextSigningKey) return NextResponse.json({ error: 'QStash verification is not configured' }, { status: 503 });
  const body = await req.text();
  const signature = req.headers.get('upstash-signature');
  if (!signature) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const valid = await new Receiver({ currentSigningKey: config.qstashCurrentSigningKey, nextSigningKey: config.qstashNextSigningKey }).verify({ body, signature, url: req.url });
    if (!valid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scheduler = await reconcilePerpetualScheduler();
    if (!scheduler.scheduleId) {
      return NextResponse.json({ success: true, inactive: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ success: true, ...(await runGlobalGenerationProcessing()) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Internal worker execution error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
