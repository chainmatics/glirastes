import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  confirmationRelaxationOutcome,
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ResolveToolPolicyResult,
} from '../tool-policy.js';

interface ToolPolicyVector {
  name: string;
  input: ResolveToolPolicyInput;
  expected: ResolveToolPolicyResult;
}

/**
 * sha256 of `__vectors__/tool-policy.v1.json`. The Platform port copies the
 * file byte for byte and pins the same digest (`SDK_VECTORS_SHA256` in its
 * vector parity spec), so a changed vector changes this digest on purpose and
 * goes to the Platform together with it.
 */
const TOOL_POLICY_VECTORS_SHA256 =
  'dcf3470e7553a05bcd08e7d32cef3a42949f6d50177addb26a674d6287db774e';

const raw = readFileSync(
  new URL('../__vectors__/tool-policy.v1.json', import.meta.url),
);
const vectors = JSON.parse(raw.toString('utf8')) as ToolPolicyVector[];

const REQUIRED_RULES = [
  'enabled',
  'risk',
  'approval',
  'relaxation',
  'roles',
  'description',
  'ratchet',
  'pin',
  'invalid',
];

describe('tool policy golden vectors v1', () => {
  it('covers every rule with at least 25 uniquely named vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(25);
    expect(new Set(vectors.map((vector) => vector.name)).size)
      .toBe(vectors.length);
    expect(new Set(vectors.map((vector) => vector.name.split('/')[0])))
      .toEqual(new Set(REQUIRED_RULES));
    for (const vector of vectors) {
      expect(vector.input.defaults.rulesVersion).toBe(TOOL_POLICY_RULES_VERSION);
    }
  });

  it('pins the file the Platform port copies byte for byte', () => {
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe(TOOL_POLICY_VECTORS_SHA256);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      expect(resolveToolPolicy(vector.input)).toEqual(vector.expected);
    },
  );
});

/**
 * The `relaxation/` vectors use the composition form the runtime overlay and
 * the Platform share (D16): `defaults` is the effective policy the code
 * reported, `local` carries the reported roles plus `requiresApproval: true`
 * when the tool asks and the report does not attribute that confirmation to
 * the code default (the local lock), and `platform` is the signed decision
 * delta.
 */
describe('tool policy relaxation vectors (D16)', () => {
  const relaxations = vectors.filter((vector) => vector.name.startsWith('relaxation/'));

  it('relax exactly where the shared rule applies and no local lock holds', () => {
    expect(relaxations).toHaveLength(14);
    for (const vector of relaxations) {
      const locked = vector.input.local?.requiresApproval === true;
      const outcome = confirmationRelaxationOutcome(
        vector.input.toolId,
        vector.input.platform?.pin,
        vector.expected.effective.riskClass,
      );
      expect(vector.expected.effective.requiresApproval, vector.name)
        .toBe(locked || outcome !== 'applies');
    }
  });

  it('list every refusal before the first acceptance', () => {
    const relaxed = relaxations.map((vector) => !vector.expected.effective.requiresApproval);
    const first = relaxed.indexOf(true);
    expect(first).toBeGreaterThan(0);
    expect(relaxed.slice(first).every(Boolean)).toBe(true);
  });
});
