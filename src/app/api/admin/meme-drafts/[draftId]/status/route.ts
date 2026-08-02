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
      updated_at: Date | string;
    }>(
      `SELECT id, status, target_count, model_key, provider, api_model, error_message, updated_at
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
      error_message: string | null;
    }>(
      `SELECT id, status, error_message
       FROM meme_generation_jobs
       WHERE cycle_id = $1 AND draft_id = $2
       ORDER BY slot_index ASC`,
      [validCycleId, validDraftId]
    );

    let pendingCount = 0;
    let processingCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;

    for (const job of jobsRows) {
      if (job.status === 'pending') pendingCount++;
      else if (job.status === 'processing') processingCount++;
      else if (job.status === 'completed') completedCount++;
      else if (job.status === 'failed') failedCount++;
      else if (job.status === 'cancelled') cancelledCount++;
    }

    const terminal = pendingCount === 0 && processingCount === 0;

    const memesRows = await queryDb<{
      id: string;
      mime_type: string;
      slot_plan: unknown;
    }>(
      `SELECT m.id, m.mime_type, m.slot_plan
       FROM memes m
       JOIN meme_generation_jobs j ON m.job_id = j.id
       WHERE j.cycle_id = $1 AND j.draft_id = $2
       ORDER BY m.delivery_order ASC, m.created_at ASC`,
      [validCycleId, validDraftId]
    );

    const memes = memesRows.map((m) => ({
      id: m.id,
      url: `/api/admin/meme-drafts/${validDraftId}/memes/${m.id}/view`,
      plan: normalizeJsonObject(m.slot_plan)
    }));

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
        terminal,
        updatedAt: cycle.updated_at,
        jobs: jobsRows.map((j) => ({
          id: j.id,
          status: j.status,
          error_message: j.error_message
        })),
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
