import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { processBackgroundQueue } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST() {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const result = await processBackgroundQueue();
    return NextResponse.json(
      { success: true, ...result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error en el procesador de trabajos.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
