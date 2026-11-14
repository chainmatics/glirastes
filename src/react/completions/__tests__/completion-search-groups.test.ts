import { describe, expect, it } from 'vitest';
import { createCompletionSearch } from '../completion-search.js';

describe('completion search groups', () => {
  it('keeps the hits of a group together in first-seen order', async () => {
    const search = createCompletionSearch([{
      id: 'mixed', trigger: '@',
      search: () => [
        { id: 'a1', type: 'task', label: 'A1', group: 'a' },
        { id: 'b1', type: 'task', label: 'B1', group: 'b' },
        { id: 'a2', type: 'task', label: 'A2', group: 'a' },
        { id: 'x', type: 'task', label: 'X' },
      ],
    }]);
    expect((await search('', '@')).map((item) => item.id)).toEqual(['a1', 'a2', 'b1', 'x']);
  });

  it('drops a group it cannot show and keeps the item', async () => {
    const search = createCompletionSearch([{
      id: 'bad', trigger: '@',
      search: () => [
        { id: 'blank', type: 'task', label: 'Blank', group: '  ' },
        { id: 'number', type: 'task', label: 'Number', group: 7 as never },
        { id: 'long', type: 'task', label: 'Long', group: 'x'.repeat(101) },
        { id: 'trimmed', type: 'task', label: 'Trimmed', group: ' Tasks ' },
      ],
    }]);
    const results = await search('', '@');
    expect(results.map((item) => item.id)).toEqual(['blank', 'number', 'long', 'trimmed']);
    expect(results.map((item) => item.group)).toEqual([undefined, undefined, undefined, 'Tasks']);
  });
});
