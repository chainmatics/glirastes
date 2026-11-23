import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The `glirastes-runtime` binary imports pg. Vitest's loader accepts named
 * imports from CommonJS that plain Node refuses (pg has an ESM entry with named
 * exports only since 8.15.0), so this runs the BUILT service import under plain
 * `node` in a child process: once against pg at the floor of the declared range
 * (`tests/fixtures/pg-floor`, pg 8.11.0 with pg-pool 3.6.0, installed by CI with
 * `bun install --frozen-lockfile --cwd tests/fixtures/pg-floor`) and once
 * against the repository's lockfile version.
 */
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR = join(SDK_ROOT, 'tests', 'fixtures', 'pg-floor');
const SERVICE = pathToFileURL(join(SDK_ROOT, 'dist', 'runtime-service', 'service.js')).href;
const CHILD = join(SDK_ROOT, 'tests', 'support', 'pg-import-child.mjs');

function importService(nodeArgs: string[]): { pg: string } {
  const output = execFileSync(process.execPath, [...nodeArgs, CHILD, SERVICE], {
    cwd: SDK_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return JSON.parse(output.trim().split('\n').at(-1)!) as { pg: string };
}

describe('the runtime service imports pg under plain Node', () => {
  it('has a built service and the floor fixture installed', () => {
    expect(existsSync(fileURLToPath(SERVICE)), 'run `bun run build` first').toBe(true);
    expect(
      existsSync(join(FLOOR, 'node_modules', 'pg', 'package.json')),
      'run `bun install --frozen-lockfile --cwd tests/fixtures/pg-floor` first',
    ).toBe(true);
  });

  it('with pg 8.11.0 and pg-pool 3.6.0, the floor of the declared range', () => {
    const version = (name: string) =>
      (JSON.parse(readFileSync(join(FLOOR, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
    expect({ pg: version('pg'), 'pg-pool': version('pg-pool') }).toEqual({ pg: '8.11.0', 'pg-pool': '3.6.0' });
    expect(importService(['--import', pathToFileURL(join(FLOOR, 'use-floor-pg.mjs')).href])).toEqual({ pg: '8.11.0' });
  });

  it('with the pg version of the lockfile', () => {
    const lock = readFileSync(join(SDK_ROOT, 'bun.lock'), 'utf8');
    const locked = /"pg": \["pg@(\d+\.\d+\.\d+)"/.exec(lock)?.[1];
    expect(locked).toBeDefined();
    expect(importService([])).toEqual({ pg: locked });
  });
});
