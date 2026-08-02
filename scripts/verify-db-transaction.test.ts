import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve(process.cwd(), 'scripts', 'verify-db-transaction.mjs');

describe('verify-db-transaction safety gate', () => {
  it('refuses before loading DATABASE_URL unless explicitly authorized', () => {
    const safeEnvironment = { ...process.env };
    delete safeEnvironment.DATABASE_URL;
    delete safeEnvironment.GENIEORB_ALLOW_TRANSACTIONAL_NEON_TEST;
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: safeEnvironment,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GENIEORB_ALLOW_TRANSACTIONAL_NEON_TEST=1');
  });
});
