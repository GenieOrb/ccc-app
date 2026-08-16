import { NextResponse } from 'next/server';
import { validateSameOrigin } from '@/lib/auth';
import { getOrCreateVisitorIdentity } from '@/lib/visitor';
import { withTransaction } from '@/lib/db';
import { triggerReplenishmentIfNeeded } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  // 1. Validate CSRF / Same-Origin
  if (!validateSameOrigin(req)) {
    return NextResponse.json(
      { status: 'error', message: 'Please try again' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const { slug } = await params;

    // Parse body for assignmentId
    const body = await req.json().catch(() => ({}));
    const assignmentId = body.assignmentId;
    if (!assignmentId || typeof assignmentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)) {
      return NextResponse.json(
        { status: 'error', message: 'Please try again' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // 2. Visitor identity
    const visitor = await getOrCreateVisitorIdentity();

    // 3. All logic inside a single transaction
    const result = await withTransaction<{ status: 'success'; canonicalUrl: string; campaignId: string } | { status: 'error' } | { status: 'expired' }>(
      async (client) => {
        // Fetch and lock campaign FOR SHARE
        const campaignRows = await client.query<{ id: string; is_active: boolean }>(
          `SELECT id, is_active FROM campaigns WHERE slug = $1 FOR SHARE`,
          [slug]
        );

        if (campaignRows.rows.length === 0) {
          return { status: 'expired' }; // Not found or deleted
        }

        const campaignId = campaignRows.rows[0].id;

        // Fetch visitor id
        const visitorRows = await client.query<{ id: string }>(
          `SELECT id FROM visitors WHERE visitor_hash = $1`,
          [visitor.visitorHash]
        );

        if (visitorRows.rows.length === 0) {
          return { status: 'error' };
        }

        const visitorId = visitorRows.rows[0].id;

        // Lock the visitor campaign state FOR UPDATE
        const stateRes = await client.query<{ active_assignment_id: string | null }>(
          `SELECT active_assignment_id
           FROM visitor_campaign_states
           WHERE campaign_id = $1 AND visitor_id = $2
           FOR UPDATE`,
          [campaignId, visitorId]
        );

        if (stateRes.rows.length === 0) {
          return { status: 'error' };
        }

        // Verify assignment ownership and retrieve URL
        const assignRes = await client.query<{ canonical_url: string }>(
          `SELECT p.canonical_url
           FROM assignments a
           JOIN campaign_posts p ON a.campaign_post_id = p.id
           WHERE a.id = $1 AND a.campaign_id = $2 AND a.visitor_id = $3`,
          [assignmentId, campaignId, visitorId]
        );

        if (assignRes.rows.length === 0) {
          return { status: 'error' };
        }

        const canonicalUrl = assignRes.rows[0].canonical_url;

        // Check if click already recorded for this assignment, campaign, visitor
        const clickRes = await client.query(
          `SELECT 1 FROM assignment_post_clicks
           WHERE assignment_id = $1 AND campaign_id = $2 AND visitor_id = $3`,
          [assignmentId, campaignId, visitorId]
        );

        if (clickRes.rows.length > 0) {
          // Idempotent success - already recorded
          // Note: we return success even if campaign was deactivated after first click, as required by "permitir este éxito aunque la campaña haya sido desactivada".
          return { status: 'success', canonicalUrl, campaignId };
        }

        // It is a new click. Require campaign to be active.
        if (!campaignRows.rows[0].is_active) {
          return { status: 'expired' };
        }

        // Require active_assignment_id to be EXACTLY this assignmentId
        if (stateRes.rows[0].active_assignment_id !== assignmentId) {
          return { status: 'error' };
        }

        // Insert click (immutable record)
        await client.query(
          `INSERT INTO assignment_post_clicks (assignment_id, campaign_id, visitor_id)
           VALUES ($1, $2, $3)`,
          [assignmentId, campaignId, visitorId]
        );

        // Conditional nullify active assignment with RETURNING 1
        const updateRes = await client.query(
          `UPDATE visitor_campaign_states
           SET active_assignment_id = NULL, updated_at = NOW()
           WHERE campaign_id = $1 AND visitor_id = $2 AND active_assignment_id = $3
           RETURNING 1`,
          [campaignId, visitorId, assignmentId]
        );

        if (updateRes.rows.length !== 1) {
          throw new Error('Failed to update active assignment state');
        }

        return { status: 'success', canonicalUrl, campaignId };
      }
    );

    if (result.status === 'expired') {
      return NextResponse.json(
        { status: 'expired' },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (result.status === 'error') {
      return NextResponse.json(
        { status: 'error', message: 'Please try again' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (result.campaignId) {
      await triggerReplenishmentIfNeeded(result.campaignId).catch(() => undefined);
    }

    return NextResponse.json(
      { status: 'success', canonicalUrl: result.canonicalUrl },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );

  } catch {
    return NextResponse.json(
      { status: 'error', message: 'Please try again' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
