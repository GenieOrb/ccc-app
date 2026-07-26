import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET() {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  const models = await queryDb(`SELECT requested_model_key AS "modelKey", COUNT(*)::int AS "commentsGenerated", COALESCE(SUM(comments_valid),0)::int AS valid, COALESCE(SUM(comments_rejected),0)::int AS rejected, COALESCE(SUM(regenerations),0)::int AS regenerations, COALESCE(SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END),0)::int AS fallbacks, COALESCE(SUM(input_tokens),0)::int AS "inputTokens", COALESCE(SUM(cached_input_tokens),0)::int AS "cachedInputTokens", COALESCE(SUM(output_tokens),0)::int AS "outputTokens", COALESCE(SUM(estimated_cost),0) AS "estimatedCost" FROM generation_usage_metrics GROUP BY requested_model_key ORDER BY requested_model_key`);
  return NextResponse.json({ models }, { headers: { 'Cache-Control': 'no-store' } });
}
