/**
 * Writes `golden-0.17.3.json`: the scenario run against the PUBLISHED
 * glirastes 0.17.3 package, under vitest (Node), the runtime the golden test
 * runs in, since the order of the stream's chunks depends on the runtime's
 * scheduling. Skipped unless `GLIRASTES_RECORD_V0173` names a directory
 * with `glirastes@0.17.3`, `ai@6.0.161` and `zod@4.4.3` installed:
 *
 *   GLIRASTES_RECORD_V0173=<dir> bunx vitest run <this file>
 *
 * The golden file is the reference of `ui-result-shape-v0173.test.ts`; it is
 * recorded once from the published package, never from this source tree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runAll, type ScenarioSdk } from './scenario.js';

const dir = process.env.GLIRASTES_RECORD_V0173;

describe.skipIf(!dir)('record the glirastes 0.17.3 golden stream', () => {
  it('writes golden-0.17.3.json', async () => {
    const modules = resolve(dir!, 'node_modules');
    const version = (JSON.parse(readFileSync(join(modules, 'glirastes/package.json'), 'utf8')) as { version: string }).version;
    expect(version).toBe('0.17.3');
    const load = async (path: string) => import(pathToFileURL(join(modules, path)).href) as Promise<Record<string, unknown>>;
    const root = await load('glirastes/dist/index.js');
    const server = await load('glirastes/dist/server/index.js');
    const http = await load('glirastes/dist/server/adapters/nextjs/index.js');
    const test = await load('ai/dist/test/index.mjs');
    const zod = await load('zod/index.js');
    const sdk = {
      createAiChatHandler: http.createAiChatHandler,
      uiActionToolToTool: server.uiActionToolToTool,
      uiToolToTool: server.uiToolToTool,
      defineUiTool: root.defineUiTool,
      z: zod.z,
      MockLanguageModelV3: test.MockLanguageModelV3,
      convertArrayToReadableStream: test.convertArrayToReadableStream,
    } as unknown as ScenarioSdk;
    const records = await runAll(sdk);
    const out = join(dirname(fileURLToPath(import.meta.url)), 'golden-0.17.3.json');
    writeFileSync(out, `${JSON.stringify({ sdk: 'glirastes@0.17.3', ai: '6.0.161', zod: '4.4.3', records }, null, 2)}\n`);
  });
});
