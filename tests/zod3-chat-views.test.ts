import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z as zod4 } from 'zod';
import {
  bindable,
  chatElementId,
  defineChatComponent,
  refOnly,
  toChatComponentManifest,
} from '../src/chat-views/index.js';
import { createAppFixture, removeAppFixtures } from '../src/codegen/tools/__tests__/app-fixture.js';
import { createSchemaProbe } from '../src/codegen/tools/schema-probe.js';
import { scanChatComponents } from '../src/codegen/tools/sources/chat-components.js';

/**
 * Chat views in an app on zod 3.25, with the REAL zod of
 * `tests/fixtures/zod3` (installed by CI with
 * `bun install --frozen-lockfile --cwd tests/fixtures/zod3`): its bundled
 * `zod/v4` build is accepted like the SDK's own zod 4, its classic `zod`
 * entry (zod 3) is refused with a hint to `zod/v4`, and an app's `tsc`
 * checking `zod/v4` schemas against the built SDK declarations stays small.
 */
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(SDK_ROOT, 'tests', 'fixtures', 'zod3');
const FIXTURE_ZOD = join(FIXTURE, 'node_modules', 'zod');
const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZod = any;
const loadZod = async (entry: string): Promise<AnyZod> =>
  ((await import(pathToFileURL(join(FIXTURE_ZOD, entry)).href)) as { z: AnyZod }).z;

/** One component, built with whichever zod 4 `z` is given. */
function component(z: AnyZod) {
  return defineChatComponent({
    id: 'OrderTable',
    schemaVersion: 2,
    description: 'Orders as rows.',
    whenToUse: 'More than three orders.',
    props: z.object({
      title: z.string().max(80).describe('Heading of the table'),
      total: bindable(z.number().meta({ description: 'Sum of all orders' })),
      status: z.enum(['open', 'paid']).default('open'),
      note: z.string().nullable().optional(),
      customer: refOnly(z.string()),
      rows: refOnly(),
      columns: z.array(z.object({ label: z.string(), cell: chatElementId() })).max(8),
      args: z.record(z.string(), bindable(z.union([z.string(), z.number()]))).optional(),
    }),
    itemScope: { rowsProp: 'rows', cellsProp: 'columns' },
    text: { label: 'title', value: 'total', rows: 'rows', columns: 'columns' },
  });
}

afterEach(removeAppFixtures);

describe('chat views on zod 3.25', () => {
  it('has the zod 3.25 fixture installed', () => {
    expect(
      existsSync(join(FIXTURE_ZOD, 'package.json')),
      'run `bun install --frozen-lockfile --cwd tests/fixtures/zod3` first',
    ).toBe(true);
    const { version } = JSON.parse(readFileSync(join(FIXTURE_ZOD, 'package.json'), 'utf8')) as { version: string };
    expect(version).toMatch(/^3\.25\.\d+$/);
  });

  it("accepts schemas of its 'zod/v4' build: the same manifest entry as with the SDK's zod 4", async () => {
    const zodV4 = await loadZod('v4/index.js');
    expect(zodV4.string()._zod.version).not.toEqual(zod4.string()._zod.version);
    const foreign = toChatComponentManifest([component(zodV4)]);
    const own = toChatComponentManifest([component(zod4)]);
    expect(foreign).toEqual(own);
    const props = foreign.components[0]!.props as { properties: Record<string, { description?: string }> };
    expect(props.properties.title?.description).toBe('Heading of the table');
    expect(props.properties.total?.description).toBe('Sum of all orders');
    expect(foreign.components[0]).toMatchObject({ bindable: ['total', 'args.*'], refOnly: ['customer', 'rows'] });
  });

  it("refuses refinements and transforms of 'zod/v4' schemas like the SDK's own", async () => {
    const z = await loadZod('v4/index.js');
    const define = (prop: unknown) => defineChatComponent({
      id: 'Bad', schemaVersion: 1, description: 'x', props: z.object({ value: prop }), text: {},
    });
    expect(() => toChatComponentManifest([define(z.string().refine(() => true))])).toThrow(/refinements/);
    expect(() => toChatComponentManifest([define(z.string().transform((value: string) => value.length))]))
      .toThrow(/transforms/);
  });

  it("refuses zod 3 classic schemas with a hint to 'zod/v4'", async () => {
    const z = await loadZod('index.js');
    const hint = /zod 3 schema.*import \{ z \} from 'zod\/v4'/;
    expect(() => bindable(z.string())).toThrow(hint);
    expect(() => refOnly(z.string())).toThrow(hint);
    expect(() => defineChatComponent({
      id: 'Classic', schemaVersion: 1, description: 'x', props: z.object({ title: z.string() }), text: {},
    })).toThrow(/chat component Classic: this is a zod 3 schema/);
    // A zod 4 object with a zod 3 prop inside.
    expect(() => defineChatComponent({
      id: 'Mixed', schemaVersion: 1, description: 'x', props: zod4.object({ title: z.string() }), text: {},
    })).toThrow(hint);
  });

  it('reports an app module on zod 3 classic as a clear chat component finding', { timeout: 60_000 }, async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' } }),
      'src/chat/order.ts': "import { z } from 'zod';\nimport { defineChatComponent, bindable } from 'glirastes';\n"
        + "export const order = defineChatComponent({ id: 'Order', schemaVersion: 1, description: 'x',\n"
        + "  props: z.object({ title: bindable(z.string()) }), text: { label: 'title' } });\n",
    });
    await mkdir(app.path('node_modules'), { recursive: true });
    await symlink(SDK_ROOT, app.path('node_modules/glirastes'), 'dir');
    await symlink(FIXTURE_ZOD, app.path('node_modules/zod'), 'dir');

    const scan = await scanChatComponents(app.root, createSchemaProbe());

    expect(scan.manifest).toBeUndefined();
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]).toMatchObject({ code: 'chat-component-invalid', severity: 'error' });
    expect(scan.findings[0]!.message).toContain('src/chat/order.ts#order uses a schema that is not zod 4');
    expect(scan.findings[0]!.message).toContain("import { z } from 'zod/v4'");
    expect(scan.findings[0]!.message).not.toContain('clone');
  });

  it("typechecks an app's 'zod/v4' components against the built declarations within a 1 GB heap", { timeout: 120_000 }, async () => {
    expect(existsSync(join(SDK_ROOT, 'dist', 'index.d.ts')), 'run `bun run build` first').toBe(true);
    // Before the structural signatures, this ran out of memory at 1, 4 and 8 GB.
    const tsc = join(SDK_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = await execFileAsync(process.execPath, ['--max-old-space-size=1024', tsc, '-p', join(FIXTURE, 'tsconfig.json')], {
      cwd: FIXTURE,
      timeout: 90_000,
      encoding: 'utf8',
    }).then(() => ({ ok: true, output: '' }), (error: { stdout?: string; stderr?: string; message: string }) => ({
      ok: false,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(0, 2_000) || error.message,
    }));
    expect(result).toEqual({ ok: true, output: '' });
  });
});
