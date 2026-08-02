import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, props: { params: Promise<{ draftId: string }> }) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  const { draftId } = await props.params;

  try {
    const assetsRes = await queryDb<{ id: string, asset_type: string, appearance_percentage: number, instruction: string, storage_url: string, mime_type: string, size_bytes: number }>(
      `SELECT id, asset_type, appearance_percentage, instruction, storage_url, mime_type, size_bytes
       FROM meme_assets
       WHERE draft_id = $1 AND status = 'active'
       ORDER BY created_at ASC`,
      [draftId]
    );

    return NextResponse.json({ assets: assetsRes });
  } catch (error: unknown) {
    console.error('Error fetching assets:', error);
    return NextResponse.json({ error: 'Error al obtener assets' }, { status: 500 });
  }
}
