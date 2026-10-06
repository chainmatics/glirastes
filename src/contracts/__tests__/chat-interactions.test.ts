import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatInteractionsError,
  chatText,
  isChatArgumentPath,
  mergeChatInteractions,
  parseChatInteractionOverrides,
  parseChatInteractions,
  type ChatInteractionsData,
} from '../chat-interactions.js';

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [{
    type: 'task',
    label: { de: 'Aufgabe', en: 'Task' },
    search: {
      tool: 'tasks.list', path: '/api/tasks', queryParam: 'search', itemsPath: ['tasks'],
      idField: 'id', labelField: 'title', descriptionField: 'status',
    },
    actions: [
      { id: 'task.tasks.complete', label: { en: 'Complete' }, entityArg: 'id', run: { kind: 'tool', tool: 'tasks.complete' } },
      {
        id: 'task.tasks.assign', label: { en: 'Assign' }, entityArg: 'id',
        args: [{ name: 'assignee', label: 'Person', required: true, entity: 'person' }],
        run: { kind: 'tool', tool: 'tasks.assign' },
      },
    ],
  }],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
    {
      id: 'filter.tasks', label: { en: 'Filter Tasks' },
      args: [{ name: 'status', label: 'Status', options: ['done', 'open'] }],
      run: { kind: 'ui', tool: 'ui.filter.tasks' },
    },
  ],
};

function issuesOf(run: () => unknown): ReadonlyArray<string> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChatInteractionsError);
    return (error as ChatInteractionsError).issues;
  }
  throw new Error('expected a ChatInteractionsError');
}

describe('chat interaction data', () => {
  it('accepts derived entities, actions and commands unchanged', () => {
    expect(parseChatInteractions(data)).toEqual(data);
  });

  it('reads texts per language with an English fallback', () => {
    expect(chatText({ de: 'Übersicht öffnen', en: 'Open Overview' }, 'de')).toBe('Übersicht öffnen');
    expect(chatText({ en: 'Open Overview' }, 'de')).toBe('Open Overview');
    expect(chatText('Öffnen', 'en')).toBe('Öffnen');
    expect(chatText(undefined)).toBe('');
  });

  it.each([
    ['a prototype path', '__proto__.polluted', false],
    ['a constructor segment', 'params.constructor', false],
    ['five segments', 'a.b.c.d.e', false],
    ['a nested path', 'params.taskId', true],
  ])('checks argument paths: %s', (_label, path, valid) => {
    expect(isChatArgumentPath(path)).toBe(valid);
  });

  it('names every violation instead of keeping a partial result', () => {
    const issues = issuesOf(() => parseChatInteractions({
      schemaVersion: 1,
      entities: [{ type: 'Task', label: '', search: { tool: 'tasks.list', path: '//evil.example', queryParam: 'q', itemsPath: [], idField: 'id', labelField: 'title' } }],
      commands: [
        { id: 'open:x', label: 'X', run: { kind: 'tool', tool: 'x' } },
        { id: 'run', label: 'Run', run: { kind: 'shell', tool: 'x' } },
        { id: 'big', label: 'Big', run: { kind: 'tool', tool: 'x', args: { blob: 'x'.repeat(2_100) } } },
        { id: 'dup', label: 'A', run: { kind: 'tool', tool: 'x' } },
        { id: 'dup', label: 'B', run: { kind: 'tool', tool: 'x' } },
        { id: 'extra', label: 'E', run: { kind: 'tool', tool: 'x' }, onRun: 'alert(1)' },
      ],
    }));
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('$.entities[0].type'),
      expect.stringContaining('$.entities[0].label'),
      expect.stringContaining('$.entities[0].search.path'),
      expect.stringContaining('$.commands[0].id'),
      expect.stringContaining('$.commands[1].run.kind'),
      expect.stringContaining('$.commands[2].run.args'),
      expect.stringContaining('duplicate dup'),
      expect.stringContaining('$.commands[5].onRun: unknown field'),
    ]));
  });

  it('refuses more commands than the limit', () => {
    const commands = Array.from({ length: 301 }, (_, index) => ({ id: `c${index}`, label: 'C', run: { kind: 'tool', tool: 'x' } }));
    expect(issuesOf(() => parseChatInteractions({ schemaVersion: 1, entities: [], commands })))
      .toEqual(['$.commands: an array of at most 300 entries']);
  });
});

