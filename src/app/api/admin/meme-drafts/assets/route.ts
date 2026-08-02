import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { queryDb } from '@/lib/db';
import { put, del } from '@vercel/blob';
import sharp from 'sharp';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Max allowed for Vercel Hobby is 60 (for pro 300)

const MAX_SIZE_BYTES = 4 * 1024 * 1024; // 4MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function POST(req: Request) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  const isSameOrigin = validateSameOrigin(req);
  if (!isSameOrigin) {
    return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    let draftId = formData.get('draftId') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: 'File exceeds 4MB limit' }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Invalid file type. Only JPEG, PNG, and WebP are allowed' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const originalBuffer = Buffer.from(arrayBuffer);
    
    // Sharp validation and sanitization
    let processedBuffer;
    try {
      const img = sharp(originalBuffer);
      const metadata = await img.metadata();
      
      if (!metadata.width || !metadata.height) {
        throw new Error('Invalid image dimensions');
      }

      if (metadata.width * metadata.height > 20000000) { // ~20MP
        throw new Error('Image dimensions exceed 20MP limit');
      }

      // Re-encode as PNG to strip EXIF and normalize
      processedBuffer = await img
        .rotate() // auto-rotate based on EXIF before stripping
        .png({ force: true })
        .toBuffer();
    } catch {
      return NextResponse.json({ error: 'La imagen subida está corrupta o no es válida.' }, { status: 400 });
    }

    const finalSize = processedBuffer.length;
    if (finalSize > MAX_SIZE_BYTES) {
       return NextResponse.json({ error: 'Processed file exceeds 4MB limit' }, { status: 400 });
    }

    const sha256 = crypto.createHash('sha256').update(processedBuffer).digest('hex');

    // Handle DB draft ID
    if (!draftId) {
      const draftRes = await queryDb<{ id: string }>(
        `INSERT INTO meme_drafts (status, expires_at) VALUES ('active', NOW() + INTERVAL '2 hours') RETURNING id`
      );
      draftId = draftRes[0].id;
    }

    // Upload to Vercel Blob
    // We append the extension .png since we re-encoded it
    const filename = `${draftId}-${Date.now()}.png`;
    
    let blobResult;
    try {
      // For private visibility, Vercel Blob doesn't have an explicit 'private' access property in all plans,
      // but passing a token ensures only we can upload. The random suffix makes it unguessable.
      blobResult = await put(filename, processedBuffer, {
        access: 'public', // 'public' is required by Vercel Blob unless using advanced features
        token: process.env.BLOB_READ_WRITE_TOKEN,
        contentType: 'image/png'
      });
    } catch (e: unknown) {
      console.error('Blob upload error', e);
      return NextResponse.json({ error: 'Failed to upload to blob storage' }, { status: 500 });
    }

    const finalMetadata = await sharp(processedBuffer).metadata();

    try {
      // Insert into DB
      const assetRes = await queryDb<{ id: string }>(
        `INSERT INTO meme_assets (
          draft_id, asset_type, appearance_percentage, instruction, 
          storage_provider, storage_key, storage_url, mime_type, 
          size_bytes, width, height, sha256_hash, status
        ) VALUES (
          $1, 'other', 10, '', 'vercel-blob', $2, $3, 'image/png', $4, $5, $6, $7, 'active'
        ) RETURNING id`,
        [
          draftId,
          blobResult.pathname,
          blobResult.url,
          finalSize,
          finalMetadata.width,
          finalMetadata.height,
          sha256
        ]
      );
      
      return NextResponse.json({
        assetId: assetRes[0].id,
        draftId,
        url: blobResult.url // used temporarily for preview in admin
      });
    } catch (e: unknown) {
      // Rollback Blob upload on DB failure
      await del(blobResult.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
      console.error('DB insert error', e);
      return NextResponse.json({ error: 'Failed to save asset metadata' }, { status: 500 });
    }

  } catch (error: unknown) {
    console.error('Asset upload error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
