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

function jobLines(workflow: string, job: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  expect(start, `job ${job}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The `- name:` of each step of one job, in order. */
function jobStepNames(workflow: string, job: string): string[] {
  return jobLines(workflow, job)
    .map((line) => /^ {6}- name: (.+)$/.exec(line)?.[1]?.trim())
    .filter((name): name is string => name !== undefined);
}

/** The text of one named step of one job. */
function jobStep(workflow: string, job: string, name: string): string {
  const lines = jobLines(workflow, job);
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  expect(start, `step ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && /^ {6}- /.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/** A job's `needs:` as a list (`needs: a` or `needs: [a, b]`). */
function jobNeeds(workflow: string, job: string): string[] {
  const line = jobLines(workflow, job).find((l) => /^ {4}needs: /.test(l));
  if (!line) return [];
  return line.replace(/^ {4}needs: /, '').replace(/[[\]]/g, '').split(',').map((n) => n.trim());
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
      'npm install -g npm@11',
      '|',
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run typecheck:tests',
      'bun run build',
      'bun install --frozen-lockfile --cwd examples/react-nest-separate/api',
      'bun install --frozen-lockfile --cwd tests/fixtures/pg-floor',
      'bun run test',
      `npm publish --access public --provenance --tag "$(node -p "['latest', 'next'][Number(require('./package.json').version.includes('-'))]")"`,
    ]);
  });

  it('checks the upgrade notes in a preflight job before the image push and the npm publish', () => {
    const workflow = read('.github/workflows/publish.yml');
    expect(jobStepNames(workflow, 'release-preflight')).toEqual([
      'Checkout',
      'Verify upgrade notes are released for this version',
      'Setup Bun',
      'Install dependencies',
      'Verify the api-surface snapshot matches the source',
    ]);
    // The image is pushed inside runtime-container, so it must wait for the preflight too.
    expect(jobNeeds(workflow, 'runtime-container')).toEqual(['release-preflight']);
    // Local STT stage 1 is a release gate as well; stage 2 (the model) is not.
    expect(jobNeeds(workflow, 'stt-local-addon')).toEqual(['release-preflight']);
    expect(workflow).toContain('uses: ./.github/workflows/stt-local-addon.yml');
    expect(jobNeeds(workflow, 'publish')).toEqual(['release-preflight', 'runtime-container', 'stt-local-addon']);
    expect(workflow).toContain("needs.stt-local-addon.result == 'success'");
    expect(workflow).not.toContain('stt-local-smoke.yml');
    const step = jobStep(workflow, 'release-preflight', 'Verify upgrade notes are released for this version');
    expect(step).toContain('ls upgrade-notes/unreleased/*.json');
    expect(step).toContain('[ ! -f "upgrade-notes/$PKG_VERSION.json" ]');
    expect(step.match(/exit 1/g)).toHaveLength(2);
    expect(jobStep(workflow, 'release-preflight', 'Install dependencies')).toContain('bun install --frozen-lockfile');
    expect(jobStep(workflow, 'release-preflight', 'Verify the api-surface snapshot matches the source'))
      .toContain('bun scripts/api-surface.ts --check');
  });
});

describe('release notes', () => {
  const manifest = JSON.parse(read('package.json')) as { version: string; exports: Record<string, unknown> };
  const changelog = read('CHANGELOG.md');

  const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+(?:-[0-9a-z.]+)?)\] - (Unreleased|\d{4}-\d{2}-\d{2})$/gm)];

  it('opens the CHANGELOG with the package version and a compare link', () => {
    expect(releases[0]?.[1]).toBe(manifest.version);
    expect(changelog).toContain(`\n[${manifest.version}]: https://github.com/chainmatics/glirastes/compare/v${releases[1]![1]}...v${manifest.version}\n`);
  });

  it('keeps the 0.5.0 Foundation notes with their breaking changes', () => {
    const index = releases.findIndex((release) => release[1] === '0.5.0');
    const notes = changelog.slice(releases[index]!.index, releases[index + 1]!.index);
    expect(notes).toContain('\n### Breaking\n');
    for (const deferred of ['server/nestjs', 'openapi', 'react/langgraph']) {
      expect(manifest.exports[`./${deferred}`], deferred).toBeUndefined();
      expect(notes, deferred).toContain(`\`glirastes/${deferred}\``);
    }
  });

  it('describes the Foundation release in the README, not an in-development label', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('in-development Foundation branch');
    expect(readme).toContain('`0.5.0` is the first Foundation release');
  });
});
