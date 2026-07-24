import { NextResponse } from 'next/server';
import { validateAdminPassword, setAdminSessionCookie, validateSameOrigin } from '@/lib/auth';
import {
  checkAdminLoginRateLimit,
  recordAdminLoginFailure,
  clearAdminLoginFailures,
  extractClientIp,
} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!validateSameOrigin(req)) {
    return NextResponse.json(
      { error: 'Petición de origen no permitida.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const ip = extractClientIp(req);
    const rateCheck = await checkAdminLoginRateLimit(ip);

    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: 'Demasiados intentos fallidos. Inténtelo más tarde.' },
        { status: 429, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { password } = body;

    if (!password || typeof password !== 'string') {
      await recordAdminLoginFailure(ip);
      return NextResponse.json(
        { error: 'Contraseña no válida.' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const isValid = validateAdminPassword(password);
    if (!isValid) {
      await recordAdminLoginFailure(ip);
      return NextResponse.json(
        { error: 'Contraseña incorrecta.' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    await clearAdminLoginFailures(ip);
    await setAdminSessionCookie();

    return NextResponse.json(
      { success: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error en el servidor.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