describe('chat interaction overrides', () => {
  it('relabels, hides and adds entries, and keeps everything else derived', () => {
    const overrides = parseChatInteractionOverrides({
      schemaVersion: 1,
      commands: {
        'open.overview': { label: { de: 'Startseite', en: 'Home' }, keywords: ['start'] },
        'filter.tasks': { hidden: true },
        'standup': { label: 'Stand-up', run: { kind: 'prompt', prompt: { de: 'Fasse meinen Tag zusammen.' } } },
      },
      entities: {
        task: { label: { de: 'Aufgabe', en: 'To-do' }, actions: { 'task.tasks.complete': { hidden: true } } },
        person: {
          label: 'Person',
          search: { tool: 'people.list', path: '/api/people', queryParam: 'q', itemsPath: [], idField: 'id', labelField: 'name' },
        },
      },
    });
    const merged = mergeChatInteractions(data, overrides);
    expect(merged.commands.map((entry) => entry.id)).toEqual(['open.overview', 'standup']);
    expect(merged.commands[0]).toMatchObject({ label: { de: 'Startseite', en: 'Home' }, keywords: ['start'], run: data.commands[0]!.run });
    expect(merged.commands[1]!.run).toEqual({ kind: 'prompt', prompt: { de: 'Fasse meinen Tag zusammen.' } });
    expect(merged.entities.map((entry) => entry.type)).toEqual(['task', 'person']);
    expect(merged.entities[0]!.label).toEqual({ de: 'Aufgabe', en: 'To-do' });
    expect(merged.entities[0]!.actions!.map((entry) => entry.id)).toEqual(['task.tasks.assign']);
  });

  it('removes the last action of an entity when every action is hidden', () => {
    const merged = mergeChatInteractions(data, parseChatInteractionOverrides({
      schemaVersion: 1,
      entities: { task: { actions: { 'task.tasks.complete': { hidden: true }, 'task.tasks.assign': { hidden: true } } } },
    }));
    expect(merged.entities[0]).not.toHaveProperty('actions');
  });

  it('refuses unknown override fields and a wrong schema version', () => {
    expect(issuesOf(() => parseChatInteractionOverrides({ schemaVersion: 1, commands: { 'open.overview': { color: 'red' } } })))
      .toEqual(['$.commands.open.overview.color: unknown field']);
    expect(issuesOf(() => parseChatInteractionOverrides({ schemaVersion: 2 }))).toEqual(['$.schemaVersion: must be 1']);
  });
});

describe('override patches for ids that are no longer derived', () => {
  afterEach(() => vi.restoreAllMocks());

  const warned = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  it('ignores a patch whose command id is not in the derived list, and warns once', () => {
    const warn = warned();
    const withoutFilter: ChatInteractionsData = { ...data, commands: data.commands.filter((entry) => entry.id !== 'filter.tasks') };
    const merged = mergeChatInteractions(withoutFilter, parseChatInteractionOverrides({
      schemaVersion: 1,
      commands: {
        'filter.tasks': { label: 'Filter tasks', icon: 'filter' },
        'open.overview': { label: 'Home' },
      },
    }));
    expect(merged.commands.map((entry) => entry.id)).toEqual(['open.overview']);
    expect(merged.commands[0]!.label).toBe('Home');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('commands.filter.tasks');
    expect(String(warn.mock.calls[0]![0])).not.toContain('open.overview');
  });

  it('ignores stale action and entity patches, keeps what is derived, and names every ignored id in one warning', () => {
    const warn = warned();
    const merged = mergeChatInteractions(data, parseChatInteractionOverrides({
      schemaVersion: 1,
      commands: { orphan: { keywords: ['x'] } },
      entities: {
        task: { label: 'To-do', actions: { 'task.tasks.removed': { label: 'Removed' }, 'task.tasks.assign': { label: 'Give' } } },
        project: { label: 'Project', icon: 'folder' },
      },
    }));
    expect(merged.commands).toEqual(data.commands);
    expect(merged.entities.map((entry) => entry.type)).toEqual(['task']);
    expect(merged.entities[0]!.label).toBe('To-do');
    expect(merged.entities[0]!.actions!.map((entry) => [entry.id, entry.label])).toEqual([
      ['task.tasks.complete', { en: 'Complete' }],
      ['task.tasks.assign', 'Give'],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    for (const id of ['commands.orphan', 'entities.task.actions.task.tasks.removed', 'entities.project']) {
      expect(message).toContain(id);
    }
  });

  it('keeps complete new entries and stays silent when nothing is stale', () => {
    const warn = warned();
    const merged = mergeChatInteractions(data, parseChatInteractionOverrides({
      schemaVersion: 1,
      commands: { standup: { label: 'Stand-up', run: { kind: 'prompt', prompt: 'Summarize my day.' } }, 'filter.tasks': { hidden: true } },
      entities: {
        person: { label: 'Person', search: { tool: 'people.list', path: '/api/people', queryParam: 'q', itemsPath: [], idField: 'id', labelField: 'name' } },
        task: { actions: { 'task.tasks.reopen': { label: 'Reopen', entityArg: 'id', run: { kind: 'tool', tool: 'tasks.reopen' } } } },
      },
    }));
    expect(merged.commands.map((entry) => entry.id)).toEqual(['open.overview', 'standup']);
    expect(merged.entities.map((entry) => entry.type)).toEqual(['task', 'person']);
    expect(merged.entities[0]!.actions!.map((entry) => entry.id)).toEqual(['task.tasks.complete', 'task.tasks.assign', 'task.tasks.reopen']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for a hidden entry that is not derived (it is already out of the list)', () => {
    const warn = warned();
    const merged = mergeChatInteractions(data, parseChatInteractionOverrides({
      schemaVersion: 1,
      commands: { 'gone.command': { hidden: true } },
      entities: { gone: { hidden: true } },
    }));
    expect(merged).toEqual(parseChatInteractions(data));
    expect(warn).not.toHaveBeenCalled();
  });
});
