import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteSourceFingerprint } from '../codegen/route-fingerprint.js';
import { FoundationDiagnosticError } from '../diagnostics/foundation-diagnostic.js';
import { runCli } from './index.js';

const ROUTE_SOURCE = 'export async function GET() { return Response.json([]); }\n';
const ROUTE_FINGERPRINT = createRouteSourceFingerprint(
  ROUTE_SOURCE,
  'GET',
  '/api/tasks',
);

const APP_ID = '019fb007-0000-7000-8000-000000000001';
const digest = (value: string) => `sha256:${createHash('sha256')
  .update(value)
  .digest('base64url')}`;

function workspace(overrides: {
  inventory?: unknown;
  promptBundle?: unknown;
  setupArtifact?: unknown;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'glirastes-validate-'));
  mkdirSync(join(root, '.glirastes'), { recursive: true });
  mkdirSync(join(root, 'src/app/api/tasks'), { recursive: true });
  writeFileSync(join(root, 'src/app/api/tasks/route.ts'), ROUTE_SOURCE, 'utf8');

  const inventory = overrides.inventory ?? {
    schemaVersion: 2,
    targetAppKey: 'fixture-app',
    executions: [{
      toolId: '019fb007-0000-7000-8000-00000000000a',
      definitionId: 'tasks.list',
      stableKey: 'GET /api/tasks',
      executionKind: 'endpoint',
      sourceFingerprint: ROUTE_FINGERPRINT,
      inputSchemaDigest: digest('input'),
      outputSchemaDigest: digest('output'),
      sourceFile: 'src/app/api/tasks/route.ts',
      method: 'GET',
      path: '/api/tasks',
    }],
  };
  writeFileSync(
    join(root, '.glirastes/foundation-execution-inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
    'utf8',
  );

  const sections = {
    planner: 'Plan carefully.',
    appBehavior: 'Manage tasks.',
    responseStyle: 'Answer briefly.',
  };
  const promptBundle = overrides.promptBundle ?? {
    schemaVersion: 1,
    appId: APP_ID,
    artifactRef: 'local://artifacts/prompt-bundle',
    sections,
  };
  writeFileSync(
    join(root, '.glirastes/prompt-bundle.json'),
    `${JSON.stringify(promptBundle, null, 2)}\n`,
    'utf8',
  );
  if (overrides.setupArtifact) {
    writeFileSync(
      join(root, '.glirastes/setup-artifact.json'),
      `${JSON.stringify(overrides.setupArtifact, null, 2)}\n`,
      'utf8',
    );
  }
  return root;
}

const readManifest = (root: string, name: string) => JSON.parse(
  readFileSync(resolve(root, '.glirastes/build', name), 'utf8'),
);

