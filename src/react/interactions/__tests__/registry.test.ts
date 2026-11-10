import { describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';
import { createCompletionSearch } from '../../completions/completion-search.js';
import type { MentionData } from '../../types.js';
import { defineChatCommand, defineChatEntity } from '../definitions.js';
import { createChatInteractionRegistry } from '../registry.js';

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: { de: 'Aufgabe', en: 'Task' },
    search: {
      tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'],
      idField: 'id', labelField: 'title', descriptionField: 'status', limitParam: 'limit',
    },
    actions: [
      { id: 'task.tasks.complete', label: { de: 'Erledigen', en: 'Complete' }, entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } },
      { id: 'task.open', label: { de: 'Öffnen', en: 'Open' }, entityArg: 'params.taskId', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks/:taskId' } } },
    ],
  }],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, keywords: ['dashboard'], run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: { de: 'Aufgaben filtern', en: 'Filter Tasks' },
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

const person = defineChatEntity({
  type: 'person',
  label: { de: 'Person', en: 'Person' },
  search: (query) => [{ id: 'alice', label: 'Alice Example' }, { id: 'bob', label: 'Bob' }]
    .filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
  card: (item) => ({ title: item.label, subtitle: `${item.id}@example.com` }),
});

const assign = defineChatCommand({
  id: 'tasks.assign',
  label: { de: 'Zuweisen', en: 'Assign' },
  args: [
    { name: 'taskId', label: 'Task', required: true, entity: 'task' },
    { name: 'assignee', label: 'Person', required: true, entity: 'person' },
  ],
  run: { kind: 'tool', tool: 'tasks.assign' },
});

const standup = defineChatCommand({
  id: 'standup',
  label: { de: 'Tagesrückblick', en: 'Stand-up' },
  run: { kind: 'prompt', prompt: { de: 'Fasse meinen Tag zusammen.', en: 'Summarize my day.' } },
});

function tasksFetch() {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({
    tasks: [{ id: 7, title: 'Release prüfen', status: 'open' }, { id: '', title: 'broken' }, { id: 'x:y', title: 'unsafe' }],
  }));
}

const mention = (type: string, id: string, label: string, prefix = '@'): MentionData => ({
  id, type, label, prefix, slug: label.toLowerCase().replace(/\s+/g, '-'),
});

