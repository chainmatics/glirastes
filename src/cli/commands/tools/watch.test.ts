import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { toolFinding } from '../../../codegen/tools/findings.js';
import { ToolsPipelineFailure, type ToolsPipelineOptions, type ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import { writeArtifactSetAtomically } from '../atomic-artifact-write.js';
import { runToolsCommand } from './index.js';
import { defaultToolsWatch, isWatchedPath, watchToolsRefresh, type ToolsWatchFactory } from './watch.js';

afterEach(removeAppFixtures);

const MODULE = 'src/generated/glirastes/tools.generated.ts';
const STAGE_ID = '0f1c1c3e-4f5a-4c8e-9a0e-2a6d8b7f1a11';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((done) => setTimeout(done, 5));
  expect(condition()).toBe(true);
};

function fakeWatch() {
  const state: { onChange?: (path: string) => void; fail?: (error: Error) => void; closed: boolean } = { closed: false };
  const factory: ToolsWatchFactory = (_root, onChange, onError) => {
    state.onChange = onChange;
    state.fail = onError;
    return { close: () => { state.closed = true; } };
  };
  return { state, factory };
}

describe('tools refresh --watch', () => {
  it.each([
    ['src/app/api/tasks/route.ts', true],
    ['app/(app)/tasks/page.tsx', true],
    ['.glirastes/tool-semantics.json', true],
    ['.glirastes/tool-policy.json', true],
    ['.glirastes/mcp-tool-names.json', true],
    ['.glirastes/setup-artifact.json', false],
    ['.glirastes/build/runtime-manifest.json', false],
    [MODULE, false],
    ['node_modules/zod/index.js', false],
    ['.next/server/app.js', false],
    ['build/server/chunk.js', false],
    ['src/app/(app)/build/actions.tsx', true],
    ['src/app/.DS_Store', false],
    ['src/app/page.tsx~', false],
    [`${MODULE}.glirastes-stage-${STAGE_ID}`, false],
    [`${MODULE}.glirastes-backup-${STAGE_ID}`, false],
    [`.glirastes/tool-semantics.json.glirastes-stage-${STAGE_ID}`, false],
    [`src/app/api/tasks/route.ts.glirastes-stage-${STAGE_ID}`, false],
    ['src/app/glirastes-stage-notes.tsx', true],
  ])('watches %s: %s', (path, watched) => {
    expect(isWatchedPath(path, MODULE)).toBe(watched);
  });

  it('compares the configured module as an app-relative path, however it is spelled', () => {
    expect(isWatchedPath(MODULE, `./${MODULE}`)).toBe(false);
    expect(isWatchedPath(MODULE, MODULE.replaceAll('/', '\\'))).toBe(false);
    expect(isWatchedPath(`./${MODULE}`, MODULE)).toBe(false);
    expect(isWatchedPath(`${MODULE}.glirastes-stage-${STAGE_ID}`, `./${MODULE}`)).toBe(false);
  });

  it('is not retriggered by the staging files the real atomic write leaves next to the module', async () => {
    const fixture = await createAppFixture();
    await mkdir(fixture.path('src/generated/glirastes'), { recursive: true });
    const seen: string[] = [];
    const watcher = defaultToolsWatch(fixture.root, (path) => { seen.push(path); }, () => undefined);
    try {
      await sleep(100);
      seen.length = 0;
      await writeArtifactSetAtomically([{ path: fixture.path(MODULE), content: 'export const generation = 1;\n' }]);
      await writeArtifactSetAtomically([{ path: fixture.path(MODULE), content: 'export const generation = 2;\n' }]);
      await until(() => seen.some((path) => path.includes('.glirastes-backup-')));
      await sleep(150);
    } finally {
      watcher.close();
    }
    const outputEvents = seen.filter((path) => path.startsWith(MODULE));
    expect(outputEvents.some((path) => path.includes('.glirastes-stage-'))).toBe(true);
    expect(outputEvents.filter((path) => isWatchedPath(path, `./${MODULE}`))).toEqual([]);
    expect(outputEvents.filter((path) => isWatchedPath(path, MODULE))).toEqual([]);
  });

  it('refreshes once, then once per burst of relevant changes, never overlapping', async () => {
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    let runs = 0;
    let active = 0;
    let overlap = false;
    const done = watchToolsRefresh({
      root: '/app', generatedModule: MODULE, signal: controller.signal, watch: factory, debounceMs: 10,
      onError: () => undefined,
      run: async () => {
        active += 1;
        overlap ||= active > 1;
        runs += 1;
        await new Promise((resolveRun) => setTimeout(resolveRun, 20));
        active -= 1;
      },
    });
    await until(() => state.onChange !== undefined);
    expect(runs).toBe(1);
    state.onChange!('src/a.ts');
    state.onChange!('src/b.ts');
    state.onChange!(MODULE);
    await until(() => runs === 2);
    state.onChange!('.glirastes/tool-report.json');
    await new Promise((settle) => setTimeout(settle, 60));
    expect(runs).toBe(2);
    controller.abort();
    await done;
    expect(state.closed).toBe(true);
    expect(overlap).toBe(false);
  });

  /** Refreshes that block on `gate`, read when a run starts, until `release()` after `block()`. */
  function blockingRuns() {
    const probe = { runs: 0, active: 0, overlap: false, release: (): void => undefined, gate: Promise.resolve() };
    const run = async () => {
      probe.active += 1;
      probe.overlap ||= probe.active > 1;
      probe.runs += 1;
      await probe.gate;
      probe.active -= 1;
    };
    const block = () => {
      probe.gate = new Promise<void>((resolveGate) => { probe.release = resolveGate; });
    };
    return { probe, run, block };
  }

  it('schedules exactly one more refresh for changes that arrive during a run, never overlapping', async () => {
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    const { probe, run, block } = blockingRuns();
    const done = watchToolsRefresh({
      root: '/app', generatedModule: MODULE, signal: controller.signal, watch: factory, debounceMs: 10,
      onError: () => undefined, run,
    });
    await until(() => state.onChange !== undefined);
    expect(probe.runs).toBe(1);
    block();
    state.onChange!('src/a.ts');
    await until(() => probe.runs === 2);
    state.onChange!('src/b.ts');
    state.onChange!('src/c.ts');
    await sleep(60);
    expect(probe.runs).toBe(2);
    probe.gate = Promise.resolve();
    probe.release();
    await until(() => probe.runs === 3);
    await sleep(60);
    expect(probe.runs).toBe(3);
    expect(state.closed).toBe(false);
    controller.abort();
    await done;
    expect(state.closed).toBe(true);
    expect(probe.overlap).toBe(false);
  });

  it('starts nothing and arms no timer after the signal, even for a change that arrived during the last run', async () => {
    const debounceMs = 17;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const debounceTimers = () => timers.mock.calls.filter(([, delay]) => delay === debounceMs).length;
    try {
      const { state, factory } = fakeWatch();
      const controller = new AbortController();
      const { probe, run, block } = blockingRuns();
      const done = watchToolsRefresh({
        root: '/app', generatedModule: MODULE, signal: controller.signal, watch: factory, debounceMs,
        onError: () => undefined, run,
      });
      await until(() => state.onChange !== undefined);
      block();
      state.onChange!('src/a.ts');
      await until(() => probe.runs === 2);
      state.onChange!('src/b.ts');
      await sleep(40);
      controller.abort();
      const armed = debounceTimers();
      probe.gate = Promise.resolve();
      probe.release();
      await done;
      await sleep(40);
      expect(probe.runs).toBe(2);
      expect(debounceTimers()).toBe(armed);
      expect(state.closed).toBe(true);
    } finally {
      timers.mockRestore();
    }
  });

  it('reports a refresh that throws, in the first run and in later ones, and keeps watching', async () => {
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    const errors: string[] = [];
    let runs = 0;
    const done = watchToolsRefresh({
      root: '/app', generatedModule: MODULE, signal: controller.signal, watch: factory, debounceMs: 10,
      onError: (error) => { errors.push((error as Error).message); },
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error('first run failed');
        if (runs === 2) throw new Error('ENOENT: raced a rename');
      },
    });
    await until(() => state.onChange !== undefined);
    expect(errors).toEqual(['first run failed']);
    state.onChange!('src/a.ts');
    await until(() => errors.length === 2);
    state.onChange!('src/b.ts');
    await until(() => runs === 3);
    expect(errors).toEqual(['first run failed', 'ENOENT: raced a rename']);
    controller.abort();
    await done;
    expect(state.closed).toBe(true);
  });

  it('stops with E-TOOLS-030 when the watcher cannot start', async () => {
    let runs = 0;
    const failing: ToolsWatchFactory = () => { throw new Error('ENOSPC: System limit for number of file watchers reached'); };
    const stopped = watchToolsRefresh({
      root: '/app', generatedModule: MODULE, signal: new AbortController().signal, watch: failing, debounceMs: 10,
      onError: () => undefined,
      run: async () => { runs += 1; },
    });
    await expect(stopped).rejects.toMatchObject({
      code: 'E-TOOLS-030',
      message: expect.stringMatching(/ENOSPC.*without --watch/su),
    });
    expect(runs).toBe(1);
  });

  it('stops cleanly, without another refresh, when the watcher fails while running', async () => {
    const { state, factory } = fakeWatch();
    let runs = 0;
    const outcome = watchToolsRefresh({
      root: '/app', generatedModule: MODULE, signal: new AbortController().signal, watch: factory, debounceMs: 10,
      onError: () => undefined,
      run: async () => { runs += 1; },
    }).then(() => undefined, (error: unknown) => error);
    await until(() => state.fail !== undefined);
    state.onChange!('src/a.ts');
    state.fail!(new Error('EMFILE: too many open files, watch'));
    expect(await outcome).toMatchObject({ code: 'E-TOOLS-030', message: expect.stringContaining('EMFILE') });
    expect(state.closed).toBe(true);
    state.onChange!('src/b.ts');
    await sleep(60);
    expect(runs).toBe(1);
  });

  it('keeps watching after a failing refresh and stops with the signal', async () => {
    const fixture = await createAppFixture();
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    const calls: ToolsPipelineOptions[] = [];
    const out: string[] = [];
    const result = (findings: ToolsPipelineResult['findings']): ToolsPipelineResult => ({
      mode: 'write', changes: { added: [], changed: [], removed: [], unchanged: [] },
      findings, excluded: [], outputs: {}, driftPaths: [], wrote: false,
    });
    const runPipeline = async (options: ToolsPipelineOptions): Promise<ToolsPipelineResult> => {
      calls.push(options);
      if (calls.length === 1) {
        throw new ToolsPipelineFailure(result([toolFinding('E-INVENTORY-011', 'error', 'next-app', 'export * found')]));
      }
      return result([]);
    };
    const watching = runToolsCommand(['refresh', '--watch'], {
      cwd: fixture.root, env: {}, log: (line) => { out.push(line); }, error: () => undefined,
      runPipeline, watch: factory, signal: controller.signal,
    });
    await until(() => state.onChange !== undefined);
    expect(out.join('\n')).toContain('Nothing was written.');
    state.onChange!('src/app/api/tasks/route.ts');
    await until(() => calls.length === 2);
    expect(calls).toEqual([
      { root: fixture.root, mode: 'write', keepGoing: true },
      { root: fixture.root, mode: 'write', keepGoing: true },
    ]);
    controller.abort();
    expect(await watching).toBe(0);
    expect(out[0]).toBe('Watching the app for tool changes. Stop with Ctrl+C.');
    expect(out.at(-1)).toContain('Tool outputs are up to date.');
  });

  it('prints an unexpected refresh error and keeps watching through the command', async () => {
    const fixture = await createAppFixture();
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    const err: string[] = [];
    let calls = 0;
    const result: ToolsPipelineResult = {
      mode: 'write', changes: { added: [], changed: [], removed: [], unchanged: [] },
      findings: [], excluded: [], outputs: {}, driftPaths: [], wrote: false,
    };
    const watching = runToolsCommand(['refresh', '--watch'], {
      cwd: fixture.root, env: {}, log: () => undefined, error: (line) => { err.push(line); },
      runPipeline: async () => {
        calls += 1;
        if (calls === 2) throw new Error('ENOENT: no such file or directory, open src/app/page.tsx');
        return result;
      },
      watch: factory, signal: controller.signal,
    });
    await until(() => state.onChange !== undefined);
    state.onChange!('src/app/page.tsx');
    await until(() => err.length === 1);
    expect(err[0]).toContain('ENOENT: no such file or directory');
    state.onChange!('src/app/page.tsx');
    await until(() => calls === 3);
    controller.abort();
    expect(await watching).toBe(0);
  });

  it('names a watcher that cannot start and exits 1', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
    const code = await runToolsCommand(['refresh', '--watch'], {
      cwd: fixture.root, env: {}, log: () => undefined, error: (line) => { err.push(line); },
      runPipeline: async () => ({
        mode: 'write', changes: { added: [], changed: [], removed: [], unchanged: [] },
        findings: [], excluded: [], outputs: {}, driftPaths: [], wrote: false,
      }),
      watch: () => { throw new Error('EMFILE: too many open files, watch'); },
      signal: new AbortController().signal,
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/E-TOOLS-030: .*EMFILE/u);
  });

  it('refuses to watch in CI or with machine-readable output', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = (env: NodeJS.ProcessEnv) => ({ cwd: '/app', env, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } });
    expect(await runToolsCommand(['refresh', '--watch'], deps({ CI: 'true' }))).toBe(2);
    expect(await runToolsCommand(['refresh', '--watch', '--json'], deps({}))).toBe(2);
    expect(err.join('\n')).toContain('--watch refreshes in write mode only');
  });
});