describe('glirastes validate', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('accepts a complete local workspace without any network access', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const root = workspace();

    await runCli(['validate', '--root', root, '--app-id', APP_ID, '--quiet']);

    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects an existing setup artifact with incomplete curated semantics', async () => {
    const root = workspace({
      setupArtifact: {
        schemaVersion: 1,
        artifactId: randomUUID(),
        runId: randomUUID(),
        appId: APP_ID,
        discoveryDigest: digest('stale'),
        assessmentMode: 'autonomous',
        status: 'ready',
        tools: [{
          toolId: '019fb007-0000-7000-8000-00000000000a',
          sourceFingerprint: ROUTE_FINGERPRINT,
          name: 'tasks.list',
          executionKind: 'endpoint',
          operationGroup: 'read',
          riskClass: 'safe-read',
          enabled: true,
          requiresApproval: false,
          inputSchemaDigest: digest('input'),
          outputSchemaDigest: digest('output'),
        }],
        planner: {
          plannerId: randomUUID(),
          modelBindingRef: 'balanced',
          promptBindingRef: 'prompt:fixture',
          budgetProfileRef: 'foundation-default',
          toolIds: ['019fb007-0000-7000-8000-00000000000a'],
        },
        prompts: {
          bundleDigest: digest('bundle'),
          artifactRef: 'local://fixture/prompts',
          plannerDigest: digest('planner'),
          appBehaviorDigest: digest('behavior'),
          responseStyleDigest: digest('style'),
          capabilityFragmentDigests: {},
        },
        warnings: [],
        generatedAt: '2026-08-13T10:00:00.000Z',
      },
    });

    await expect(runCli([
      'validate', '--root', root, '--app-id', APP_ID, '--quiet',
    ])).rejects.toThrow('incomplete curated semantics');
  });

  it('rejects an inventory whose source file no longer exists', async () => {
    const root = workspace({
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture-app',
        executions: [{
          toolId: '019fb007-0000-7000-8000-00000000000a',
          definitionId: 'tasks.list',
          stableKey: 'GET /api/tasks',
          executionKind: 'endpoint',
          sourceFingerprint: digest('route'),
          inputSchemaDigest: digest('input'),
          outputSchemaDigest: digest('output'),
          sourceFile: 'src/app/api/missing/route.ts',
          method: 'GET',
          path: '/api/missing',
        }],
      },
    });

    await expect(runCli([
      'validate', '--root', root, '--app-id', APP_ID, '--quiet',
    ])).rejects.toThrow();
  });

  it('rejects definition ids that collide after model-safe encoding', async () => {
    // Model providers see the encoded name (dots become underscores). Two
    // definitions whose names only differ in that separator would shadow each
    // other at the model — the workspace is invalid before anything ships.
    const second = {
      toolId: '019fb007-0000-7000-8000-00000000000b',
      definitionId: 'tasks_list',
      stableKey: 'GET /api/tasks?alt',
      executionKind: 'endpoint',
      sourceFingerprint: ROUTE_FINGERPRINT,
      inputSchemaDigest: digest('input'),
      outputSchemaDigest: digest('output'),
      sourceFile: 'src/app/api/tasks/route.ts',
      method: 'GET',
      path: '/api/tasks',
    };
    const root = workspace({
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture-app',
        executions: [{
          toolId: '019fb007-0000-7000-8000-00000000000a',
          definitionId: 'tasks.list',
          stableKey: 'GET /api/tasks',
          executionKind: 'endpoint',
          sourceFingerprint: ROUTE_FINGERPRINT,
          inputSchemaDigest: digest('input'),
          outputSchemaDigest: digest('output'),
          sourceFile: 'src/app/api/tasks/route.ts',
          method: 'GET',
          path: '/api/tasks',
        }, second],
      },
    });

    await expect(runCli([
      'validate', '--root', root, '--app-id', APP_ID, '--quiet',
    ])).rejects.toThrow(/collide/i);
  });

  it('rejects definition ids outside the tool naming convention', async () => {
    const root = workspace({
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture-app',
        executions: [{
          toolId: '019fb007-0000-7000-8000-00000000000a',
          definitionId: 'Tasks List!',
          stableKey: 'GET /api/tasks',
          executionKind: 'endpoint',
          sourceFingerprint: ROUTE_FINGERPRINT,
          inputSchemaDigest: digest('input'),
          outputSchemaDigest: digest('output'),
          sourceFile: 'src/app/api/tasks/route.ts',
          method: 'GET',
          path: '/api/tasks',
        }],
      },
    });

    await expect(runCli([
      'validate', '--root', root, '--app-id', APP_ID, '--quiet',
    ])).rejects.toMatchObject({
      code: 'E-INVENTORY-001',
      operation: 'validate.inventory',
      identifier: 'Tasks List!',
    } satisfies Partial<FoundationDiagnosticError>);
  });

  it('rejects a schema-invalid inventory', async () => {
    const root = workspace({
      inventory: { schemaVersion: 1, executions: [] },
    });

    await expect(runCli([
      'validate', '--root', root, '--app-id', APP_ID, '--quiet',
    ])).rejects.toThrow();
  });

  it('rejects a prompt bundle addressed to another app', async () => {
    const root = workspace({
      promptBundle: {
        schemaVersion: 1,
        appId: '019fb007-0000-7000-8000-0000000000ff',
        artifactRef: 'local://artifacts/prompt-bundle',
        sections: {
          planner: 'Plan.',
          appBehavior: 'Behave.',
          responseStyle: 'Answer.',
        },
      },
    });

    await expect(runCli([
      'validate', '--root', root, '--app-id', APP_ID, '--quiet',
    ])).rejects.toThrow(/app/i);
  });

  it('rejects prompt content that carries a secret-shaped value', async () => {
    const root = workspace({
      promptBundle: {
        schemaVersion: 1,
        appId: APP_ID,
        artifactRef: 'local://artifacts/prompt-bundle',
        sections: {
          planner: 'Use sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789 to call.',
          appBehavior: 'Manage tasks.',
          responseStyle: 'Answer briefly.',
        },
      },
    });

    await expect(runCli([
      'validate', '--root', root, '--app-id', APP_ID, '--quiet',
    ])).rejects.toThrow(/content boundary|secret/i);
  });
});

