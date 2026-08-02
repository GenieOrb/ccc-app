import { NextResponse } from 'next/server';
import { validateSameOrigin } from '@/lib/auth';
import { getOrCreateVisitorIdentity } from '@/lib/visitor';
import { checkPublicAssignmentRateLimit, extractClientIp } from '@/lib/rate-limit';
import { assignCommentToVisitor } from '@/lib/services';

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

    // 2. Visitor identity handling (cookie set automatically if missing)
    const visitor = await getOrCreateVisitorIdentity();

    // 3. Define Rate Limit check logic (only executed for new assignments)
    const ip = extractClientIp(req);
    const checkRateLimit = async () => {
      const rateLimit = await checkPublicAssignmentRateLimit(ip);
      return rateLimit.allowed;
    };

    // 4. Atomic DB assignment
    const result = await assignCommentToVisitor(slug, visitor.visitorHash, checkRateLimit);

    if (result.status === 'expired') {
      return NextResponse.json(
        { status: 'expired' },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (result.status === 'unavailable') {
      return NextResponse.json(
        { status: 'unavailable', message: 'This link is currently unavailable. Please try again later.' },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (result.status === 'no_inventory') {
      return NextResponse.json(
        { status: 'no_inventory', message: 'Please try again' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (result.status === 'generating') {
      return NextResponse.json({ status: 'generating', retryAfterMs: result.retryAfterMs }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    if (result.status === 'rate_limited') {
      return NextResponse.json(
        { status: 'rate_limited', message: 'Please try again' },
        { status: 429, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (result.type === 'meme') {
      return NextResponse.json(
        {
          status: 'success',
          type: 'meme',
          assignmentId: result.assignmentId,
          postUrl: result.postUrl,
          viewUrl: result.viewUrl,
          downloadUrl: result.downloadUrl,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        type: 'comment',
        assignmentId: result.assignmentId,
        comment: result.comment,
        postUrl: result.postUrl,
        replyIntentUrl: result.replyIntentUrl,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { status: 'error', message: 'Please try again' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
