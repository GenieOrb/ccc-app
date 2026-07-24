import 'server-only';
import { cookies } from 'next/headers';
import { getConfig } from './config';
import { createHmacHash, generateSecureToken, safeCompareStrings } from './crypto';

const VISITOR_COOKIE_NAME = '__comment_app_vid';

export interface VisitorIdentification {
  rawId: string;
  visitorHash: string;
  isNew: boolean;
  signedCookieValue: string;
}

export function signVisitorId(rawId: string): string {
  const config = getConfig();
  const signature = createHmacHash(`visitor:${rawId}`, config.visitorCookieSecret);
  return `vid.${rawId}.${signature}`;
}

export function parseAndVerifyVisitorCookie(cookieValue?: string | null): string | null {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 3 || parts[0] !== 'vid') return null;

  const rawId = parts[1];
  const signature = parts[2];
  if (!rawId || !signature) return null;

  const expectedSignature = createHmacHash(`visitor:${rawId}`, getConfig().visitorCookieSecret);
  if (safeCompareStrings(signature, expectedSignature)) {
    return rawId;
  }
  return null;
}

export function computeVisitorDbHash(rawId: string): string {
  const config = getConfig();
  return createHmacHash(`db_visitor:${rawId}`, config.securityHmacSecret);
}

export async function getOrCreateVisitorIdentity(): Promise<VisitorIdentification> {
  const cookieStore = await cookies();
  const existingCookie = cookieStore.get(VISITOR_COOKIE_NAME)?.value;
  const verifiedRawId = parseAndVerifyVisitorCookie(existingCookie);

  if (verifiedRawId) {
    return {
      rawId: verifiedRawId,
      visitorHash: computeVisitorDbHash(verifiedRawId),
      isNew: false,
      signedCookieValue: existingCookie!,
    };
  }

  // Create new visitor token (256-bit random)
  const newRawId = generateSecureToken(32);
  const signedCookieValue = signVisitorId(newRawId);
  const isProd = process.env.NODE_ENV === 'production';

  cookieStore.set(VISITOR_COOKIE_NAME, signedCookieValue, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60, // 1 year
  });

  return {
    rawId: newRawId,
    visitorHash: computeVisitorDbHash(newRawId),
    isNew: true,
    signedCookieValue,
  };
}
