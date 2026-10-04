import { describe, expect, it } from 'vitest';
import type { ToolRiskClass } from '../revisions.js';
import {
  TOOL_POLICY_RULES_VERSION,
  confirmationFloor,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  riskTier,
  type ToolPolicyDefaults,
} from '../tool-policy.js';

describe('riskTier', () => {
  it.each([
    ['safe-read', 0],
    ['read-sensitive', 1],
    ['write', 2],
    ['delete', 3],
    ['financial', 3],
    ['external', 3],
    ['unknown', 3],
  ] as const)('maps %s to tier %i', (riskClass, tier) => {
    expect(riskTier(riskClass)).toBe(tier);
  });

  it('pins the rules version', () => {
    expect(TOOL_POLICY_RULES_VERSION).toBe(1);
  });
});

describe('confirmationFloor', () => {
  it.each([
    ['safe-read', false, false],
    ['safe-read', true, true],
    ['read-sensitive', false, false],
    ['write', false, false],
    ['write', true, true],
    ['delete', false, true],
    ['financial', false, true],
    ['external', false, true],
    ['unknown', false, true],
  ] as const)('%s with requiresApproval=%s confirms=%s', (
    riskClass,
    requiresApproval,
    expected,
  ) => {
    expect(confirmationFloor(riskClass, requiresApproval)).toBe(expected);
  });
});

describe('mostRestrictiveRiskClass', () => {
  it.each([
    ['write', 'delete', 'delete'],
    ['delete', 'write', 'delete'],
    ['delete', 'financial', 'delete'],
    ['safe-read', undefined, 'safe-read'],
    ['write', 'unknown', 'unknown'],
  ] as const)('%s raised by %s is %s', (current, candidate, expected) => {
    expect(mostRestrictiveRiskClass(current, candidate)).toBe(expected);
  });

  // Frozen non-generic signature: a layer fold assigns the result back to a
  // `ToolRiskClass` variable that starts from the narrower assessed defaults.
  // A generic signature makes `raised` circularly typed (TS7022) here, which
  // typecheck and typecheck:tests would reject.
  it('keeps a layer fold typable and raises across layers', () => {
    const defaults: Pick<ToolPolicyDefaults, 'riskClass'> = { riskClass: 'write' };
    const layers: ReadonlyArray<{ entry: { riskClass?: ToolRiskClass } }> = [
      { entry: {} },
      { entry: { riskClass: 'safe-read' } },
      { entry: { riskClass: 'delete' } },
      { entry: { riskClass: 'financial' } },
    ];
    let value: ToolRiskClass = defaults.riskClass;
    for (const layer of layers) {
      const raised = mostRestrictiveRiskClass(value, layer.entry.riskClass);
      if (raised !== value) value = raised;
    }
    expect(value).toBe('delete');
  });
});

describe('intersectAllowedRoles', () => {
  it('treats an empty list as no restriction', () => {
    expect(intersectAllowedRoles([], undefined))
      .toEqual({ roles: [], disjoint: false });
    expect(intersectAllowedRoles([], ['member', 'admin', 'admin']))
      .toEqual({ roles: ['admin', 'member'], disjoint: false });
    expect(intersectAllowedRoles(['member', 'admin'], []))
      .toEqual({ roles: ['admin', 'member'], disjoint: false });
  });

  it('narrows to the shared roles', () => {
    expect(intersectAllowedRoles(['admin', 'member'], ['member', 'viewer']))
      .toEqual({ roles: ['member'], disjoint: false });
  });

  it('reports a disjoint restriction instead of returning everyone', () => {
    expect(intersectAllowedRoles(['admin'], ['member']))
      .toEqual({ roles: [], disjoint: true });
  });
});
