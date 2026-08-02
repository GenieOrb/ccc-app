import 'server-only';
import { put, del, head, get } from '@vercel/blob';
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
    access: 'private',
    contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
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
    access: 'private',
    contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
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
    await del(pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (error) {
    console.error(`Failed to delete blob ${pathname}:`, error);
  }
}

export async function getBlobMetadata(url: string) {
  try {
    return await head(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (error) {
    console.error(`Failed to head blob ${url}:`, error);
    return null;
  }
}

export async function getMemeBlobStream(pathname: string) {
  const result = await get(pathname, {
    access: 'private',
    token: process.env.BLOB_READ_WRITE_TOKEN,
    useCache: false
  });
  if (!result || result.statusCode === 304 || !result.stream) {
    throw new Error(`Blob no encontrado o respuesta vacía para: ${pathname}`);
  }
  return { stream: result.stream, contentType: result.blob.contentType, size: result.blob.size };
}

export async function getMemeBlobBuffer(pathname: string): Promise<Buffer> {
  const { stream } = await getMemeBlobStream(pathname);
  
  // Convert ReadableStream to Buffer
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}
