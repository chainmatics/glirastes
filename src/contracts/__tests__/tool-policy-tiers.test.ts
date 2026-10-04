import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  confirmationFloor,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  riskTier,
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
