import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { queryDb, withTransaction } from '@/lib/db';
import { del } from '@vercel/blob';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  assetType: z.enum(['logo', 'mascot', 'product', 'fictional_character', 'object', 'other']),
  percentage: z.number().int().min(0).max(100),
  instruction: z.string().max(500).optional().default(''),
});

export async function PATCH(req: Request, props: { params: Promise<{ draftId: string, assetId: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: 'Petición de origen no permitida.' }, { status: 403 });
  }

  const { draftId, assetId } = await props.params;

  const rawBody = await req.json().catch(() => null);
  const parseResult = patchSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json({ error: 'Datos no válidos.', details: parseResult.error.format() }, { status: 400 });
  }

  const { assetType, percentage, instruction } = parseResult.data;

  try {
    const asset = await withTransaction(async (client) => {
      // Bloquear los assets activos del draft con FOR UPDATE
      const assetsRes = await client.query(
        `SELECT id, appearance_percentage FROM meme_assets WHERE draft_id = $1 AND status = 'active' FOR UPDATE`,
        [draftId]
      );

      const targetAsset = assetsRes.rows.find((a: { id: string }) => a.id === assetId);
      if (!targetAsset) {
        throw new Error('Asset no encontrado.');
      }

      let sum = percentage;
      for (const row of assetsRes.rows) {
        if (row.id !== assetId) {
          sum += row.appearance_percentage;
        }
      }

      if (sum > 100) {
        throw new Error('La suma de los porcentajes supera el 100%.');
      }

      const updateRes = await client.query(
        `UPDATE meme_assets
         SET asset_type = $1, appearance_percentage = $2, instruction = $3
         WHERE id = $4 AND draft_id = $5
         RETURNING *`,
        [assetType, percentage, instruction, assetId, draftId]
      );

      return updateRes.rows[0];
    });

    return NextResponse.json({ success: true, asset });
  } catch (error: unknown) {
    const dbErr = error as { code?: string; message?: string };
    if (dbErr.code === '23514') {
      return NextResponse.json({ error: 'Error de validación de base de datos.' }, { status: 400 });
    }
    if (dbErr.message === 'Asset no encontrado.') {
      return NextResponse.json({ error: dbErr.message }, { status: 404 });
    }
    if (dbErr.message === 'La suma de los porcentajes supera el 100%.') {
      return NextResponse.json({ error: dbErr.message }, { status: 400 });
    }
    console.error('Error updating asset:', error);
    return NextResponse.json({ error: 'Error al actualizar asset' }, { status: 500 });
  }
}

export async function DELETE(req: Request, props: { params: Promise<{ draftId: string, assetId: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  if (!validateSameOrigin(req)) {
    return NextResponse.json({ error: 'Petición de origen no permitida.' }, { status: 403 });
  }

  const { draftId, assetId } = await props.params;

  try {
    // Verificamos pertenencia y storage_key
    const assetRes = await queryDb<{ id: string, storage_key: string, storage_url: string }>(
      `SELECT id, storage_key, storage_url FROM meme_assets WHERE id = $1 AND draft_id = $2`,
      [assetId, draftId]
    );

    if (assetRes.length === 0) {
      return NextResponse.json({ error: 'Asset no encontrado.' }, { status: 404 });
    }

    const asset = assetRes[0];

    // Verificar referencias: jobs, memes
    const jobRes = await queryDb(`SELECT 1 FROM meme_generation_jobs WHERE asset_snapshot->>'id' = $1 LIMIT 1`, [assetId]);
    const memeRes = await queryDb(`SELECT 1 FROM memes WHERE asset_id = $1 LIMIT 1`, [assetId]);

    const hasReferences = jobRes.length > 0 || memeRes.length > 0;

    if (hasReferences) {
      // Borrado lógico
      await queryDb(
        `UPDATE meme_assets SET status = 'retired', retired_at = NOW() WHERE id = $1 AND draft_id = $2`,
        [assetId, draftId]
      );
    } else {
      // Borrado físico
      const storageKey = asset.storage_key || asset.storage_url;
      try {
        await del(storageKey, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch (e) {
        console.error('Blob delete error', e);
      }

      await queryDb(
        `DELETE FROM meme_assets WHERE id = $1 AND draft_id = $2`,
        [assetId, draftId]
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Error deleting asset:', error);
    return NextResponse.json({ error: 'Error al eliminar el asset' }, { status: 500 });
  }
}
