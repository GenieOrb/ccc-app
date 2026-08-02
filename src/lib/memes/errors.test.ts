import { describe, it, expect } from 'vitest';
import { classifyMemeProviderError } from './errors';

describe('classifyMemeProviderError', () => {
  it('classifies 403 OpenAI gpt-image-2 error as permanent with sanitized message', () => {
    const error = new Error('Acceso denegado a modelo de imagen OpenAI: gpt-image-2 (403)');
    const result = classifyMemeProviderError(error);

    expect(result.isPermanent).toBe(true);
    expect(result.sanitizedMessage).toBe('La clave de OpenAI configurada no tiene acceso a gpt-image-2.');
    expect(result.statusCode).toBe(403);
  });

  it('classifies 400 unknown parameter error as permanent', () => {
    const error = new Error('400 Unknown parameter: response_format');
    const result = classifyMemeProviderError(error);

    expect(result.isPermanent).toBe(true);
    expect(result.statusCode).toBe(400);
  });

  it('classifies missing apiModel as permanent with user-friendly message', () => {
    const error = new Error('Invalid meme model snapshot: apiModel is missing');
    const result = classifyMemeProviderError(error);

    expect(result.isPermanent).toBe(true);
    expect(result.sanitizedMessage).toBe('No se pudo recuperar el modelo de imagen asociado al trabajo.');
  });

  it('classifies 429 rate limit as transient error', () => {
    const error = new Error('Rate limit excedido en modelo de imagen Google (429)');
    const result = classifyMemeProviderError(error);

    expect(result.isPermanent).toBe(false);
    expect(result.statusCode).toBe(429);
  });

  it('classifies 500 server error as transient', () => {
    const error = new Error('Internal Server Error 500');
    const result = classifyMemeProviderError(error);

    expect(result.isPermanent).toBe(false);
    expect(result.statusCode).toBe(500);
  });
});
