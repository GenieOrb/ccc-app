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
    const res = await queryDb<{ storage_key: string; storage_url: string; mime_type: string }>(`
      SELECT m.storage_key, m.storage_url, m.mime_type
      FROM assignments a
      JOIN campaigns c ON a.campaign_id = c.id
      JOIN visitors v ON a.visitor_id = v.id
      JOIN memes m ON a.meme_id = m.id
      WHERE a.id = $1 AND c.slug = $2 AND v.visitor_hash = $3
      LIMIT 1
    `, [assignmentId, slug, visitor.visitorHash]);

    if (res.length === 0) {
      return new NextResponse('Not found or unauthorized', { status: 404 });
    }

    const { storage_key, storage_url, mime_type } = res[0];

    // 2. Fetch from Vercel Blob privately to proxy
    const { stream, contentType } = await getMemeBlobStream(storage_key || storage_url);
    
    const actualMimeType = contentType || mime_type;
    // Extension logic based on mime_type
    const ext = actualMimeType === 'image/png' ? 'png' : actualMimeType === 'image/jpeg' ? 'jpeg' : 'jpg';

    // 3. Return with correct MIME type and Content-Disposition
    return new NextResponse(stream, {
      headers: {
        'Content-Type': actualMimeType,
        'Content-Disposition': `attachment; filename="meme.${ext}"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
