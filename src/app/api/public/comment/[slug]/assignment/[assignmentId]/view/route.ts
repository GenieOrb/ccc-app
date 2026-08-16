import { NextResponse } from 'next/server';
import { getOrCreateVisitorIdentity } from '@/lib/visitor';
import { queryDb } from '@/lib/db';
import { getMemeBlobStream } from '@/lib/memes/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; assignmentId: string }> }
) {
  try {
    const { slug, assignmentId } = await params;
    const visitor = await getOrCreateVisitorIdentity();

    // 1. Validate that the visitor owns this assignment and it belongs to the campaign
    const res = await queryDb<{ storage_key: string; storage_url: string; mime_type: string; cancelled_at: Date | null }>(`
      SELECT COALESCE(cm.storage_key, m.storage_key) AS storage_key,
             COALESCE(cm.storage_url, m.storage_url) AS storage_url,
             COALESCE(cm.mime_type, m.mime_type) AS mime_type,
             c.cancelled_at
      FROM assignments a
      JOIN campaigns c ON a.campaign_id = c.id
      JOIN visitors v ON a.visitor_id = v.id
      LEFT JOIN memes m ON a.meme_id = m.id
      LEFT JOIN campaign_memes cm ON a.campaign_meme_id = cm.id AND cm.campaign_id = a.campaign_id
      WHERE a.id = $1 AND c.slug = $2 AND v.visitor_hash = $3
      AND (m.id IS NOT NULL OR cm.id IS NOT NULL)
      LIMIT 1
    `, [assignmentId, slug, visitor.visitorHash]);

    if (res.length === 0 || res[0].cancelled_at != null) {
      return new NextResponse('Not found or unauthorized', { status: 404 });
    }

    const { storage_key, storage_url, mime_type } = res[0];

    // 2. Fetch from Vercel Blob privately to proxy
    const { stream, contentType } = await getMemeBlobStream(storage_key || storage_url);

    // 3. Return with correct MIME type
    return new NextResponse(stream, {
      headers: {
        'Content-Type': contentType || mime_type,
        'Cache-Control': 'private, no-store'
      }
    });
  } catch {
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
