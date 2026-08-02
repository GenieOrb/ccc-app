import 'server-only';
import { put, del, head } from '@vercel/blob';
import { createHash } from 'node:crypto';

export interface BlobUploadResult {
  url: string;
  pathname: string;
  contentType: string;
  sizeBytes: number;
  sha256Hash: string;
}

export async function uploadMemeAsset(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<BlobUploadResult> {
  const sha256Hash = createHash('sha256').update(buffer).digest('hex');
  const uniqueFilename = `${sha256Hash.substring(0, 12)}-${filename}`;

  // Store assets in a specific prefix for memes
  const blob = await put(`memes/assets/${uniqueFilename}`, buffer, {
    access: 'public',
    contentType,
  });

  return {
    url: blob.url,
    pathname: blob.pathname,
    contentType,
    sizeBytes: buffer.byteLength,
    sha256Hash,
  };
}

export async function uploadGeneratedMeme(
  buffer: Buffer,
  contentType: string
): Promise<BlobUploadResult> {
  const sha256Hash = createHash('sha256').update(buffer).digest('hex');
  const filename = `${sha256Hash}.png`;

  // Store generated memes in their prefix
  const blob = await put(`memes/generated/${filename}`, buffer, {
    access: 'public',
    contentType,
  });

  return {
    url: blob.url,
    pathname: blob.pathname,
    contentType,
    sizeBytes: buffer.byteLength,
    sha256Hash,
  };
}

export async function deleteBlob(pathname: string): Promise<void> {
  try {
    await del(pathname);
  } catch (error) {
    console.error(`Failed to delete blob ${pathname}:`, error);
  }
}

export async function getBlobMetadata(url: string) {
  try {
    return await head(url);
  } catch (error) {
    console.error(`Failed to head blob ${url}:`, error);
    return null;
  }
}
