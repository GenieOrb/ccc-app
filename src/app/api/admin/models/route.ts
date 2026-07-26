import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { getPublicAiModels } from '@/lib/ai/models';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET() { if (!(await isAdminAuthenticated())) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 }); return NextResponse.json({ models: getPublicAiModels() }, { headers: { 'Cache-Control': 'no-store' } }); }
