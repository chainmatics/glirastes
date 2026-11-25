// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sameConfig, useEqualValue } from '../same-config.js';

describe('useEqualValue', () => {
  it('keeps the value while the next one is equal by value, also when an entry changed in place in the meantime', () => {
    const entry = { singular: 'Archive', plural: 'Archive' };
    const { result, rerender } = renderHook(({ value }) => useEqualValue(value), { initialProps: { value: { labels: { a: entry } } } });
    const first = result.current;
    rerender({ value: { labels: { a: { singular: 'Archive', plural: 'Archive' } } } });
    expect(result.current).toBe(first);
    entry.singular = 'Archivieren';
    const next = { labels: { a: entry } };
    rerender({ value: next });
    expect(result.current).toBe(next);
    // Changed in place once more and passed again: the same object comes back (what is derived from it is
    // made again only where its own memo sees a new object, as before), and the copy follows the change.
    entry.plural = 'Archivieren';
    rerender({ value: next });
    expect(result.current).toBe(next);
    rerender({ value: { labels: { a: { singular: 'Archivieren', plural: 'Archivieren' } } } });
    expect(result.current).toBe(next);
    rerender({ value: { labels: { a: { singular: 'Archivieren', plural: 'Archive' } } } });
    expect(result.current).not.toBe(next);
  });
});

describe('sameConfig', () => {
  it('compares plain data by value, functions and React elements by identity', () => {
    expect(sameConfig({ a: [1, { b: 'c' }] }, { a: [1, { b: 'c' }] })).toBe(true);
    expect(sameConfig({ a: [1, { b: 'c' }] }, { a: [1, { b: 'd' }] })).toBe(false);
    const fn = () => {};
    expect(sameConfig({ fn }, { fn })).toBe(true);
    expect(sameConfig({ fn }, { fn: () => {} })).toBe(false);
    expect(sameConfig({ icon: <b /> }, { icon: <b /> })).toBe(false);
    const icon = <b />;
    expect(sameConfig({ icon }, { icon })).toBe(true);
  });
});
