import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { updateCampaignDuration } from '@/lib/services';
import { getAiModel, isProviderConfigured } from '@/lib/ai/models';
import { queryDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const body = await req.json().catch(() => null);

    if (!body || Array.isArray(body) || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Cuerpo de petición no válido.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const keys = Object.keys(body);
    if (keys.length !== 1 || !['postActiveLifetimeHours','displayName','modelKey'].includes(keys[0])) {
      return NextResponse.json(
        { error: 'El cuerpo solo puede contener el campo postActiveLifetimeHours.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const { postActiveLifetimeHours } = body;
    if (keys[0] === 'displayName') { if (typeof body.displayName !== 'string' || body.displayName.trim().length > 120) throw new Error('Nombre no válido.'); await queryDb(`UPDATE campaigns SET display_name=$1,updated_at=NOW() WHERE id=$2`, [body.displayName.trim() || null,id]); return NextResponse.json({ success:true }); }
    if (keys[0] === 'modelKey') { const model=getAiModel(body.modelKey); if (!model || !model.enabled || !isProviderConfigured(model.provider)) throw new Error('Modelo no configurado.'); await queryDb(`UPDATE campaigns SET model_key=$1,updated_at=NOW() WHERE id=$2`, [model.key,id]); return NextResponse.json({ success:true }); }

    if (postActiveLifetimeHours === undefined || typeof postActiveLifetimeHours !== 'number' || postActiveLifetimeHours < 1 || postActiveLifetimeHours > 720 || !Number.isInteger(postActiveLifetimeHours)) {
      return NextResponse.json(
        { error: 'La duración de los posts debe ser un número entero entre 1 y 720 horas.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // In this phase we only allow changing the duration
    await updateCampaignDuration(id, postActiveLifetimeHours);

    return NextResponse.json(
      { success: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al actualizar configuración.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
