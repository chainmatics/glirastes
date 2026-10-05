import { symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { scanAppSources } from './app-files.js';
import { jsonSchemaDigest } from '../canonical.js';
import { OPAQUE_SCHEMA_DIGEST } from '../contract-tiers.js';
import {
  hasNavigationBridge,
  UI_TOOL_OUTPUT_SCHEMA,
  uiDefinitionIdForAction,
  uiObservation,
  uniqueDefinitionIds,
  viewName,
} from './ui-tools.js';

afterEach(removeAppFixtures);

const file = (path: string, source: string) => ({ path, absolute: `/app/${path}`, source });

describe('navigation bridge detection', () => {
  it.each([
    ["import { useGlirastesNavigationBridge as useBridge } from 'glirastes/react';\nexport function A() { useBridge({ push: () => {} }); }"],
    ["import * as browser from 'glirastes/browser';\nbrowser.registerNavigationBridge({ push: (href) => location.assign(href) });"],
  ])('finds the bridge in %#', (source) => {
    expect(hasNavigationBridge([file('src/a.tsx', source)])).toBe(true);
  });

  it.each([
    ['a same-named local function', 'function useGlirastesNavigationBridge() {}\nuseGlirastesNavigationBridge();'],
    ['a comment', "// useGlirastesNavigationBridge({ push }) from 'glirastes/react'"],
    ['an import without a call', "import { registerNavigationBridge } from 'glirastes/browser';\nexport { registerNavigationBridge };"],
  ])('does not count %s', (_label, source) => {
    expect(hasNavigationBridge([file('src/a.tsx', source)])).toBe(false);
  });
});

describe('UI tool names', () => {
  it.each([
    ['/', 'home'],
    ['/tasks', 'tasks'],
    ['/admin/users', 'adminUsers'],
    ['/projects/:projectId/tasks', 'projectsTasks'],
    ['/tasks/:taskId', 'tasksItem'],
    ['/2fa-setup', 'v2faSetup'],
  ])('names the filter view of %s %s', (path, expected) => {
    expect(viewName(path)).toBe(expected);
  });

  it.each([
    ['tasks.highlight', 'ui.tasks.highlight'],
    ['task-details.open', 'ui.taskDetails.open'],
    ['navigate', 'ui.action.navigate'],
    ['filter.tasks', 'ui.action.filter.tasks'],
    ['2fa.start', 'ui.a2fa.start'],
    ['', undefined],
    ['...', undefined],
  ])('names the client action %j %s', (actionId, expected) => {
    expect(uiDefinitionIdForAction(actionId)).toBe(expected);
  });
});

describe('scanAppSources', () => {
  it('reads matching app files only, outside dependencies, build output and generated code', async () => {
    const app = await createAppFixture({
      'src/a.tsx': 'useAiClientAction();',
      'src/b.ts': 'nothing here',
      'src/generated/glirastes/tools.generated.ts': 'useAiClientAction();',
      'src/.cache/x.ts': 'useAiClientAction();',
      'node_modules/lib/index.js': 'useAiClientAction();',
      '.next/server/page.js': 'useAiClientAction();',
      'src/types.d.ts': 'useAiClientAction();',
    });
    const scan = await scanAppSources(app.root, { matches: (source) => source.includes('useAiClientAction') });
    expect(scan).toEqual({ complete: true, files: [expect.objectContaining({ path: 'src/a.tsx' })] });
  });

  it('reports a linked source folder as incomplete', async () => {
    const app = await createAppFixture({ 'src/a.tsx': 'x', 'lib/b.ts': 'x' });
    await symlink(app.path('lib'), app.path('src/lib'), 'dir');
    expect(await scanAppSources(app.root, { matches: () => true })).toEqual({
      complete: false,
      reason: 'src/lib is a link; its sources cannot be enumerated.',
    });
  });

  it('refuses a linked source file but not a link to something that is no source', async () => {
    const app = await createAppFixture({ 'src/a.tsx': 'x', 'src/notes.md': 'x' });
    await symlink(app.path('src/notes.md'), app.path('src/notes-link.md'), 'file');
    expect(await scanAppSources(app.root, { matches: () => true })).toEqual({
      complete: true,
      files: [expect.objectContaining({ path: 'src/a.tsx' })],
    });
    await symlink(app.path('src/a.tsx'), app.path('src/b.tsx'), 'file');
    expect(await scanAppSources(app.root, { matches: () => true })).toEqual({
      complete: false,
      reason: 'src/b.tsx is a link; its sources cannot be enumerated.',
    });
  });

  it('scans an app without src although its root holds an agent-instructions link', async () => {
    const app = await createAppFixture({ 'AGENTS.md': 'x', 'a.tsx': 'useAiClientAction();' });
    await symlink(app.path('AGENTS.md'), app.path('CLAUDE.md'), 'file');
    const scan = await scanAppSources(app.root, { matches: (source) => source.includes('useAiClientAction') });
    expect(scan).toEqual({ complete: true, files: [expect.objectContaining({ path: 'a.tsx' })] });
  });

  it('ignores a dangling or looping link unless its name is a source file', async () => {
    const app = await createAppFixture({ 'src/a.tsx': 'x' });
    await symlink(app.path('src/missing.md'), app.path('src/stale.md'), 'file');
    await symlink('loop.md', app.path('src/loop.md'), 'file');
    expect(await scanAppSources(app.root, { matches: () => true })).toMatchObject({ complete: true });
    await symlink(app.path('src/missing.tsx'), app.path('src/old.tsx'), 'file');
    expect(await scanAppSources(app.root, { matches: () => true })).toEqual({
      complete: false,
      reason: 'src/old.tsx is a link; its sources cannot be enumerated.',
    });
  });

  it('leaves out tests, stories and their output because they never register app handlers', async () => {
    const app = await createAppFixture({
      'src/a.tsx': 'x',
      'src/latest.tsx': 'x',
      'src/a.testing.tsx': 'x',
      'src/spec.ts': 'x',
      'src/a.test.tsx': 'x',
      'src/a.spec.ts': 'x',
      'src/Button.stories.tsx': 'x',
      'src/__tests__/b.tsx': 'x',
      'src/e2e/c.ts': 'x',
      'src/storybook-static/chunk.js': 'x',
    });
    const scan = await scanAppSources(app.root, { matches: () => true });
    expect(scan).toMatchObject({ complete: true });
    expect(scan.complete && scan.files.map((entry) => entry.path)).toEqual([
      'src/a.testing.tsx', 'src/a.tsx', 'src/latest.tsx', 'src/spec.ts',
    ]);
  });
});

describe('UI tool observations', () => {
  const input = { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false };

  it('keeps a typed UI tool bound to its JSON Schema and action', () => {
    const observed = uiObservation({
      stableKey: 'UI action tasks.highlight',
      definitionId: 'ui.tasks.highlight',
      actionBindingRef: 'tasks.highlight',
      input,
      uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
      params: { path: [], query: [], body: ['taskId'] },
      facts: { files: ['src/a.tsx'] },
      findings: [],
      jsDoc: 'Highlight a task.',
    });
    expect(observed.execution).toMatchObject({
      executionKind: 'ui', actionBindingRef: 'tasks.highlight',
      inputSchemaDigest: jsonSchemaDigest(input), outputSchemaDigest: jsonSchemaDigest(UI_TOOL_OUTPUT_SCHEMA),
    });
    expect(observed.contract).toMatchObject({
      source: 'ui-bridge', loadBearing: true, input,
      runtime: { input: { kind: 'json', schema: input }, output: { kind: 'json', schema: UI_TOOL_OUTPUT_SCHEMA } },
      uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
    });
    expect(observed.evidence).toEqual({ authEvidence: false, externalCall: false, jsDoc: 'Highlight a task.' });
  });

  it('keeps the identity of an untyped tool without a contract', () => {
    const observed = uiObservation({
      stableKey: 'UI action tasks.highlight', definitionId: 'ui.tasks.highlight', actionBindingRef: 'tasks.highlight',
      uiAction: { kind: 'client-action', actionId: 'tasks.highlight' }, facts: {}, findings: [], uiMutation: true,
    });
    expect(observed.contract).toBeUndefined();
    expect(observed.execution.inputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(observed.evidence.uiMutation).toBe(true);
  });

  it('changes the fingerprint with the facts, never with unrelated keys', () => {
    const fingerprint = (facts: unknown, stableKey = 'UI navigate') => uiObservation({
      stableKey, definitionId: 'ui.navigate', actionBindingRef: 'glirastes.navigate', input,
      uiAction: { kind: 'navigate' }, facts, findings: [],
    }).execution.sourceFingerprint;
    expect(fingerprint({ destinations: ['/a'] })).toBe(fingerprint({ destinations: ['/a'] }));
    expect(fingerprint({ destinations: ['/a'] })).not.toBe(fingerprint({ destinations: ['/b'] }));
    expect(fingerprint({ destinations: ['/a'] })).not.toBe(fingerprint({ destinations: ['/a'] }, 'UI filter /a'));
  });

  it('gives colliding base names a stable digest suffix in stable-key order', () => {
    const ids = uniqueDefinitionIds([
      { stableKey: 'UI filter /admin/users', base: 'ui.filter.adminUsers' },
      { stableKey: 'UI filter /admin-users', base: 'ui.filter.adminUsers' },
      { stableKey: 'UI filter /tasks', base: 'ui.filter.tasks' },
    ]);
    expect(ids.get('UI filter /admin-users')).toBe('ui.filter.adminUsers');
    expect(ids.get('UI filter /admin/users')).toMatch(/^ui\.filter\.adminUsers[A-Za-z0-9]{8}$/);
    expect(ids.get('UI filter /tasks')).toBe('ui.filter.tasks');
  });
});
