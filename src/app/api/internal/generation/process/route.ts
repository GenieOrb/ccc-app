import { NextResponse } from 'next/server';
import { isAuthorizedInternalProcessRequest } from '@/lib/internal-process-auth';
import { runGenerationProcessing } from '@/lib/worker';
import { runGlobalGenerationProcessing } from '@/lib/generation-processing';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handleProcess(req: Request) {
  let phase = 'authorization';
  let mode = 'global';
  let requestMemeCycleId: string | undefined = undefined;

  try {
    if (!isAuthorizedInternalProcessRequest(req)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    phase = 'body_validation';
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (body && typeof body === 'object' && 'memeCycleId' in body) {
          if (typeof body.memeCycleId !== 'string') {
            return NextResponse.json({ error: 'Invalid memeCycleId' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
          }
          const parsed = uuidSchema.safeParse(body.memeCycleId);
          if (parsed.success) {
            requestMemeCycleId = parsed.data;
            mode = 'directed_preview';
          } else {
            return NextResponse.json({ error: 'Invalid UUID' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
        }
        // body could be empty or non-JSON, ignore other errors
      }
    }

    if (requestMemeCycleId) {
      phase = 'directed_meme_worker';
      const workerId = randomUUID();
      const generationResult = await runGenerationProcessing(workerId, 50000, requestMemeCycleId);

      phase = 'response_serialization';
      const memeWorker = generationResult.workerMemes;
      return NextResponse.json(
        {
          success: true,
          mode,
          noOp: memeWorker.processed === 0,
          ...generationResult
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    } else {
      phase = 'global_generation';
      const generationResult = await runGlobalGenerationProcessing();

      phase = 'response_serialization';
      return NextResponse.json(
        {
          success: true,
          mode,
          ...generationResult
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
  } catch (error: unknown) {
    console.error('Internal process error:', {
      mode,
      phase,
      memeCycleId: requestMemeCycleId || null,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 300)
    });
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
