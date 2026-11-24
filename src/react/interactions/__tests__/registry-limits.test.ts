import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionProvider } from '../../types.js';
import { createCompletionSearch, resolveCompletionLimits } from '../../completions/completion-search.js';
import { defineChatCommand, defineChatEntity, type ChatEntityDefinition } from '../definitions.js';
import { createChatInteractionRegistry, type ChatInteractionsConfig } from '../registry.js';

const commands = Array.from({ length: 30 }, (_, index) => defineChatCommand({
  id: `cmd.${String(index).padStart(2, '0')}`,
  label: `Command ${String(index).padStart(2, '0')}`,
  run: { kind: 'prompt', prompt: 'x' },
}));

const hits = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, label: `${prefix} ${index}` }));
const entity = (type: string, count: number, spy?: (limit: number) => void): ChatEntityDefinition => defineChatEntity({
  type, label: type, search: (_query, { limit }) => {
    spy?.(limit);
    return hits(type, count).slice(0, limit);
  },
});

/** The search the provider builds: the registry's providers (after the app's own) with `completionLimits` as `limits`. */
function composerSearch(config: ChatInteractionsConfig, own: ChatCompletionProvider[] = []) {
  const registry = createChatInteractionRegistry(config);
  return {
    registry,
    search: createCompletionSearch([...own, ...registry.providers], config.completionLimits ? { limits: config.completionLimits } : {}),
  };
}

