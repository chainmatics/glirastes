import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';
import { createCompletionSearch } from '../../completions/completion-search.js';
import type { ChatCompletionProvider } from '../../types.js';
import { defineChatCommand, defineChatEntity, entitiesFromData, type ChatEntityDefinition } from '../definitions.js';
import { createChatInteractionRegistry, type ChatInteractionsConfig, type ChatMentionContext } from '../registry.js';

/** An entity whose search records each query and returns `<type> <query>` hits. */
function entity(type: string, label: ChatEntityDefinition['label'], extra: Partial<ChatEntityDefinition> = {}) {
  const queries: string[] = [];
  const definition = defineChatEntity({
    type,
    label,
    search: (query) => {
      queries.push(query);
      return [{ id: `${type}-1`, label: `${type} ${query}`.trim() }];
    },
    ...extra,
  });
  return { definition, queries };
}

function setup(config: Omit<ChatInteractionsConfig, 'entities'> & { entities: ChatEntityDefinition[] }, providers: ChatCompletionProvider[] = []) {
  const registry = createChatInteractionRegistry(config);
  const search = createCompletionSearch([...providers, ...registry.providers]);
  return { registry, search };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('@<type>:<text> filter', () => {
  it('searches only the named type with the text after the first colon', async () => {
    const task = entity('task', { de: 'Aufgabe', en: 'Task' });
    const person = entity('person', { de: 'Person', en: 'Person' });
    const { search, registry } = setup({ entities: [task.definition, person.definition], locale: 'de' });

    const hits = await search('aufgabe:rel', '@');
    expect(hits.map((hit) => [hit.type, hit.id, hit.label])).toEqual([['task', 'task-1', 'task rel']]);
    expect(task.queries).toEqual(['rel']);
    expect(person.queries).toEqual([]);

    // Colon inside the text: only the first one separates.
    expect(registry.entityFilter('task:12:30')).toEqual({ type: 'task', text: '12:30' });
    // Case and diacritics folded; the canonical type always works.
    expect(registry.entityFilter('AUFGABE:x')).toEqual({ type: 'task', text: 'x' });
    expect(registry.entityFilter('Task:x')).toEqual({ type: 'task', text: 'x' });
    // Empty text after the colon lists that type.
    task.queries.length = 0;
    await search('Aufgabe:', '@');
    expect(task.queries).toEqual(['']);
    expect(person.queries).toEqual([]);
  });

  it('searches every type with the whole input when the text before the colon is no filter name', async () => {
    const task = entity('task', 'Task');
    const person = entity('person', 'Person');
    const { search, registry } = setup({ entities: [task.definition, person.definition] });
    expect(registry.entityFilter('12:30')).toBeUndefined();
    expect(registry.entityFilter('meeting:today')).toBeUndefined();
    expect(registry.entityFilter(':x')).toBeUndefined();
    await search('12:30', '@');
    expect(task.queries).toEqual(['12:30']);
    expect(person.queries).toEqual(['12:30']);
  });

  it('applies the German transliteration the command ranking uses', () => {
    const office = entity('supply', { de: 'Bürobedarf', en: 'Supplies' });
    const { registry } = setup({ entities: [office.definition, entity('task', 'Aufgabe').definition], locale: 'de-AT' });
    expect(registry.entityFilter('buerobedarf:x')).toEqual({ type: 'supply', text: 'x' });
    expect(registry.entityFilter('burobedarf:x')).toEqual({ type: 'supply', text: 'x' });
    expect(registry.entityFilter('BÜROBEDARF:x')).toEqual({ type: 'supply', text: 'x' });
  });

  it('takes aliases of the active language (pl-PL finds pl) and a language-free list', () => {
    const task = entity('task', { pl: 'Zadanie', en: 'Task' }, { aliases: { pl: ['zad', 'todo-pl'], de: ['aufg'] } });
    const person = entity('person', { pl: 'Osoba', en: 'Person' }, { aliases: ['who'] });
    const { registry } = setup({ entities: [task.definition, person.definition], locale: 'pl-PL' });
    expect(registry.entityFilter('zad:x')).toEqual({ type: 'task', text: 'x' });
    expect(registry.entityFilter('zadanie:x')).toEqual({ type: 'task', text: 'x' });
    expect(registry.entityFilter('aufg:x')).toBeUndefined();
    expect(registry.entityFilter('who:x')).toEqual({ type: 'person', text: 'x' });
    expect(registry.entityFilterNames('task')).toEqual(['Zadanie', 'zad', 'todo-pl', 'task']);
    expect(registry.entityFilterNames('person')).toEqual(['Osoba', 'who', 'person']);
  });

  it('never makes a label with a space a filter name; its alias and type still work', () => {
    const order = entity('purchase-order', 'Purchase order', { aliases: ['po'] });
    const { registry } = setup({ entities: [order.definition, entity('task', 'Task').definition] });
    expect(registry.entityFilter('Purchase:x')).toBeUndefined();
    expect(registry.entityFilter('po:x')).toEqual({ type: 'purchase-order', text: 'x' });
    expect(registry.entityFilter('purchase-order:x')).toEqual({ type: 'purchase-order', text: 'x' });
    expect(registry.entityFilterNames('purchase-order')).toEqual(['po', 'purchase-order']);
  });

  it('makes a name two types share a filter name of neither and warns once, naming the types', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = entity('ticket', 'Item', { aliases: ['tk'] });
    const b = entity('product', 'Item');
    const { registry } = setup({ entities: [a.definition, b.definition] });
    expect(registry.entityFilter('item:x')).toBeUndefined();
    expect(registry.entityFilter('tk:x')).toEqual({ type: 'ticket', text: 'x' });
    expect(registry.entityFilter('product:x')).toEqual({ type: 'product', text: 'x' });
    expect(registry.entityFilterNames('product')).toEqual(['product']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('1 group(s) of entity types');
    expect(String(warn.mock.calls[0]![0])).not.toContain('Item');
    expect(registry.entityFilterConflicts).toEqual([['product', 'ticket']]);
  });

  it('keeps the canonical type with its own type when another type uses it as a label', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = entity('user', 'Person');
    const person = entity('person', 'Contact');
    const { registry } = setup({ entities: [user.definition, person.definition] });
    expect(registry.entityFilter('person:x')).toEqual({ type: 'person', text: 'x' });
    expect(registry.entityFilter('user:x')).toEqual({ type: 'user', text: 'x' });
    expect(registry.entityFilter('contact:x')).toEqual({ type: 'person', text: 'x' });
  });

  it('does not throw for two entities with the same label (existing apps)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => setup({ entities: [entity('a', 'Same').definition, entity('b', 'Same').definition] })).not.toThrow();
  });

  it('treats a type the user may not search (absent, or without a search) as no filter', async () => {
    const data: ChatInteractionsData = {
      schemaVersion: 1,
      entities: [
        { type: 'invoice', label: 'Invoice', actions: [{ id: 'invoice.pay', label: 'Pay', entityArg: 'id', run: { kind: 'tool', tool: 'invoices.pay' } }] },
      ],
      commands: [],
    };
    const task = entity('task', 'Task');
    const { registry, search } = setup({ data, entities: [task.definition, entity('person', 'Person').definition] });
    expect(registry.entityFilter('invoice:x')).toBeUndefined();
    expect(registry.entityFilter('secret:x')).toBeUndefined();
    await search('invoice:x', '@');
    expect(task.queries).toEqual(['invoice:x']);
  });

  it('still filters with preferredTypes set', async () => {
    const task = entity('task', 'Task');
    const person = entity('person', 'Person');
    const { search } = setup({ entities: [task.definition, person.definition], mentionContext: { preferredTypes: ['person'] } });
    expect((await search('task:a', '@')).map((hit) => hit.type)).toEqual(['task']);
    expect(person.queries).toEqual([]);
  });

  it('narrows only its own entities: an app @ provider keeps receiving the full query', async () => {
    const own = vi.fn(({ query }: { query: string }) => [{ id: 'x1', type: 'doc', label: `Doc ${query}` }]);
    const task = entity('task', 'Task');
    const person = entity('person', 'Person');
    const { search } = setup(
      { entities: [task.definition, person.definition] },
      [{ id: 'docs', trigger: '@', search: own }],
    );
    const hits = await search('task:rel', '@');
    expect(own.mock.calls[0]![0].query).toBe('task:rel');
    expect(hits.map((hit) => hit.type)).toEqual(['doc', 'task']);
    expect(person.queries).toEqual([]);
    // Unfiltered, both keep their hits.
    expect((await search('rel', '@')).map((hit) => hit.type)).toEqual(['doc', 'task', 'person']);
  });
});

