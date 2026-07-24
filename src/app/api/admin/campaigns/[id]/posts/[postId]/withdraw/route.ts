import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { withTransaction } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; postId: string }> }
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
    const { id, postId } = await params;

    return await withTransaction(async (client) => {
      // Acquire lock on campaign
      const campRes = await client.query<{ id: string; campaign_type: string }>(
        `SELECT id, campaign_type FROM campaigns WHERE id = $1 FOR UPDATE`,
        [id]
      );

      if (campRes.rows.length === 0) {
        return NextResponse.json(
          { error: 'Campaña no encontrada.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (campRes.rows[0].campaign_type === 'perpetual') {
        return NextResponse.json(
          { error: 'No se pueden retirar posts manualmente en una campaña perpetua.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      // Check how many active posts are left
      const activePostsRes = await client.query<{ id: string }>(
        `SELECT id FROM campaign_posts WHERE campaign_id = $1 AND retired_at IS NULL FOR UPDATE`,
        [id]
      );

      if (activePostsRes.rows.length <= 1 && activePostsRes.rows.some(p => p.id === postId)) {
        return NextResponse.json(
          { error: 'No se puede retirar el último post vigente de la campaña.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const res = await client.query(
        `UPDATE campaign_posts 
         SET retired_at = NOW() 
         WHERE id = $1 AND campaign_id = $2 AND retired_at IS NULL
         RETURNING id`,
        [postId, id]
      );

      if (res.rows.length === 0) {
        return NextResponse.json(
          { error: 'Post no encontrado o ya estaba retirado.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      return NextResponse.json(
        { success: true },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al retirar el post.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
