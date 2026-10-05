import { describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { deriveChatInteractions, humanizeIdentifier } from './chat-interactions.js';
import type { JsonSchemaLike, ToolContract, ToolContractsEntry } from './types.js';

const digest = (character: string) => `sha256:${character.repeat(43)}`;
const id = (index: number) => `019fb700-0000-7000-8000-${String(index).padStart(12, '0')}`;
const STRING = { type: 'string' };

interface Spec {
  name: string;
  method?: 'GET' | 'POST' | 'PATCH';
  path?: string;
  enabled?: boolean;
  input: JsonSchemaLike;
  output?: JsonSchemaLike;
  params?: ToolContract['params'];
  uiAction?: ToolContract['uiAction'];
}

const object = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties: props, required, additionalProperties: false,
});

const SPECS: Spec[] = [
  {
    name: 'tasks.list', method: 'GET', path: '/api/tasks',
    input: object({ search: STRING, status: { type: 'string', enum: ['done', 'open'] }, limit: STRING }),
    output: object({ tasks: { type: 'array', items: object({ id: STRING, title: STRING, status: STRING }) } }),
    params: { path: [], query: ['limit', 'search', 'status'], body: [] },
  },
  {
    name: 'people.list', method: 'GET', path: '/api/people',
    input: object({ q: STRING }),
    output: { type: 'array', items: object({ id: STRING, name: STRING, email: STRING }) },
    params: { path: [], query: ['q'], body: [] },
  },
  {
    name: 'reports.list', method: 'GET', path: '/api/reports',
    input: object({ year: STRING }),
    output: object({ reports: { type: 'array', items: object({ id: STRING, title: STRING }) } }),
    params: { path: [], query: ['year'], body: [] },
  },
  {
    name: 'tasks.complete', method: 'POST', path: '/api/tasks/:taskId/complete',
    input: object({ taskId: STRING }, ['taskId']), params: { path: ['taskId'], query: [], body: [] },
  },
  {
    name: 'tasks.assign', method: 'POST', path: '/api/tasks/:id/assign',
    input: object({ id: STRING, personId: STRING }, ['id', 'personId']), params: { path: ['id'], query: [], body: ['personId'] },
  },
  {
    name: 'tasks.update', method: 'PATCH', path: '/api/tasks/:id',
    input: object({ id: STRING, title: STRING, priority: { type: 'number' }, labels: { type: 'object' } }, ['id']),
    params: { path: ['id'], query: [], body: ['labels', 'priority', 'title'] },
  },
  {
    name: 'tasks.move', method: 'POST', path: '/api/tasks/:id/move',
    input: object({ id: STRING, target: { type: 'object' } }, ['id', 'target']), params: { path: ['id'], query: [], body: ['target'] },
  },
  {
    name: 'tasks.archive', method: 'POST', path: '/api/tasks/:id/archive', enabled: false,
    input: object({ id: STRING }, ['id']), params: { path: ['id'], query: [], body: [] },
  },
  {
    name: 'ui.navigate',
    input: object({
      destination: { type: 'string', enum: ['/', '/overview', '/tasks', '/tasks/:taskId', '/projects/:projectId/board'] },
      params: object({ projectId: STRING, taskId: STRING }),
    }, ['destination']),
    uiAction: { kind: 'navigate' },
  },
  {
    name: 'ui.filter.tasks',
    input: object({
      status: { type: 'string', enum: ['done', 'open'] },
      labels: { type: 'array', items: { type: 'string', enum: ['bug', 'idea'] } },
      page: { type: 'number' },
    }),
    uiAction: { kind: 'filter', destination: '/tasks', keys: [{ key: 'labels', array: 'comma' }, { key: 'page' }, { key: 'status' }] },
  },
  {
    name: 'ui.tasks.highlight',
    input: object({ title: STRING }, ['title']),
    uiAction: { kind: 'client-action', actionId: 'tasks.highlight' },
  },
];