describe('mention context order', () => {
  it('lists the groups of preferredTypes first, then the declared order; unknown types are ignored', async () => {
    const types = ['task', 'person', 'project'].map((type) => entity(type, type[0]!.toUpperCase() + type.slice(1)));
    let context: ChatMentionContext | null = null;
    const { search } = setup({ entities: types.map((entry) => entry.definition), mentionContext: () => context });
    const groups = async () => [...new Set((await search('', '@')).map((hit) => hit.group))];
    expect(await groups()).toEqual(['Task', 'Person', 'Project']);
    context = { preferredTypes: ['project', 'unknown', 'person'] };
    expect(await groups()).toEqual(['Project', 'Person', 'Task']);
    context = null;
    expect(await groups()).toEqual(['Task', 'Person', 'Project']);
  });

  it('keeps the declared order of data entities before app entities', async () => {
    const data: ChatInteractionsData = {
      schemaVersion: 1,
      entities: [{
        type: 'task', label: 'Task',
        search: { tool: 'tasks.list', path: '/api/tasks', queryParam: 'q', itemsPath: ['items'], idField: 'id', labelField: 'title' },
      }],
      commands: [],
    };
    const fetch = vi.fn(async () => Response.json({ items: [{ id: 't1', title: 'Task one' }] }));
    const person = entity('person', 'Person');
    const { search } = setup({ data, fetch, entities: [person.definition], mentionContext: { preferredTypes: ['person'] } });
    expect([...new Set((await search('', '@')).map((hit) => hit.group))]).toEqual(['Person', 'Task']);
  });
});

