import 'server-only';
import { cookies } from 'next/headers';
import { getConfig } from './config';
import { createHmacHash, safeCompareStrings, verifyScryptPassword } from './crypto';

const ADMIN_COOKIE_NAME = '__comment_app_admin_session';
const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function adminCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
  };
}

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
  const maxAgeMs = ADMIN_SESSION_MAX_AGE_SECONDS * 1000;
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
  cookieStore.set(ADMIN_COOKIE_NAME, token, {
    ...adminCookieOptions(),
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  // Match every attribute used when issuing the cookie. Relying on delete()
  // defaults can leave a path-scoped session cookie alive in some runtimes.
  cookieStore.set(ADMIN_COOKIE_NAME, '', {
    ...adminCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!token) return false;
  if (!verifySessionToken(token)) return false;

  // Sliding, persistent session: every authenticated server request refreshes
  // both the signed timestamp and the browser persistence window.
  // Server Components expose a read-only cookie store. API handlers can renew
  // the cookie; rendering an admin page must still be able to authenticate.
  try {
    await setAdminSessionCookie();
  } catch {
    // The already-verified session remains valid; the next mutable request
    // will renew it.
  }
  return true;
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
