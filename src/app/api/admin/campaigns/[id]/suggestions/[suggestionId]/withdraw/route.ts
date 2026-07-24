import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { withTransaction } from '@/lib/db';
import { triggerReplenishmentIfNeeded } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; suggestionId: string }> }
) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!validateSameOrigin(req)) {
    return NextResponse.json(
      { error: 'Petición de origen no permitida.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const { id, suggestionId } = await params;

    const res = await withTransaction(async (client) => {
      // First check the current status to provide appropriate errors
      const statusRes = await client.query<{ status: string; id: string }>(
        `SELECT id, status FROM suggestions WHERE id = $1 AND campaign_id = $2 FOR UPDATE`,
        [suggestionId, id]
      );

      if (statusRes.rows.length === 0) {
        return NextResponse.json(
          { error: 'Sugerencia no encontrada.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const suggestion = statusRes.rows[0];

      if (suggestion.status === 'withdrawn') {
        // Idempotent
        return NextResponse.json(
          { success: true },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (suggestion.status === 'assigned') {
        return NextResponse.json(
          { error: 'Conflicto: la sugerencia ya fue asignada públicamente y no puede retirarse.' },
          { status: 409, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      // It's available, so we can withdraw it
      await client.query(
        `UPDATE suggestions 
         SET status = 'withdrawn', withdrawn_at = NOW() 
         WHERE id = $1 AND status = 'available'`,
        [suggestionId]
      );
      
      return NextResponse.json(
        { success: true },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    });

    if (res.status === 200) {
      triggerReplenishmentIfNeeded(id).catch(() => {});
    }

    return res;
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al retirar la sugerencia.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
