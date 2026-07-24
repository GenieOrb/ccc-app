import 'server-only';
import { getConfig } from './config';
import { createHmacHash } from './crypto';
import { queryDb, withTransaction } from './db';

export function extractClientIp(req: Request): string {
  // En Vercel, x-vercel-forwarded-for es seguro y garantizado por la plataforma
  const vercelIp = req.headers.get('x-vercel-forwarded-for');
  if (vercelIp) return vercelIp;

  // Si no está en Vercel, intenta x-forwarded-for o x-real-ip
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const firstIp = xff.split(',')[0].trim();
    if (firstIp) return firstIp;
  }
  const xRealIp = req.headers.get('x-real-ip');
  if (xRealIp?.trim()) {
    return xRealIp.trim();
  }
  return '127.0.0.1'; // Fallback for local development
}

export function computePseudonymizedRateKey(ip: string, actionPrefix: string, windowId: number): string {
  const config = getConfig();
  return createHmacHash(`${actionPrefix}:${ip}:${windowId}`, config.securityHmacSecret);
}

function getWindowId(windowSizeMs: number): number {
  return Math.floor(Date.now() / windowSizeMs);
}

export async function checkAdminLoginRateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const windowSizeMs = 15 * 60 * 1000;
  const windowId = getWindowId(windowSizeMs);
  const rateKeyHash = computePseudonymizedRateKey(ip, 'admin_login', windowId);

  const rows = await queryDb<{ failure_count: number; blocked_until: Date | null }>(
    `SELECT failure_count, blocked_until FROM admin_login_attempts WHERE attempt_key_hash = $1`,
    [rateKeyHash]
  );

  if (rows.length > 0) {
    const record = rows[0];
    if (record.blocked_until && new Date(record.blocked_until) > new Date()) {
      return { allowed: false, remaining: 0 };
    }
    if (record.failure_count >= 5) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: Math.max(0, 5 - record.failure_count) };
  }

  return { allowed: true, remaining: 5 };
}

export async function recordAdminLoginFailure(ip: string): Promise<void> {
  const windowSizeMs = 15 * 60 * 1000;
  const windowId = getWindowId(windowSizeMs);
  const rateKeyHash = computePseudonymizedRateKey(ip, 'admin_login', windowId);
  const now = new Date();
  const blockUntil = new Date(now.getTime() + 15 * 60 * 1000);

  await queryDb(
    `INSERT INTO admin_login_attempts (attempt_key_hash, window_start, failure_count, blocked_until, updated_at)
     VALUES ($1, $2, 1, NULL, $2)
     ON CONFLICT (attempt_key_hash) DO UPDATE SET
       failure_count = admin_login_attempts.failure_count + 1,
       blocked_until = CASE WHEN admin_login_attempts.failure_count + 1 >= 5 THEN $3 ELSE admin_login_attempts.blocked_until END,
       updated_at = $2`,
    [rateKeyHash, now, blockUntil]
  );
}

export async function clearAdminLoginFailures(ip: string): Promise<void> {
  const windowSizeMs = 15 * 60 * 1000;
  const windowId = getWindowId(windowSizeMs);
  const rateKeyHash = computePseudonymizedRateKey(ip, 'admin_login', windowId);
  await queryDb(`DELETE FROM admin_login_attempts WHERE attempt_key_hash = $1`, [rateKeyHash]);
}

export async function checkPublicAssignmentRateLimit(ip: string): Promise<{ allowed: boolean }> {
  const windowSizeMs = 15 * 60 * 1000;
  const windowId = getWindowId(windowSizeMs);
  const rateKeyHash = computePseudonymizedRateKey(ip, 'public_assignment', windowId);
  const now = new Date();

  return await withTransaction(async (client) => {
    // Clean up old rate limit windows occasionally (older than 1 hour)
    await client.query(
      `DELETE FROM public_assignment_rate_limits WHERE updated_at < NOW() - INTERVAL '1 hour'`
    );

    const res = await client.query<{ request_count: number; blocked_until: Date | null }>(
      `INSERT INTO public_assignment_rate_limits (rate_key_hash, window_start, request_count, updated_at)
       VALUES ($1, $2, 1, $2)
       ON CONFLICT (rate_key_hash) DO UPDATE SET
         request_count = public_assignment_rate_limits.request_count + 1,
         updated_at = $2
       RETURNING request_count, blocked_until`,
      [rateKeyHash, now]
    );

    const record = res.rows[0];
    if (record.blocked_until && new Date(record.blocked_until) > now) {
      return { allowed: false };
    }
    if (record.request_count > 30) {
      // Only set blocked_until if it wasn't already blocked and count exceeded
      if (!record.blocked_until) {
        const blockUntil = new Date(now.getTime() + 15 * 60 * 1000);
        await client.query(
          `UPDATE public_assignment_rate_limits SET blocked_until = $1 WHERE rate_key_hash = $2`,
          [blockUntil, rateKeyHash]
        );
      }
      return { allowed: false };
    }

    return { allowed: true };
  });
}
