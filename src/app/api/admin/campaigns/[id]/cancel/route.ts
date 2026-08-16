import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { cancelCampaign } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!validateSameOrigin(req)) {
    return NextResponse.json(
      { error: 'Petición de origen no permitida.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const { id } = await params;
    const result = await cancelCampaign(id);
    return NextResponse.json(
      { success: !result.cleanupPending, cancelled: true, ...result },
      { status: result.cleanupPending ? 502 : 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al cancelar la campaña.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
