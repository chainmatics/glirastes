import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ToolSourceContext } from '../types.js';
import { createOpenapiEndpointSource, type OpenapiSourceOptions } from './openapi-endpoints.js';

afterEach(removeAppFixtures);

const SECURED = [{ APIKeyCookie: [] }];
const TASK = {
  type: 'object',
  title: 'Task',
  properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: ['open', 'done'] } },
  required: ['id', 'title', 'status'],
};
const TASK_CREATE = {
  type: 'object',
  title: 'TaskCreate',
  properties: { title: { type: 'string', minLength: 1, maxLength: 120 } },
  required: ['title'],
};
const TASK_PATHS = {
  '/api/tasks': {
    get: {
      summary: 'List Tasks',
      description: 'Lists the tasks of the signed-in user.',
      security: SECURED,
      parameters: [{ name: 'status', in: 'query', required: false, schema: { anyOf: [{ type: 'string', enum: ['open', 'done'] }, { type: 'null' }] } }],
      responses: {
        '200': { description: 'Tasks', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } } },
        '422': { description: 'Validation Error' },
      },
    },
    post: {
      summary: 'Create Task',
      security: SECURED,
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskCreate' } } } },
      responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } } } },
    },
  },
  '/api/tasks/{task_id}': {
    delete: {
      summary: 'Delete Task',
      security: SECURED,
      'x-glirastes-effect': 'destructive',
      parameters: [{ name: 'task_id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted' } },
    },
  },
};

