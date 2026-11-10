import { describe, expect, it } from 'vitest';
import type { ToolRiskClass } from '../tool-policy-entry.js';
import {
  TOOL_POLICY_RULES_VERSION,
  confirmationRelaxationOutcome,
  platformMayRelaxConfirmation,
  resolveToolPolicy,
} from '../tool-policy.js';

const TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
const OTHER_TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906';
const RISK_CLASSES: ToolRiskClass[] = [
  'safe-read', 'read-sensitive', 'write', 'delete', 'financial', 'external', 'unknown',
];

describe('confirmationRelaxationOutcome (D16, the one relaxation rule)', () => {
  it.each([
    ['delete', 'write', 'override-lapsed-risk-raised'],
    ['financial', 'write', 'override-lapsed-risk-raised'],
    ['external', 'write', 'override-lapsed-risk-raised'],
    ['unknown', 'write', 'override-lapsed-risk-raised'],
    ['delete', 'delete', 'tier-3-always-requires-approval'],
    ['unknown', 'unknown', 'tier-3-always-requires-approval'],
    ['write', 'external', 'tier-3-always-requires-approval'],
    ['write', 'safe-read', 'override-lapsed-risk-raised'],
    ['write', 'read-sensitive', 'override-lapsed-risk-raised'],
  ] as const)('refuses a %s tool pinned at %s: %s', (riskClass, atRiskClass, outcome) => {
    expect(confirmationRelaxationOutcome(TOOL_ID, { toolId: TOOL_ID, atRiskClass }, riskClass))
      .toBe(outcome);
  });

  it('refuses an unpinned relaxation from tier 2 on and a pin of another tool at every tier', () => {
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'write'))
      .toBe('relaxation-requires-reviewed-pin');
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'delete'))
      .toBe('tier-3-always-requires-approval');
    for (const riskClass of RISK_CLASSES) {
      expect(confirmationRelaxationOutcome(
        TOOL_ID,
        { toolId: OTHER_TOOL_ID, atRiskClass: 'write' },
        riskClass,
      )).toBe('pin-for-other-tool');
    }
  });

  it('applies a relaxation pinned at write up to tier 2 and any relaxation at tier 0-1', () => {
    const pin = { toolId: TOOL_ID, atRiskClass: 'write' as const };
    expect(confirmationRelaxationOutcome(TOOL_ID, pin, 'write')).toBe('applies');
    expect(confirmationRelaxationOutcome(TOOL_ID, pin, 'read-sensitive')).toBe('applies');
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'read-sensitive')).toBe('applies');
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'safe-read')).toBe('applies');
  });

  it.each(RISK_CLASSES)('is the rule resolveToolPolicy relaxes by, for a %s tool', (riskClass) => {
    const pins = [
      undefined,
      { toolId: OTHER_TOOL_ID, atRiskClass: 'write' as const },
      ...RISK_CLASSES.map((atRiskClass) => ({ toolId: TOOL_ID, atRiskClass })),
    ];
    for (const pin of pins) {
      const { effective } = resolveToolPolicy({
        toolId: TOOL_ID,
        defaults: {
          operationGroup: 'update',
          riskClass: riskClass as Exclude<ToolRiskClass, 'unknown'>,
          requiresApproval: true,
          rulesVersion: TOOL_POLICY_RULES_VERSION,
        },
        codeEnabled: true,
        platform: { requiresApproval: false, ...(pin ? { pin } : {}) },
      });
      expect(effective.requiresApproval)
        .toBe(confirmationRelaxationOutcome(TOOL_ID, pin, riskClass) !== 'applies');
    }
  });
});

describe('platformMayRelaxConfirmation (D16 local lock)', () => {
  it('opens only a code-default confirmation of a tier 0-2 tool to the Platform', () => {
    expect(platformMayRelaxConfirmation('write', 'code-default')).toBe(true);
    expect(platformMayRelaxConfirmation('read-sensitive', 'code-default')).toBe(true);
    expect(platformMayRelaxConfirmation('write', 'local-policy')).toBe(false);
    expect(platformMayRelaxConfirmation('write', 'platform')).toBe(false);
    expect(platformMayRelaxConfirmation('write', undefined)).toBe(false);
    for (const riskClass of ['delete', 'financial', 'external', 'unknown'] as const) {
      expect(platformMayRelaxConfirmation(riskClass, 'code-default')).toBe(false);
    }
  });
});
