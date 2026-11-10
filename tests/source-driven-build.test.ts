import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { runToolsPipeline, ToolsPipelineFailure } from '../src/codegen/tools/pipeline.js';
import { assertBuiltSdk, copyApp, EXAMPLES, NATIVE_APP, removeCopiedApps } from './support/tool-runtime.js';

const roots: string[] = [];
beforeAll(assertBuiltSdk);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await removeCopiedApps();
});

it('stops the normal app build before Next when tools refresh fails', async () => {
  const { prepareBrowserReference } = await import('../examples/source-driven-next/prepare-browser.mjs');
  const root = await prepareBrowserReference();
  roots.push(root);
  const inventory = await readFile(resolve(root, '.glirastes/foundation-execution-inventory.json'), 'utf8');
  const generated = await readFile(resolve(root, 'src/generated/glirastes/tools.generated.js'), 'utf8');
  await writeFile(resolve(root, 'src/app/api/tasks/route.js'), "export * from './contract.js';\n");
  const result = await promisify(execFile)('bun', ['run', 'build'], { cwd: root,
    env: { PATH: process.env.PATH, NEXT_TELEMETRY_DISABLED: '1' } })
    .then(() => ({ code: 0, stdout: '' }), (error: { code: number; stdout: string }) => error);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain('E-INVENTORY-011');
  await expect(readFile(resolve(root, '.next/BUILD_ID'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(root, '.glirastes/foundation-execution-inventory.json'), 'utf8')).toBe(inventory);
  expect(await readFile(resolve(root, 'src/generated/glirastes/tools.generated.js'), 'utf8')).toBe(generated);
}, 60_000);

it('refuses a linked output folder without writing outside the app', async () => {
  const root = await copyApp(NATIVE_APP, '.build-proof-');
  const outside = await mkdtemp(resolve(EXAMPLES, '.build-proof-outside-'));
  roots.push(outside);
  await symlink(outside, resolve(root, 'src/generated'), 'dir');
  const outcome = await runToolsPipeline({ root, mode: 'write' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  expect((outcome as ToolsPipelineFailure).result.findings).toContainEqual(expect.objectContaining({ code: 'output-path-linked' }));
  expect(await readdir(outside)).toEqual([]);
  await expect(readFile(resolve(root, '.glirastes/setup-artifact.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);
