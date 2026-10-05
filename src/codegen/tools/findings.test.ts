import { describe, expect, it } from 'vitest';
import { nextActionFor, sortFindings, toolFinding, TRANSIENT_FINDING_CODES } from './findings.js';

describe('tool findings', () => {
  it('attaches the next safe action for known codes and a generic one otherwise', () => {
    expect(toolFinding('auth-evidence-missing', 'needs_attention', 'GET /api/x', 'No session call.'))
      .toEqual({
        code: 'auth-evidence-missing',
        severity: 'needs_attention',
        subjectRef: 'GET /api/x',
        message: 'No session call.',
        nextAction: nextActionFor('auth-evidence-missing'),
      });
    expect(nextActionFor('auth-evidence-missing')).toContain('authHelpers');
    expect(nextActionFor('something-new')).toContain('glirastes tools refresh');
    expect(nextActionFor('constructor')).toContain('glirastes tools refresh');
  });

  it('gives a rejected schema its own remediation instead of the unloadable-module text', () => {
    const action = nextActionFor('schema-content-rejected');
    expect(action).toContain('secret-looking');
    expect(action).toContain('never reach committed outputs');
    expect(action).not.toBe(nextActionFor('schema-module-unloadable'));
    expect(action).not.toBe(nextActionFor('something-new'));
    expect(toolFinding('schema-content-rejected', 'needs_attention', 'POST /api/x', 'Schema carries a secret-looking value.'))
      .toMatchObject({ code: 'schema-content-rejected', severity: 'needs_attention', nextAction: action });
  });

  it('orders errors before attention items before warnings, then by code and subject', () => {
    const sorted = sortFindings([
      toolFinding('contract-derived', 'warning', 'GET /a', 'w'),
      toolFinding('input-contract-unresolved', 'needs_attention', 'POST /b', 'n'),
      toolFinding('E-INVENTORY-011', 'error', 'next-app', 'e'),
      toolFinding('contract-derived', 'warning', 'GET /0', 'w'),
    ]);
    expect(sorted.map((finding) => `${finding.severity}:${finding.subjectRef}`)).toEqual([
      'error:next-app', 'needs_attention:POST /b', 'warning:GET /0', 'warning:GET /a',
    ]);
  });

  it('marks only change-relative findings as transient so they never reach committed outputs', () => {
    expect([...TRANSIENT_FINDING_CODES].sort()).toEqual(['risk-raised', 'tool-outputs-drift']);
    expect(TRANSIENT_FINDING_CODES.has('override-lapsed-risk-raised')).toBe(false);
  });

  it('branches the E-POLICY-002 remediation on the rejection reason', () => {
    const unpinned = nextActionFor('E-POLICY-002', 'relaxation-requires-reviewed-pin');
    expect(unpinned).toContain('reviewed pin');
    expect(unpinned).toContain('glirastes tools policy relax');
    expect(unpinned).toContain('--yes');

    const tier3 = nextActionFor('E-POLICY-002', 'tier-3-always-requires-approval');
    expect(tier3).toContain('Remove the relaxation');
    expect(tier3).toContain('always confirm');
    expect(tier3).not.toContain('reviewed pin');

    expect(nextActionFor('E-POLICY-002')).toBe(tier3);
    expect(nextActionFor('E-POLICY-002', 'some-future-reason')).toBe(tier3);
  });

  it('carries the reason into the finding next action and ignores it for other codes', () => {
    expect(toolFinding(
      'E-POLICY-002', 'error', 'POST /api/x', 'local.requiresApproval: relaxation-requires-reviewed-pin',
      'relaxation-requires-reviewed-pin',
    ).nextAction).toBe(nextActionFor('E-POLICY-002', 'relaxation-requires-reviewed-pin'));
    expect(toolFinding('E-POLICY-002', 'error', 'DELETE /api/x', 'm').nextAction)
      .toBe(nextActionFor('E-POLICY-002'));
    expect(nextActionFor('contract-stale', 'relaxation-requires-reviewed-pin'))
      .toBe(nextActionFor('contract-stale'));
  });
});
