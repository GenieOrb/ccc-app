import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const vercelConfigPath = resolve(process.cwd(), 'vercel.json');

describe('Vercel configuration', () => {
  it('does not configure a global cron while dynamic scheduling is unavailable', async () => {
    const config = JSON.parse(await readFile(vercelConfigPath, 'utf8')) as {
      crons?: unknown;
    };

    expect(config.crons).toBeUndefined();
  });
});
