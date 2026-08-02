import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { generateDeterministicMemeSlotPlans } from '@/lib/memes/planner';
import { resolveImageModel } from '@/lib/ai/image-models';
import { parseMultipleXUrls, fetchXPosts, resolveXUsername, fetchNewXPostsForAccount } from '@/lib/x-api';
import { normalizeXAccounts } from '@/lib/x-accounts';
import { z } from 'zod';
import { createHash } from 'crypto';
import { withTransaction } from '@/lib/db';
import { buildInternalProcessAuthorizationHeader } from '@/lib/internal-process-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const PREVIEW_X_TIMEOUT_MS = 10_000;
const PREVIEW_X_USER_TIMEOUT_MS = 8_000;

const previewSchema = z.object({
  campaignType: z.enum(['manual', 'perpetual']),
  urlsInput: z.string().optional(),
  accountsInput: z.string().optional(),
  direction: z.string().optional(),
  memeModelKey: z.string(),
  draftId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: 'Petición de origen no permitida.' }, { status: 403 });
  }

  try {
    const rawBody = await req.json().catch(() => null);
    const parseResult = previewSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Cuerpo de petición no válido.' }, { status: 400 });
    }

    const { campaignType, urlsInput, accountsInput, direction, memeModelKey, draftId } = parseResult.data;
    const PLANNER_VERSION = 1;

    let model;
    try {
      model = resolveImageModel(memeModelKey);
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Modelo de imagen desconocido.' }, { status: 400 });
    }

    let postContent;
    if (campaignType === 'manual') {
      if (!urlsInput) return NextResponse.json({ error: 'Faltan URLs' }, { status: 400 });
      const extractedUrls = parseMultipleXUrls(urlsInput);
      const fetchedPosts = await fetchXPosts([extractedUrls[0]], undefined, PREVIEW_X_TIMEOUT_MS);
      if (fetchedPosts.length === 0) return NextResponse.json({ error: 'Post no encontrado' }, { status: 400 });
      postContent = fetchedPosts[0];
    } else {
      if (!accountsInput) return NextResponse.json({ error: 'Faltan cuentas' }, { status: 400 });
      const normalizedAccounts = normalizeXAccounts(accountsInput);
      const xUserId = await resolveXUsername(normalizedAccounts[0].username, undefined, PREVIEW_X_USER_TIMEOUT_MS);
      const result = await fetchNewXPostsForAccount(xUserId, null, undefined, PREVIEW_X_TIMEOUT_MS, undefined, 1, true);
      if (result.posts.length === 0) return NextResponse.json({ error: 'Cuenta sin posts' }, { status: 400 });
      postContent = result.posts[result.posts.length - 1];
    }

    const config = {
      campaignType,
      sourcePostId: postContent.postId,
      postText: postContent.textContent,
      authorName: postContent.authorName,
      authorUsername: postContent.authorUsername,
      accessibleContext: postContent.accessibleContext,
      direction: direction || 'Sin dirección específica.',
      memeModelKey: model.key,
      plannerVersion: PLANNER_VERSION
    };

    const digestSource = JSON.stringify(config);
    const inputs_digest = createHash('sha256').update(digestSource).digest('hex');

    const txResult = await withTransaction(async (client) => {

      let effectiveDraftId = draftId;
      let previousDigest = null;

      if (effectiveDraftId) {
        const draftLock = await client.query('SELECT id, inputs_digest FROM meme_drafts WHERE id = $1 FOR UPDATE', [effectiveDraftId]);
        if (draftLock.rowCount === 0) {
          effectiveDraftId = undefined;
        } else {
          previousDigest = draftLock.rows[0].inputs_digest;
        }
      }

      if (effectiveDraftId) {
        await client.query(
          `UPDATE meme_drafts SET config = $1, inputs_digest = $2, expires_at = NOW() + INTERVAL '2 hours' WHERE id = $3`,
          [JSON.stringify(config), inputs_digest, effectiveDraftId]
        );
      } else {
        const insertDraft = await client.query(
          `INSERT INTO meme_drafts (config, inputs_digest, status, expires_at)
           VALUES ($1, $2, 'active', NOW() + INTERVAL '2 hours') RETURNING id`,
          [JSON.stringify(config), inputs_digest]
        );
        effectiveDraftId = insertDraft.rows[0].id;
      }

      if (effectiveDraftId && previousDigest === inputs_digest) {
        // Reuse cycle
        const cycleRes = await client.query(`SELECT id, status FROM meme_generation_cycles WHERE draft_id = $1 AND status IN ('pending', 'processing') LIMIT 1`, [effectiveDraftId]);
        if (cycleRes.rowCount! > 0) {
           return NextResponse.json({ success: true, draftId: effectiveDraftId, cycleId: cycleRes.rows[0].id, targetCount: 3, status: cycleRes.rows[0].status });
        }
        // Check if completed 3 previews
        const memesRes = await client.query(`SELECT id FROM memes WHERE draft_id = $1 AND status = 'preview'`, [effectiveDraftId]);
        if (memesRes.rowCount! >= 3) {
           return NextResponse.json({ success: true, draftId: effectiveDraftId, targetCount: 3, status: 'completed' });
        }
      }

      if (previousDigest !== null && previousDigest !== inputs_digest) {
         // Digest changed: Cancel only pending jobs
         await client.query(`UPDATE meme_generation_jobs SET status = 'cancelled' WHERE draft_id = $1 AND status IN ('pending', 'processing')`, [effectiveDraftId]);
         // Cancel previous cycles
         await client.query(`UPDATE meme_generation_cycles SET status = 'cancelled' WHERE draft_id = $1 AND status IN ('pending', 'processing')`, [effectiveDraftId]);
      }

      const insertCycle = await client.query(
        `INSERT INTO meme_generation_cycles
         (campaign_id, draft_id, campaign_post_id, cycle_type, target_count, status, model_key, provider, api_model, planner_version, pricing_snapshot)
         VALUES (NULL, $1, NULL, 'preview', 3, 'pending', $2, $3, $4, $5, '{}'::jsonb) RETURNING id`,
         [effectiveDraftId, model.key, model.provider, model.apiModel, PLANNER_VERSION]
      );
      const cycleId = insertCycle.rows[0].id;

      const assetsRes = await client.query(
        `SELECT id, asset_type, appearance_percentage, instruction, storage_key, mime_type, sha256_hash, width, height
         FROM meme_assets WHERE draft_id = $1 AND status = 'active'`,
        [effectiveDraftId]
      );

      const totalPercentage = assetsRes.rows.reduce((sum, a) => sum + a.appearance_percentage, 0);
      if (totalPercentage > 100) {
         throw new Error('La suma de porcentajes de los assets supera 100%.');
      }

      const availableAssets = assetsRes.rows.map(a => ({
        id: a.id,
        assetType: a.asset_type,
        appearancePercentage: a.appearance_percentage,
        instruction: a.instruction,
        storageKey: a.storage_key,
        mimeType: a.mime_type,
        sha256: a.sha256_hash,
        width: a.width,
        height: a.height
      }));

      const plans = generateDeterministicMemeSlotPlans(null, effectiveDraftId || null, [postContent.postId], 3, availableAssets);

      for (const plan of plans) {
        let assetSnapshot = null;
        if (plan.requiresAsset && plan.assetId) {
          const matched = availableAssets.find(a => a.id === plan.assetId);
          if (matched) assetSnapshot = matched;
        }

        await client.query(
          `INSERT INTO meme_generation_jobs
           (cycle_id, campaign_id, draft_id, campaign_post_id, slot_index, slot_plan, deterministic_dimensions, asset_snapshot, model_snapshot, status, next_attempt_at)
           VALUES ($1, NULL, $2, NULL, $3, $4, $5, $6, $7, 'pending', NOW())`,
          [
            cycleId,
            effectiveDraftId,
            plan.slotIndex,
            JSON.stringify(plan),
            JSON.stringify({}),
            assetSnapshot ? JSON.stringify(assetSnapshot) : null,
            JSON.stringify({ key: model.key, provider: model.provider, model_name: model.apiModel })
          ]
        );
      }

      return NextResponse.json(
        { success: true, draftId: effectiveDraftId, cycleId, targetCount: 3, status: 'pending' },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    });

    const resultData = await txResult.clone().json();
    const finalDraftId = resultData.draftId;

    if (resultData.status !== 'completed' && finalDraftId) {
      try {
        const triggerUrl = new URL('/api/internal/generation/process', req.url).toString();
        const triggerRes = await fetch(triggerUrl, {
          method: 'POST',
          headers: {
            'Authorization': buildInternalProcessAuthorizationHeader(),
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json'
          }
        });
        
        if (!triggerRes.ok) {
          console.error('Internal generation trigger rejected', {
            route: '/api/internal/generation/process',
            status: triggerRes.status,
            draftId: finalDraftId,
            hasInternalProcessSecret: !!process.env.INTERNAL_PROCESS_SECRET,
            hasCronSecret: !!process.env.CRON_SECRET
          });
          return NextResponse.json(
            { error: 'No se pudo iniciar el procesador de memes. Los trabajos quedaron pendientes y pueden reintentarse.' },
            { status: 500, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
          );
        }
      } catch {
        console.error('Internal generation trigger error', {
            route: '/api/internal/generation/process',
            status: 'timeout or network error',
            draftId: finalDraftId,
            hasInternalProcessSecret: !!process.env.INTERNAL_PROCESS_SECRET,
            hasCronSecret: !!process.env.CRON_SECRET
        });
        return NextResponse.json(
          { error: 'No se pudo iniciar el procesador de memes. Los trabajos quedaron pendientes y pueden reintentarse.' },
          { status: 500, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
        );
      }
    }

    return txResult;
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al generar la preview de memes.' },
      { status: 400, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }
    );
  }
}
