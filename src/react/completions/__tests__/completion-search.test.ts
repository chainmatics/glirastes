import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionProvider } from '../../types.js';
import { createCompletionSearch } from '../completion-search.js';

const people: ChatCompletionProvider = {
  id: 'people',
  trigger: '@',
  search: async ({ query }) => [
    { id: '42', type: 'user', label: 'Alice Doe', description: `match ${query}` },
    { id: '43', type: 'user', label: 'Alex Roe' },
  ],
};

const tasks: ChatCompletionProvider = {
  id: 'tasks',
  trigger: '@',
  search: () => [
    { id: '42', type: 'task', label: 'Bericht schreiben' },
    { id: '42', type: 'user', label: 'Duplicate Alice' },
  ],
};

describe('createCompletionSearch', () => {
  it('merges providers of one trigger with stable keys and app ids', async () => {
    const search = createCompletionSearch([people, tasks]);
    expect(await search('al', '@')).toEqual([
      { id: '42', key: 'people:user:42', type: 'user', label: 'Alice Doe', description: 'match al' },
      { id: '43', key: 'people:user:43', type: 'user', label: 'Alex Roe' },
      { id: '42', key: 'tasks:task:42', type: 'task', label: 'Bericht schreiben' },
    ]);
    expect(await search('al', '/')).toEqual([]);
  });

  it('gives items that share an id across types of one provider distinct keys', async () => {
    const search = createCompletionSearch([{
      id: 'workspace',
      trigger: '@',
      search: () => [
        { id: '42', type: 'user', label: 'Alice Doe' },
        { id: '42', type: 'task', label: 'Bericht schreiben' },
        { id: '42', type: 'user', label: 'Duplicate Alice' },
      ],
    }]);
    const results = await search('', '@');
    expect(results.map((result) => result.key)).toEqual(['workspace:user:42', 'workspace:task:42']);
    expect(new Set(results.map((result) => result.key)).size).toBe(results.length);
  });

  it('passes the permission context, limit and an abort signal', async () => {
    const search = vi.fn(() => []);
    await createCompletionSearch(
      [{ id: 'commands', trigger: '/', search }],
      { context: { roles: ['member'] }, limitPerProvider: 3 },
    )('nav', '/');
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'nav',
      trigger: '/',
      limit: 3,
      context: { roles: ['member'] },
      signal: expect.any(AbortSignal),
    }));
  });

  it('isolates failing and slow providers', async () => {
    vi.useFakeTimers();
    try {
      const onProviderError = vi.fn();
      const search = createCompletionSearch([
        { id: 'broken', trigger: '@', search: async () => { throw new Error('offline'); } },
        { id: 'slow', trigger: '@', search: () => new Promise(() => {}) },
        people,
      ], { timeoutMs: 50, onProviderError });
      const pending = search('al', '@');
      await vi.advanceTimersByTimeAsync(60);
      expect((await pending).map((result) => result.key)).toEqual(['people:user:42', 'people:user:43']);
      expect(onProviderError.mock.calls.map(([id]) => id)).toEqual(['broken', 'slow']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a superseded search and returns nothing for it', async () => {
    let firstSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const search = createCompletionSearch([{
      id: 'people',
      trigger: '@',
      search: async ({ query, signal }) => {
        if (query === 'a') {
          firstSignal = signal;
          await gate;
        }
        return [{ id: query, type: 'user', label: query }];
      },
    }]);
    const first = search('a', '@');
    const second = await search('al', '@');
    release();
    expect(await first).toEqual([]);
    expect(firstSignal?.aborted).toBe(true);
    expect(second.map((result) => result.id)).toEqual(['al']);
  });

  it('drops items that would break mention markers and rejects bad providers', async () => {
    const search = createCompletionSearch([{
      id: 'people',
      trigger: '@',
      search: () => [
        { id: 'a:b', type: 'user', label: 'Colon' },
        { id: 'ok', type: 'User Type', label: 'Bad type' },
        { id: 'x', type: 'user', label: '   ' },
        { id: 'fine', type: 'user', label: 'Fine' },
      ],
    }]);
    expect((await search('', '@')).map((result) => result.id)).toEqual(['fine']);
    expect(() => createCompletionSearch([people, people])).toThrow(/Duplicate/);
    expect(() => createCompletionSearch([{ ...people, id: 'Bad Id' }])).toThrow(/Invalid/);
  });

  it('hands the definition id and arguments of a tool-backed command to the result', async () => {
    const search = createCompletionSearch([{
      id: 'ui-tools',
      trigger: '/',
      search: () => [
        {
          id: 'ui.navigate.admin',
          type: 'command',
          label: 'Administration öffnen',
          definitionId: 'ui.navigate',
          args: { destination: 'admin' },
        },
        { id: 'ui.filter.done', type: 'command', label: 'Erledigte filtern' },
      ],
    }]);
    expect(await search('', '/')).toEqual([
      {
        id: 'ui.navigate.admin',
        key: 'ui-tools:command:ui.navigate.admin',
        type: 'command',
        label: 'Administration öffnen',
        definitionId: 'ui.navigate',
        args: { destination: 'admin' },
      },
      { id: 'ui.filter.done', key: 'ui-tools:command:ui.filter.done', type: 'command', label: 'Erledigte filtern' },
    ]);
  });

  it('drops tool-backed items whose definition id or arguments cannot be sent to the model', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad = [
      { definitionId: 'ui navigate' },
      { definitionId: 42 },
      { args: { destination: 'admin' } },
      { definitionId: 'ui.navigate', args: ['admin'] },
      { definitionId: 'ui.navigate', args: null },
      { definitionId: 'ui.navigate', args: circular },
      { definitionId: 'ui.navigate', args: { text: 'x'.repeat(2_001) } },
    ];
    const search = createCompletionSearch([{
      id: 'ui-tools',
      trigger: '/',
      search: () => [
        ...bad.map((extra, index) => ({
          id: `bad-${index}`, type: 'command', label: `Bad ${index}`, ...extra,
        })),
        { id: 'ok', type: 'command', label: 'Ok', definitionId: 'ui.navigate', args: { destination: 'x' } },
      ] as never,
    }]);
    expect((await search('', '/')).map((result) => result.id)).toEqual(['ok']);
  });
});
