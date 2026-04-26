import { describe, it, expect } from 'vitest';
import { deepWalkReplace } from '../deep-walk.js';

describe('deepWalkReplace', () => {
  it('replaces strings in flat object', () => {
    const result = deepWalkReplace(
      { name: 'Alice', age: 30 },
      (s) => s === 'Alice' ? 'Sabine' : s,
    );
    expect(result).toEqual({ name: 'Sabine', age: 30 });
  });

  it('replaces strings in nested object', () => {
    const result = deepWalkReplace(
      { user: { name: 'Alice', email: 'alice@test.com' } },
      (s) => s.replace('Alice', 'Sabine').replace('alice@test.com', 'sabine@demo.de'),
    );
    expect(result).toEqual({ user: { name: 'Sabine', email: 'sabine@demo.de' } });
  });

  it('replaces strings in arrays', () => {
    const result = deepWalkReplace(
      { tags: ['Alice', 'Bob'] },
      (s) => s === 'Alice' ? 'Sabine' : s,
    );
    expect(result).toEqual({ tags: ['Sabine', 'Bob'] });
  });

  it('preserves non-string primitives', () => {
    const result = deepWalkReplace(
      { count: 5, active: true, value: null },
      (s) => s,
    );
    expect(result).toEqual({ count: 5, active: true, value: null });
  });

  it('handles plain string input', () => {
    const result = deepWalkReplace('hello Alice', (s) => s.replace('Alice', 'Sabine'));
    expect(result).toBe('hello Sabine');
  });

  it('handles array at top level', () => {
    const result = deepWalkReplace(['Alice', 'Bob'], (s) => s === 'Alice' ? 'Sabine' : s);
    expect(result).toEqual(['Sabine', 'Bob']);
  });

  it('returns non-string primitives unchanged', () => {
    expect(deepWalkReplace(42, (s) => s)).toBe(42);
    expect(deepWalkReplace(null, (s) => s)).toBe(null);
    expect(deepWalkReplace(undefined, (s) => s)).toBe(undefined);
    expect(deepWalkReplace(true, (s) => s)).toBe(true);
  });
});
