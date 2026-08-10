import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';
import { normalizeJsonObject } from '@/lib/json-utils';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uuidSchema = z.string().uuid();

export async function GET(req: Request, props: { params: Promise<{ draftId: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  const { draftId } = await props.params;
  const url = new URL(req.url);
  const cycleId = url.searchParams.get('cycleId');

  const draftIdParsed = uuidSchema.safeParse(draftId);
  const cycleIdParsed = uuidSchema.safeParse(cycleId);

  if (!draftIdParsed.success || !cycleIdParsed.success) {
    return NextResponse.json(
      { error: 'Parámetros draftId o cycleId inválidos.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const validDraftId = draftIdParsed.data;
  const validCycleId = cycleIdParsed.data;

  try {
    const cycleRows = await queryDb<{
      id: string;
      status: string;
      target_count: number;
      model_key: string;
      provider: string;
      api_model: string;
      error_message: string | null;
      created_at: Date | string;
    }>(
      `SELECT id, status, target_count, model_key, provider, api_model, error_message, created_at
       FROM meme_generation_cycles
       WHERE id = $1 AND draft_id = $2
       LIMIT 1`,
      [validCycleId, validDraftId]
    );

    if (cycleRows.length === 0) {
      return NextResponse.json(
        { error: 'El ciclo especificado no existe o no pertenece a este borrador.' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const cycle = cycleRows[0];

    const jobsRows = await queryDb<{
      id: string;
      status: string;
      slot_index: number;
      error_message: string | null;
      attempts_count: number;
      next_attempt_at: Date | string | null;
      lease_expires_at: Date | string | null;
      updated_at: Date | string;
      latest_call_status: string | null;
      latest_call_purpose: string | null;
      latest_call_updated: Date | string | null;
      latest_call_checkpoint: string | null;
    }>(
      `SELECT j.id, j.status, j.slot_index, j.error_message, j.attempts_count, j.next_attempt_at, j.lease_expires_at, j.updated_at,
              (SELECT c.status FROM meme_api_calls c WHERE c.job_id = j.id ORDER BY c.created_at DESC LIMIT 1) as latest_call_status,
              (SELECT c.purpose FROM meme_api_calls c WHERE c.job_id = j.id ORDER BY c.created_at DESC LIMIT 1) as latest_call_purpose,
              (SELECT c.finished_at FROM meme_api_calls c WHERE c.job_id = j.id ORDER BY c.created_at DESC LIMIT 1) as latest_call_updated,
              (SELECT c.error_message FROM meme_api_calls c WHERE c.job_id = j.id ORDER BY c.created_at DESC LIMIT 1) as latest_call_checkpoint
       FROM meme_generation_jobs j
       WHERE j.cycle_id = $1 AND j.draft_id = $2
       ORDER BY j.slot_index ASC`,
      [validCycleId, validDraftId]
    );

    let pendingCount = 0;
    let processingCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;

    let latestProgressTime = new Date(cycle.created_at).getTime();

    const jobs = jobsRows.map(j => {
      if (j.status === 'pending') pendingCount++;
      else if (j.status === 'processing') processingCount++;
      else if (j.status === 'completed') completedCount++;
      else if (j.status === 'failed') failedCount++;
      else if (j.status === 'cancelled') cancelledCount++;

      const jobUpdatedTime = new Date(j.updated_at).getTime();
      if (jobUpdatedTime > latestProgressTime) latestProgressTime = jobUpdatedTime;

      if (j.latest_call_updated) {
        const callUpdatedTime = new Date(j.latest_call_updated).getTime();
        if (callUpdatedTime > latestProgressTime) latestProgressTime = callUpdatedTime;
      }

      let currentPhase = 'pending';
      if (j.status === 'completed') currentPhase = 'completed';
      else if (j.status === 'failed') currentPhase = 'failed';
      else if (j.status === 'cancelled') currentPhase = 'cancelled';
      else if (j.latest_call_purpose) currentPhase = j.latest_call_purpose;

      return {
        id: j.id,
        slotIndex: j.slot_index,
        status: j.status,
        attemptsCount: j.attempts_count,
        nextAttemptAt: j.next_attempt_at,
        leaseExpiresAt: j.lease_expires_at,
        updatedAt: j.updated_at,
        currentPhase,
        latestCallStatus: j.latest_call_status,
        latestCheckpoint: j.latest_call_checkpoint || null,
        errorMessage: j.error_message || null
      };
    });

    const terminal = pendingCount === 0 && processingCount === 0;

    const memesRows = await queryDb<{
      id: string;
      mime_type: string;
      slot_plan: unknown;
      created_at: Date | string;
    }>(
      `SELECT m.id, m.mime_type, m.slot_plan, m.created_at
       FROM memes m
       JOIN meme_generation_jobs j ON m.job_id = j.id
       WHERE j.cycle_id = $1 AND j.draft_id = $2
       ORDER BY m.delivery_order ASC, m.created_at ASC`,
      [validCycleId, validDraftId]
    );

    const actualMemesCount = memesRows.length;

    const memes = memesRows.map((m) => {
      let plan;
      try {
        plan = normalizeJsonObject(m.slot_plan);
      } catch {
        plan = null;
      }

      const memeCreatedTime = new Date(m.created_at).getTime();
      if (memeCreatedTime > latestProgressTime) latestProgressTime = memeCreatedTime;

      return {
        id: m.id,
        url: `/api/admin/meme-drafts/${validDraftId}/memes/${m.id}/view`,
        plan
      };
    });

    return NextResponse.json(
      {
        success: true,
        draftId: validDraftId,
        cycleId: validCycleId,
        cycleStatus: cycle.status,
        targetCount: cycle.target_count,
        modelKey: cycle.model_key,
        provider: cycle.provider,
        apiModel: cycle.api_model,
        pendingCount,
        processingCount,
        completedCount,
        failedCount,
        cancelledCount,
        actualMemesCount,
        terminal,
        progressUpdatedAt: new Date(latestProgressTime).toISOString(),
        jobs,
        memes,
        errorMessage: cycle.error_message || null
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    console.error('Meme preview status failed', {
      draftId: validDraftId,
      cycleId: validCycleId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage:
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    });

    return NextResponse.json(
      { error: 'No se pudo consultar el estado de la preview.' },
      {
        status: 500,
        headers: { 'Cache-Control': 'no-store' }
      }
    );
  }
}
