import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { generateDeterministicSlotPlans } from '@/lib/planner';
import { generateSingleComment } from '@/lib/openai';
import { DEFAULT_MODEL_KEY, getAiModel, isProviderConfigured } from '@/lib/ai/models';
import { parseMultipleXUrls, fetchXPosts } from '@/lib/x-api';
import { normalizeXAccounts } from '@/lib/x-accounts';
import { resolveXUsername, fetchNewXPostsForAccount } from '@/lib/x-api';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
      const fetchedPosts = await fetchXPosts([extractedUrls[0]]); // Use the first one
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
      const xUserId = await resolveXUsername(firstAccount.username);
      const result = await fetchNewXPostsForAccount(xUserId, null, undefined, 15000, undefined, 1, true);
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plans = generateDeterministicSlotPlans([postContent.post_id], 7, (brandVariants as any) || []);
    const comments: Array<{ text: string, slotIndex: number, slotPlan?: unknown }> = [];

    // Generar concurrentemente para no superar el límite de maxDuration (60s)
    for (const batch of [plans.slice(0, 5), plans.slice(5)]) {
      if (batch.length === 0) continue;
      const generated = await Promise.all(batch.map(async (plan) => {
        try {
          const generatedComment = await generateSingleComment({
            apiModel: model.apiModel,
            provider: model.provider,
            postText: postContent!.text_content,
            authorName: postContent!.author_name || '',
            authorUsername: postContent!.author_username || '',
            accessibleContext: (postContent!.accessible_context as Record<string, unknown>) || {},
            direction: direction || undefined,
            plan,
            recentComments: comments.map(c => c.text),
          });
          return { text: generatedComment.comment, slotIndex: plan.slotIndex, slotPlan: plan };
        } catch (error) {
          throw new Error(`La preview con ${model.displayName} falló en el slot ${plan.slotIndex}. Error: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
      }));
      comments.push(...generated);
    }

    return NextResponse.json(
      { success: true, preview: { comments } },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al generar la preview.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
