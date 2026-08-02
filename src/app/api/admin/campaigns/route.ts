import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { getCampaignsPage, createCampaign, createPerpetualCampaign } from '@/lib/services';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CAMPAIGNS_PAGE_SIZE = 10;

export async function GET(req: Request) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const config = getConfig();
    const rawPage = new URL(req.url).searchParams.get('page');
    const page = rawPage === null ? 1 : Number(rawPage);
    if (!Number.isInteger(page) || page < 1) {
      return NextResponse.json(
        { error: 'El parámetro page debe ser un entero positivo.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const campaigns = await getCampaignsPage(config.appBaseUrl, page, CAMPAIGNS_PAGE_SIZE);

    return NextResponse.json(
      campaigns,
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
    const creationMode = body.creationMode;
    if (creationMode !== undefined && creationMode !== 'active' && creationMode !== 'inactive') {
      return NextResponse.json(
        { error: 'Modo de creación no válido. Debe ser active o inactive.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const isInactive = creationMode === 'inactive';

    if (campaignType === 'manual') {
      if ('accountsInput' in body || 'postActiveLifetimeHours' in body) {
        return NextResponse.json(
          { error: 'Payload ambiguo: una campaña manual no debe contener accountsInput o postActiveLifetimeHours.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const { urlsInput, direction, displayName, modelKey, brandVariants, maxCommentsTotal, includeMemes, memePercentage, memeModelKey } = body;

      if (maxCommentsTotal !== undefined) {
        if (!Number.isInteger(maxCommentsTotal) || maxCommentsTotal < 1 || maxCommentsTotal > 1000000) {
          return NextResponse.json(
            { error: 'El máximo de comentarios debe ser un entero entre 1 y 1.000.000.' },
            { status: 400, headers: { 'Cache-Control': 'no-store' } }
          );
        }
      }

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

      if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 120)) return NextResponse.json({ error: 'Nombre de campaña no válido.' }, { status: 400 });
      if (modelKey !== undefined && typeof modelKey !== 'string') return NextResponse.json({ error: 'Modelo no válido.' }, { status: 400 });
      if (brandVariants !== undefined && !Array.isArray(brandVariants)) return NextResponse.json({ error: 'Variantes de marca no válidas.' }, { status: 400 });
      if (memePercentage !== undefined && (!Number.isInteger(memePercentage) || memePercentage < 0 || memePercentage > 100)) return NextResponse.json({ error: 'Porcentaje de memes no válido.' }, { status: 400 });

      const created = await createCampaign({ urlsInput, direction, displayName, modelKey, brandVariants, maxCommentsTotal, isInactive, includeMemes, memePercentage, memeModelKey });

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

      const { accountsInput, direction, postActiveLifetimeHours, displayName, modelKey, brandVariants, maxCommentsTotal, includeMemes, memePercentage, memeModelKey } = body;

      if (maxCommentsTotal !== undefined) {
        if (!Number.isInteger(maxCommentsTotal) || maxCommentsTotal < 1 || maxCommentsTotal > 1000000) {
          return NextResponse.json(
            { error: 'El máximo de comentarios debe ser un entero entre 1 y 1.000.000.' },
            { status: 400, headers: { 'Cache-Control': 'no-store' } }
          );
        }
      }

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

      if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 120)) return NextResponse.json({ error: 'Nombre de campaña no válido.' }, { status: 400 });
      if (modelKey !== undefined && typeof modelKey !== 'string') return NextResponse.json({ error: 'Modelo no válido.' }, { status: 400 });
      if (brandVariants !== undefined && !Array.isArray(brandVariants)) return NextResponse.json({ error: 'Variantes de marca no válidas.' }, { status: 400 });
      if (memePercentage !== undefined && (!Number.isInteger(memePercentage) || memePercentage < 0 || memePercentage > 100)) return NextResponse.json({ error: 'Porcentaje de memes no válido.' }, { status: 400 });

      const created = await createPerpetualCampaign({ accountsInput, direction, postActiveLifetimeHours, displayName, modelKey, brandVariants, maxCommentsTotal, isInactive, includeMemes, memePercentage, memeModelKey });

      return NextResponse.json(
        { success: true, campaign: { id: created.id, slug: created.slug, campaignType: 'perpetual' }, initialSync: created.initialSync || { pending: true } },
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
