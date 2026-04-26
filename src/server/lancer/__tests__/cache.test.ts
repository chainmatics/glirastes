import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Cache } from '../cache';

describe('Cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves a value', () => {
    const cache = new Cache<string>(10_000);
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
  });

  it('returns undefined for missing keys', () => {
    const cache = new Cache<string>(10_000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    const cache = new Cache<string>(1_000);
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');

    vi.advanceTimersByTime(1_001);
    expect(cache.get('key')).toBeUndefined();
  });

  it('does not expire entries before TTL', () => {
    const cache = new Cache<string>(5_000);
    cache.set('key', 'value');

    vi.advanceTimersByTime(4_999);
    expect(cache.get('key')).toBe('value');
  });

  it('deletes a specific key', () => {
    const cache = new Cache<string>(10_000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
  });

  it('clears all entries', () => {
    const cache = new Cache<string>(10_000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
