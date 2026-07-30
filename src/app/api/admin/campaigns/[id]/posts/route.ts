import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { parseMultipleXUrls, fetchXPosts } from '@/lib/x-api';
import { checkCampaignSafety } from '@/lib/openai';
import { withTransaction } from '@/lib/db';
import { generateDeterministicSlotPlans } from '@/lib/planner';
import { getAiModel } from '@/lib/ai/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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
    const { id } = await params;
    const body = await req.json();
    const { urlsInput } = body;

    if (!urlsInput || typeof urlsInput !== 'string') {
      return NextResponse.json(
        { error: 'urlsInput es requerido y debe ser texto.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Lock campaign to safely add posts
    return await withTransaction(async (client) => {
      const campRes = await client.query<{ id: string; direction: string | null; campaign_type: string; model_key: string }>(
        `SELECT id, direction, campaign_type, model_key FROM campaigns WHERE id = $1 FOR UPDATE`,
        [id]
      );

      if (campRes.rows.length === 0) {
        return NextResponse.json(
          { error: 'Campaña no encontrada.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const campaign = campRes.rows[0];

      if (campaign.campaign_type === 'perpetual') {
        return NextResponse.json(
          { error: 'No se pueden añadir posts manualmente a una campaña perpetua.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      const model = getAiModel(campaign.model_key);
      if (!model || !model.enabled) {
        return NextResponse.json(
          { error: 'El modelo de la campaña no está configurado.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      // Parse and fetch
      const extractedUrls = parseMultipleXUrls(urlsInput);
      
      // Filter out posts that are already active in this campaign
      const activePostsRes = await client.query<{ x_post_id: string }>(
        `SELECT x_post_id FROM campaign_posts WHERE campaign_id = $1 AND retired_at IS NULL`,
        [campaign.id]
      );
      
      const activePostIds = new Set(activePostsRes.rows.map(r => r.x_post_id));
      
      if (activePostIds.size + extractedUrls.length > 50) {
         return NextResponse.json(
          { error: 'No se permiten más de 50 posts vigentes simultáneamente.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const newUrls = extractedUrls.filter(u => !activePostIds.has(u.postId));
      
      if (newUrls.length === 0) {
        return NextResponse.json(
          { error: 'Todos los posts proporcionados ya están vigentes en esta campaña.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const fetchedPosts = await fetchXPosts(newUrls, { campaignId: campaign.id });

      // Check safety
      const postsTexts = fetchedPosts.map((fp) => fp.textContent);
      const safetyResult = await checkCampaignSafety(
        postsTexts,
        campaign.direction || undefined,
        { campaignId: campaign.id },
      );

      if (!safetyResult.allowed) {
        return NextResponse.json(
          { error: `Los nuevos posts fueron rechazados por seguridad. Categoria: ${safetyResult.category}. Motivo: ${safetyResult.reason}` },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      // Insert new posts
      for (const fp of fetchedPosts) {
        const postRes = await client.query<{ id: string }>(
          `INSERT INTO campaign_posts (
             campaign_id, x_post_id, input_url, canonical_url, author_name, author_username,
             text_content, language, conversation_id, posted_at, accessible_context
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
           ) RETURNING id`,
          [
            campaign.id,
            fp.postId,
            fp.inputUrl,
            fp.canonicalUrl,
            fp.authorName,
            fp.authorUsername,
            fp.textContent,
            fp.language,
            fp.conversationId,
            fp.postedAt ? new Date(fp.postedAt) : null,
            JSON.stringify(fp.accessibleContext),
          ]
        );
        const campaignPostId = postRes.rows[0].id;
        const cycleRes = await client.query<{ id: string }>(
          `INSERT INTO generation_cycles (
             campaign_id, campaign_post_id, cycle_type, target_count, status, model_key, model_name, prompt_version
           ) VALUES (
             $1, $2, 'initial', 30, 'pending', $3, $4, 1
           ) RETURNING id`,
          [campaign.id, campaignPostId, model.key, model.apiModel]
        );
        const cycleId = cycleRes.rows[0].id;
        for (const plan of generateDeterministicSlotPlans([campaignPostId], 30)) {
          await client.query(
            `INSERT INTO generation_jobs (
               cycle_id, campaign_id, campaign_post_id, slot_index, slot_plan,
               length_mode, emoji_policy, rhetorical_form, texture, status,
               model_name, prompt_version
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, 1
             )`,
            [
              cycleId, campaign.id, plan.assignedPostId, plan.slotIndex, JSON.stringify(plan),
              plan.lengthMode, plan.emojiPolicy, plan.rhetoricalForm, plan.texture, model.apiModel,
            ]
          );
        }
      }

      return NextResponse.json(
        { success: true, added: fetchedPosts.length },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al añadir posts.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
