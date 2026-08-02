import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { generateDeterministicSlotPlans } from '@/lib/planner';
import { parseBrandVariantsSafe } from '@/lib/brand-variants';
import { generateSingleComment, generatePreviewCommentsBatch } from '@/lib/openai';
import { DEFAULT_MODEL_KEY, getAiModel, isProviderConfigured } from '@/lib/ai/models';
import { parseMultipleXUrls, fetchXPosts } from '@/lib/x-api';
import { normalizeXAccounts } from '@/lib/x-accounts';
import { resolveXUsername, fetchNewXPostsForAccount } from '@/lib/x-api';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PREVIEW_TOTAL_BUDGET_MS = 50_000;
const PREVIEW_AI_TIMEOUT_MS = 30_000;
const PREVIEW_X_TIMEOUT_MS = 10_000;
const PREVIEW_X_USER_TIMEOUT_MS = 8_000;

function resolveCampaignModel(modelKey?: string) {
  const model = getAiModel(modelKey || DEFAULT_MODEL_KEY);
  if (!model || !model.enabled) throw new Error('Modelo no configurado.');
  if (!isProviderConfigured(model.provider)) throw new Error('El proveedor del modelo seleccionado no está configurado.');
  return model;
}

export async function POST(req: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: 'Petición de origen no permitida.' }, { status: 403 });
  }

  const startTime = Date.now();

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Cuerpo de petición no válido.' }, { status: 400 });
    }

    const { campaignType, urlsInput, accountsInput, direction, modelKey, brandVariants } = body;
    const model = resolveCampaignModel(modelKey);
    let postContent: {
      post_id: string;
      text_content: string;
      author_name: string | null;
      author_username: string | null;
      accessible_context: unknown;
    } | null = null;

    if (campaignType === 'manual') {
      if (!urlsInput || typeof urlsInput !== 'string') {
        return NextResponse.json({ error: 'Debes proporcionar las URLs de los posts de X.' }, { status: 400 });
      }
      const extractedUrls = parseMultipleXUrls(urlsInput);
      const fetchedPosts = await fetchXPosts([extractedUrls[0]], undefined, PREVIEW_X_TIMEOUT_MS);
      if (fetchedPosts.length === 0) {
        return NextResponse.json({ error: 'No se pudo obtener el post para generar la preview.' }, { status: 400 });
      }
      const p = fetchedPosts[0];
      postContent = {
        post_id: p.postId,
        text_content: p.textContent,
        author_name: p.authorName,
        author_username: p.authorUsername,
        accessible_context: p.accessibleContext,
      };
    } else if (campaignType === 'perpetual') {
      if (!accountsInput || typeof accountsInput !== 'string') {
        return NextResponse.json({ error: 'Debes proporcionar las cuentas de X.' }, { status: 400 });
      }
      const normalizedAccounts = normalizeXAccounts(accountsInput);
      const firstAccount = normalizedAccounts[0];
      const xUserId = await resolveXUsername(firstAccount.username, undefined, PREVIEW_X_USER_TIMEOUT_MS);
      const result = await fetchNewXPostsForAccount(xUserId, null, undefined, PREVIEW_X_TIMEOUT_MS, undefined, 1, true);
      if (result.posts.length === 0) {
        return NextResponse.json({ error: 'La cuenta no tiene posts recientes válidos para generar una preview.' }, { status: 400 });
      }
      const p = result.posts[result.posts.length - 1]; // Use the newest one from the fetched page
      postContent = {
        post_id: p.postId,
        text_content: p.textContent,
        author_name: p.authorName,
        author_username: p.authorUsername,
        accessible_context: p.accessibleContext,
      };
    } else {
      return NextResponse.json({ error: 'Tipo de campaña no soportado.' }, { status: 400 });
    }

    if (!postContent) {
      return NextResponse.json({ error: 'No se pudo obtener contenido para la preview.' }, { status: 400 });
    }

    const plans = generateDeterministicSlotPlans([postContent.post_id], 7, parseBrandVariantsSafe(brandVariants));

    let batchResult;
    try {
      const remainingTime = PREVIEW_TOTAL_BUDGET_MS - (Date.now() - startTime);
      if (remainingTime <= 0) throw new Error('PREVIEW_TIMEOUT');
      const aiTimeout = Math.min(PREVIEW_AI_TIMEOUT_MS, remainingTime);

      batchResult = await generatePreviewCommentsBatch({
        apiModel: model.apiModel,
        provider: model.provider,
        postText: postContent!.text_content,
        authorName: postContent!.author_name || '',
        authorUsername: postContent!.author_username || '',
        accessibleContext: (postContent!.accessible_context as Record<string, unknown>) || {},
        direction: direction || undefined,
        plans,
        timeoutMs: aiTimeout,
      });
    } catch (error) {
      throw new Error(`La preview con ${model.displayName} falló en lote. Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }

    const comments = [];
    for (const plan of plans) {
      const generated = batchResult.comments.find(c => c.slotIndex === plan.slotIndex);
      if (generated) {
        comments.push({ text: generated.comment, slotIndex: plan.slotIndex, slotPlan: plan });
      } else {
        // Fallback for partial failures (not likely with structured output, but safe)
        try {
          const fallback = await generateSingleComment({
            apiModel: model.apiModel,
            provider: model.provider,
            postText: postContent!.text_content,
            authorName: postContent!.author_name || '',
            authorUsername: postContent!.author_username || '',
            accessibleContext: (postContent!.accessible_context as Record<string, unknown>) || {},
            direction: direction || undefined,
            plan,
            recentComments: [],
            timeoutMs: 5000,
          });
          comments.push({ text: fallback.comment, slotIndex: plan.slotIndex, slotPlan: plan });
        } catch {
          comments.push({ text: 'Error in generation for this slot.', slotIndex: plan.slotIndex, slotPlan: plan });
        }
      }
    }

    return NextResponse.json(
      { success: true, preview: { comments } },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    const timeElapsed = Date.now() - startTime;
    const isTimeout = timeElapsed >= PREVIEW_TOTAL_BUDGET_MS ||
      (error instanceof Error && (error.message === 'PREVIEW_TIMEOUT' || error.name === 'AbortError' || error.message.includes('timeout') || error.message.includes('tiempo límite')));

    if (isTimeout) {
      return NextResponse.json(
        { error: 'La preview tardó demasiado en generarse. Vuelve a intentarlo.' },
        { status: 504, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al generar la preview.' },
      { status: 400, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
    );
  }
}
