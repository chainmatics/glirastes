import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { z as zodV3 } from 'zod-v3';
import { createLocalSchemaDigest } from '../../runtime/local-tool-bindings.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { createSchemaProbe, type SchemaProbeItem } from './schema-probe.js';

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeAppFixtures();
});

const schemaItem = (module: string, exportName = 'schema', io: 'input' | 'output' = 'input'): SchemaProbeItem => ({
  kind: 'schema', io, module, export: exportName, property: [],
});

describe('schema probe', () => {
  it('probes TypeScript schemas through a tsconfig alias and .js-suffixed imports', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/fields.ts': "import { z } from 'zod';\nexport const title = z.string().min(1).describe('Note title');\n",
      'src/lib/notes.ts': "import { z } from 'zod';\nimport { title } from '@/lib/fields';\n"
        + "export const createNote = z.object({ title }).strict().describe('Create a note');\n",
      'src/app/api/notes/schemas.ts': "export { createNote } from '../../../lib/notes.js';\n",
    });
    const [result] = await createSchemaProbe().probe(app.root, [schemaItem('src/app/api/notes/schemas.ts', 'createNote')]);
    const expected = z.object({ title: z.string().min(1).describe('Note title') }).strict().describe('Create a note');
    expect(result).toMatchObject({
      ok: true, kind: 'schema', digest: createLocalSchemaDigest(expected), description: 'Create a note',
    });
    const json = result?.ok && result.kind === 'schema' ? result.jsonSchema : null;
    expect(json).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: { title: { type: 'string', minLength: 1 } },
    });
    expect(json).not.toHaveProperty('$schema');
  }, 30_000);

  it('reads contract entries and reports a missing method entry', async () => {
    const app = await createAppFixture({
      'src/app/api/notes/contract.ts': "import { z } from 'zod';\nexport const contract = {\n"
        + "  POST: { input: z.object({ title: z.string() }), output: z.object({ id: z.string() }),\n"
        + "    description: 'Create a note', effect: 'write', id: 'notes.add', usageHints: ['Use to add a note'] },\n};\n",
    });
    const entry = (method: string): SchemaProbeItem => ({
      kind: 'contract-entry', io: 'input', module: 'src/app/api/notes/contract.ts', export: 'contract', property: [method],
    });
    const [post, get] = await createSchemaProbe().probe(app.root, [entry('POST'), entry('GET')]);
    expect(post).toMatchObject({
      ok: true, kind: 'contract-entry', description: 'Create a note', effect: 'write', id: 'notes.add',
      usageHints: ['Use to add a note'], input: { ok: true, kind: 'schema' }, output: { ok: true, kind: 'schema' },
    });
    expect(post?.ok && post.kind === 'contract-entry' ? post.moduleDigest : '').toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(get).toEqual({ ok: false, reason: 'missing' });
  }, 30_000);

  it('flags a mistyped effect and an invalid presentation instead of silently dropping them', async () => {
    const app = await createAppFixture({
      'src/app/api/notes/contract.ts': "import { z } from 'zod';\nexport const contract = {\n"
        + "  GET: { input: z.object({}), effect: 'read', presentation: { locale: 'en', singular: 'note', plural: 'notes', approval: 'List notes' } },\n"
        + "  POST: { input: z.object({}), effect: 'destructve' },\n"
        + "  PUT: { input: z.object({}), presentation: { locale: 'en', singular: 'note' } },\n"
        + "  PATCH: { input: z.object({}), effect: 'destructve', presentation: { locale: 'x' } },\n"
        + '  DELETE: { input: z.object({}) },\n};\n',
    });
    const entry = (method: string): SchemaProbeItem => ({
      kind: 'contract-entry', io: 'input', module: 'src/app/api/notes/contract.ts', export: 'contract', property: [method],
    });
    const results = await createSchemaProbe().probe(app.root, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(entry));
    const [get, post, put, patch, del] = results.map((result) => (
      result.ok && result.kind === 'contract-entry' ? result : undefined
    ));
    expect(get).toMatchObject({ effect: 'read', presentation: { singular: 'note' } });
    expect(get).not.toHaveProperty('invalidFields');
    expect(del).toMatchObject({ effect: null, presentation: null });
    expect(del).not.toHaveProperty('invalidFields');
    expect(post).toMatchObject({ effect: null, presentation: null, invalidFields: ['effect'] });
    expect(put).toMatchObject({ effect: null, presentation: null, invalidFields: ['presentation'] });
    expect(patch).toMatchObject({ effect: null, presentation: null, invalidFields: ['effect', 'presentation'] });
    // Only the field names travel; the invalid value is never carried and does not change the digest.
    expect(JSON.stringify(results)).not.toContain('destructve');
    expect(post?.moduleDigest).toBe(del?.moduleDigest);
  }, 30_000);

  it('fails closed per module and never hands app secrets to the child', async () => {
    vi.stubEnv('GLIRASTES_PROBE_SECRET', 'super-secret');
    const app = await createAppFixture({
      'src/value.ts': 'export const value = 42;\n',
      'src/broken.ts': "throw new Error('database unavailable');\nexport const schema = 1;\n",
      'src/secret-aware.ts': "import { z } from 'zod';\n"
        + "if (process.env.GLIRASTES_PROBE_SECRET !== undefined) throw new Error('secret leaked');\n"
        + 'export const schema = z.object({ q: z.string() });\n',
      'src/app/api/items/contract.js': "import { z } from 'zod';\nexport const inputSchema = z.object({ status: z.string().optional() });\n",
    });
    const results = await createSchemaProbe().probe(app.root, [
      schemaItem('src/value.ts', 'value'),
      schemaItem('src/broken.ts'),
      schemaItem('src/secret-aware.ts'),
      schemaItem('src/app/api/items/contract.js', 'inputSchema'),
    ]);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason)))
      .toEqual(['not-a-schema', 'import-failed', 'ok', 'ok']);
  }, 30_000);

  it('rejects schemas and contract metadata that carry a secret-looking string', async () => {
    const bearer = `Bearer ${'a1b2c3d4'.repeat(3)}`;
    const app = await createAppFixture({
      'src/leaky.ts': "import { z } from 'zod';\n"
        + `export const defaulted = z.object({ auth: z.string().default('${bearer}') });\n`
        + `export const described = z.object({ q: z.string() }).describe('${bearer}');\n`
        + "export const clean = z.object({ q: z.string().describe('Search text') });\n"
        + 'export const contract = {\n'
        + "  POST: { input: z.object({ q: z.string() }), usageHints: ['Use to search'] },\n"
        + `  PUT: { input: z.object({ q: z.string() }), usageHints: ['${bearer}'] },\n`
        + `  PATCH: { input: z.object({ q: z.string() }), output: z.object({ auth: z.literal('${bearer}') }) },\n`
        + '};\n',
    });
    const entry = (method: string): SchemaProbeItem => ({
      kind: 'contract-entry', io: 'input', module: 'src/leaky.ts', export: 'contract', property: [method],
    });
    const results = await createSchemaProbe().probe(app.root, [
      schemaItem('src/leaky.ts', 'defaulted'),
      schemaItem('src/leaky.ts', 'described'),
      schemaItem('src/leaky.ts', 'clean'),
      entry('POST'),
      entry('PUT'),
      entry('PATCH'),
    ]);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual([
      'content-rejected', 'content-rejected', 'ok', 'ok', 'content-rejected', 'content-rejected',
    ]);
    expect(JSON.stringify(results)).not.toContain(bearer);
  }, 30_000);

  it('isolates a module that kills the probe and rejects malformed contract entries', async () => {
    const app = await createAppFixture({
      'src/exits.ts': 'process.exit(3);\nexport const schema = 1;\n',
      'src/fine.ts': "import { z } from 'zod';\nexport const schema = z.object({ q: z.string() });\n",
      'src/contract.ts': "import { z } from 'zod';\nexport const contract = {\n"
        + "  GET: { input: 'not a schema' },\n"
        + '  POST: { input: z.object({}), output: 7 },\n'
        + '  PUT: 7,\n'
        + '};\n',
    });
    const entry = (method: string): SchemaProbeItem => ({
      kind: 'contract-entry', io: 'input', module: 'src/contract.ts', export: 'contract', property: [method],
    });
    const results = await createSchemaProbe().probe(app.root, [
      schemaItem('src/exits.ts'),
      schemaItem('src/fine.ts'),
      entry('GET'),
      entry('POST'),
      entry('PUT'),
    ]);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason)))
      .toEqual(['probe-failed', 'ok', 'invalid-entry', 'invalid-entry', 'invalid-entry']);
  }, 30_000);

  it('keeps import-time stdout output of app modules out of the result channel', async () => {
    const app = await createAppFixture({
      'src/chatty-value.ts': "console.log('hello');\nexport const value = 42;\n",
      'src/chatty-schema.ts': "import { z } from 'zod';\n"
        + "console.log('startup banner');\n"
        + "process.stdout.write('{\"results\":[]}\\n');\n"
        + 'export const schema = z.object({ q: z.string() });\n',
      'src/fine.ts': "import { z } from 'zod';\nexport const schema = z.object({ q: z.string() });\n",
    });
    const results = await createSchemaProbe().probe(app.root, [
      schemaItem('src/chatty-value.ts', 'value'),
      schemaItem('src/chatty-schema.ts'),
      schemaItem('src/fine.ts'),
    ]);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason)))
      .toEqual(['not-a-schema', 'ok', 'ok']);
    expect(results[1]).toEqual(results[2]);
  }, 30_000);

  it('returns a result far larger than a pipe buffer intact', async () => {
    const app = await createAppFixture({
      'src/large.ts': "import { z } from 'zod';\n"
        + 'export const schema = z.enum(Array.from({ length: 40_000 }, (_, index) => `value-${index}`) as [string, ...string[]]);\n',
    });
    const [result] = await createSchemaProbe().probe(app.root, [schemaItem('src/large.ts')]);
    const json = result?.ok && result.kind === 'schema' ? result.jsonSchema : null;
    expect(result).toMatchObject({ ok: true, kind: 'schema' });
    expect((json as { enum?: string[] } | null)?.enum).toHaveLength(40_000);
  }, 30_000);

  it('times out a hanging module without losing the other modules of its batch', async () => {
    const app = await createAppFixture({
      'src/hangs.ts': 'setInterval(() => {}, 1_000);\nawait new Promise(() => {});\nexport const schema = 1;\n',
      'src/fine.ts': "import { z } from 'zod';\nexport const schema = z.object({ q: z.string() });\n",
    });
    const results = await createSchemaProbe({ timeoutMs: 1_500 }).probe(app.root, [
      schemaItem('src/hangs.ts'),
      schemaItem('src/fine.ts'),
    ]);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual(['timeout', 'ok']);
  }, 30_000);

  it('digests zod v3 schemas and leaves JSON Schema empty without zod-to-json-schema', async () => {
    const app = await createAppFixture({
      'src/legacy.ts': "import { z } from 'zod-v3';\nexport const schema = z.object({ q: z.string() });\n",
    });
    const [result] = await createSchemaProbe().probe(app.root, [schemaItem('src/legacy.ts')]);
    expect(result).toEqual({
      ok: true,
      kind: 'schema',
      digest: createLocalSchemaDigest(zodV3.object({ q: zodV3.string() })),
      jsonSchema: null,
      description: null,
    });
  }, 30_000);
});
