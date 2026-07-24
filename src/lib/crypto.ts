import 'server-only';
import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  scryptSync,
} from 'node:crypto';

export function createHmacHash(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateSecureSlug(byteLength = 16): string {
  // Generates url-safe string like 'k8x9q2m4z1p3a7n5'
  return randomBytes(byteLength).toString('hex');
}

export function generateSecureToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

export function verifyScryptPassword(password: string, formattedHash: string): boolean {
  if (!password || !formattedHash || !formattedHash.startsWith('scrypt:')) {
    return false;
  }

  const parts = formattedHash.split(':');
  if (parts.length !== 6) {
    return false;
  }

  const [, costStr, rStr, pStr, saltHex, targetHashHex] = parts;
  const N = parseInt(costStr, 10);
  const r = parseInt(rStr, 10);
  const p = parseInt(pStr, 10);

  if (isNaN(N) || isNaN(r) || isNaN(p) || !saltHex || !targetHashHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const targetHash = Buffer.from(targetHashHex, 'hex');

  try {
    const derivedKey = scryptSync(password, salt, targetHash.length, {
      N,
      r,
      p,
    });
    if (derivedKey.length !== targetHash.length) {
      return false;
    }
    return timingSafeEqual(derivedKey, targetHash);
  } catch {
    return false;
  }
}
