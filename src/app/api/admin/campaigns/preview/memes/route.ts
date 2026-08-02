import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { generateDeterministicMemeSlotPlans } from '@/lib/memes/planner';
import { generateMemeImage } from '@/lib/memes/generation';
import { performMemeAnalysis } from '@/lib/memes/analysis';
import { resolveImageModel } from '@/lib/ai/image-models';
import { parseMultipleXUrls, fetchXPosts } from '@/lib/x-api';
import { normalizeXAccounts } from '@/lib/x-accounts';
import { resolveXUsername, fetchNewXPostsForAccount } from '@/lib/x-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // Generating 3 images could take long

const PREVIEW_TOTAL_BUDGET_MS = 110_000;
const PREVIEW_X_TIMEOUT_MS = 10_000;
const PREVIEW_X_USER_TIMEOUT_MS = 8_000;

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

    const { campaignType, urlsInput, accountsInput, direction, memeModelKey } = body;
    if (!memeModelKey) {
      return NextResponse.json({ error: 'Debe especificar un modelo de generación (memeModelKey).' }, { status: 400 });
    }
    
    let model;
    try {
      model = resolveImageModel(memeModelKey);
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Modelo de imagen desconocido.' }, { status: 400 });
    }

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

    const plans = generateDeterministicMemeSlotPlans(null, 'preview-draft-id', [postContent.post_id], 3, []);

    const generatedPromises = plans.map(async (plan) => {
      const remainingTime = PREVIEW_TOTAL_BUDGET_MS - (Date.now() - startTime);
      if (remainingTime <= 0) {
        throw new Error('PREVIEW_TIMEOUT');
      }

      try {
        const analysis = await performMemeAnalysis({
          postText: postContent!.text_content,
          campaignDirection: direction || 'Sin dirección específica.',
          availableAssets: []
        });

        const generation = await generateMemeImage(
          plan,
          analysis,
          model.key
        );
        
        const imageBlobUrl = `data:${generation.mimeType};base64,${generation.imageBuffer.toString('base64')}`;
        const prompt = `Concept: ${analysis.concept}\nMechanism: ${plan.mechanism}\nFormat: ${plan.format}\nTone: ${plan.tone}`;
        
        return { imageBlobUrl, prompt, slotIndex: plan.slotIndex, dimensions: plan };
      } catch (error) {
        throw new Error(`La preview de meme falló. Error: ${error instanceof Error ? error.message : 'Unknown'}`);
      }
    });

    const results = await Promise.allSettled(generatedPromises);
    const memes = [];
    for (const r of results) {
      if (r.status === 'rejected') {
         throw r.reason;
      }
      memes.push(r.value);
    }

    return NextResponse.json(
      { success: true, preview: { memes } },
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
      { error: error instanceof Error ? error.message : 'Error al generar la preview de memes.' },
      { status: 400, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
    );
  }
}
