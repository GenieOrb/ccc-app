import 'server-only';

/**
 * Safely normalizes a stored JSON object.
 * PostgreSQL driver `pg` can return JSONB columns as parsed JS objects.
 * Calling `JSON.parse` directly on an object will fail with a SyntaxError (`[object Object] is not valid JSON`).
 * This helper handles both pre-parsed JS objects and JSON strings.
 */
export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    const parsed = JSON.parse(value);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  throw new Error('Invalid stored JSON object');
}
