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
});
