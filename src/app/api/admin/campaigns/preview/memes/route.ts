import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { generateDeterministicMemeSlotPlans } from '@/lib/memes/planner';
import { resolveImageModel } from '@/lib/ai/image-models';
import { parseMultipleXUrls, fetchXPosts } from '@/lib/x-api';
import { normalizeXAccounts } from '@/lib/x-accounts';
import { resolveXUsername, fetchNewXPostsForAccount } from '@/lib/x-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // Generating 3 images could take long

const PREVIEW_X_TIMEOUT_MS = 10_000;
const PREVIEW_X_USER_TIMEOUT_MS = 8_000;

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

    const { campaignType, urlsInput, accountsInput, direction, memeModelKey, draftId } = body;
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

    const { queryDb } = await import('@/lib/db');
    let effectiveDraftId = draftId;
    if (!effectiveDraftId) {
       effectiveDraftId = crypto.randomUUID();
       // Optionally insert into meme_drafts here if it requires a foreign key
       // But assuming meme_generation_jobs cascade or just requires draft_id string
    }

    const plans = generateDeterministicMemeSlotPlans(null, effectiveDraftId, [postContent.post_id], 3, []);

    for (const plan of plans) {
       await queryDb(
         `INSERT INTO meme_generation_jobs 
          (id, assignment_id, model_key, slot_plan, post_context, campaign_direction, created_at, status, draft_id)
          VALUES (gen_random_uuid(), NULL, $1, $2, $3, $4, NOW(), 'pending', $5)`,
         [
           model.key,
           JSON.stringify(plan),
           JSON.stringify({ 
             text: postContent!.text_content, 
             author: postContent!.author_username 
           }),
           direction || 'Sin dirección específica.',
           effectiveDraftId
         ]
       );
    }

    return NextResponse.json(
      { success: true, draftId: effectiveDraftId },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al generar la preview de memes.' },
      { status: 400, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
    );
  }
}
