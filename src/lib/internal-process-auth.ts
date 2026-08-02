import { getConfig } from './config';
import { safeCompareStrings } from './crypto';

/**
 * Resuelve y devuelve el primer secreto válido (INTERNAL_PROCESS_SECRET preferente, CRON_SECRET como fallback).
 * Solo para uso de clientes internos que necesiten disparar el endpoint.
 */
export function getInternalProcessSecret(): string | null {
  const config = getConfig();
  if (config.internalProcessSecret) return config.internalProcessSecret;
  if (config.cronSecret) return config.cronSecret;
  return null;
}

/**
 * Construye la cabecera Authorization: Bearer <secret>.
 * Lanza un error si no hay secretos configurados.
 */
export function buildInternalProcessAuthorizationHeader(): string {
  const secret = getInternalProcessSecret();
  if (!secret) {
    throw new Error('No hay secreto interno o cron configurado para la autenticación.');
  }
  return `Bearer ${secret}`;
}

/**
 * Valida si la Request tiene una cabecera de Authorization con un token válido.
 * Utiliza crypto.timingSafeEqual (vía safeCompareStrings) para evitar timing attacks.
 * Acepta tanto INTERNAL_PROCESS_SECRET como CRON_SECRET.
 */
export function isAuthorizedInternalProcessRequest(req: Request): boolean {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7).trim();
  const config = getConfig();

  if (!token || (!config.internalProcessSecret && !config.cronSecret)) {
    return false;
  }

  const isValidInternal = config.internalProcessSecret ? safeCompareStrings(token, config.internalProcessSecret) : false;
  const isValidCron = config.cronSecret ? safeCompareStrings(token, config.cronSecret) : false;

  return isValidInternal || isValidCron;
}
