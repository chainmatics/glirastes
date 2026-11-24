import { describe, expect, it, vi } from 'vitest';
import { CHAT_COMMAND_MAX_LABEL_LENGTH, parseChatCommandMessage } from '../../../contracts/chat-command.js';
import { parseMentionMarkers } from '../../../contracts/mention-marker.js';
import type { ChatInteractionArg, ChatInteractionsData } from '../../../contracts/chat-interactions.js';
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
      group: 'Befehle',
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
      actions: [{ id: 'task.tasks.complete', label: 'Complete' }, { id: 'task.open', label: 'Open' }], group: 'Task',
    }]);
    expect((await search('ali', '@')).filter((item) => item.type === 'person')).toEqual([{
      id: 'alice', key: 'chat-entities:person:alice', type: 'person', label: 'Alice Example', description: 'alice@example.com',
      group: 'Person',
    }]);
  });

  it('finds commands with umlauts typed either way', async () => {
    const label = (id: string, text: string) => defineChatCommand({ id, label: text, run: { kind: 'tool', tool: id } });
    const registry = createChatInteractionRegistry({
      locale: 'de',
      commands: [label('one', 'Löschen'), label('two', 'Schließen'), label('three', 'Übersicht öffnen')],
    });
    const search = createCompletionSearch(registry.providers);
    const labels = async (query: string) => (await search(query, '/')).map((item) => item.label);
    expect(await labels('loe')).toEqual(['Löschen']);
    expect(await labels('los')).toEqual(['Löschen']);
    expect(await labels('ueber')).toEqual(['Übersicht öffnen']);
    expect(await labels('uber')).toEqual(['Übersicht öffnen']);
    expect(await labels('schliessen')).toEqual(['Schließen']);
    expect(await labels('oeffnen')).toEqual(['Übersicht öffnen']);
  });

  it('carries the icon name of commands and entities to their hits', async () => {
    const registry = createChatInteractionRegistry({
      locale: 'en',
      commands: [defineChatCommand({ id: 'help', label: 'Help', icon: 'life-buoy', run: { kind: 'tool', tool: 'help' } })],
      entities: [defineChatEntity({ type: 'person', label: 'Person', icon: 'user', search: () => [{ id: 'a', label: 'Ann' }] })],
    });
    const search = createCompletionSearch(registry.providers);
    expect((await search('hel', '/'))[0]).toMatchObject({ icon: 'life-buoy' });
    expect((await search('an', '@'))[0]).toMatchObject({ icon: 'user' });
  });

  it('names the group of every hit', async () => {
    const german = createCompletionSearch(createChatInteractionRegistry({ data, entities: [person], fetch: tasksFetch(), locale: 'de' }).providers);
    expect((await german('auf', '/'))[0]).toMatchObject({ group: 'Befehle' });
    expect((await german('rel', '@')).find((item) => item.type === 'task')).toMatchObject({ group: 'Aufgabe' });
    const english = createCompletionSearch(createChatInteractionRegistry({ data, locale: 'en' }).providers);
    expect((await english('filter', '/'))[0]).toMatchObject({ group: 'Commands' });
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
    expect(both.map((item) => item.id)).toEqual(['aaa0', 'aaa1', 'aaa2', 'aaa3', 'bbb0', 'bbb1', 'bbb2', 'bbb3']);

    // A type with few hits is not starved by two with many, and a short list gives its slots to the others.
    const mixed = createCompletionSearch(createChatInteractionRegistry({
      entities: [entity('aaa', 8), entity('bbb', 1), entity('ccc', 8)],
    }).providers);
    expect((await mixed('', '@')).map((item) => item.id)).toEqual(['aaa0', 'aaa1', 'aaa2', 'aaa3', 'bbb0', 'ccc0', 'ccc1', 'ccc2']);
  });

  it('sends a picked command alone as a direct command, and mixed text to the model', () => {
    const registry = createChatInteractionRegistry({ data, locale: 'en' });
    const open = mention('command', 'open.overview', 'Open Overview', '/');
    const plan = registry.planMessage('/open-overview', [open]);
    expect(plan?.status).toBe('send');
    expect(parseChatCommandMessage((plan as { text: string }).text)).toEqual({
      invocation: { commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } },
      label: '{{mention:command:open.overview:Open Overview}}',
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
      label: '{{mention:command:tasks.assign:Assign}} {{mention:task:7:Release prüfen}} {{mention:person:alice:Alice Example}}',
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
      invocation: { commandId: 'filter.tasks', tool: 'ui.filter.tasks', args: { status: 'done' } }, label: '{{mention:command:filter.tasks:Filter Tasks}} done',
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
      label: '{{mention:command:task.tasks.complete:Erledigen}} {{mention:task:7:Release prüfen}}',
    });
    expect(parseChatCommandMessage((registry.planAction(target, 'task.open') as { text: string }).text)?.invocation.args)
      .toEqual({ destination: '/tasks/:taskId', params: { taskId: '7' } });
    expect(registry.planAction(target, 'task.unknown')).toBeUndefined();
  });
  describe('label line of a direct command', () => {
    const labelOf = (plan: unknown) => parseChatCommandMessage((plan as { text: string }).text)?.label;
    const assignWith = (args: ReadonlyArray<ChatInteractionArg>) => defineChatCommand({ ...assign, args });

    it('writes no marker for an entity argument without a picked label, nor for an argument without an entity type', () => {
      const registry = createChatInteractionRegistry({ data, entities: [person], commands: [assign], locale: 'en' });
      const partial = registry.planMessage('/assign @release-prüfen', [mention('command', 'tasks.assign', 'Assign', '/'), mention('task', '7', 'Release prüfen')]);
      if (partial?.status !== 'needs-args') throw new Error('expected a form request');
      // Typed into the form without a pick: the id as before, no name the approval card would trust.
      expect(labelOf(registry.completeCommand(partial.request, { assignee: 'bob' })))
        .toBe('{{mention:command:tasks.assign:Assign}} {{mention:task:7:Release prüfen}} @bob');
      expect(labelOf(registry.completeCommand(partial.request, { assignee: 'bob' }, { assignee: 'Bob Builder' })))
        .toBe('{{mention:command:tasks.assign:Assign}} {{mention:task:7:Release prüfen}} {{mention:person:bob:Bob Builder}}');
      // No declared entity type: plain text.
      const untyped = createChatInteractionRegistry({
        commands: [assignWith([{ name: 'taskId', label: 'Task', required: true }])], locale: 'en',
      });
      const asked = untyped.planMessage('/assign', [mention('command', 'tasks.assign', 'Assign', '/')]);
      if (asked?.status !== 'needs-args') throw new Error('expected a form request');
      expect(labelOf(untyped.completeCommand(asked.request, { taskId: '7' }, { taskId: 'Release' })))
        .toBe('{{mention:command:tasks.assign:Assign}} 7');
    });

    it('falls back to plain text for an id or label that cannot be written as a marker', () => {
      const registry = createChatInteractionRegistry({ data, entities: [person], commands: [assign], locale: 'en' });
      const command = mention('command', 'tasks.assign', 'Assign', '/');
      const label = (task: MentionData, who: MentionData) => labelOf(registry.planMessage(
        `/assign @${task.slug} @${who.slug}`, [command, task, who],
      ));
      // A colon splits the id for every reader, `}` ends the marker, a hidden character could carry text.
      expect(label(mention('task', 'a:b', 'Colon'), mention('person', 'x}y', 'Brace')))
        .toBe('{{mention:command:tasks.assign:Assign}} @Colon @Brace');
      expect(label(mention('task', 'a\u200bb', 'Hidden'), mention('person', 'two  spaces', 'Spaces')))
        .toBe('{{mention:command:tasks.assign:Assign}} @Hidden @Spaces');
      // A label is written in its canonical form, never ending the marker early.
      expect(label(mention('task', '7', 'A}}B'), mention('person', 'alice', 'Line\nbreak')))
        .toBe('{{mention:command:tasks.assign:Assign}} {{mention:task:7:A｝｝B}} {{mention:person:alice:Line break}}');
    });

    it('never cuts a marker at the label limit', () => {
      const registry = createChatInteractionRegistry({ data, entities: [person], commands: [assign], locale: 'en' });
      const command = mention('command', 'tasks.assign', 'Assign', '/');
      const longId = `t${'1'.repeat(150)}`;
      for (const [task, who] of [
        [mention('task', '7', 'R'.repeat(150)), mention('person', 'alice', 'A'.repeat(150))],
        [mention('task', longId, 'Short'), mention('person', 'alice', 'Alice')],
        [mention('task', '7', '😀'.repeat(110)), mention('person', 'alice', '😀'.repeat(110))],
      ] as const) {
        const line = labelOf(registry.planMessage(`/assign @${task.slug} @${who.slug}`, [command, task, who]))!;
        expect(line.length).toBeLessThanOrEqual(CHAT_COMMAND_MAX_LABEL_LENGTH);
        // Every `{{mention:` that starts in the line is a whole marker.
        expect(line.split('{{mention:').length - 1).toBe(parseMentionMarkers(line).length);
        expect(line.startsWith('{{mention:command:tasks.assign:Assign}} ')).toBe(true);
      }
      // A label too long for the rest of the line is shortened inside its marker, not dropped.
      const send = (task: MentionData, who: MentionData) => labelOf(registry.planMessage(`/assign @${task.slug} @${who.slug}`, [command, task, who]))!;
      const long = send(mention('task', '7', 'R'.repeat(150)), mention('person', 'alice', 'Alice'));
      expect(parseMentionMarkers(long).map(({ type, id }) => `${type}:${id}`)).toEqual(['command:tasks.assign', 'task:7', 'person:alice']);
      expect(parseMentionMarkers(long)[1]!.label).toMatch(/^R+…$/);
      // An id that leaves no room for a marker: that piece as plain text, cut like before.
      const plain = send(mention('task', longId, 'Short'), mention('person', 'alice', 'Alice'));
      expect(plain).toBe(`{{mention:command:tasks.assign:Assign}} @Short {{mention:person:alice:Alice}}`);

      // Free text between two mentions: the first label leaves room for it and the second marker.
      const noted = createChatInteractionRegistry({
        entities: [person],
        commands: [assignWith([
          { name: 'taskId', label: 'Task', required: true, entity: 'task' },
          { name: 'note', label: 'Note', required: true },
          { name: 'assignee', label: 'Person', required: true, entity: 'person' },
        ])],
        locale: 'en',
      });
      const asked = noted.planMessage('/assign', [command]);
      if (asked?.status !== 'needs-args') throw new Error('expected a form request');
      const withNote = labelOf(noted.completeCommand(
        asked.request,
        { taskId: '7', note: 'n'.repeat(40), assignee: 'alice' },
        { taskId: 'T'.repeat(150), assignee: 'Alice' },
      ))!;
      expect(withNote.length).toBeLessThanOrEqual(CHAT_COMMAND_MAX_LABEL_LENGTH);
      expect(parseMentionMarkers(withNote).map(({ type }) => type)).toEqual(['command', 'task', 'person']);
      expect(withNote).toContain(` ${'n'.repeat(40)} {{mention:person:alice:Alice}}`);
    });

    it('marks the target of an entity action with the type of its entity', () => {
      const registry = createChatInteractionRegistry({ data, locale: 'en' });
      expect(labelOf(registry.planAction({ type: 'task', id: '7', label: 'Release' }, 'task.open')))
        .toBe('{{mention:command:task.open:Open}} {{mention:task:7:Release}}');
      expect(labelOf(registry.planAction({ type: 'task', id: '7:8', label: 'Release' }, 'task.open')))
        .toBe('{{mention:command:task.open:Open}} @Release');
    });
  });
});
