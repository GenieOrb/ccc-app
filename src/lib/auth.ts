import 'server-only';
import { cookies } from 'next/headers';
import { getConfig } from './config';
import { createHmacHash, safeCompareStrings, verifyScryptPassword } from './crypto';

const ADMIN_COOKIE_NAME = '__comment_app_admin_session';

export interface AdminSession {
  authenticated: boolean;
  issuedAt: number;
}

export function createSessionToken(): string {
  const config = getConfig();
  const timestamp = Date.now();
  const payload = `admin:${timestamp}`;
  const signature = createHmacHash(payload, config.adminSessionSecret);
  return `${payload}:${signature}`;
}

export function verifySessionToken(token: string): AdminSession | null {
  if (!token || typeof token !== 'string') return null;
  const config = getConfig();
  const parts = token.split(':');
  if (parts.length !== 3 || parts[0] !== 'admin') return null;

  const timestamp = parseInt(parts[1], 10);
  const signature = parts[2];
  if (isNaN(timestamp)) return null;

  // Check 8-hour expiry
  const maxAgeMs = 8 * 60 * 60 * 1000;
  if (Date.now() - timestamp > maxAgeMs) {
    return null;
  }

  const expectedPayload = `admin:${timestamp}`;
  const expectedSignature = createHmacHash(expectedPayload, config.adminSessionSecret);

  if (safeCompareStrings(signature, expectedSignature)) {
    return { authenticated: true, issuedAt: timestamp };
  }
  return null;
}

export async function setAdminSessionCookie(): Promise<void> {
  const token = createSessionToken();
  const cookieStore = await cookies();
  const isProd = process.env.NODE_ENV === 'production';

  cookieStore.set(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 60 * 60, // 8 hours
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_COOKIE_NAME);
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!token) return false;
  return verifySessionToken(token) !== null;
}

export function validateAdminPassword(password: string): boolean {
  const config = getConfig();
  if (!config.adminPasswordHash) {
    throw new Error('ADMIN_PASSWORD_HASH environment variable is missing.');
  }
  return verifyScryptPassword(password, config.adminPasswordHash);
}

export function validateSameOrigin(req: Request): boolean {
  const host = req.headers.get('host');
  if (!host) return false;

  try {
    const expectedUrl = new URL(getConfig().appBaseUrl);
    
    // The Host header must strictly match our application's configured host
    if (host !== expectedUrl.host) return false;

    const origin = req.headers.get('origin');
    if (!origin) {
      // If browser omits origin on GET or standard navigation, allow if sec-fetch-site is same-origin
      const fetchSite = req.headers.get('sec-fetch-site');
      return fetchSite === 'same-origin' || fetchSite === 'none' || fetchSite === null;
    }

    const originUrl = new URL(origin);
    return originUrl.host === expectedUrl.host && originUrl.protocol === expectedUrl.protocol;
  } catch {
    return false;
  }
}
