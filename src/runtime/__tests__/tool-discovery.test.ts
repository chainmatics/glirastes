import { describe, expect, it, vi } from 'vitest';
import type { ToolRegistry } from '../../types.js';
import type { TurnSnapshot } from '../turn-snapshot.js';
import { createTurnToolDiscovery } from '../tool-discovery.js';

const TENANT = '99999999-9999-4999-8999-999999999999';
const toolId = (suffix: string) =>
  `11111111-1111-4111-8111-1111111111${suffix.padStart(2, '0')}`;

function fixture(): { snapshot: TurnSnapshot; registry: ToolRegistry } {
  const facts = [
    {
      id: toolId('1'), name: 'tasks.listTasks', description: 'Show visible work.',
      module: 'task_query', sharedWith: ['dashboard'],
      hints: ['Use when the user asks for an overview.'], roles: ['member'],
    },
    {
      id: toolId('2'), name: 'reports.taskSummary', description: 'Task list report.',
      module: 'reporting', sharedWith: [],
      hints: ['Summarizes completion.'], roles: ['member'],
    },
    {
      id: toolId('3'), name: 'admin.listAudit', description: 'List audit entries.',
      module: 'administration', sharedWith: [], hints: ['Use for audit.'],
      roles: ['admin'],
    },
    {
      id: toolId('4'), name: 'tasks.deleteTask', description: 'Delete a task.',
      module: 'task_mutation', sharedWith: [], hints: ['Destructive.'],
      roles: ['member'], enabled: false,
    },
  ];
  const manifestTools = facts.map((fact) => ({
    toolId: fact.id,
    sourceFingerprint: 'sha256:tool',
    executionKind: 'endpoint' as const,
    name: fact.name,
    description: fact.description,
    modelName: fact.name.replaceAll('.', '_'),
    module: fact.module,
    sharedWith: fact.sharedWith,
    usageHints: fact.hints,
    presentation: {
      locale: 'de-DE', singular: 'Aktion', plural: 'Aktionen',
      approval: 'Aktion ausführen',
    },
    riskClass: 'safe-read' as const,
    enabled: fact.enabled ?? true,
    tombstone: false,
    method: 'GET' as const,
    path: `/api/${fact.name}`,
    authBindingRef: 'session',
    inputSchemaDigest: 'sha256:input',
    outputSchemaDigest: 'sha256:output',
  }));
  const snapshot = {
    turnId: 'turn-1',
    startedAt: '2026-08-14T08:00:00.000Z',
    principal: { subjectId: 'u1', tenantId: TENANT, roles: ['member'], attributes: {} },
    agentRevision: { tenantId: TENANT, toolAllowlist: facts.map((fact) => fact.id) },
    manifestRevision: { tenantId: TENANT, tools: manifestTools },
    policyRevision: {
      tenantId: TENANT,
      toolPolicies: facts.map((fact) => ({
        toolId: fact.id,
        enabled: fact.enabled ?? true,
        riskClass: 'safe-read',
        requiresApproval: false,
        allowedRoles: fact.roles,
      })),
    },
    budget: {},
  } as unknown as TurnSnapshot;
  const registry = Object.fromEntries(facts
    .filter((fact) => fact.enabled ?? true)
    .map((fact) => [fact.name.replaceAll('.', '_'), {
      id: fact.id,
      description: fact.description,
      inputSchema: {
        secretSchema: true,
        safeParse: (value: unknown) => ({ success: true as const, data: value }),
      },
      execute: async () => ({ secretResult: true }),
    }]));
  return { snapshot, registry };
}

describe('createTurnToolDiscovery', () => {
  it('ranks name tokens before description and uses the model name as tie-break', () => {
    const discovery = createTurnToolDiscovery(fixture());
    expect(discovery.search('list').map((result) => result.name)).toEqual([
      'tasks_listTasks',
      'reports_taskSummary',
    ]);
  });

  it('indexes module, sharing and usage hints after names and descriptions', () => {
    const discovery = createTurnToolDiscovery(fixture());
    expect(discovery.search('dashboard')[0]?.name).toBe('tasks_listTasks');
    expect(discovery.search('overview')[0]?.name).toBe('tasks_listTasks');
  });

  it('contains only role-eligible, enabled, bound, unrevoked tools', () => {
    const { snapshot, registry } = fixture();
    delete registry.reports_taskSummary;
    const discovery = createTurnToolDiscovery({
      snapshot,
      registry,
      revokedToolIds: [toolId('1')],
    });
    expect(discovery.eligibleNames).toEqual([]);
    expect(discovery.search('list')).toEqual([]);
  });

  it('returns frozen bounded metadata without schemas or executors', () => {
    const discovery = createTurnToolDiscovery(fixture(), {
      maxResults: 1,
      maxDescriptionLength: 8,
    });
    const results = discovery.search('task');
    expect(results).toHaveLength(1);
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0])).toBe(true);
    expect(results[0]!.description.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(results)).not.toMatch(/schema|execute|secret/i);
    expect(() => discovery.search('x'.repeat(201))).toThrow(/query/i);
  });

  it('does not perform network access while building or searching', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    createTurnToolDiscovery(fixture()).search('tasks');
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('keeps a tool whose policy raised its risk and drops one whose policy lowered it', () => {
    const raised = fixture();
    raised.snapshot.policyRevision.toolPolicies[0]!.riskClass = 'delete';
    expect(createTurnToolDiscovery(raised).eligibleNames)
      .toContain('tasks_listTasks');

    const lowered = fixture();
    lowered.snapshot.manifestRevision.tools[0]!.riskClass = 'write';
    expect(createTurnToolDiscovery(lowered).eligibleNames)
      .not.toContain('tasks_listTasks');
  });
});
