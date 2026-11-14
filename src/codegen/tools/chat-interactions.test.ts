import { describe, expect, it, vi } from 'vitest';
import { mergeChatInteractions, parseChatInteractionOverrides } from '../../contracts/chat-interactions.js';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { createJsonSchemaLike } from '../../runtime/json-schema.js';
import { canonicalJson } from './canonical.js';
import { CHAT_INTERNAL_ACTION, deriveChatInteractions, humanizeIdentifier } from './chat-interactions.js';
import type { JsonSchemaLike, ToolContract, ToolContractsEntry, ToolTitle } from './types.js';

const digest = (character: string) => `sha256:${character.repeat(43)}`;
const id = (index: number) => `019fb700-0000-7000-8000-${String(index).padStart(12, '0')}`;
const STRING = { type: 'string' };

interface Spec {
  name: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path?: string;
  enabled?: boolean;
  input: JsonSchemaLike;
  output?: JsonSchemaLike;
  params?: ToolContract['params'];
  uiAction?: ToolContract['uiAction'];
  title?: ToolTitle;
  presentation?: { locale: string; singular: string; plural: string; approval: string };
  riskClass?: string;
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

const TITLED: Spec[] = [
  { ...SPECS[0]!, presentation: { locale: 'de-DE', singular: 'Aufgabe', plural: 'Aufgaben', approval: 'Aufgaben abrufen?' } },
  {
    name: 'tasks.permanentDelete', method: 'DELETE', path: '/api/tasks/:id/permanent', riskClass: 'delete',
    title: { de: 'Aufgabe endgültig löschen', en: 'Permanently delete task' },
    input: object({ id: STRING }, ['id']), params: { path: ['id'], query: [], body: [] },
  },
  {
    name: 'tasks.addSubtask', method: 'POST', path: '/api/tasks/:id/subtasks',
    input: object({ id: STRING, title: STRING }, ['id', 'title']), params: { path: ['id'], query: [], body: ['title'] },
  },
  {
    name: 'tasksAttachable.list', method: 'GET', path: '/api/tasks/:id/attachable',
    input: object({ id: STRING }, ['id']), params: { path: ['id'], query: [], body: [] },
  },
  {
    name: 'tasks.delete', method: 'DELETE', path: '/api/tasks/:id', riskClass: 'delete',
    input: object({ id: STRING }, ['id']), params: { path: ['id'], query: [], body: [] },
  },
  {
    name: 'ui.taskCreateDialog.open', title: { de: 'Dialog Aufgabe anlegen', en: 'Open create-task dialog' },
    input: object({}), uiAction: { kind: 'client-action', actionId: 'task-create-dialog.open' },
  },
  { name: 'ui.tasks.view.switch', input: object({}), uiAction: { kind: 'client-action', actionId: 'tasks.view.switch' } },
  { ...SPECS[9]!, title: { de: 'Aufgaben filtern' } },
];

const USERS: Spec[] = [
  {
    name: 'users.search', method: 'GET', path: '/api/users/search',
    input: object({ email: STRING, name: STRING, teamId: STRING }), params: { path: [], query: ['email', 'name', 'teamId'], body: [] },
    output: object({
      users: { type: 'array', items: object({ id: STRING, displayName: STRING, email: STRING, role: STRING }) },
      count: { type: 'number' },
    }),
  },
  {
    name: 'users.updateRole', method: 'PATCH', path: '/api/users/:id/role',
    input: object({ id: STRING, role: { type: 'string', enum: ['admin', 'member'] } }, ['id', 'role']),
    params: { path: ['id'], query: [], body: ['role'] },
  },
  {
    name: 'users.delete', method: 'DELETE', path: '/api/users/:id', riskClass: 'delete',
    input: object({ id: STRING }, ['id']), params: { path: ['id'], query: [], body: [] },
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
      riskClass: spec.riskClass ?? (spec.uiAction || spec.method === 'GET' ? 'safe-read' : 'write'), enabled: spec.enabled ?? true,
      ...(spec.presentation ? { presentation: spec.presentation } : {}),
      requiresApproval: !spec.uiAction && spec.method !== 'GET', inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
    })),
    planner: { plannerId: id(9004), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [] },
    prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
    warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
  });
  const contracts: ToolContractsEntry[] = specs.map((spec, index) => ({
    toolId: id(index + 1), stableKey: spec.uiAction ? `UI ${spec.name}` : `${spec.method} ${spec.path}`, definitionId: spec.name,
    defaults: { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
    ...(spec.title ? { title: spec.title } : {}),
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
          args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
          run: { kind: 'ui', tool: 'ui.filter.tasks' },
        },
        { id: 'open.home', label: { en: 'Open Home', de: 'Startseite öffnen' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/' } } },
        { id: 'open.overview', label: { en: 'Open Overview', de: 'Overview öffnen' }, keywords: ['overview'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
        { id: 'open.tasks', label: { en: 'Open Tasks', de: 'Tasks öffnen' }, keywords: ['tasks'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } },
        {
          id: 'tasks.highlight', label: { en: 'Highlight tasks', de: 'Tasks hervorheben' },
          args: [{ name: 'title', label: 'Title', required: true }],
          run: { kind: 'ui', tool: 'ui.tasks.highlight' },
        },
      ],
    });
  });

  it('labels commands, actions and entities from titles and the presentation noun', () => {
    const derived = deriveChatInteractions(catalog(TITLED));
    expect(derived.entities[0]!.label).toEqual({ en: 'Task', de: 'Aufgabe' });
    const actions = derived.entities[0]!.actions!;
    expect(Object.fromEntries(actions.map((action) => [action.id, action.label]))).toEqual({
      'task.tasks.addSubtask': { en: 'Add subtask', de: 'Subtask hinzufügen' },
      'task.tasksAttachable.list': { en: 'Show attachable', de: 'Attachable anzeigen' },
      'task.tasks.delete': { en: 'Delete', de: 'Löschen' },
      // The entity's own menu drops its leading noun.
      'task.tasks.permanentDelete': { en: 'Permanently delete task', de: 'Endgültig löschen' },
    });
    expect(actions.map((action) => action.id))
      .toEqual(['task.tasks.addSubtask', 'task.tasksAttachable.list', 'task.tasks.delete', 'task.tasks.permanentDelete']);
    expect(Object.fromEntries(derived.commands.map((command) => [command.id, command.label]))).toEqual({
      'taskCreateDialog.open': { en: 'Open create-task dialog', de: 'Dialog Aufgabe anlegen' },
      'tasks.view.switch': { en: 'Switch tasks view', de: 'Tasks view wechseln' },
      'filter.tasks': { en: 'Filter Tasks', de: 'Aufgaben filtern' },
    });
  });

  it('falls back per language and clamps a title the list cannot show', () => {
    const long = 'x'.repeat(201);
    const derived = deriveChatInteractions(catalog([
      { ...TITLED[5]!, title: { en: 'Open the dialog' } },
      { ...TITLED[6]!, title: { de: long, en: 'Bad\u0007' } },
    ]));
    expect(Object.fromEntries(derived.commands.map((command) => [command.id, command.label]))).toEqual({
      'taskCreateDialog.open': { en: 'Open the dialog', de: 'Task create dialog öffnen' },
      'tasks.view.switch': { en: 'Switch tasks view', de: `${'x'.repeat(199)}…` },
    });
  });

  it('uses the presentation noun only in its own language', () => {
    const english = deriveChatInteractions(catalog([{ ...SPECS[0]!, presentation: { locale: 'en-US', singular: 'To-do', plural: 'To-dos', approval: 'List?' } }]));
    expect(english.entities[0]!.label).toEqual({ en: 'To-do', de: 'Task' });
    expect(deriveChatInteractions(catalog([SPECS[0]!])).entities[0]!.label).toEqual({ en: 'Task', de: 'Task' });
    const templated = { locale: 'en-US', singular: 'List tasks', plural: 'List tasks', approval: 'List tasks' };
    expect(deriveChatInteractions(catalog([{ ...SPECS[0]!, presentation: templated }])).entities[0]!.label).toEqual({ en: 'Task', de: 'Task' });
  });

  it('does not offer the chat window or the command palette inside the chat', () => {
    const client = (name: string, actionId: string): Spec => ({ name, input: object({}), uiAction: { kind: 'client-action', actionId } });
    const derived = deriveChatInteractions(catalog([
      client('ui.aiChat.open', 'ai-chat.open'),
      client('ui.commandPalette.open', 'command-palette.open'),
      client('ui.chat.clear', 'chat.clear'),
      client('ui.chatbotSettings.open', 'chatbot-settings.open'),
    ]));
    expect(derived.commands.map((command) => command.id)).toEqual(['chatbotSettings.open']);
    expect(CHAT_INTERNAL_ACTION.test('cmdk')).toBe(true);
  });

  it('lets an override add a chat-internal action back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const derived = deriveChatInteractions(catalog([
      { name: 'ui.aiChat.open', input: object({}), uiAction: { kind: 'client-action', actionId: 'ai-chat.open' } },
    ]));
    const merged = mergeChatInteractions(derived, parseChatInteractionOverrides({
      schemaVersion: 1,
      commands: { 'aiChat.open': { label: 'KI-Chat öffnen', run: { kind: 'ui', tool: 'ui.aiChat.open' } } },
    }));
    expect(merged.commands.map((command) => command.id)).toEqual(['aiChat.open']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('derives an entity from a search endpoint and hangs item actions on its collection', () => {
    const derived = deriveChatInteractions(catalog(USERS));
    expect(derived.entities).toHaveLength(1);
    expect(derived.entities[0]!.type).toBe('user');
    expect(derived.entities[0]!.search).toEqual({
      tool: 'users.search', path: '/api/users/search', queryParam: 'name', itemsPath: ['users'],
      idField: 'id', labelField: 'displayName', descriptionField: 'email',
    });
    expect(derived.entities[0]!.actions!.map((action) => action.id)).toEqual(['user.users.updateRole', 'user.users.delete']);
  });

  it('accepts name as a search parameter only on a search endpoint', () => {
    const derived = deriveChatInteractions(catalog([{
      name: 'reports.list', method: 'GET', path: '/api/reports',
      input: object({ name: STRING }), params: { path: [], query: ['name'], body: [] },
      output: object({ reports: { type: 'array', items: object({ id: STRING, title: STRING }) } }),
    }]));
    expect(derived.entities).toEqual([]);
  });

  it('prefers the collection search over a search endpoint of the same type', () => {
    const collection: Spec = {
      name: 'users.list', method: 'GET', path: '/api/users',
      input: object({ q: STRING }), params: { path: [], query: ['q'], body: [] },
      output: { type: 'array', items: object({ id: STRING, displayName: STRING }) },
    };
    const derived = deriveChatInteractions(catalog([USERS[0]!, collection]));
    expect(derived.entities.map((entity) => entity.search!.path)).toEqual(['/api/users']);
  });

  it('derives nothing from a bare /search path', () => {
    const derived = deriveChatInteractions(catalog([{
      name: 'search.list', method: 'GET', path: '/search',
      input: object({ q: STRING }), params: { path: [], query: ['q'], body: [] },
      output: { type: 'array', items: object({ id: STRING, title: STRING }) },
    }]));
    expect(derived.entities).toEqual([]);
  });

  it('is a pure function of the catalog, whatever the input order', () => {
    const forward = deriveChatInteractions(catalog([...SPECS, ...TITLED.slice(1, 7)]));
    expect(deriveChatInteractions(catalog([...SPECS, ...TITLED.slice(1, 7)].reverse()))).toEqual(forward);
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

  it('never offers an array key as a single value, because the bound schema rejects a scalar', () => {
    // The filter tool's input schema is what the runtime binds: a picked scalar would never validate.
    const labels = { type: 'array', items: { type: 'string', enum: ['bug', 'idea'] } };
    const bound = createJsonSchemaLike(object({ labels }));
    expect(bound.safeParse({ labels: 'bug' }).success).toBe(false);
    expect(bound.safeParse({ labels: ['bug'] }).success).toBe(true);

    const optional = deriveChatInteractions(catalog([{
      name: 'ui.filter.tasks', input: object({ labels, status: { type: 'string', enum: ['done', 'open'] } }),
      uiAction: { kind: 'filter', destination: '/tasks', keys: [{ key: 'labels', array: 'repeat' }, { key: 'status' }] },
    }]));
    expect(optional.commands).toEqual([{
      id: 'filter.tasks', label: { en: 'Filter Tasks', de: 'Tasks filtern' },
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    }]);

    // A required array has no form the chat can fill, so its command is dropped like any untypeable required key.
    const required = deriveChatInteractions(catalog([{
      name: 'ui.filter.tasks', input: object({ labels }, ['labels']),
      uiAction: { kind: 'filter', destination: '/tasks', keys: [{ key: 'labels', array: 'comma' }] },
    }]));
    expect(required.commands).toEqual([]);
  });

  it('derives nested params arguments in one canonical order', () => {
    const filter = (params: Record<string, unknown>): Spec => ({
      name: 'ui.filter.teamsMembersItem',
      input: object({ params: object(params), status: { type: 'string', enum: ['active', 'inactive'] } }),
      uiAction: { kind: 'filter', destination: '/teams/:teamId/members/:memberId', keys: [{ key: 'status' }] },
    });
    const pathOrder = deriveChatInteractions(catalog([filter({ teamId: STRING, memberId: STRING })]));
    const fileOrder = deriveChatInteractions(catalog([filter({ memberId: STRING, teamId: STRING })]));
    expect(pathOrder.commands[0]!.args!.map((entry) => entry.name)).toEqual(['params.memberId', 'params.teamId', 'status']);
    expect(JSON.stringify(pathOrder)).toBe(JSON.stringify(fileOrder));
  });

  it('derives the same data from the observed contracts and from tool-contracts.json', () => {
    // `tools refresh` renders from the observed contracts, `tools check --integrity-only` from the
    // canonical file, whose keys are sorted; both must give byte-identical interactions.
    const nested: Spec = {
      name: 'ui.filter.teamsMembersItem',
      input: object({ params: object({ teamId: STRING, memberId: STRING }), status: { type: 'string', enum: ['active', 'inactive'] } }),
      uiAction: { kind: 'filter', destination: '/teams/:teamId/members/:memberId', keys: [{ key: 'status' }] },
    };
    const { artifact, contracts } = catalog([...SPECS, ...TITLED.slice(1, 7), nested]);
    const fromFile = JSON.parse(canonicalJson({ tools: contracts })).tools as ToolContractsEntry[];
    const observed = deriveChatInteractions({ artifact, contracts });
    expect(observed.commands.some((entry) => entry.id === 'filter.teamsMembersItem')).toBe(true);
    expect(JSON.stringify(deriveChatInteractions({ artifact, contracts: fromFile }))).toBe(JSON.stringify(observed));
  });

  it('humanizes identifiers for default labels', () => {
    expect(humanizeIdentifier('myTasks')).toBe('My tasks');
    expect(humanizeIdentifier('team-members')).toBe('Team members');
    expect(humanizeIdentifier('tasks.highlight')).toBe('Tasks highlight');
  });
});