function catalog(specs: ReadonlyArray<Spec>) {
  const artifact = AppSetupArtifactSchema.parse({
    schemaVersion: 1, artifactId: id(9001), runId: id(9002), appId: id(9003), discoveryDigest: digest('D'),
    assessmentMode: 'autonomous', status: 'ready',
    tools: specs.map((spec, index) => ({
      toolId: id(index + 1), sourceFingerprint: digest('F'), name: spec.name, description: `Run ${spec.name}.`,
      modelName: spec.name.replace(/\./g, '_'),
      executionKind: spec.uiAction ? 'ui' : 'endpoint',
      ...(spec.uiAction ? { actionBindingRef: 'glirastes.navigate' } : { method: spec.method, path: spec.path }),
      allowedRoles: [], operationGroup: spec.uiAction ? 'ui' : spec.method === 'GET' ? 'read' : 'update',
      riskClass: spec.uiAction || spec.method === 'GET' ? 'safe-read' : 'write', enabled: spec.enabled ?? true,
      requiresApproval: !spec.uiAction && spec.method !== 'GET', inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
    })),
    planner: { plannerId: id(9004), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [] },
    prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
    warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
  });
  const contracts: ToolContractsEntry[] = specs.map((spec, index) => ({
    toolId: id(index + 1), stableKey: spec.uiAction ? `UI ${spec.name}` : `${spec.method} ${spec.path}`, definitionId: spec.name,
    defaults: { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
    contract: {
      source: spec.uiAction ? 'ui-bridge' : 'native', loadBearing: true, input: spec.input,
      ...(spec.output ? { output: spec.output } : {}),
      params: spec.params ?? { path: [], query: [], body: [] }, interfaceDigest: digest('N'),
      runtime: { input: { kind: 'json', schema: spec.input }, output: { kind: 'json', schema: spec.output ?? {} } },
      ...(spec.uiAction ? { uiAction: spec.uiAction } : {}),
    },
  }));
  return { artifact, contracts };
}

describe('deriveChatInteractions', () => {
  it('derives searchable entities, their actions and the UI commands from the catalog', () => {
    expect(deriveChatInteractions(catalog(SPECS))).toEqual({
      schemaVersion: 1,
      entities: [
        {
          type: 'person',
          label: { en: 'Person', de: 'Person' },
          search: {
            tool: 'people.list', path: '/api/people', queryParam: 'q', itemsPath: [],
            idField: 'id', labelField: 'name', descriptionField: 'email',
          },
        },
        {
          type: 'task',
          label: { en: 'Task', de: 'Task' },
          search: {
            tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'],
            idField: 'id', labelField: 'title', descriptionField: 'status', limitParam: 'limit',
          },
          actions: [
            { id: 'task.open', label: { en: 'Open', de: 'Öffnen' }, entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
            {
              id: 'task.tasks.assign', label: { en: 'Assign', de: 'Zuweisen' }, entityArg: 'id',
              args: [{ name: 'personId', label: 'Person id', required: true, entity: 'person' }],
              run: { kind: 'tool', tool: 'tasks.assign' },
            },
            { id: 'task.tasks.complete', label: { en: 'Complete', de: 'Erledigen' }, entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
            {
              id: 'task.tasks.update', label: { en: 'Edit', de: 'Bearbeiten' }, entityArg: 'id',
              args: [{ name: 'title', label: 'Title' }],
              run: { kind: 'tool', tool: 'tasks.update' },
            },
          ],
        },
      ],
      commands: [
        {
          id: 'filter.tasks', label: { en: 'Filter Tasks', de: 'Tasks filtern' },
          args: [{ name: 'labels', label: 'Labels', options: ['bug', 'idea'] }, { name: 'status', label: 'Status', options: ['done', 'open'] }],
          run: { kind: 'ui', tool: 'ui.filter.tasks' },
        },
        { id: 'open.home', label: { en: 'Open Home', de: 'Startseite öffnen' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/' } } },
        { id: 'open.overview', label: { en: 'Open Overview', de: 'Overview öffnen' }, keywords: ['overview'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
        { id: 'open.tasks', label: { en: 'Open Tasks', de: 'Tasks öffnen' }, keywords: ['tasks'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } },
        {
          id: 'tasks.highlight', label: { en: 'Tasks highlight', de: 'Tasks highlight' },
          args: [{ name: 'title', label: 'Title', required: true }],
          run: { kind: 'ui', tool: 'ui.tasks.highlight' },
        },
      ],
    });
  });

  it('is a pure function of the catalog, whatever the input order', () => {
    const forward = deriveChatInteractions(catalog(SPECS));
    expect(deriveChatInteractions(catalog([...SPECS].reverse()))).toEqual(forward);
  });

  it('derives nothing from disabled tools or tools without a contract', () => {
    const { artifact, contracts } = catalog(SPECS);
    const withoutContracts = contracts.map((entry) => ({ ...entry, contract: null }));
    expect(deriveChatInteractions({ artifact, contracts: withoutContracts })).toEqual({ schemaVersion: 1, entities: [], commands: [] });
    const disabled = AppSetupArtifactSchema.parse({ ...artifact, tools: artifact.tools.map((tool) => ({ ...tool, enabled: false })) });
    expect(deriveChatInteractions({ artifact: disabled, contracts })).toEqual({ schemaVersion: 1, entities: [], commands: [] });
  });

  it('keeps one entity per type and skips ids it cannot express', () => {
    const duplicate: Spec = {
      ...SPECS[0]!, name: 'admin.tasks.list', path: '/api/admin/tasks',
    };
    const longName = `tasks.${'x'.repeat(190)}`;
    const derived = deriveChatInteractions(catalog([
      SPECS[0]!, duplicate,
      { ...SPECS[3]!, path: '/api/admin/tasks/:taskId/complete' },
      { ...SPECS[3]!, name: longName, path: '/api/admin/tasks/:taskId/x' },
    ]));
    expect(derived.entities.map((entity) => entity.search!.tool)).toEqual(['admin.tasks.list']);
    expect(derived.entities[0]!.actions!.map((action) => action.id)).toEqual(['task.tasks.complete']);
  });

  it('drops only what the chat cannot carry and never fails the refresh', () => {
    const derived = deriveChatInteractions(catalog([
      {
        name: 'ui.filter.tasks',
        input: object({ status: { type: 'string', enum: ['', 'open'] }, _: STRING }),
        uiAction: { kind: 'filter', destination: '/tasks', keys: [{ key: '_' }, { key: 'status' }] },
      },
      {
        name: 'ui.notes.pin',
        input: object({ params: object({ 'note id': STRING }) }),
        uiAction: { kind: 'client-action', actionId: 'notes.pin' },
      },
    ]));
    expect(derived.commands).toEqual([{
      id: 'filter.tasks', label: { en: 'Filter Tasks', de: 'Tasks filtern' },
      args: [{ name: '_', label: '_' }, { name: 'status', label: 'Status', options: ['open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    }]);
  });

  it('humanizes identifiers for default labels', () => {
    expect(humanizeIdentifier('myTasks')).toBe('My tasks');
    expect(humanizeIdentifier('team-members')).toBe('Team members');
    expect(humanizeIdentifier('tasks.highlight')).toBe('Tasks highlight');
  });
});
