import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { getAllCampaigns, createCampaign, createPerpetualCampaign } from '@/lib/services';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const config = getConfig();
    const campaigns = await getAllCampaigns(config.appBaseUrl);
    return NextResponse.json(
      { campaigns },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al obtener campañas.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function POST(req: Request) {
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
    const body = await req.json().catch(() => null);

    if (!body || Array.isArray(body) || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Cuerpo de petición no válido.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const campaignType = body.campaignType || 'manual';

    if (campaignType === 'manual') {
      if ('accountsInput' in body || 'postActiveLifetimeHours' in body) {
        return NextResponse.json(
          { error: 'Payload ambiguo: una campaña manual no debe contener accountsInput o postActiveLifetimeHours.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const { urlsInput, direction } = body;
      
      if (!urlsInput || typeof urlsInput !== 'string') {
        return NextResponse.json(
          { error: 'Debes proporcionar las URLs de los posts de X.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (direction && (typeof direction !== 'string' || direction.length > 4000)) {
        return NextResponse.json(
          { error: 'La dirección del comentario no puede superar 4000 caracteres.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const created = await createCampaign({ urlsInput, direction });

      return NextResponse.json(
        { success: true, campaign: { ...created, campaignType: 'manual' } },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    } else if (campaignType === 'perpetual') {
      if ('urlsInput' in body) {
        return NextResponse.json(
          { error: 'Payload ambiguo: una campaña perpetua no debe contener urlsInput.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const { accountsInput, direction, postActiveLifetimeHours } = body;
      
      if (!accountsInput || typeof accountsInput !== 'string') {
        return NextResponse.json(
          { error: 'Debes proporcionar las cuentas de X.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (typeof postActiveLifetimeHours !== 'number' || postActiveLifetimeHours < 1 || postActiveLifetimeHours > 720 || !Number.isInteger(postActiveLifetimeHours)) {
        return NextResponse.json(
          { error: 'La duración de los posts debe ser un número entero entre 1 y 720 horas.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (direction && (typeof direction !== 'string' || direction.length > 4000)) {
        return NextResponse.json(
          { error: 'La dirección del comentario no puede superar 4000 caracteres.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const created = await createPerpetualCampaign({ accountsInput, direction, postActiveLifetimeHours });

      return NextResponse.json(
        { success: true, campaign: { ...created, campaignType: 'perpetual' } },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    } else {
      return NextResponse.json(
        { error: 'Tipo de campaña no soportado.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al crear la campaña.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
