import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonSchemaLike, type LocalJsonSchema } from '../../runtime/json-schema.js';
import { createAppFixture, FIXTURE_APP_ID, FIXTURE_PROMPT_BUNDLE, removeAppFixtures, SDK_ROOT } from './__tests__/app-fixture.js';
import { runToolsPipeline, type ToolsPipelineResult, type ToolsPipelineTool } from './pipeline.js';

afterEach(removeAppFixtures);

const OPENAPI_SOURCE = { sources: [{ kind: 'openapi', document: 'openapi.json' }] };
const FIXTURE = join(SDK_ROOT, 'examples/openapi-3.0.tasks.json');

/** The input validator exactly as the generated module builds it at runtime. */
function inputValidator(tool: ToolsPipelineTool) {
  const source = tool.contract!.runtime.input;
  if (source.kind !== 'json') throw new Error(`${tool.stableKey} has a ${source.kind} input`);
  return createJsonSchemaLike(source.schema);
}

function accepts(tool: ToolsPipelineTool, value: unknown): boolean {
  return inputValidator(tool).safeParse(value).success;
}

describe('an OpenAPI 3.0 export through the tools pipeline', () => {
  it('generates the tools with nullability the runtime validator honours', async () => {
    const fixture = await createAppFixture({ 'openapi.json': await readFile(FIXTURE, 'utf8') }, { toolsConfig: OPENAPI_SOURCE });
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });

    expect(result.wrote).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).not.toContain('schema-reference-unresolved');
    expect(result.excluded).toEqual([{ stableKey: 'POST /api/tasks/:taskId/attachments', reason: 'unsupported-body', origin: 'code' }]);
    const tools = new Map((result.tools ?? []).map((tool) => [tool.stableKey, tool]));
    expect([...tools.keys()].sort()).toEqual([
      'GET /api/tags', 'GET /api/tasks', 'GET /api/tasks/:taskId', 'PATCH /api/tasks/:taskId', 'POST /api/tasks',
    ]);
    // A required header cannot be sent by a tool call; the tool needs attention.
    expect(tools.get('GET /api/tags')!.findings.map((finding) => finding.code)).toContain('input-role-unsupported');

    const list = tools.get('GET /api/tasks')!;
    expect(list.contract!.input).toMatchObject({
      properties: {
        status: { type: ['string', 'null'], enum: ['open', 'done', null] },
        search: { type: ['string', 'null'] },
        limit: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
        minScore: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
      },
    });
    expect(accepts(list, { status: null, search: null, limit: null })).toBe(true);
    expect(accepts(list, { status: 'archived' })).toBe(false);
    expect(accepts(list, { minScore: 0 })).toBe(false);
    expect(accepts(list, { minScore: 10 })).toBe(true);

    const create = tools.get('POST /api/tasks')!;
    expect(create.params).toMatchObject({ body: expect.arrayContaining(['title', 'tag', 'nullable']) });
    expect(accepts(create, {
      title: 'Write the docs', notes: null, priority: null, estimate: null, position: null, done: null,
      meta: null, tagIds: null, tag: null, nullable: true,
    })).toBe(true);
    expect(accepts(create, {
      title: 'Write the docs', priority: 'high', estimate: 2.5, meta: { a: 'b' }, tagIds: ['t'],
      tag: { id: 'tag-1', name: 'docs', color: null }, reminder: { channel: 'email', address: 'a@example.com' },
    })).toBe(true);
    expect(accepts(create, { title: 'x', notes: 5 })).toBe(false);
    expect(accepts(create, { title: 'x', priority: 'urgent' })).toBe(false);
    expect(accepts(create, { title: 'x', estimate: 0 })).toBe(false);
    expect(accepts(create, { title: 'x', estimate: 1000 })).toBe(false);
    expect(accepts(create, { title: 'x', tag: { name: 'no id' } })).toBe(false);
    expect(accepts(create, { title: 'x', nullable: 'yes' })).toBe(false);
    expect(accepts(create, { title: null })).toBe(false);

    const update = tools.get('PATCH /api/tasks/:taskId')!;
    expect(accepts(update, { taskId: 't-1', notes: null, done: null, position: null, tag: null })).toBe(true);
    expect(accepts(update, { taskId: 't-1', done: 'yes' })).toBe(false);

    const get = tools.get('GET /api/tasks/:taskId')!;
    const output = get.contract!.output!;
    expect(output).toMatchObject({ description: 'The task, or null when it was archived', anyOf: [{}, { type: 'null' }] });
    expect(createJsonSchemaLike(output).safeParse(null).success).toBe(true);
  });

  it('reports a nullable request body as an input that is not an object', async () => {
    const document = JSON.parse(await readFile(FIXTURE, 'utf8')) as {
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } }>>;
    };
    document.paths['/api/tasks']!.post!.requestBody!.content['application/json']!.schema.nullable = true;
    const fixture = await createAppFixture({ 'openapi.json': JSON.stringify(document) }, { toolsConfig: OPENAPI_SOURCE });
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });

    const create = result.tools!.find((tool) => tool.stableKey === 'POST /api/tasks')!;
    expect(create.enabled).toBe(false);
    expect(create.findings.map((finding) => finding.code)).toContain('input-schema-not-object');
  });
});

