import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { toolFinding } from '../../../codegen/tools/findings.js';
import { ToolsPipelineFailure, type ToolsPipelineOptions, type ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import { runToolsCommand } from './index.js';
import { isWatchedPath, watchToolsRefresh, type ToolsWatchFactory } from './watch.js';

afterEach(removeAppFixtures);

const MODULE = 'src/generated/glirastes/tools.generated.ts';
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((done) => setTimeout(done, 5));
  expect(condition()).toBe(true);
};

function fakeWatch() {
  const state: { onChange?: (path: string) => void; closed: boolean } = { closed: false };
  const factory: ToolsWatchFactory = (_root, onChange) => {
    state.onChange = onChange;
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
    ['.glirastes/setup-artifact.json', false],
    ['.glirastes/build/runtime-manifest.json', false],
    [MODULE, false],
    ['node_modules/zod/index.js', false],
    ['.next/server/app.js', false],
    ['build/server/chunk.js', false],
    ['src/app/(app)/build/actions.tsx', true],
    ['src/app/.DS_Store', false],
    ['src/app/page.tsx~', false],
  ])('watches %s: %s', (path, watched) => {
    expect(isWatchedPath(path, MODULE)).toBe(watched);
  });

  it('refreshes once, then once per burst of relevant changes, never overlapping', async () => {
    const { state, factory } = fakeWatch();
    const controller = new AbortController();
    let runs = 0;
    let active = 0;
    let overlap = false;
    const done = watchToolsRefresh({
      root: '/app', generatedModule: MODULE, signal: controller.signal, watch: factory, debounceMs: 10,
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

  it('refuses to watch in CI or with machine-readable output', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = (env: NodeJS.ProcessEnv) => ({ cwd: '/app', env, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } });
    expect(await runToolsCommand(['refresh', '--watch'], deps({ CI: 'true' }))).toBe(2);
    expect(await runToolsCommand(['refresh', '--watch', '--json'], deps({}))).toBe(2);
    expect(err.join('\n')).toContain('--watch refreshes in write mode only');
  });
});
