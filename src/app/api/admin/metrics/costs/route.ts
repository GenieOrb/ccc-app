import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const res = await queryDb<{
      ai_cost: string | null,
      x_cost: string | null,
      unknown_ai: string | null,
      unknown_x: string | null
    }>(`
      SELECT
        (SELECT SUM(estimated_cost) FROM generation_api_calls WHERE estimated_cost IS NOT NULL AND status = 'succeeded' AND created_at >= NOW() - INTERVAL '30 days') as ai_cost,
        (SELECT SUM(estimated_cost) FROM x_api_calls WHERE estimated_cost IS NOT NULL AND status = 'succeeded' AND created_at >= NOW() - INTERVAL '30 days') as x_cost,
        (SELECT COUNT(*) FROM generation_api_calls WHERE estimated_cost IS NULL AND status = 'succeeded' AND created_at >= NOW() - INTERVAL '30 days') as unknown_ai,
        (SELECT COUNT(*) FROM x_api_calls WHERE estimated_cost IS NULL AND status = 'succeeded' AND created_at >= NOW() - INTERVAL '30 days') as unknown_x
    `);

    const aiCost = isFinite(Number(res[0]?.ai_cost)) ? Number(res[0]?.ai_cost) || 0 : 0;
    const xCost = isFinite(Number(res[0]?.x_cost)) ? Number(res[0]?.x_cost) || 0 : 0;
    const unknownAiCostCalls = parseInt(res[0]?.unknown_ai || '0', 10);
    const unknownXCostCalls = parseInt(res[0]?.unknown_x || '0', 10);

    const costIsComplete = unknownAiCostCalls === 0 && unknownXCostCalls === 0;

    return NextResponse.json({
      periodDays: 30,
      currency: "USD",
      aiCost,
      xCost,
      totalCost: aiCost + xCost,
      costIsComplete,
      unknownAiCostCalls,
      unknownXCostCalls
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al obtener costes.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
