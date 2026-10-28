import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Release gates that live outside the TypeScript sources: the test type check
 * must not depend on a built `dist/`, CI must run it, and the publish workflow
 * must run the same gates in an order that can pass (the suite needs `dist/`
 * and the NestJS fixture API's own dependencies).
 */
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(SDK_ROOT, path), 'utf8');

interface ExportTarget {
  types?: string;
  import?: { types?: string };
}

/** `glirastes/<subpath>` → the source file whose declarations the export ships. */
function sourceOfEveryExport(): Record<string, string[]> {
  const manifest = JSON.parse(read('package.json')) as { exports: Record<string, ExportTarget> };
  const mapping: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const types = target.import?.types ?? target.types;
    if (types === undefined) continue; // ./react/styles.css
    const specifier = subpath === '.' ? 'glirastes' : `glirastes/${subpath.slice(2)}`;
    mapping[specifier] = [types.replace('./dist/', './src/').replace(/\.d\.ts$/, '.ts')];
  }
  return mapping;
}

/** The `run:` commands of one job, in order (the workflows use two-space job indentation). */
function jobRuns(workflow: string, job: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  expect(start, `job ${job}`).toBeGreaterThan(-1);
  const runs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    const run = /^\s+(?:- )?run: (.+)$/.exec(line);
    if (run) runs.push(run[1]!.trim());
  }
  return runs;
}

describe('release workflows', () => {
  it('type-checks the tests against the sources, not a built dist', () => {
    const config = JSON.parse(read('tsconfig.test.json')) as {
      compilerOptions: { paths?: Record<string, string[]> };
    };
    expect(config.compilerOptions.paths).toEqual(sourceOfEveryExport());
  });

  it('runs the test type check in CI', () => {
    expect(jobRuns(read('.github/workflows/ci.yml'), 'typecheck')).toEqual([
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run typecheck:tests',
    ]);
  });

  it('publishes only after the CI gates, with the build before the tests', () => {
    expect(jobRuns(read('.github/workflows/publish.yml'), 'publish')).toEqual([
      'npm install -g npm@latest',
      '|',
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run typecheck:tests',
      'bun run build',
      'bun install --frozen-lockfile --cwd examples/react-nest-separate/api',
      'bun run test',
      'npm publish --access public --provenance',
    ]);
  });
});
