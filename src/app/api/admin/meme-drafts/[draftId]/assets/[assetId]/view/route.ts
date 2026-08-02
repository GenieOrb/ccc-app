import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, props: { params: Promise<{ draftId: string, assetId: string }> }) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return new Response('No autorizado.', { status: 401 });
  }

  const { draftId, assetId } = await props.params;

  try {
    const assetRes = await queryDb<{ storage_url: string, mime_type: string }>(
      `SELECT storage_url, mime_type FROM meme_assets WHERE id = $1 AND draft_id = $2`,
      [assetId, draftId]
    );

    if (assetRes.length === 0) {
      return new Response('Asset no encontrado', { status: 404 });
    }

    const { storage_url, mime_type } = assetRes[0];

    // Download from Blob to serve to admin
    const blobResponse = await fetch(storage_url);
    if (!blobResponse.ok) {
      return new Response('Error fetch blob', { status: 500 });
    }

    const buffer = await blobResponse.arrayBuffer();

    return new Response(buffer, {
      headers: {
        'Content-Type': mime_type,
        'Cache-Control': 'private, max-age=3600'
      }
    });

  } catch (error: unknown) {
    console.error('Error viewing asset:', error);
    return new Response('Error al obtener imagen', { status: 500 });
  }
}
