import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { queryDb } from '@/lib/db';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET() {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  const models = await queryDb(`WITH usage_by_model AS (
    SELECT requested_model_key AS model_key, COUNT(*)::int AS "commentsGenerated", COALESCE(SUM(comments_valid),0)::int AS valid, COALESCE(SUM(comments_rejected),0)::int AS rejected, COALESCE(SUM(regenerations),0)::int AS regenerations, COALESCE(SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END),0)::int AS fallbacks
    FROM generation_usage_metrics GROUP BY requested_model_key
  ), calls_by_model AS (
    SELECT model_key, COALESCE(SUM(input_tokens),0)::int AS "inputTokens", COALESCE(SUM(cached_input_tokens),0)::int AS "cachedInputTokens", COALESCE(SUM(output_tokens),0)::int AS "outputTokens", COALESCE(SUM(estimated_cost),0) AS "estimatedCost"
    FROM generation_api_calls WHERE purpose IN ('generation','rewrite','fallback','preview') AND status IN ('succeeded','usage_unknown') GROUP BY model_key
  )
  SELECT COALESCE(u.model_key,a.model_key) AS "modelKey", COALESCE(u."commentsGenerated",0) AS "commentsGenerated", COALESCE(u.valid,0) AS valid, COALESCE(u.rejected,0) AS rejected, COALESCE(u.regenerations,0) AS regenerations, COALESCE(u.fallbacks,0) AS fallbacks, COALESCE(a."inputTokens",0) AS "inputTokens", COALESCE(a."cachedInputTokens",0) AS "cachedInputTokens", COALESCE(a."outputTokens",0) AS "outputTokens", COALESCE(a."estimatedCost",0) AS "estimatedCost"
  FROM usage_by_model u FULL OUTER JOIN calls_by_model a ON a.model_key = u.model_key ORDER BY "modelKey"`);
  return NextResponse.json({ models }, { headers: { 'Cache-Control': 'no-store' } });
}