/**
 * A larger real-world export, never committed: point GLIRASTES_TEST_OPENAPI_SPEC
 * at an OpenAPI 3.0 or 3.1 JSON file. The file is linked, not copied, into a
 * temporary app outside the repository, and only generic properties are checked.
 * GLIRASTES_TEST_OPENAPI_SELECTION=opt-in reads it with the opt-in selection,
 * GLIRASTES_TEST_OPENAPI_LOCALE sets the label locale (en-US by default).
 */
const EXTERNAL_SPEC = process.env.GLIRASTES_TEST_OPENAPI_SPEC;
const EXTERNAL_SELECTION = process.env.GLIRASTES_TEST_OPENAPI_SELECTION === 'opt-in' ? 'opt-in' : 'all';
const EXTERNAL_LOCALE = process.env.GLIRASTES_TEST_OPENAPI_LOCALE ?? 'en-US';

describe.skipIf(!EXTERNAL_SPEC)('an external OpenAPI export (GLIRASTES_TEST_OPENAPI_SPEC)', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('completes with compilable input schemas', async () => {
    root = await mkdtemp(join(tmpdir(), 'glirastes-openapi-'));
    await mkdir(join(root, '.glirastes'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'openapi-check', private: true, type: 'module' }));
    await writeFile(join(root, '.glirastes/prompt-bundle.json'), JSON.stringify(FIXTURE_PROMPT_BUNDLE));
    await writeFile(join(root, '.glirastes/tools.json'), JSON.stringify({
      schemaVersion: 1,
      appId: FIXTURE_APP_ID,
      targetAppKey: 'openapi-check',
      locale: EXTERNAL_LOCALE,
      sources: [{ kind: 'openapi', document: 'openapi.json', selection: EXTERNAL_SELECTION }],
    }));
    await symlink(EXTERNAL_SPEC!, join(root, 'openapi.json'));

    const result: ToolsPipelineResult = await runToolsPipeline({ root, mode: 'write', keepGoing: true });
    const tools = result.tools ?? [];
    const count = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
    const artifact = JSON.parse(result.outputs['.glirastes/setup-artifact.json']!) as {
      tools: Array<{ name: string; module?: string; allowedRoles?: string[]; enabled: boolean; presentation?: { singular: string } }>;
    };
    console.info(JSON.stringify({
      selection: EXTERNAL_SELECTION,
      tools: tools.length,
      excluded: count(result.excluded.map((entry) => entry.reason)),
      findings: count(result.findings.map((finding) => `${finding.severity} ${finding.code}`)),
      ...(EXTERNAL_SELECTION === 'opt-in'
        ? {
          toolDetails: artifact.tools.map((tool) => ({
            name: tool.name, module: tool.module, allowedRoles: tool.allowedRoles, enabled: tool.enabled, label: tool.presentation?.singular,
          })),
        }
        : {}),
    }, null, 2));

    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(result.wrote).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    if (EXTERNAL_SELECTION === 'opt-in') {
      // Only marked operations are tools, and an operation that is no tool reports nothing about its extensions.
      const notOptedIn = new Set(result.excluded.filter((entry) => entry.reason === 'not-opted-in').map((entry) => entry.stableKey));
      expect(result.findings.filter((finding) => notOptedIn.has(finding.subjectRef) && finding.code !== 'tool-marker-invalid')).toEqual([]);
      expect(result.findings.map((finding) => finding.code)).not.toContain('tool-roles-invalid');
    }
    expect(result.findings.map((finding) => finding.code)).not.toContain('schema-reference-unresolved');
    for (const tool of tools) {
      const input = tool.contract?.runtime.input;
      if (input?.kind !== 'json') continue;
      expect(() => createJsonSchemaLike(input.schema as LocalJsonSchema), tool.stableKey).not.toThrow();
    }
  }, 60_000);
});
