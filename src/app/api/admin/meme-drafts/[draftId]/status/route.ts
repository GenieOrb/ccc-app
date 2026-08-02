import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, props: { params: Promise<{ draftId: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  const { draftId } = await props.params;

  try {
    const cycleRes = await queryDb<{ id: string, target_count: number }>(
      `SELECT id, target_count FROM meme_generation_cycles WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [draftId]
    );

    const cycleId = cycleRes.length > 0 ? cycleRes[0].id : null;
    const targetCount = cycleRes.length > 0 ? cycleRes[0].target_count : 3;

    const jobsRes = await queryDb<{ id: string, status: string, error_message: string | null }>(
      `SELECT id, status, error_message FROM meme_generation_jobs WHERE draft_id = $1`,
      [draftId]
    );

    if (jobsRes.length === 0) {
       return NextResponse.json({ 
         success: true, draftId, cycleId, targetCount, pendingCount: 0, processingCount: 0, completedCount: 0, failedCount: 0, cancelledCount: 0, terminal: true, jobs: [], memes: [] 
       }, { headers: { 'Cache-Control': 'no-store' } });
    }

    let pendingCount = 0;
    let processingCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;

    for (const job of jobsRes) {
      if (job.status === 'pending') pendingCount++;
      else if (job.status === 'processing') processingCount++;
      else if (job.status === 'completed') completedCount++;
      else if (job.status === 'failed') failedCount++;
      else if (job.status === 'cancelled') cancelledCount++;
    }

    const terminal = (pendingCount === 0 && processingCount === 0);

    const memesRes = await queryDb<{ id: string, mime_type: string, slot_plan: string }>(
      `SELECT id, mime_type, slot_plan FROM memes WHERE draft_id = $1`,
      [draftId]
    );

    return NextResponse.json({
      success: true,
      draftId,
      cycleId,
      targetCount,
      pendingCount,
      processingCount,
      completedCount,
      failedCount,
      cancelledCount,
      terminal,
      jobs: jobsRes.map(j => ({ id: j.id, status: j.status, error_message: j.error_message })),
      memes: memesRes.map(m => ({
        id: m.id,
        url: `/api/admin/meme-drafts/${draftId}/memes/${m.id}/view`,
        plan: JSON.parse(m.slot_plan)
      }))
    }, { headers: { 'Cache-Control': 'no-store' } });

  } catch {
    return NextResponse.json({ error: 'Error al obtener estado' }, { status: 500 });
  }
}
