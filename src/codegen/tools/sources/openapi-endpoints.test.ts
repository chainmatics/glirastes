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
    ['an OpenAPI 3.0 export', documentOf(TASK_PATHS).replace('"3.1.0"', '"3.0.3"'), 'is OpenAPI 3.0.3'],
    ['a file that is not JSON', '{ openapi: 3.1.0 }', 'is not valid JSON'],
  ])('stops with E-INVENTORY-011 for %s', async (_label, text, reason) => {
    const observed = await observe({ 'api/openapi.json': text });

    expect(observed.complete).toBe(false);
    expect(observed.findings).toEqual([expect.objectContaining({ code: 'E-INVENTORY-011', severity: 'error' })]);
    expect(observed.findings[0]!.message).toContain(`api/openapi.json ${reason}`);
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
