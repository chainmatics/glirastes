import { describe, expect, it } from 'vitest';
import * as runtime from '../index.js';

describe('glirastes/runtime policy surface', () => {
  it('exports overlay composition and binding diagnostics', () => {
    expect(typeof runtime.applyPolicyOverlay).toBe('function');
    expect(typeof runtime.policyOverlayFromRevision).toBe('function');
    expect(typeof runtime.localToolBindingMismatches).toBe('function');
    expect(runtime.applyPolicyOverlay([], []))
      .toEqual({ policies: [], ignored: [] });
  });
});
