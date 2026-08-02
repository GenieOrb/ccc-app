import 'server-only';

export interface ClassifiedError {
  isPermanent: boolean;
  sanitizedMessage: string;
  originalMessage: string;
  statusCode?: number;
}

export function classifyMemeProviderError(error: unknown): ClassifiedError {
  const originalMessage = error instanceof Error ? error.message : String(error);
  const lowerMsg = originalMessage.toLowerCase();

  // Extract HTTP status code if present
  const statusMatch = originalMessage.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
  const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

  // 1. Permanent Errors
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lowerMsg.includes('acceso denegado') ||
    lowerMsg.includes('access denied') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('forbidden')
  ) {
    if (lowerMsg.includes('gpt-image-2') || lowerMsg.includes('openai')) {
      return {
        isPermanent: true,
        sanitizedMessage: 'La clave de OpenAI configurada no tiene acceso a gpt-image-2.',
        originalMessage,
        statusCode: 403
      };
    }
    return {
      isPermanent: true,
      sanitizedMessage: 'Acceso denegado al modelo de imagen configurado.',
      originalMessage,
      statusCode: statusCode || 403
    };
  }

  if (
    statusCode === 400 ||
    statusCode === 404 ||
    lowerMsg.includes('unknown parameter') ||
    lowerMsg.includes('unknown image model') ||
    lowerMsg.includes('invalid meme model snapshot') ||
    lowerMsg.includes('apimodel is missing') ||
    lowerMsg.includes('content policy') ||
    lowerMsg.includes('rechazo de contenido')
  ) {
    return {
      isPermanent: true,
      sanitizedMessage: lowerMsg.includes('apimodel is missing')
        ? 'No se pudo recuperar el modelo de imagen asociado al trabajo.'
        : 'Parámetro o modelo no soportado por el proveedor de imágenes.',
      originalMessage,
      statusCode: statusCode || 400
    };
  }

  // 2. Transient Errors (408, 429, 5xx, timeouts, network issues)
  if (
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('fetch failed')
  ) {
    return {
      isPermanent: false,
      sanitizedMessage: 'Error temporal del proveedor de imágenes. Reintentando...',
      originalMessage,
      statusCode
    };
  }

  // Default: treat unclassified errors after max attempts as permanent failures
  return {
    isPermanent: false,
    sanitizedMessage: originalMessage.slice(0, 200),
    originalMessage,
    statusCode
  };
}