function documentOf(paths: Readonly<Record<string, unknown>>, extra: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Tasks API', version: '1.0.0' },
    paths,
    components: {
      schemas: { Task: TASK, TaskCreate: TASK_CREATE },
      securitySchemes: { APIKeyCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
    },
    ...extra,
  }, null, 2)}\n`;
}

const MAIN_PY = [
  'from fastapi import APIRouter, FastAPI',
  '',
  'app = FastAPI()',
  "router = APIRouter(prefix='/api/tasks')",
  '',
  '',
  "@router.get('')",
  'def list_tasks(status: str | None = None):',
  '    return []',
  '',
  '',
  "@router.post('', status_code=201)",
  'def create_task():',
  '    return {}',
  '',
  '',
  "@router.delete('/{task_id}', status_code=204)",
  'def delete_task(task_id: str):',
  '    return None',
  '',
  '',
  "@app.get('/internal/health', include_in_schema=False)",
  'def health():',
  "    return {'ok': True}",
  '',
  '',
  'app.include_router(router)',
  '',
].join('\n');

function context(root: string): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

async function observe(files: Readonly<Record<string, string>>, options: OpenapiSourceOptions = {}) {
  const source = { kind: 'openapi', document: 'api/openapi.json', ...(options.fastapi ? { fastapi: options.fastapi } : {}) };
  const app = await createAppFixture(files, { toolsConfig: { sources: [source] } });
  return createOpenapiEndpointSource({ document: 'api/openapi.json', ...options }).observe(context(app.root));
}

describe('OpenAPI endpoint source', () => {
  it('reads every operation with the schemas the server validates', async () => {
    const observed = await observe({ 'api/openapi.json': documentOf(TASK_PATHS) });

    expect(observed.complete).toBe(true);
    expect(observed.findings).toEqual([]);
    expect(observed.observations.map((tool) => [tool.execution.stableKey, tool.execution.definitionId])).toEqual([
      ['DELETE /api/tasks/:task_id', 'tasks.delete'],
      ['GET /api/tasks', 'tasks.list'],
      ['POST /api/tasks', 'tasks.create'],
    ]);
    const [remove, list, create] = observed.observations;
    expect(list!.execution).toMatchObject({ sourceKind: 'openapi', sourceFile: 'api/openapi.json', method: 'GET', path: '/api/tasks' });
    expect(list!.contract).toMatchObject({
      source: 'openapi',
      loadBearing: true,
      input: {
        type: 'object',
        properties: { status: { anyOf: [{ type: 'string', enum: ['open', 'done'] }, { type: 'null' }] } },
        additionalProperties: false,
      },
      output: { type: 'array', items: TASK },
      params: { path: [], query: ['status'], body: [] },
    });
    expect(list!.evidence).toEqual({ authEvidence: true, externalCall: false, jsDoc: 'Lists the tasks of the signed-in user.' });
    expect(create!.contract).toMatchObject({ input: TASK_CREATE, output: TASK, params: { body: ['title'] } });
    expect(create!.evidence.jsDoc).toBe('Create Task');
    expect(remove!.contract!.input).toEqual({
      type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false,
    });
    expect(remove!.evidence.declaredEffect).toBe('destructive');
  });

  it('keeps an operation without a security requirement disabled; document security counts', async () => {
    const paths = structuredClone(TASK_PATHS) as Record<string, Record<string, Record<string, unknown>>>;
    delete paths['/api/tasks']!.get!.security;
    paths['/api/tasks']!.post!.security = [];
    const local = await observe({ 'api/openapi.json': documentOf(paths) });
    expect(local.observations.filter((tool) => !tool.evidence.authEvidence).map((tool) => tool.execution.stableKey))
      .toEqual(['GET /api/tasks', 'POST /api/tasks']);
    expect(local.observations[1]!.findings).toEqual([expect.objectContaining({ code: 'auth-evidence-missing' })]);

    const global = await observe({ 'api/openapi.json': documentOf(paths, { security: SECURED }) });
    expect(global.observations.filter((tool) => !tool.evidence.authEvidence).map((tool) => tool.execution.stableKey))
      .toEqual(['POST /api/tasks']);
  });

  it('reports operations it does not turn into tools instead of dropping them', async () => {
    const observed = await observe({
      'api/openapi.json': documentOf({
        ...TASK_PATHS,
        '/api/tasks/export': { options: { security: SECURED, responses: { '200': { description: 'ok' } } } },
        '/api/files/{name}.json': { get: { security: SECURED, responses: { '200': { description: 'ok' } } } },
        '/api/uploads': {
          post: {
            security: SECURED,
            requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/api/internal/reindex': { post: { security: SECURED, 'x-glirastes-ignore': true, responses: { '200': { description: 'ok' } } } },
      }),
    });

    expect(observed.complete).toBe(true);
    expect(observed.observations).toHaveLength(3);
    expect(observed.excluded).toEqual([
      { stableKey: 'GET /api/files/{name}.json', reason: 'unsupported-path', origin: 'code' },
      { stableKey: 'OPTIONS /api/tasks/export', reason: 'unsupported-method', origin: 'code' },
      { stableKey: 'POST /api/internal/reindex', reason: 'ai-ignore', origin: 'code' },
      { stableKey: 'POST /api/uploads', reason: 'unsupported-body', origin: 'code' },
    ]);
  });

  it('names an invalid x-glirastes-effect and a recursive schema instead of guessing', async () => {
    const paths = structuredClone(TASK_PATHS) as Record<string, Record<string, Record<string, unknown>>>;
    paths['/api/tasks/{task_id}']!.delete!['x-glirastes-effect'] = 'erase';
    paths['/api/tasks']!.post!.requestBody = {
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
    };
    const document = JSON.parse(documentOf(paths)) as { components: { schemas: Record<string, unknown> } };
    document.components.schemas.Node = {
      type: 'object', properties: { title: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } },
    };
    const observed = await observe({ 'api/openapi.json': JSON.stringify(document) });

    const byKey = new Map(observed.observations.map((tool) => [tool.execution.stableKey, tool]));
    expect(byKey.get('DELETE /api/tasks/:task_id')!.evidence.declaredEffect).toBeUndefined();
    expect(byKey.get('DELETE /api/tasks/:task_id')!.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['contract-effect-invalid', 'needs_attention'],
      // 204 No Content: there is no response schema to show the model.
      ['output-contract-opaque', 'warning'],
    ]);
    const create = byKey.get('POST /api/tasks')!;
    expect(create.findings).toEqual([expect.objectContaining({ code: 'schema-reference-unresolved', severity: 'warning' })]);
    expect(create.findings[0]!.message).toContain('recursive reference #/components/schemas/Node');
    expect(create.contract!.input).toMatchObject({ properties: { children: { type: 'array', items: {} } } });
  });

  it.each([
    ['an OpenAPI 3.2 export', documentOf(TASK_PATHS).replace('"3.1.0"', '"3.2.0"'), 'is OpenAPI 3.2.0'],
    ['a Swagger 2.0 export', JSON.stringify({ swagger: '2.0', paths: {} }), 'is not an OpenAPI document'],
    ['a file that is not JSON', '{ openapi: 3.1.0 }', 'is not valid JSON'],
  ])('stops with E-INVENTORY-011 for %s', async (_label, text, reason) => {
    const observed = await observe({ 'api/openapi.json': text });

    expect(observed.complete).toBe(false);
    expect(observed.findings).toEqual([expect.objectContaining({ code: 'E-INVENTORY-011', severity: 'error' })]);
    expect(observed.findings[0]!.message).toContain(`api/openapi.json ${reason}`);
  });

  it('reads an OpenAPI 3.0 export with nullable parameters as their 3.1 shape', async () => {
    const paths = structuredClone(TASK_PATHS) as Record<string, Record<string, Record<string, unknown>>>;
    paths['/api/tasks']!.get!.parameters = [
      { name: 'status', in: 'query', required: false, schema: { type: 'string', nullable: true, enum: ['open', 'done'] } },
    ];
    const observed = await observe({ 'api/openapi.json': documentOf(paths).replace('"3.1.0"', '"3.0.3"') });

    expect(observed.complete).toBe(true);
    expect(observed.findings).toEqual([]);
    const list = observed.observations.find((tool) => tool.execution.stableKey === 'GET /api/tasks')!;
    expect(list.contract!.input).toMatchObject({
      properties: { status: { type: ['string', 'null'], enum: ['open', 'done', null] } },
    });
  });

  it('names the operation whose schema the runtime validator cannot compile', async () => {
    const paths = structuredClone(TASK_PATHS) as Record<string, Record<string, Record<string, unknown>>>;
    // A 3.0 keyword in a 3.1 document is kept as written, and Ajv rejects it.
    paths['/api/tasks']!.get!.parameters = [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 0, exclusiveMinimum: true } },
    ];
    const observed = await observe({ 'api/openapi.json': documentOf(paths) });

    expect(observed.complete).toBe(true);
    expect(observed.findings).toEqual([expect.objectContaining({
      code: 'schema-uncompilable', severity: 'error', subjectRef: 'GET /api/tasks',
    })]);
    expect(observed.findings[0]!.message).toBe(
      'api/openapi.json GET /api/tasks has a schema the JSON Schema validator cannot compile: schema is invalid: data/properties/limit/exclusiveMinimum must be number',
    );
    expect(observed.observations.map((tool) => tool.execution.stableKey)).toEqual(['DELETE /api/tasks/:task_id', 'POST /api/tasks']);
  });

  it('keeps a nullable request body visible instead of reading it as an object', async () => {
    const paths = structuredClone(TASK_PATHS) as Record<string, Record<string, Record<string, unknown>>>;
    const nullableBody = { content: { 'application/json': { schema: { ...TASK_CREATE, nullable: true } } } };
    paths['/api/tasks']!.post!.requestBody = nullableBody;
    paths['/api/tasks/{task_id}']!.patch = {
      security: SECURED,
      parameters: [{ name: 'task_id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: nullableBody,
      responses: { '200': { description: 'ok' } },
    };
    const observed = await observe({ 'api/openapi.json': documentOf(paths).replace('"3.1.0"', '"3.0.3"') });
    const byKey = new Map(observed.observations.map((tool) => [tool.execution.stableKey, tool]));

    // Alone, the body stays the whole input; the pipeline then reports
    // input-schema-not-object and keeps the tool disabled (openapi-3-0.test.ts).
    const create = byKey.get('POST /api/tasks')!;
    expect(create.contract!.input).toMatchObject({ type: ['object', 'null'] });
    // Next to a path parameter, it cannot be merged, and says so.
    const update = byKey.get('PATCH /api/tasks/:task_id')!;
    expect(update.contract).toBeUndefined();
    expect(update.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'input-role-unsupported', severity: 'needs_attention',
    })]));
  });
});

const TAG_PATHS = {
  '/api/tags': {
    get: {
      summary: 'List tags', security: SECURED,
      'x-glirastes-tool': true, 'x-glirastes-name': 'list_tags', 'x-glirastes-group': 'tag', 'x-glirastes-roles': ['tag.read', 'admin', 'tag.read'],
      responses: { '200': { description: 'ok' } },
    },
    // Not a tool: its roles, name, group and effect are never read, even malformed.
    post: {
      summary: 'Create tag', security: SECURED,
      'x-glirastes-roles': 'tag.write', 'x-glirastes-name': 42, 'x-glirastes-group': '', 'x-glirastes-effect': 'erase',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
      responses: { '201': { description: 'ok' } },
    },
  },
  '/api/tags/{tag_id}': {
    delete: {
      summary: 'Delete tag', security: SECURED, 'x-glirastes-tool': false, 'x-glirastes-roles': ['tag.delete'],
      parameters: [{ name: 'tag_id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Deleted' } },
    },
  },
};

async function observeWith(
  paths: Readonly<Record<string, unknown>>,
  options: OpenapiSourceOptions = {},
  exclude: Array<{ match: string; reason: string }> = [],
) {
  const app = await createAppFixture({ 'api/openapi.json': documentOf(paths) }, {
    toolsConfig: { sources: [{ kind: 'openapi', document: 'api/openapi.json' }] },
  });
  const ctx = context(app.root);
  ctx.policy = ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude, acceptedRisk: {} });
  return createOpenapiEndpointSource({ document: 'api/openapi.json', ...options }).observe(ctx);
}

const codes = (findings: ReadonlyArray<{ code: string; severity: string; subjectRef: string }>) => (
  findings.map((finding) => [finding.code, finding.severity, finding.subjectRef])
);

describe('OpenAPI selection and x-glirastes-* extensions', () => {
  it('turns only marked operations into tools with opt-in, and reports nothing about the others', async () => {
    const observed = await observeWith(TAG_PATHS, { selection: 'opt-in' });

    expect(observed.complete).toBe(true);
    expect(observed.findings).toEqual([]);
    expect(observed.excluded).toEqual([
      { stableKey: 'DELETE /api/tags/:tag_id', reason: 'opted-out', origin: 'code' },
      { stableKey: 'POST /api/tags', reason: 'not-opted-in', origin: 'code' },
    ]);
    expect(observed.observations).toHaveLength(1);
    const [list] = observed.observations;
    expect(list!.execution).toMatchObject({ stableKey: 'GET /api/tags', definitionId: 'list_tags' });
    expect(list!.prose).toEqual({ module: 'tag' });
    expect(list!.codeRoles).toEqual(['admin', 'tag.read']);
    expect(codes(list!.findings)).toEqual([['output-contract-opaque', 'warning', 'GET /api/tags']]);
  });

  it('keeps every unmarked operation with the default selection; x-glirastes-tool: false still opts out', async () => {
    const paths = structuredClone(TAG_PATHS) as Record<string, Record<string, Record<string, unknown>>>;
    paths['/api/tags']!.post!['x-glirastes-roles'] = ['tag.write'];
    delete paths['/api/tags']!.post!['x-glirastes-name'];
    delete paths['/api/tags']!.post!['x-glirastes-group'];
    delete paths['/api/tags']!.post!['x-glirastes-effect'];
    for (const selection of [undefined, 'all'] as const) {
      const observed = await observeWith(paths, selection ? { selection } : {});
      expect(observed.excluded).toEqual([{ stableKey: 'DELETE /api/tags/:tag_id', reason: 'opted-out', origin: 'code' }]);
      const byKey = new Map(observed.observations.map((tool) => [tool.execution.stableKey, tool]));
      expect([...byKey.keys()]).toEqual(['GET /api/tags', 'POST /api/tags']);
      expect(byKey.get('POST /api/tags')!.execution.definitionId).toBe('tags.create');
      expect(byKey.get('POST /api/tags')!.codeRoles).toEqual(['tag.write']);
      expect(byKey.get('POST /api/tags')!.prose).toBeUndefined();
    }
  });

  it('lets existing exclusions win over the marker and keep their reason, but never silently', async () => {
    const marked = { security: SECURED, 'x-glirastes-tool': true, responses: { '200': { description: 'ok' } } };
    const paths = {
      '/api/auth/login': { post: marked },
      '/api/internal/reindex': { post: { ...marked, 'x-glirastes-ignore': true } },
      '/api/reports': { get: marked },
      '/api/tasks/export': { options: marked },
      '/api/files/{name}.json': { get: marked },
      '/api/uploads': {
        post: { ...marked, requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } } },
      },
      // Unmarked: an existing reason still wins over not-opted-in.
      '/api/auth/logout': { post: { security: SECURED, responses: { '200': { description: 'ok' } } } },
    };
    for (const selection of ['all', 'opt-in'] as const) {
      const observed = await observeWith(paths, { selection }, [{ match: 'GET /api/reports', reason: 'internal reporting' }]);
      expect(observed.observations).toEqual([]);
      expect(observed.excluded).toEqual([
        { stableKey: 'GET /api/files/{name}.json', reason: 'unsupported-path', origin: 'code' },
        { stableKey: 'GET /api/reports', reason: 'internal reporting', origin: 'policy' },
        { stableKey: 'OPTIONS /api/tasks/export', reason: 'unsupported-method', origin: 'code' },
        { stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' },
        { stableKey: 'POST /api/auth/logout', reason: 'auth-route', origin: 'default' },
        { stableKey: 'POST /api/internal/reindex', reason: 'ai-ignore', origin: 'code' },
        { stableKey: 'POST /api/uploads', reason: 'unsupported-body', origin: 'code' },
      ]);
      expect(codes(observed.findings).sort()).toEqual([
        ['opt-in-excluded', 'warning', 'GET /api/files/{name}.json'],
        ['opt-in-excluded', 'warning', 'GET /api/reports'],
        ['opt-in-excluded', 'warning', 'OPTIONS /api/tasks/export'],
        ['opt-in-excluded', 'warning', 'POST /api/auth/login'],
        ['opt-in-excluded', 'warning', 'POST /api/internal/reindex'],
        ['opt-in-excluded', 'warning', 'POST /api/uploads'],
      ]);
      const login = observed.findings.find((finding) => finding.subjectRef === 'POST /api/auth/login')!;
      expect(login.message).toContain('stays excluded (auth-route, default)');
      expect(login.nextAction).toContain('x-glirastes-tool: true');
    }
  });

  it.each([
    ['all', 1, []],
    ['opt-in', 0, [{ stableKey: 'GET /api/tags', reason: 'not-opted-in', origin: 'code' }]],
  ] as const)('reports a marker that is not a boolean and reads it as absent (%s)', async (selection, tools, excluded) => {
    const observed = await observeWith({
      '/api/tags': { get: { security: SECURED, 'x-glirastes-tool': 'yes', 'x-glirastes-roles': 7, responses: { '200': { description: 'ok' } } } },
    }, { selection });
    expect(observed.observations).toHaveLength(tools);
    expect(observed.excluded).toEqual(excluded);
    expect(codes(observed.findings)).toEqual([['tool-marker-invalid', 'warning', 'GET /api/tags']]);
    expect(observed.findings[0]!.nextAction).toContain('true or false');
  });

  it('falls back visibly for an invalid name or group and fails closed for invalid roles', async () => {
    const operation = (extensions: Record<string, unknown>) => ({
      get: { security: SECURED, 'x-glirastes-tool': true, ...extensions, responses: { '200': { description: 'ok' } } },
    });
    const observed = await observeWith({
      '/api/a': operation({ 'x-glirastes-name': ['list_a'] }),
      '/api/b': operation({ 'x-glirastes-name': 'List B' }),
      '/api/c': operation({ 'x-glirastes-group': '   ' }),
      '/api/d': operation({ 'x-glirastes-roles': 'admin' }),
      '/api/e': operation({ 'x-glirastes-roles': ['admin', 3] }),
      '/api/f': operation({ 'x-glirastes-roles': ['admin', ''] }),
      '/api/g': operation({ 'x-glirastes-roles': Array.from({ length: 51 }, (_, index) => `role${index}`) }),
      '/api/h': operation({ 'x-glirastes-roles': [], 'x-glirastes-group': 7 }),
      '/api/i': operation({ 'x-glirastes-roles': [...Array.from({ length: 50 }, (_, index) => `role${index}`), 'role0'] }),
    }, { selection: 'opt-in' });

    const byKey = new Map(observed.observations.map((tool) => [tool.execution.stableKey, tool]));
    const own = (key: string) => codes(byKey.get(key)!.findings).filter(([code]) => code !== 'output-contract-opaque');
    expect(byKey.get('GET /api/a')!.execution.definitionId).toBe('a.list');
    expect(own('GET /api/a')).toEqual([['definition-id-invalid', 'warning', 'GET /api/a']]);
    expect(byKey.get('GET /api/b')!.execution.definitionId).toBe('b.list');
    expect(codes(observed.findings)).toEqual([['definition-id-invalid', 'warning', 'GET /api/b']]);
    expect(observed.findings[0]!.message).toContain('x-glirastes-name "List B"');
    expect(byKey.get('GET /api/c')!.prose).toBeUndefined();
    expect(own('GET /api/c')).toEqual([['tool-group-invalid', 'warning', 'GET /api/c']]);
    for (const key of ['GET /api/d', 'GET /api/e', 'GET /api/f', 'GET /api/g']) {
      expect(own(key)).toEqual([['tool-roles-invalid', 'needs_attention', key]]);
      expect(byKey.get(key)!.codeRoles).toBeUndefined();
    }
    expect(own('GET /api/h')).toEqual([['tool-group-invalid', 'warning', 'GET /api/h']]);
    expect(byKey.get('GET /api/h')!.codeRoles).toBeUndefined();
    expect(byKey.get('GET /api/i')!.codeRoles).toHaveLength(50);
    expect(own('GET /api/i')).toEqual([]);
  });
});

describe('FastAPI route count', () => {
  it('accepts an export that lists every declared route and names the hidden one', async () => {
    const observed = await observe({ 'api/openapi.json': documentOf(TASK_PATHS), 'api/app/main.py': MAIN_PY }, { fastapi: 'api/app' });

    expect(observed.complete).toBe(true);
    expect(observed.observations).toHaveLength(3);
    expect(observed.findings).toEqual([expect.objectContaining({
      code: 'route-hidden', severity: 'warning', subjectRef: 'api/app/main.py:22',
    })]);
    expect(observed.findings[0]!.message).toContain('declares GET with include_in_schema=False');
  });

  it('stops when the export is older than the code', async () => {
    const stale = structuredClone(TASK_PATHS) as Record<string, unknown>;
    delete stale['/api/tasks/{task_id}'];
    const observed = await observe({ 'api/openapi.json': documentOf(stale), 'api/app/main.py': MAIN_PY }, { fastapi: 'api/app' });

    expect(observed.complete).toBe(false);
    expect(observed.findings[0]!.message)
      .toBe('api/openapi.json lists 2 operations, the FastAPI code in api/app declares 3; run the export again.');
  });

  it('stops on routes whose methods it cannot count', async () => {
    const computed = `${MAIN_PY}\nMETHODS = ['GET']\n\n\n@router.api_route('/bulk', methods=METHODS)\ndef bulk():\n    return []\n`;
    const observed = await observe({ 'api/openapi.json': documentOf(TASK_PATHS), 'api/app/main.py': computed }, { fastapi: 'api/app' });

    expect(observed.complete).toBe(false);
    expect(observed.findings[0]!.message).toContain('api/app/main.py:32 computes the methods of a route');
  });

  it('stops visibly when Python is missing', async () => {
    const observed = await observe(
      { 'api/openapi.json': documentOf(TASK_PATHS), 'api/app/main.py': MAIN_PY },
      { fastapi: 'api/app', python: '/nonexistent/python3' },
    );

    expect(observed.complete).toBe(false);
    expect(observed.findings[0]!.message).toContain('/nonexistent/python3 was not found; Python 3.12 counts the FastAPI routes in api/app');
  });
});