describe('@<type>: suggestions', () => {
  const task = () => entity('task', { de: 'Aufgabe', en: 'Task' }, { icon: 'check' });
  const person = () => entity('person', { de: 'Person', en: 'Person' });

  it('suggests matching types above the hits, which still search every type', async () => {
    const tasks = task();
    // An entity whose name starts like the type name stays findable.
    const people = entity('person', 'Person', { search: (query) => [{ id: 'p1', label: `Aufgabenverteiler ${query}` }] });
    const { search } = setup({ entities: [tasks.definition, people.definition], locale: 'de' });
    const hits = await search('auf', '@');
    expect(hits[0]).toEqual({
      id: 'task', key: 'chat-entity-types:mention-filter:task', type: 'mention-filter', label: 'Aufgabe:',
      description: 'Nur diesen Typ durchsuchen', icon: 'check', group: 'Nach Typ filtern', select: 'query', insertText: 'Aufgabe:',
    });
    expect(hits.slice(1).map((hit) => hit.label)).toEqual(['task auf', 'Aufgabenverteiler auf']);
  });

  it('offers English texts by default and the app texts when given', async () => {
    const english = setup({ entities: [task().definition, person().definition] });
    expect((await english.search('ta', '@'))[0]).toMatchObject({ label: 'Task:', group: 'Filter by type', description: 'Search only this type' });
    const own = setup({
      entities: [task().definition, person().definition], locale: 'pl',
      texts: { entityTypesGroup: 'Szukaj w', entityTypeFilter: 'Tylko {type}', commandsGroup: 'Polecenia' },
      commands: [defineChatCommand({ id: 'help', label: 'Help', run: { kind: 'tool', tool: 'help' } })],
    });
    expect((await own.search('ta', '@'))[0]).toMatchObject({ group: 'Szukaj w', description: 'Tylko Task' });
    expect((await own.search('', '/'))[0]).toMatchObject({ group: 'Polecenia' });
  });

  it('matches every filter name but shows the primary one, at most three, preferred types first', async () => {
    const entities = ['alpha', 'alder', 'almond', 'alpine'].map((type) => entity(type, type.toUpperCase()).definition);
    const { search } = setup({ entities, mentionContext: { preferredTypes: ['alpine'] } });
    const suggestions = (await search('al', '@')).filter((hit) => hit.select === 'query');
    expect(suggestions.map((hit) => hit.label)).toEqual(['ALPINE:', 'ALPHA:', 'ALDER:']);
    const aliased = setup({ entities: [entity('task', 'Aufgabe', { aliases: ['todo'] }).definition, person().definition] });
    expect((await aliased.search('to', '@'))[0]).toMatchObject({ label: 'Aufgabe:', insertText: 'Aufgabe:' });
  });

  it('offers none with fewer than two entity types, for an empty query or once a colon is typed', async () => {
    const single = setup({ entities: [task().definition] });
    expect((await single.search('ta', '@')).some((hit) => hit.select === 'query')).toBe(false);
    // The filter itself still works with one type.
    expect(single.registry.entityFilter('task:x')).toEqual({ type: 'task', text: 'x' });
    const both = setup({ entities: [task().definition, person().definition] });
    expect((await both.search('', '@')).some((hit) => hit.select === 'query')).toBe(false);
    expect((await both.search('task:', '@')).some((hit) => hit.select === 'query')).toBe(false);
  });

  it('are neither dropped by the per-provider or overall cap nor merged with a hit of the same id', async () => {
    const tasks = entity('task', 'Task', { search: () => [{ id: 'task', label: 'Task named task' }] });
    const registry = createChatInteractionRegistry({ entities: [tasks.definition, person().definition] });
    const search = createCompletionSearch(registry.providers, { limitPerProvider: 1, maxResults: 1 });
    const hits = await search('ta', '@');
    expect(hits.map((hit) => [hit.type, hit.id])).toEqual([['mention-filter', 'task'], ['task', 'task']]);
  });
});

