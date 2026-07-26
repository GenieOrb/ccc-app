import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { generateCampaignPreview, listCampaignPreviews } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  const { id } = await params;
  return NextResponse.json({ previews: await listCampaignPreviews(id) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  if (!validateSameOrigin(req)) return NextResponse.json({ error: 'Petición de origen no permitida.' }, { status: 403 });
  try { const { id } = await params; return NextResponse.json({ success: true, preview: await generateCampaignPreview(id) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Error al generar preview.' }, { status: 400 }); }
}
