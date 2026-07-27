import { NextResponse } from 'next/server';
import { clearAdminSessionCookie, validateSameOrigin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: 'Petición de origen no permitida.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  await clearAdminSessionCookie();
  return NextResponse.json(
    { success: true },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
