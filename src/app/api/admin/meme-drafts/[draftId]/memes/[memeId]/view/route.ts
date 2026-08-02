import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';
import { getMemeBlobStream } from '@/lib/memes/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, props: { params: Promise<{ draftId: string, memeId: string }> }) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return new Response('No autorizado.', { status: 401 });
  }

  const { draftId, memeId } = await props.params;

  try {
    const memeRes = await queryDb<{ storage_key: string, storage_url: string, mime_type: string }>(
      `SELECT m.storage_key, m.storage_url, m.mime_type FROM memes m 
       JOIN meme_generation_jobs j ON m.job_id = j.id
       WHERE m.id = $1 AND j.draft_id = $2`,
      [memeId, draftId]
    );

    if (memeRes.length === 0) {
      return new Response('Meme no encontrado', { status: 404 });
    }

    const { storage_key, storage_url, mime_type } = memeRes[0];
    const { stream, contentType } = await getMemeBlobStream(storage_key || storage_url);

    return new Response(stream, {
      headers: {
        'Content-Type': contentType || mime_type,
        'Cache-Control': 'private, no-store'
      }
    });

  } catch (error: unknown) {
    console.error('Error viewing meme:', error);
    return new Response('Error al obtener imagen', { status: 500 });
  }
}
