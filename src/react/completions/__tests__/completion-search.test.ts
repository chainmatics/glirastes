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
      { id: '42', key: 'people:42', type: 'user', label: 'Alice Doe', description: 'match al' },
      { id: '43', key: 'people:43', type: 'user', label: 'Alex Roe' },
      { id: '42', key: 'tasks:42', type: 'task', label: 'Bericht schreiben' },
    ]);
    expect(await search('al', '/')).toEqual([]);
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
      expect((await pending).map((result) => result.key)).toEqual(['people:42', 'people:43']);
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
});
