import { NextResponse } from 'next/server';
import { clearAdminSessionCookie } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  await clearAdminSessionCookie();
  return NextResponse.json(
    { success: true },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
