import { describe, expect, it, vi } from 'vitest';

// The effect gate must read the policy's own effect-to-risk mapping, never a
// copy of it. A mapping that disagrees with the real table proves which one
// the gate consults.
vi.mock('../../contracts/tool-policy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../contracts/tool-policy.js')>(),
  declaredEffectRiskClass: (effect: string) => (effect === 'read' ? 'write' : 'financial'),
}));

const { validateResolutionEntry } = await import('./resolutions.js');

const DIGEST = `sha256:${'R'.repeat(43)}`;

function check(effect: string, codeRiskClass: 'write' | 'delete') {
  return validateResolutionEntry({
    stableKey: 'POST /api/tasks/:id/archive',
    raw: { interfaceDigest: DIGEST, effect },
    codeRiskClass,
  });
}

describe('validateResolutionEntry effect gate', () => {
  it('takes the effect risk class from the tool policy', () => {
    // The real table maps read to safe-read and write to write; both would be refused here.
    expect(check('read', 'write').entry?.effect).toBe('read');
    expect(check('write', 'delete').entry?.effect).toBe('write');
    const refused = check('read', 'delete');
    expect(refused.entry).toBeUndefined();
    expect(refused.findings[0]?.message).toContain('would lower the risk below delete');
  });
});
