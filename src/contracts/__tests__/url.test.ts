import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../url.js';

describe('trimTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://api.test///')).toBe('https://api.test');
    expect(trimTrailingSlashes('https://api.test/v1')).toBe('https://api.test/v1');
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('stays linear on a long run of slashes followed by text', () => {
    const input = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
