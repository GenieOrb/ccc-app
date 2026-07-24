import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const { id } = await params;
    
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const cursor = url.searchParams.get('cursor'); // expected format: timestamp_id

    let suggestionsQuery = `
      SELECT s.id, s.comment_text, s.status, s.created_at, s.assigned_at, s.withdrawn_at,
             p.x_post_id, p.canonical_url, p.author_username, p.retired_at
      FROM suggestions s
      JOIN campaign_posts p ON s.campaign_post_id = p.id
      WHERE s.campaign_id = $1
    `;
    const queryParams: (string | number)[] = [id];

    if (cursor) {
      const [cursorTime, cursorId] = cursor.split('_');
      if (cursorTime && cursorId) {
        suggestionsQuery += ` AND (s.created_at, s.id) < ($2, $3)`;
        queryParams.push(new Date(parseInt(cursorTime, 10)).toISOString(), cursorId);
      }
    }

    suggestionsQuery += ` ORDER BY s.created_at DESC, s.id DESC LIMIT $${queryParams.length + 1}`;
    queryParams.push(limit);

    interface SuggestionRow {
      id: string;
      comment_text: string;
      status: string;
      created_at: string;
      assigned_at: string | null;
      withdrawn_at: string | null;
      x_post_id: string;
      canonical_url: string;
      author_username: string;
      retired_at: string | null;
    }

    const res = await queryDb<SuggestionRow>(suggestionsQuery, queryParams);

    const suggestions = res.map(row => ({
      id: row.id,
      text: row.comment_text,
      status: row.status,
      createdAt: row.created_at,
      assignedAt: row.assigned_at,
      withdrawnAt: row.withdrawn_at,
      postId: row.x_post_id,
      postUrl: row.canonical_url,
      postAuthor: row.author_username,
      postIsRetired: row.retired_at !== null
    }));

    let nextCursor = null;
    if (suggestions.length === limit) {
      const last = suggestions[suggestions.length - 1];
      nextCursor = `${new Date(last.createdAt).getTime()}_${last.id}`;
    }

    return NextResponse.json(
      { suggestions, nextCursor },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al listar sugerencias.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
