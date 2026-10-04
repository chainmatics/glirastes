import { describe, expect, it } from 'vitest';
import {
  agentRevision,
  manifestRevision,
  policyRevision,
  principal,
} from './turn-snapshot.test.js';
import { authorizeToolCall } from '../authorization.js';

describe('authorizeToolCall', () => {
  it('allows only the intersection of principal, agent, manifest, and policy', () => {
    expect(authorizeToolCall({
      principal,
      agentRevision,
      manifestRevision,
      policyRevision,
      toolId: agentRevision.toolAllowlist[0]!,
    })).toEqual({
      allowed: true,
      requiresApproval: false,
      riskClass: 'safe-read',
    });
  });

  it.each([
    ['missing_principal', undefined, agentRevision.toolAllowlist[0]!],
    ['principal_role_denied', { ...principal, roles: ['viewer'] }, agentRevision.toolAllowlist[0]!],
    ['agent_tool_denied', principal, crypto.randomUUID()],
  ])('fails closed with %s', (reason, candidatePrincipal, toolId) => {
    expect(authorizeToolCall({
      principal: candidatePrincipal,
      agentRevision,
      manifestRevision,
      policyRevision,
      toolId,
    })).toEqual({ allowed: false, reason });
  });

  it('always confirms tier-3 tools even when the policy does not ask for it', () => {
    expect(authorizeToolCall({
      principal,
      agentRevision,
      manifestRevision: {
        ...manifestRevision,
        tools: [{ ...manifestRevision.tools[0]!, riskClass: 'delete' }],
      },
      policyRevision: {
        ...policyRevision,
        toolPolicies: [{
          ...policyRevision.toolPolicies[0]!,
          riskClass: 'delete',
          requiresApproval: false,
        }],
      },
      toolId: agentRevision.toolAllowlist[0]!,
    })).toEqual({ allowed: true, requiresApproval: true, riskClass: 'delete' });
  });
});
