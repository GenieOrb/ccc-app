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
    const jobsRes = await queryDb<{ id: string, status: string, error_message: string | null }>(
      `SELECT id, status, error_message FROM meme_generation_jobs WHERE draft_id = $1`,
      [draftId]
    );

    if (jobsRes.length === 0) {
       return NextResponse.json({ success: true, jobs: [] }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const memesRes = await queryDb<{ id: string, storage_key: string, storage_url: string, mime_type: string, slot_plan: string }>(
      `SELECT m.id, m.storage_key, m.storage_url, m.mime_type, m.slot_plan FROM memes m 
       JOIN meme_generation_jobs j ON m.job_id = j.id
       WHERE j.draft_id = $1`,
      [draftId]
    );

    return NextResponse.json({
      success: true,
      jobs: jobsRes.map(j => ({ id: j.id, status: j.status, error_message: j.error_message })),
      memes: memesRes.map(m => ({ id: m.id, key: m.storage_key || m.storage_url, url: `/api/admin/meme-drafts/${draftId}/memes/${m.id}/view`, plan: JSON.parse(m.slot_plan) }))
    }, { headers: { 'Cache-Control': 'no-store' } });

  } catch {
    return NextResponse.json({ error: 'Error al obtener estado' }, { status: 500 });
  }
}
