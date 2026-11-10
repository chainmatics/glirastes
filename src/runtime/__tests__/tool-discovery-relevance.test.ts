import { describe, expect, it } from 'vitest';
import type { ToolRegistry } from '../../types.js';
import type { TurnSnapshot } from '../turn-snapshot.js';
import {
  createRegistryToolDiscovery,
  createTurnToolDiscovery,
  type ToolSearchSemanticsMap,
} from '../tool-discovery.js';

const TENANT = '99999999-9999-4999-8999-999999999999';
const toolId = (suffix: number) =>
  `22222222-2222-4222-8222-${String(suffix).padStart(12, '0')}`;

interface CorpusTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly module: string;
  readonly hints: ReadonlyArray<string>;
  readonly roles: ReadonlyArray<string>;
  readonly deployed?: boolean;
}

const CORPUS: ReadonlyArray<CorpusTool> = [
  {
    id: toolId(1), name: 'tasks.listTasks', module: 'task_query',
    description: 'Show visible tasks with status and due date filters.',
    hints: ['Use when the user asks for an overview of open or completed work.'],
    roles: ['member'],
  },
  {
    id: toolId(2), name: 'tasks.createTask', module: 'task_mutation',
    description: 'Create a new task with title, due date and assignee.',
    hints: ['Use when the user wants to add work.'], roles: ['member'],
  },
  {
    id: toolId(3), name: 'tasks.deleteTask', module: 'task_mutation',
    description: 'Delete a task permanently.',
    hints: ['Destructive; always confirm.'], roles: ['member'],
  },
  {
    id: toolId(4), name: 'teams.listMembers', module: 'teams',
    description: 'List the members of a team.',
    hints: ['Use for questions about colleagues.'], roles: ['member'],
  },
  {
    id: toolId(5), name: 'reports.weeklySummary', module: 'reporting',
    description: 'Summarize completed work for the current week.',
    hints: ['Use for weekly reviews.'], roles: ['member'],
  },
  {
    id: toolId(6), name: 'admin.auditLog', module: 'administration',
    description: 'List audit log entries.',
    hints: ['Use for compliance questions.'], roles: ['admin'],
  },
  {
    id: toolId(7), name: 'billing.listInvoices', module: 'billing',
    description: 'List invoices and payment status.',
    hints: ['Use for invoices.'], roles: ['member'], deployed: false,
  },
];

const SEMANTICS: ToolSearchSemanticsMap = {
  tasks_listTasks: {
    synonyms: ['Aufgaben anzeigen', 'Aufgaben zeigen', 'Aufgabenliste', 'offene Aufgaben', 'To-dos'],
  },
  tasks_createTask: {
    synonyms: ['Aufgabe anlegen', 'Aufgabe erstellen', 'neue Aufgabe', 'hinzufügen', 'add task'],
  },
  tasks_deleteTask: {
    synonyms: ['Aufgabe löschen', 'entfernen', 'remove task'],
  },
  teams_listMembers: {
    synonyms: ['Teammitglieder', 'Kollegen', 'Mitglieder'],
  },
  reports_weeklySummary: {
    synonyms: ['Wochenbericht', 'Zusammenfassung der Woche', 'weekly report'],
  },
  admin_auditLog: { synonyms: ['Protokoll', 'Prüfprotokoll'] },
  billing_listInvoices: { synonyms: ['Rechnungen', 'Rechnung bezahlen'] },
};

function corpus(roles: ReadonlyArray<string>): {
  snapshot: TurnSnapshot;
  registry: ToolRegistry;
} {
  const snapshot = {
    turnId: 'turn-relevance',
    startedAt: '2026-10-04T08:00:00.000Z',
    principal: { subjectId: 'u1', tenantId: TENANT, roles: [...roles], attributes: {} },
    agentRevision: { tenantId: TENANT, toolAllowlist: CORPUS.map((tool) => tool.id) },
    manifestRevision: {
      tenantId: TENANT,
      tools: CORPUS.map((tool) => ({
        toolId: tool.id,
        sourceFingerprint: 'sha256:tool',
        executionKind: 'endpoint' as const,
        name: tool.name,
        description: tool.description,
        modelName: tool.name.replaceAll('.', '_'),
        module: tool.module,
        sharedWith: [],
        usageHints: [...tool.hints],
        riskClass: 'safe-read' as const,
        enabled: true,
        tombstone: false,
        method: 'GET' as const,
        path: `/api/${tool.name}`,
        authBindingRef: 'session',
        inputSchemaDigest: 'sha256:input',
        outputSchemaDigest: 'sha256:output',
      })),
    },
    policyRevision: {
      tenantId: TENANT,
      toolPolicies: CORPUS.map((tool) => ({
        toolId: tool.id,
        enabled: true,
        riskClass: 'safe-read',
        requiresApproval: false,
        allowedRoles: [...tool.roles],
      })),
    },
    budget: {},
  } as unknown as TurnSnapshot;
  const registry: ToolRegistry = Object.fromEntries(CORPUS
    .filter((tool) => tool.deployed !== false)
    .map((tool) => [tool.name.replaceAll('.', '_'), {
      id: tool.id,
      description: tool.description,
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    }]));
  return { snapshot, registry };
}

