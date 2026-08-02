import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';
import { del } from '@vercel/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, props: { params: Promise<{ draftId: string, assetId: string }> }) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  const { draftId, assetId } = await props.params;

  try {
    const { assetType, percentage, instruction } = await req.json();

    await queryDb(
      `UPDATE meme_assets 
       SET asset_type = $1, appearance_percentage = $2, instruction = $3
       WHERE id = $4 AND draft_id = $5`,
      [assetType, percentage, instruction, assetId, draftId]
    );

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Error updating asset:', error);
    return NextResponse.json({ error: 'Error al actualizar asset' }, { status: 500 });
  }
}

export async function DELETE(req: Request, props: { params: Promise<{ draftId: string, assetId: string }> }) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  const { draftId, assetId } = await props.params;

  try {
    const assetRes = await queryDb<{ storage_url: string }>(
      `SELECT storage_url FROM meme_assets WHERE id = $1 AND draft_id = $2`,
      [assetId, draftId]
    );

    if (assetRes.length > 0) {
      const url = assetRes[0].storage_url;
      try {
        await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch (e) {
        console.error('Blob delete error', e);
      }
    }

    await queryDb(
      `DELETE FROM meme_assets WHERE id = $1 AND draft_id = $2`,
      [assetId, draftId]
    );

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Error deleting asset:', error);
    return NextResponse.json({ error: 'Error al eliminar el asset' }, { status: 500 });
  }
}
