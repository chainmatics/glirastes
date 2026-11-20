import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The declared ranges of zod and pg decide whether an app shares its own copy
 * with the SDK or gets a second one nested under `node_modules/glirastes`.
 * Raising a floor nests a copy for every app below it, so a change to these
 * ranges must be a conscious one: update this test, the install notes in the
 * README and the setup skill, and the changelog together.
 *
 * - zod `^4.0.0`: any zod 4 app shares the copy; a zod 3 app gets a nested
 *   zod 4 for the SDK (schemas are read by shape, so app schemas keep working).
 * - pg `>=8.11 <9`: only the `glirastes-runtime` binary imports pg. 8.11.0 (with
 *   pg-pool 3.6.0) is the verified floor for every Pool option and client event
 *   `src/runtime-service` uses (`connectionString`, `max`,
 *   `connectionTimeoutMillis`, `query_timeout`, `keepAlive`, pool `error`,
 *   `query`, `connect`, `end`, client `query`, `release(true)`, `error`/`end`).
 */
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(SDK_ROOT, 'package.json'), 'utf8')) as Manifest;
}

describe('declared dependency ranges', () => {
  it('pins the zod and pg ranges', async () => {
    const { dependencies = {} } = await manifest();
    expect({ zod: dependencies.zod, pg: dependencies.pg }).toEqual({
      zod: '^4.0.0',
      pg: '>=8.11 <9',
    });
  });

  it('keeps zod and pg regular dependencies, not peers or optional', async () => {
    const { peerDependencies = {}, optionalDependencies = {} } = await manifest();
    for (const name of ['zod', 'pg']) {
      expect(peerDependencies, name).not.toHaveProperty(name);
      expect(optionalDependencies, name).not.toHaveProperty(name);
    }
  });

  it('resolves pg in the lockfile to a version inside the declared range', async () => {
    const lock = await readFile(join(SDK_ROOT, 'bun.lock'), 'utf8');
    const resolved = /"pg": \["pg@(\d+)\.(\d+)\.(\d+)"/.exec(lock);
    expect(resolved, 'pg entry in bun.lock').not.toBeNull();
    const [major, minor] = resolved!.slice(1, 3).map(Number);
    expect(major).toBe(8);
    expect(minor).toBeGreaterThanOrEqual(11);
  });
});