describe('completion limits per trigger', () => {
  it('shows 8 of 30 commands by default and all 30 when / is raised', async () => {
    expect(await composerSearch({ commands }).search('', '/')).toHaveLength(8);
    const raised = composerSearch({ commands, completionLimits: { '/': { perProvider: 30, total: 30 } } });
    const all = await raised.search('', '/');
    expect(all).toHaveLength(30);
    expect(all.map((item) => item.id)).toEqual(commands.map((command) => command.id));
  });

  it('a raised per-provider cap without a total is not cut back to 12', async () => {
    expect(await composerSearch({ commands, completionLimits: { '/': { perProvider: 20 } } }).search('', '/')).toHaveLength(20);
    // A total below the per-provider cap still holds.
    expect(await composerSearch({ commands, completionLimits: { '/': { perProvider: 20, total: 5 } } }).search('', '/')).toHaveLength(5);
  });

  it('passes the @ per-provider cap to every entity search as limit, and keeps @ at 8 when only / is raised', async () => {
    const limits: number[] = [];
    const raised = composerSearch({
      entities: [entity('task', 50, (limit) => limits.push(limit))],
      commands,
      completionLimits: { '@': { perProvider: 40, total: 40 } },
    });
    expect(await raised.search('', '@')).toHaveLength(40);
    expect(limits).toEqual([40]);
    // `/` keeps its default when only `@` is raised.
    expect(await raised.search('', '/')).toHaveLength(8);

    limits.length = 0;
    const onlyCommands = composerSearch({
      entities: [entity('task', 50, (limit) => limits.push(limit))],
      commands,
      completionLimits: { '/': { perProvider: 30, total: 30 } },
    });
    expect(await onlyCommands.search('', '@')).toHaveLength(8);
    expect(limits).toEqual([8]);
    expect(await onlyCommands.search('', '/')).toHaveLength(30);
  });

  it('clamps invalid and out-of-range values without throwing', () => {
    expect(resolveCompletionLimits({}, '/')).toEqual({ perProvider: 8, total: 12 });
    expect(resolveCompletionLimits({ limits: { '/': { perProvider: 1_000, total: 10_000 } } }, '/')).toEqual({ perProvider: 100, total: 200 });
    expect(resolveCompletionLimits({ limits: { '/': { perProvider: 0, total: -5 } } }, '/')).toEqual({ perProvider: 1, total: 1 });
    expect(resolveCompletionLimits({ limits: { '/': { perProvider: 12.9, total: 15.2 } } }, '/')).toEqual({ perProvider: 12, total: 15 });
    expect(resolveCompletionLimits({ limits: { '/': { perProvider: Number.NaN, total: Infinity } } }, '/')).toEqual({ perProvider: 8, total: 12 });
    expect(resolveCompletionLimits({ limits: { '/': { perProvider: '30' as never, total: null as never } } }, '/')).toEqual({ perProvider: 8, total: 12 });
    expect(resolveCompletionLimits({ limits: { '/': null as never } }, '/')).toEqual({ perProvider: 8, total: 12 });
    expect(resolveCompletionLimits({ limits: 'x' as never }, '/')).toEqual({ perProvider: 8, total: 12 });
    // Inherited keys are no configuration.
    expect(resolveCompletionLimits({ limits: {} }, 'constructor')).toEqual({ perProvider: 8, total: 12 });
    // The overall caps keep their defaults and gain the new maxima.
    expect(resolveCompletionLimits({ limitPerProvider: 500, maxResults: 500 }, '@')).toEqual({ perProvider: 100, total: 200 });
    expect(resolveCompletionLimits({ limitPerProvider: 3, limits: { '/': { perProvider: 30 } } }, '@')).toEqual({ perProvider: 3, total: 12 });
  });

  it('keeps the total cap across several entity types and gives each its turn', async () => {
    const { search } = composerSearch({
      entities: [entity('aaa', 50), entity('bbb', 2), entity('ccc', 50)],
      completionLimits: { '@': { perProvider: 30, total: 20 } },
    });
    const results = await search('', '@');
    expect(results).toHaveLength(20);
    const count = (type: string) => results.filter((item) => item.type === type).length;
    // Round robin: the short list gives its slots to the others, none fills the list alone.
    expect([count('aaa'), count('bbb'), count('ccc')]).toEqual([9, 2, 9]);
  });

  it('applies to the app\'s own providers on the same trigger', async () => {
    const own: ChatCompletionProvider = {
      id: 'own-commands', trigger: '/',
      search: ({ limit }) => hits('own', 40).map((item) => ({ ...item, type: 'snippet' })).slice(0, limit),
    };
    const { search } = composerSearch({ commands, completionLimits: { '/': { perProvider: 25, total: 60 } } }, [own]);
    const results = await search('', '/');
    expect(results.filter((item) => item.type === 'snippet')).toHaveLength(25);
    expect(results.filter((item) => item.type === 'command')).toHaveLength(25);
    expect(results).toHaveLength(50);
  });

  it('type suggestions stay at most 3 and outside the caps', async () => {
    const { search } = composerSearch({
      entities: ['task', 'tag', 'team', 'topic'].map((type) => entity(type, 5)),
      completionLimits: { '@': { perProvider: 2, total: 2 } },
    });
    const results = await search('t', '@');
    expect(results.filter((item) => item.type === 'mention-filter')).toHaveLength(3);
    expect(results.filter((item) => item.type !== 'mention-filter')).toHaveLength(2);
  });

  it('sizes the argument form\'s entity search by the @ per-provider cap, else 8', async () => {
    const search = vi.fn((_query: string, { limit }: { limit: number }) => hits('p', 50).slice(0, limit + 5));
    const person = defineChatEntity({ type: 'person', label: 'Person', search });
    const signal = new AbortController().signal;
    expect(await createChatInteractionRegistry({ entities: [person] }).searchEntity('person', '', signal)).toHaveLength(8);
    expect(search.mock.calls[0]![1]).toMatchObject({ limit: 8 });
    const raised = createChatInteractionRegistry({ entities: [person], completionLimits: { '@': { perProvider: 25 }, '/': { perProvider: 3 } } });
    expect(await raised.searchEntity('person', '', signal)).toHaveLength(25);
    expect(search.mock.calls[1]![1]).toMatchObject({ limit: 25 });
    const clamped = createChatInteractionRegistry({ entities: [person], completionLimits: { '@': { perProvider: 999 } } });
    expect(await clamped.searchEntity('person', '', signal)).toHaveLength(50);
    expect(search.mock.calls[2]![1]).toMatchObject({ limit: 100 });
  });
});