const member = () => createTurnToolDiscovery({ ...corpus(['member']), semantics: SEMANTICS });
const top = (query: string) => member().search(query)[0]?.name;

describe('find_tools DE/EN relevance corpus', () => {
  it.each([
    ['show my open tasks', 'tasks_listTasks'],
    ['create a task', 'tasks_createTask'],
    ['remove task', 'tasks_deleteTask'],
    ['weekly report', 'reports_weeklySummary'],
    ['Zeige meine Aufgaben', 'tasks_listTasks'],
    ['Neue Aufgabe anlegen', 'tasks_createTask'],
    ['Füge eine neue Aufgabe hinzu', 'tasks_createTask'],
    ['Lösche die Aufgabe', 'tasks_deleteTask'],
    ['Wer ist in meinem Team?', 'teams_listMembers'],
    ['erledigte Aufgaben dieser Woche zusammenfassen', 'reports_weeklySummary'],
  ])('ranks %j first as %s', (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it.each([
    ['Kollegen', 'teams_listMembers'],
    ['Wochenbericht', 'reports_weeklySummary'],
    ['To-dos', 'tasks_listTasks'],
    ['Aufgabenliste', 'tasks_listTasks'],
  ])('resolves the synonym %j to %s', (query, expected) => {
    expect(top(query)).toBe(expected);
  });

  it.each([
    'Wetter in Berlin',
    'Rechnung bezahlen',
    'Rechnungen',
    'audit',
    'Protokoll',
  ])('returns no tool for %j (unrelated, undeployed or unauthorized)', (query) => {
    expect(member().search(query)).toEqual([]);
  });

  it('never lists unauthorized or undeployed tools as eligible', () => {
    expect(member().eligibleNames).toEqual([
      'reports_weeklySummary',
      'tasks_createTask',
      'tasks_deleteTask',
      'tasks_listTasks',
      'teams_listMembers',
    ]);
  });

  it('finds the admin tool only for a principal holding the role', () => {
    const admin = createTurnToolDiscovery({
      ...corpus(['member', 'admin']), semantics: SEMANTICS,
    });
    expect(admin.search('Protokoll')[0]?.name).toBe('admin_auditLog');
  });

  it('does not let synonyms of revoked tools leak into results', () => {
    const discovery = createTurnToolDiscovery({
      ...corpus(['member']),
      semantics: SEMANTICS,
      revokedToolIds: [toolId(3)],
    });
    expect(discovery.search('Aufgabe löschen').map((result) => result.name))
      .not.toContain('tasks_deleteTask');
  });

  it('returns only the bounded model-facing fields, never the synonyms', () => {
    const [result] = member().search('Kollegen');
    expect(result?.name).toBe('teams_listMembers');
    expect(Object.keys(result!).sort()).toEqual([
      'description',
      'module',
      'name',
      'usageHints',
    ]);
  });
});

describe('createRegistryToolDiscovery', () => {
  const registry: ToolRegistry = {
    list_tasks: {
      id: 'tasks.list', description: 'List visible tasks.',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    },
    create_task: {
      id: 'tasks.create', description: 'Create a task.',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    },
    suggest_followups: {
      id: 'suggest_followups', description: 'Suggest follow-up tasks.',
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => ({}),
    },
  };

  it('indexes the deployed registry with synonyms and skips built-ins', () => {
    const discovery = createRegistryToolDiscovery({
      turnId: 'turn-registry',
      registry,
      excludeNames: ['suggest_followups'],
      semantics: { create_task: { synonyms: ['Aufgabe anlegen'] } },
    });
    expect(discovery.eligibleNames).toEqual(['create_task', 'list_tasks']);
    expect(discovery.search('Aufgabe anlegen').map((result) => result.name))
      .toEqual(['create_task']);
    expect(discovery.search('follow-up')).toEqual([]);
  });
});
