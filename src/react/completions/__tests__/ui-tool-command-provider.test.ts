import { describe, expect, it } from 'vitest';
import type { ChatCompletionProvider, CompletionItem } from '../../types.js';
import {
  mentionDataFromResult,
  normalizeMentionSlug,
  serializeMentionsForSend,
} from '../../utils/mention-markup.js';
import { createCompletionSearch } from '../completion-search.js';
import { createUiToolCommandProvider } from '../ui-tool-command-provider.js';

const provider = createUiToolCommandProvider({
  tools: [
    { definitionId: 'ui.navigate.overview', label: 'Übersicht öffnen', keywords: ['dashboard'] },
    { definitionId: 'ui.filter.doneTasks', label: 'Erledigte Aufgaben filtern' },
    { definitionId: 'ui.navigate.admin', label: 'Administration öffnen', allowedRoles: ['admin'] },
    { definitionId: 'ui.dialog.newTask', label: 'Neue Aufgabe', description: 'Dialog öffnen' },
  ],
});

const search = (query: string, roles: string[] = ['member'], limit = 8) =>
  provider.search({
    query,
    trigger: '/',
    signal: new AbortController().signal,
    context: { roles },
    limit,
  }) as ReadonlyArray<{ id: string; type: string; label: string }>;

describe('createUiToolCommandProvider', () => {
  it('offers UI tools as / commands with their definition ids', () => {
    expect(provider).toMatchObject({ id: 'ui-tools', trigger: '/' });
    expect(search('über')).toEqual([
      { id: 'ui.navigate.overview', type: 'command', label: 'Übersicht öffnen' },
    ]);
  });

  it('folds diacritics and ranks label prefixes before word and id matches', () => {
    expect(search('ub').map((item) => item.id)).toEqual(['ui.navigate.overview']);
    expect(search('offnen').map((item) => item.id)).toEqual(['ui.navigate.overview']);
    expect(search('dashboard').map((item) => item.id)).toEqual(['ui.navigate.overview']);
    expect(search('newtask').map((item) => item.id)).toEqual(['ui.dialog.newTask']);
  });

  it('hides role-restricted commands unless the context holds the role', () => {
    expect(search('').map((item) => item.id)).not.toContain('ui.navigate.admin');
    expect(search('admin', ['admin']).map((item) => item.id)).toEqual(['ui.navigate.admin']);
  });

  it('lists everything for an empty query, sorted and limited', () => {
    expect(search('', ['member'], 2).map((item) => item.label)).toEqual([
      'Erledigte Aufgaben filtern',
      'Neue Aufgabe',
    ]);
  });
});