describe('completionPreset', () => {
  it('gives `<name>:` for a bare @ while the context names a known type', () => {
    let context: ChatMentionContext | undefined = { presetType: 'task' };
    const { registry } = setup({
      entities: [entity('task', { de: 'Aufgabe', en: 'Task' }).definition, entity('person', 'Person').definition],
      locale: 'de',
      mentionContext: () => context,
    });
    expect(registry.completionPreset('@')).toBe('Aufgabe:');
    expect(registry.completionPreset('/')).toBeUndefined();
    expect(registry.completionPreset('#')).toBeUndefined();
    context = { presetType: 'unknown' };
    expect(registry.completionPreset('@')).toBeUndefined();
    context = undefined;
    expect(registry.completionPreset('@')).toBeUndefined();
  });

  it('survives a throwing context reader', () => {
    const { registry, search } = setup({
      entities: [entity('task', 'Task').definition],
      mentionContext: () => { throw new Error('boom'); },
    });
    expect(registry.completionPreset('@')).toBeUndefined();
    return expect(search('', '@')).resolves.toHaveLength(1);
  });
});

describe('entity aliases in definitions', () => {
  it('validates aliases through the contract and carries derived ones over', () => {
    expect(() => defineChatEntity({ type: 'task', label: 'Task', aliases: ['to do'], search: () => [] })).toThrow(/aliases/);
    expect(() => defineChatEntity({ type: 'task', label: 'Task', aliases: ['a:b'], search: () => [] })).toThrow(/aliases/);
    expect(defineChatEntity({ type: 'task', label: 'Task', aliases: { pl: ['zadanie'] }, search: () => [] }).aliases).toEqual({ pl: ['zadanie'] });
    const [derived] = entitiesFromData({
      schemaVersion: 1,
      entities: [{ type: 'task', label: 'Task', aliases: { de: ['aufg'] } }],
      commands: [],
    });
    expect(derived!.aliases).toEqual({ de: ['aufg'] });
  });
});
