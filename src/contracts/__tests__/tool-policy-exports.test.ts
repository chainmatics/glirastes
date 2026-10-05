import { describe, expect, it } from 'vitest';
import * as contracts from '../index.js';

describe('glirastes/contracts tool policy surface', () => {
  it('exports the shared tool policy contract', () => {
    expect(contracts.TOOL_POLICY_RULES_VERSION).toBe(1);
    for (const name of [
      'riskTier',
      'confirmationFloor',
      'mostRestrictiveRiskClass',
      'intersectAllowedRoles',
      'deriveToolPolicyDefaults',
      'parseToolPolicyFile',
      'resolveToolPolicy',
    ] as const) {
      expect(typeof contracts[name]).toBe('function');
    }
    expect(contracts.ToolPolicyFileSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
      tools: {},
      exclude: [],
      acceptedRisk: {},
    });
    expect(contracts.ToolPolicyEntrySchema.safeParse({ enabled: false }).success)
      .toBe(true);
    expect(contracts.ToolPolicyPinSchema.safeParse({
      toolId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
      atRiskClass: 'write',
    }).success).toBe(true);
  });
});
