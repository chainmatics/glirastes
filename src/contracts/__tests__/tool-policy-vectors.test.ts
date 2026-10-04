import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ResolveToolPolicyResult,
} from '../tool-policy.js';

interface ToolPolicyVector {
  name: string;
  input: ResolveToolPolicyInput;
  expected: ResolveToolPolicyResult;
}

const vectors = JSON.parse(readFileSync(
  new URL('../__vectors__/tool-policy.v1.json', import.meta.url),
  'utf8',
)) as ToolPolicyVector[];

const REQUIRED_RULES = [
  'enabled',
  'risk',
  'approval',
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

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      expect(resolveToolPolicy(vector.input)).toEqual(vector.expected);
    },
  );
});
