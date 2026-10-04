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

  // Compile-time check: typecheck:tests fails if the type is not exported.
  it('exports the managed-mode Platform revision refs type', () => {
    const refs: runtime.PlatformRevisionRefs = {
      agentRevision: { revisionId: '12121212-1212-4212-8212-121212121212', revision: 7 },
      manifestRevision: { revisionId: '13131313-1313-4313-8313-131313131313', revision: 5 },
    };
    expect(refs.agentRevision.revision).toBe(7);
  });
});
