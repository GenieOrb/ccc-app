import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { toggleCampaignStatus } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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

  if (!validateSameOrigin(req)) {
    return NextResponse.json(
      { error: 'Petición de origen no permitida.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (typeof body.isActive !== 'boolean') {
      return NextResponse.json({ error: 'Debes proporcionar isActive booleano.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    const newStatus = await toggleCampaignStatus(id, body.isActive);
    return NextResponse.json(
      { success: true, isActive: newStatus },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al cambiar estado.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
