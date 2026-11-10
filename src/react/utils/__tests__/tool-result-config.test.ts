import { describe, expect, it } from 'vitest';
import { resolveToolResultConfig } from '../tool-result-config.js';

describe('how tool results show by default', () => {
  it('hides raw tool output in a chat without its own result renderers: the work log already says what ran', () => {
    expect(resolveToolResultConfig(undefined, false)).toEqual({ mode: 'hidden', allowlist: [] });
  });

  it('keeps showing results in a chat that registered renderers for them', () => {
    expect(resolveToolResultConfig(undefined, true)).toEqual({ mode: 'default', allowlist: [] });
  });

  it('always follows what the app asked for', () => {
    expect(resolveToolResultConfig({ mode: 'default' }, false)).toEqual({ mode: 'default', allowlist: [] });
    expect(resolveToolResultConfig({ mode: 'allowlist', allowlist: ['orders_list'] }, false))
      .toEqual({ mode: 'allowlist', allowlist: ['orders_list'] });
    expect(resolveToolResultConfig({ mode: 'hidden' }, true)).toEqual({ mode: 'hidden', allowlist: [] });
  });
});