describe('createUiToolCommandProvider with command ids and arguments', () => {
  const navigation = createUiToolCommandProvider({
    tools: [
      {
        definitionId: 'ui.navigate',
        commandId: 'ui.navigate.overview',
        label: 'Übersicht öffnen',
        args: { destination: 'overview' },
      },
      {
        definitionId: 'ui.navigate',
        commandId: 'ui.navigate.admin',
        label: 'Administration öffnen',
        args: { destination: 'admin' },
        allowedRoles: ['admin'],
      },
      { definitionId: 'ui.filter', commandId: 'ui.filter.done', label: 'Erledigte filtern' },
      { definitionId: 'ui.dialog.newTask', label: 'Neue Aufgabe', args: { source: 'chat' } },
      { definitionId: 'ui.dialog.help', label: 'Hilfe', args: {} },
    ],
  });
  const run = (
    commands: ChatCompletionProvider,
    query: string,
    roles: string[] = [],
    limit = 20,
  ) => commands.search({
    query,
    trigger: '/',
    signal: new AbortController().signal,
    context: { roles },
    limit,
  }) as ReadonlyArray<CompletionItem>;
  const list = (roles: string[]) => run(navigation, '', roles);

  it('keeps one list entry per command id and hands the definition id and arguments to the model', () => {
    expect(list(['admin'])).toEqual([
      {
        id: 'ui.navigate.admin',
        type: 'command',
        label: 'Administration öffnen',
        definitionId: 'ui.navigate',
        args: { destination: 'admin' },
      },
      { id: 'ui.filter.done', type: 'command', label: 'Erledigte filtern', definitionId: 'ui.filter' },
      { id: 'ui.dialog.help', type: 'command', label: 'Hilfe' },
      {
        id: 'ui.dialog.newTask',
        type: 'command',
        label: 'Neue Aufgabe',
        definitionId: 'ui.dialog.newTask',
        args: { source: 'chat' },
      },
      {
        id: 'ui.navigate.overview',
        type: 'command',
        label: 'Übersicht öffnen',
        definitionId: 'ui.navigate',
        args: { destination: 'overview' },
      },
    ]);
    expect(list(['member']).map((item) => item.id)).not.toContain('ui.navigate.admin');
  });

  it('matches the command id as well as the definition id', () => {
    const ids = (query: string) => run(navigation, query, ['admin']).map((item) => item.id);
    expect(ids('navigate.admin')).toEqual(['ui.navigate.admin']);
    expect(ids('ui.navigate')).toEqual(['ui.navigate.admin', 'ui.navigate.overview']);
  });

  it.each([
    ['a duplicate command id', [
      { definitionId: 'ui.navigate', commandId: 'nav', label: 'A' },
      { definitionId: 'ui.filter', commandId: 'nav', label: 'B' },
    ], /Duplicate/],
    ['a shared definition id without command ids', [
      { definitionId: 'ui.navigate', label: 'A', args: { destination: 'a' } },
      { definitionId: 'ui.navigate', label: 'B', args: { destination: 'b' } },
    ], /Duplicate/],
    ['a colon in the command id', [
      { definitionId: 'ui.navigate', commandId: 'ui.navigate:admin', label: 'A' },
    ], /command id/],
    ['a colon in the default command id', [
      { definitionId: 'ui:navigate', label: 'A' },
    ], /command id/],
    ['a closing brace in the command id', [
      { definitionId: 'ui.navigate', commandId: 'nav}', label: 'A' },
    ], /command id/],
    ['a blank command id', [
      { definitionId: 'ui.navigate', commandId: ' ', label: 'A' },
    ], /command id/],
    ['a command id over 200 characters', [
      { definitionId: 'ui.navigate', commandId: 'x'.repeat(201), label: 'A' },
    ], /command id/],
    ['arguments the model cannot be given', [
      { definitionId: 'ui.navigate', commandId: 'nav', label: 'A', args: { big: 1n } },
    ], /definition id or arguments/],
    ['a definition id that cannot reach the model', [
      { definitionId: 'ui navigate', commandId: 'nav', label: 'A' },
    ], /definition id or arguments/],
  ])('rejects %s', (_name, tools, message) => {
    expect(() => createUiToolCommandProvider({ tools })).toThrow(message);
  });

  it('skips entries without a definition id or label instead of failing', () => {
    const lenient = createUiToolCommandProvider({
      tools: [
        { definitionId: ' ', commandId: 'a:b', label: 'No id' },
        { definitionId: 'ui.navigate', commandId: 'a:b', label: ' ' },
        { definitionId: 'ui.dialog.newTask', label: 'Neue Aufgabe' },
      ],
    });
    expect(run(lenient, '', [], 8)).toEqual([
      { id: 'ui.dialog.newTask', type: 'command', label: 'Neue Aufgabe' },
    ]);
  });
});

describe('a picked tool-backed command', () => {
  it('reaches the model with its definition id and arguments', async () => {
    const commands = createUiToolCommandProvider({
      tools: [
        {
          definitionId: 'ui.navigate',
          commandId: 'ui.navigate.admin',
          label: 'Administration öffnen',
          args: { destination: 'admin' },
        },
        { definitionId: 'ui.filter', commandId: 'ui.filter.done', label: 'Erledigte filtern' },
      ],
    });
    const find = createCompletionSearch([commands]);

    const results = await find('admin', '/');
    expect(results).toHaveLength(1);
    const picked = results[0];
    const slug = normalizeMentionSlug(picked.label);
    const sent = serializeMentionsForSend(
      `/${slug}`,
      [mentionDataFromResult(picked, { prefix: '/', slug })],
    );

    expect(sent).toBe(
      '<!--context:[Referenced entities: Administration öffnen '
      + '(ID: ui.navigate.admin, tool: ui.navigate, args: {"destination":"admin"})]--> '
      + '{{mention:command:ui.navigate.admin:Administration öffnen}}',
    );
  });
});
