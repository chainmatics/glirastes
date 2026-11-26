import { mkdir, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { chatComponentManifestSchema } from '../../../contracts/chat-view.js';
import { defineChatComponent, toChatComponentManifest } from '../../../chat-views/index.js';
import { z } from 'zod';
import { createAppFixture, removeAppFixtures, SDK_ROOT, type AppFixture } from '../__tests__/app-fixture.js';
import { TOOLS_PATHS } from '../config.js';
import { runToolsPipeline } from '../pipeline.js';
import { createSchemaProbe } from '../schema-probe.js';
import { renderChatComponentManifest, scanChatComponents } from './chat-components.js';

afterEach(removeAppFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler' } });
const WIDGET = "import { z } from 'zod';\nimport { defineChatComponent, bindable } from 'glirastes';\n"
  + 'export const orderCard = defineChatComponent({\n'
  + "  id: 'OrderCard',\n  schemaVersion: 1,\n  description: 'One order with its status.',\n"
  + "  props: z.object({ title: bindable(z.string()), status: z.enum(['open', 'shipped']) }),\n"
  + "  text: { label: 'title' },\n});\n";

/** `glirastes` resolves to this checkout (its built `dist`), as it would from the app's node_modules. */
async function linkSdk(fixture: AppFixture): Promise<void> {
  await mkdir(fixture.path('node_modules'), { recursive: true });
  await symlink(SDK_ROOT, fixture.path('node_modules/glirastes'), 'dir');
}

async function appWith(files: Record<string, string>): Promise<AppFixture> {
  const fixture = await createAppFixture({ 'tsconfig.json': TSCONFIG, ...files });
  await linkSdk(fixture);
  return fixture;
}

describe('chat component manifest scan', { timeout: 60_000 }, () => {
  it('collects an exported definition into the manifest the SDK itself produces', async () => {
    const fixture = await appWith({ 'src/chat/order-card.ts': WIDGET });
    const scan = await scanChatComponents(fixture.root, createSchemaProbe());
    expect(scan.findings).toEqual([]);
    const expected = toChatComponentManifest([defineChatComponent({
      id: 'OrderCard',
      schemaVersion: 1,
      description: 'One order with its status.',
      props: z.object({ title: z.string(), status: z.enum(['open', 'shipped']) }),
      text: { label: 'title' },
    })]);
    expect(scan.manifest?.components.map((entry) => entry.id)).toEqual(['OrderCard']);
    expect(scan.manifest?.components[0]?.props).toEqual(expected.components[0]?.props);
    expect(scan.manifest?.components[0]?.bindable).toEqual(['title']);
    expect(chatComponentManifestSchema.safeParse(scan.manifest).success).toBe(true);
    expect(renderChatComponentManifest(scan.manifest!).endsWith('}\n')).toBe(true);
  });

  it('finds nothing in an app without definitions', async () => {
    const fixture = await appWith({ 'src/lib/util.ts': 'export const answer = 42;\n' });
    expect(await scanChatComponents(fixture.root, createSchemaProbe())).toEqual({ findings: [] });
  });

  it('ignores a same-named local function and reports a definition that is not exported', async () => {
    const fixture = await appWith({
      'src/local.ts': 'function defineChatComponent(input: unknown) { return input; }\nexport const x = defineChatComponent({});\n',
      'src/hidden.ts': WIDGET.replace('export const', 'const'),
    });
    const scan = await scanChatComponents(fixture.root, createSchemaProbe());
    expect(scan.manifest).toBeUndefined();
    expect(scan.findings.map((finding) => finding.code)).toEqual(['chat-component-not-exported']);
  });

  it('reports a definition whose props cannot be JSON Schema, with the SDK message', async () => {
    const fixture = await appWith({
      'src/chat/bad.ts': WIDGET.replace("title: bindable(z.string())", 'title: z.string().transform((value) => value.length)'),
    });
    const scan = await scanChatComponents(fixture.root, createSchemaProbe());
    expect(scan.manifest).toBeUndefined();
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]).toMatchObject({ code: 'chat-component-invalid', severity: 'error' });
    expect(scan.findings[0]!.message).toContain('JSON Schema');
  });

  it('reports one id and version defined twice', async () => {
    const fixture = await appWith({
      'src/chat/a.ts': WIDGET,
      'src/chat/b.ts': WIDGET.replace('orderCard', 'otherCard'),
    });
    const scan = await scanChatComponents(fixture.root, createSchemaProbe());
    expect(scan.manifest).toBeUndefined();
    expect(scan.findings.map((finding) => finding.code)).toEqual(['chat-component-invalid']);
  });

  it('writes .glirastes/chat-components.json from the pipeline, and no file when there are no definitions', async () => {
    const withComponent = await appWith({
      'src/app/api/ping/route.ts': "export async function GET() { return Response.json({ ok: true }); }\n",
      'src/chat/order-card.ts': WIDGET,
    });
    const written = await runToolsPipeline({ root: withComponent.root, mode: 'write' });
    expect(written.outputs[TOOLS_PATHS.chatComponents]).toBeDefined();
    const manifest = chatComponentManifestSchema.parse(JSON.parse(await withComponent.read(TOOLS_PATHS.chatComponents)));
    expect(manifest.components.map((entry) => entry.id)).toEqual(['OrderCard']);
    const again = await runToolsPipeline({ root: withComponent.root, mode: 'write' });
    expect(again.wrote).toBe(false);

    const without = await appWith({
      'src/app/api/ping/route.ts': "export async function GET() { return Response.json({ ok: true }); }\n",
    });
    const result = await runToolsPipeline({ root: without.root, mode: 'write' });
    expect(result.outputs[TOOLS_PATHS.chatComponents]).toBeUndefined();
    expect(await without.read(TOOLS_PATHS.chatComponents).catch(() => 'absent')).toBe('absent');
  });
});
