import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('production package manifest', () => {
  it('ships pg as a runtime dependency while keeping its types as development-only', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageManifest;

    expect(manifest.dependencies?.pg).toBeDefined();
    expect(manifest.devDependencies?.pg).toBeUndefined();
    expect(manifest.devDependencies?.['@types/pg']).toBeDefined();
  });
});