describe('createChatInteractionRegistry', () => {
  it('refuses definitions the chat could not run safely', () => {
    expect(() => defineChatCommand({ id: 'open:x', label: 'X', run: { kind: 'tool', tool: 'x' } })).toThrow(/commands\[0\]\.id/);
    expect(() => defineChatEntity({ type: 'task', label: 'Task' } as never)).toThrow(/needs a search function/);
  });

  it('offers derived and app commands, the app replacing a derived id', async () => {
    const registry = createChatInteractionRegistry({
      data, locale: 'de',
      commands: [assign, standup, defineChatCommand({ id: 'open.overview', label: 'Start', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/' } } })],
    });
    const search = createCompletionSearch(registry.providers);
    expect((await search('', '/')).map((item) => item.label)).toEqual(['Aufgaben filtern', 'Start', 'Tagesrückblick', 'Zuweisen']);
    expect(await search('zuw', '/')).toEqual([{
      id: 'tasks.assign', key: 'chat-commands:command:tasks.assign', type: 'command', label: 'Zuweisen', definitionId: 'tasks.assign',
    }]);
    expect((await search('tages', '/'))[0]).not.toHaveProperty('definitionId');
    expect((await search('filtern', '/'))[0]).toMatchObject({ id: 'filter.tasks', definitionId: 'ui.filter.tasks' });
  });

  it('searches derived entities through the app endpoint with the session and offers their actions', async () => {
    const fetch = tasksFetch();
    const registry = createChatInteractionRegistry({ data, entities: [person], fetch, locale: 'en' });
    const search = createCompletionSearch(registry.providers);
    const results = await search('rel', '@');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/api/tasks?search=rel&limit=8');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' });
    expect(results).toEqual([{
      id: '7', key: 'chat-entities:task:7', type: 'task', label: 'Release prüfen', description: 'open',
      actions: [{ id: 'task.tasks.complete', label: 'Complete' }, { id: 'task.open', label: 'Open' }],
    }]);
    expect((await search('ali', '@')).filter((item) => item.type === 'person')).toEqual([{
      id: 'alice', key: 'chat-entities:person:alice', type: 'person', label: 'Alice Example', description: 'alice@example.com',
    }]);
  });

  it('drops results whose actions the composer could not offer safely', async () => {
    const search = createCompletionSearch([{
      id: 'custom', trigger: '@',
      search: () => [
        { id: 'a', type: 'task', label: 'Valid', actions: [{ id: 'task.open', label: 'Open' }] },
        { id: 'b', type: 'task', label: 'Bad id', actions: [{ id: 'open:now', label: 'Open' }] },
        { id: 'c', type: 'task', label: 'Blank label', actions: [{ id: 'task.open', label: ' ' }] },
      ],
    }]);
    expect((await search('', '@')).map((item) => item.id)).toEqual(['a']);
  });

  it('searches one entity type for argument fields, with the permission context', async () => {
    const search = vi.fn((_query: string, _context: unknown) => [{ id: 'alice', label: 'Alice' }, { id: '', label: 'broken' }]);
    const registry = createChatInteractionRegistry({
      entities: [defineChatEntity({ type: 'person', label: 'Person', search })],
      context: { roles: ['member'] },
    });
    expect(await registry.searchEntity('person', 'al', new AbortController().signal)).toEqual([{ id: 'alice', label: 'Alice' }]);
    expect(search.mock.calls[0]![1]).toMatchObject({ limit: 8, locale: 'en', context: { roles: ['member'] } });
    expect(await registry.searchEntity('unknown', 'al', new AbortController().signal)).toEqual([]);
  });

  it('keeps the other entities when one search fails', async () => {
    const registry = createChatInteractionRegistry({
      data, entities: [person], fetch: vi.fn(async () => { throw new Error('offline'); }),
    });
    expect((await createCompletionSearch(registry.providers)('bob', '@')).map((item) => item.id)).toEqual(['bob']);
  });

  it('shares the per-provider cap between entity types instead of showing only the first', async () => {
    const hits = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, label: `${prefix} ${index}` }));
    const entity = (type: string, count: number) => defineChatEntity({
      type, label: type, search: (_query, { limit }) => hits(type, count).slice(0, limit),
    });
    const crowded = createCompletionSearch(createChatInteractionRegistry({ entities: [entity('aaa', 8), entity('bbb', 8)] }).providers);
    const both = await crowded('', '@');
    expect(new Set(both.map((item) => item.type))).toEqual(new Set(['aaa', 'bbb']));
    expect(both.map((item) => item.id)).toEqual(['aaa0', 'bbb0', 'aaa1', 'bbb1', 'aaa2', 'bbb2', 'aaa3', 'bbb3']);

    // A type with few hits is not starved by two with many, and a short list gives its slots to the others.
    const mixed = createCompletionSearch(createChatInteractionRegistry({
      entities: [entity('aaa', 8), entity('bbb', 1), entity('ccc', 8)],
    }).providers);
    expect((await mixed('', '@')).map((item) => item.id)).toEqual(['aaa0', 'bbb0', 'ccc0', 'aaa1', 'ccc1', 'aaa2', 'ccc2', 'aaa3']);
  });

  it('sends a picked command alone as a direct command, and mixed text to the model', () => {
    const registry = createChatInteractionRegistry({ data, locale: 'en' });
    const open = mention('command', 'open.overview', 'Open Overview', '/');
    const plan = registry.planMessage('/open-overview', [open]);
    expect(plan?.status).toBe('send');
    expect(parseChatCommandMessage((plan as { text: string }).text)).toEqual({
      invocation: { commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } },
      label: '/Open Overview',
    });
    expect(registry.planMessage('/open-overview and summarize it', [open])).toBeUndefined();
    expect(registry.planMessage('Hello', [])).toBeUndefined();
  });

  it('fills entity arguments from picked references and asks for what is missing', () => {
    const registry = createChatInteractionRegistry({ data, entities: [person], commands: [assign], locale: 'en' });
    const command = mention('command', 'tasks.assign', 'Assign', '/');
    const task = mention('task', '7', 'Release prüfen');
    const alice = mention('person', 'alice', 'Alice Example');
    const full = registry.planMessage('/assign @release-prüfen @alice-example', [command, task, alice]);
    expect(parseChatCommandMessage((full as { text: string }).text)).toEqual({
      invocation: { commandId: 'tasks.assign', tool: 'tasks.assign', args: { taskId: '7', assignee: 'alice' } },
      label: '/Assign @Release prüfen @Alice Example',
    });
    const partial = registry.planMessage('/assign @release-prüfen', [command, task]);
    expect(partial).toEqual({
      status: 'needs-args',
      request: {
        commandId: 'tasks.assign', tool: 'tasks.assign', label: 'Assign', fixedArgs: {}, args: assign.args,
        values: { taskId: '7' }, valueLabels: { taskId: 'Release prüfen' },
      },
    });
    if (partial?.status !== 'needs-args') throw new Error('expected a form request');
    const completed = registry.completeCommand(partial.request, { assignee: ' bob ' });
    expect(parseChatCommandMessage((completed as { text: string }).text)?.invocation.args).toEqual({ taskId: '7', assignee: 'bob' });
    expect(registry.planMessage('/assign @release-prüfen @release-prüfen', [command, task, { ...task, id: '8' }])).toBeUndefined();
  });

  it('asks once for optional arguments and sends without the empty ones', () => {
    const registry = createChatInteractionRegistry({ data, locale: 'en' });
    const plan = registry.planMessage('/filter-tasks', [mention('command', 'filter.tasks', 'Filter Tasks', '/')]);
    expect(plan?.status).toBe('needs-args');
    const request = (plan as { request: Parameters<typeof registry.completeCommand>[0] }).request;
    expect(parseChatCommandMessage((registry.completeCommand(request, { status: '' }) as { text: string }).text)?.invocation.args).toEqual({});
    expect(parseChatCommandMessage((registry.completeCommand(request, { status: 'done' }) as { text: string }).text)).toEqual({
      invocation: { commandId: 'filter.tasks', tool: 'ui.filter.tasks', args: { status: 'done' } }, label: '/Filter Tasks done',
    });
    expect(registry.completeCommand(request, { status: 'x'.repeat(2_100) })).toMatchObject({ status: 'needs-args', request: { error: 'invalid' } });
  });

  it('turns a prompt command into model text', () => {
    const registry = createChatInteractionRegistry({ commands: [standup], locale: 'de' });
    expect(registry.planMessage('/tagesrückblick bitte kurz', [mention('command', 'standup', 'Tagesrückblick', '/')]))
      .toEqual({ status: 'prompt', text: 'Fasse meinen Tag zusammen. bitte kurz' });
  });

  it('keeps the prompt text as written, including dollar replacement patterns', () => {
    const cost = defineChatCommand({
      id: 'cost',
      label: 'Cost',
      run: { kind: 'prompt', prompt: "Cost $& and $$ and $` and $' and $1 today." },
    });
    const registry = createChatInteractionRegistry({ commands: [cost] });
    expect(registry.planMessage('/cost hello', [mention('command', 'cost', 'Cost', '/')]))
      .toEqual({ status: 'prompt', text: "Cost $& and $$ and $` and $' and $1 today. hello" });
  });

  it('runs entity actions with the entity id, nested where the action needs it', () => {
    const registry = createChatInteractionRegistry({ data, locale: 'de' });
    const target = { type: 'task', id: '7', label: 'Release prüfen' };
    expect(parseChatCommandMessage((registry.planAction(target, 'task.tasks.complete') as { text: string }).text)).toEqual({
      invocation: { commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } },
      label: '/Erledigen @Release prüfen',
    });
    expect(parseChatCommandMessage((registry.planAction(target, 'task.open') as { text: string }).text)?.invocation.args)
      .toEqual({ destination: '/tasks/:taskId', params: { taskId: '7' } });
    expect(registry.planAction(target, 'task.unknown')).toBeUndefined();
  });
});
