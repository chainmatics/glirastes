import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  Principal,
  RuntimePolicyRevision,
  TechnicalRuntimeEventV2,
} from '../../../../contracts/index.js';
import type { RuntimeMetricsSink } from '../../../../runtime/metrics/turn-recorder.js';
import { createTurnSnapshot, type TurnSnapshot } from '../../../../runtime/turn-snapshot.js';

const signature = { algorithm: 'Ed25519' as const, keyId: 'key-1', value: 'c2lnbmF0dXJl' };
const TENANT = '019fb710-0000-7000-8000-000000000001';
export const LIST_TASKS_ID = '019fb710-0000-7000-8000-000000000011';
export const ARCHIVE_TASK_ID = '019fb710-0000-7000-8000-000000000012';

export const localLimits: ExecutionBudget = {
  maxModelSteps: 20, maxToolCalls: 10, totalTimeoutMs: 120_000, toolTimeoutMs: 20_000,
  maxInputTokens: 50_000, maxOutputTokens: 10_000, maxEstimatedCostUsd: 5,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 3, maxBreadth: 4, sharedBudget: false },
};

export const agentRevision: AgentRevision = {
  revisionId: '019fb710-0000-7000-8000-000000000002', revision: 1, agentId: '019fb710-0000-7000-8000-000000000003',
  tenantId: TENANT, name: 'Assistant', objective: 'Help with tasks.', modelAlias: 'standard', promptBindingRef: 'prompt-v1',
  toolAllowlist: [LIST_TASKS_ID, ARCHIVE_TASK_ID], budget: localLimits,
  publishedAt: '2026-10-05T08:00:00.000Z', signature,
};

const tool = (toolId: string, name: string, method: 'GET' | 'POST', riskClass: 'safe-read' | 'write') => ({
  toolId, sourceFingerprint: 'sha256:tool', executionKind: 'endpoint' as const, name, description: `Run ${name}.`,
  riskClass, enabled: true, tombstone: false, method, path: '/api/tasks',
  inputSchemaDigest: 'sha256:input', outputSchemaDigest: 'sha256:output', authBindingRef: 'task-session',
});

export const manifestRevision: ManifestRevision = {
  revisionId: '019fb710-0000-7000-8000-000000000004', revision: 1, tenantId: TENANT,
  targetAppId: '019fb710-0000-7000-8000-000000000005', environmentId: '019fb710-0000-7000-8000-000000000006',
  sourceDigest: 'sha256:manifest',
  tools: [tool(LIST_TASKS_ID, 'tasks.list', 'GET', 'safe-read'), tool(ARCHIVE_TASK_ID, 'tasks.archive', 'POST', 'write')],
  publishedAt: '2026-10-05T08:00:00.000Z', signature,
};

export function policyRevision(overrides: { listRoles?: string[]; archiveEnabled?: boolean } = {}): RuntimePolicyRevision {
  return {
    revisionId: '019fb710-0000-7000-8000-000000000007', revision: 1, tenantId: TENANT,
    environmentId: manifestRevision.environmentId, budget: localLimits,
    toolPolicies: [
      { toolId: LIST_TASKS_ID, enabled: true, riskClass: 'safe-read', requiresApproval: false, allowedRoles: overrides.listRoles ?? [] },
      { toolId: ARCHIVE_TASK_ID, enabled: overrides.archiveEnabled ?? true, riskClass: 'write', requiresApproval: true, allowedRoles: [] },
    ],
    toolOverrides: [],
    publishedAt: '2026-10-05T08:00:00.000Z', signature,
  };
}

export function principal(roles: string[] = ['member']): Principal {
  return { subjectId: 'alice', tenantId: TENANT, roles, attributes: {} };
}

export function snapshot(turnId: string, options: Parameters<typeof policyRevision>[0] = {}, roles?: string[]): TurnSnapshot {
  return createTurnSnapshot({
    turnId, agentRevision, manifestRevision, policyRevision: policyRevision(options), principal: principal(roles), localLimits,
  });
}

export function collectingSink() {
  const events: TechnicalRuntimeEventV2[] = [];
  const sink: RuntimeMetricsSink = {
    identity: {
      appId: '019fb710-0000-7000-8000-0000000000a1', environmentId: '019fb710-0000-7000-8000-0000000000e1',
      buildId: null, instanceId: 'web-1',
    },
    // Keeps finished turns only, so the fixture also compiles once the sink takes more event types (P05).
    record: (event) => { if (event.eventType === 'turn.finished') events.push(event); },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

/** The data chunks of an AI SDK UI message stream response; `start` without its generated message id. */
export async function streamChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .map((chunk) => (chunk.type === 'start' ? { type: 'start' } : chunk));
}
