import { describe, expect, it } from 'vitest';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  ToolPolicyEntrySchema,
  parseToolPolicyFile,
} from '../tool-policy.js';

const TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';

function expectPolicyError(
  value: unknown,
  identifier: string | undefined,
): FoundationDiagnosticError {
  try {
    parseToolPolicyFile(value);
  } catch (error) {
    expect(error).toBeInstanceOf(FoundationDiagnosticError);
    const diagnostic = error as FoundationDiagnosticError;
    expect(diagnostic.code).toBe('E-POLICY-001');
    expect(diagnostic.operation).toBe('tools.policy');
    expect(diagnostic.remediation).toBe('repair-tool-policy-file');
    expect(diagnostic.path).toBe('.glirastes/tool-policy.json');
    expect(diagnostic.identifier).toBe(identifier);
    return diagnostic;
  }
  throw new Error('parseToolPolicyFile accepted an invalid policy file');
}

describe('parseToolPolicyFile', () => {
  it('parses the documented file shape', () => {
    const file = {
      schemaVersion: 1,
      tools: {
        'DELETE /api/tasks/[id]': {
          enabled: false,
          requiresApproval: true,
          riskClass: 'delete',
          allowedRoles: ['admin'],
          description: 'Delete one task permanently.',
          reason: 'Only admins clean up.',
          pin: { toolId: TOOL_ID, atRiskClass: 'write' },
        },
      },
      exclude: [{ match: 'POST /api/internal/**', reason: 'internal' }],
      acceptedRisk: {
        'POST /api/tasks/[id]/archive': { riskClass: 'write', toolId: TOOL_ID },
      },
    };
    expect(parseToolPolicyFile(file)).toEqual(file);
  });

  it('fills absent sections with empty defaults', () => {
    expect(parseToolPolicyFile({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
      tools: {},
      exclude: [],
      acceptedRisk: {},
    });
  });

  it.each([
    ['an unsupported schema version', { schemaVersion: 2 }, 'schemaVersion'],
    ['an unknown top-level key', { schemaVersion: 1, overrides: {} }, undefined],
    ['a non-boolean approval', {
      schemaVersion: 1,
      tools: { 'GET /api/tasks': { requiresApproval: 'no' } },
    }, 'tools.GET /api/tasks.requiresApproval'],
    ['a pin without a tool id', {
      schemaVersion: 1,
      tools: {
        'POST /api/tasks': {
          requiresApproval: false,
          pin: { toolId: 'not-a-uuid', atRiskClass: 'write' },
        },
      },
    }, 'tools.POST /api/tasks.pin.toolId'],
    ['an exclusion without a reason', {
      schemaVersion: 1,
      exclude: [{ match: 'POST /api/internal/**' }],
    }, 'exclude.0.reason'],
    ['an empty role name', {
      schemaVersion: 1,
      tools: { 'GET /api/tasks': { allowedRoles: [''] } },
    }, 'tools.GET /api/tasks.allowedRoles.0'],
  ])('rejects %s with E-POLICY-001', (_label, value, identifier) => {
    expectPolicyError(value, identifier);
  });

  it('rejects secret-like content without echoing it', () => {
    const secret = `sk-or-v1-${'a1B2c3D4'.repeat(4)}`;
    const diagnostic = expectPolicyError({
      schemaVersion: 1,
      tools: { 'POST /api/tasks': { description: `Use ${secret} to call.` } },
    }, 'tools.POST /api/tasks.description');
    expect(JSON.stringify(diagnostic.toJSON())).not.toContain(secret);
    expect(diagnostic.message).not.toContain(secret);
  });

  it('does not treat stable keys as content', () => {
    expect(parseToolPolicyFile({
      schemaVersion: 1,
      tools: { 'POST /api/auth/token-refresh': { enabled: false } },
    }).tools['POST /api/auth/token-refresh']).toEqual({ enabled: false });
  });
});

describe('ToolPolicyEntrySchema', () => {
  it('is strict so stray fields never pass as policy', () => {
    expect(ToolPolicyEntrySchema.safeParse({ enabled: true, toolId: TOOL_ID })
      .success).toBe(false);
  });
});