describe('glirastes build', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('emits separate runtime and prompt manifests with digests', async () => {
    const root = workspace();

    await runCli(['build', '--root', root, '--app-id', APP_ID, '--quiet']);

    const runtime = readManifest(root, 'runtime-manifest.json');
    const prompt = readManifest(root, 'prompt-manifest.json');

    expect(runtime.appId).toBe(APP_ID);
    expect(runtime.runtimeDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(runtime.executions).toHaveLength(1);
    expect(prompt.promptDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(prompt.groupDigests.planner)
      .toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(prompt.artifactRef).toBe('local://artifacts/prompt-bundle');
  });

  it('never places prompt content or a secret in a manifest', async () => {
    const root = workspace();

    await runCli(['build', '--root', root, '--app-id', APP_ID, '--quiet']);

    const serialized = [
      readFileSync(resolve(root, '.glirastes/build/runtime-manifest.json'), 'utf8'),
      readFileSync(resolve(root, '.glirastes/build/prompt-manifest.json'), 'utf8'),
    ].join('\n');

    expect(serialized).not.toContain('Plan carefully');
    expect(serialized).not.toContain('Answer briefly');
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(serialized).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('is byte-identical across two clean output directories', async () => {
    const first = workspace();
    const second = workspace();

    await runCli(['build', '--root', first, '--app-id', APP_ID, '--quiet']);
    await runCli(['build', '--root', second, '--app-id', APP_ID, '--quiet']);

    for (const name of ['runtime-manifest.json', 'prompt-manifest.json']) {
      expect(readFileSync(resolve(first, '.glirastes/build', name), 'utf8'))
        .toBe(readFileSync(resolve(second, '.glirastes/build', name), 'utf8'));
    }
  });

  it('changes the prompt digest without changing the runtime digest', async () => {
    const base = workspace();
    const changed = workspace({
      promptBundle: {
        schemaVersion: 1,
        appId: APP_ID,
        artifactRef: 'local://artifacts/prompt-bundle',
        sections: {
          planner: 'Plan carefully.',
          appBehavior: 'Manage tasks.',
          responseStyle: 'Answer very briefly.',
        },
      },
    });

    await runCli(['build', '--root', base, '--app-id', APP_ID, '--quiet']);
    await runCli(['build', '--root', changed, '--app-id', APP_ID, '--quiet']);

    expect(readManifest(changed, 'runtime-manifest.json').runtimeDigest)
      .toBe(readManifest(base, 'runtime-manifest.json').runtimeDigest);
    expect(readManifest(changed, 'prompt-manifest.json').promptDigest)
      .not.toBe(readManifest(base, 'prompt-manifest.json').promptDigest);
  });

  it('never publishes or deploys', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const root = workspace();

    await runCli(['build', '--root', root, '--app-id', APP_ID, '--quiet']);

    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('refuses to build an invalid workspace', async () => {
    const root = workspace({
      inventory: { schemaVersion: 2, targetAppKey: 'x', executions: 'no' },
    });

    await expect(runCli([
      'build', '--root', root, '--app-id', randomUUID(), '--quiet',
    ])).rejects.toThrow();
  });
});
