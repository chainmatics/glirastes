import { describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { evaluateRouting } from './routing-eval.js';
import type { ToolSearchFacts } from './types.js';

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;

function tool(suffix: string, name: string, module: string, description: string, enabled = true) {
  return {
    toolId: id(suffix), sourceFingerprint: digest('F'), name, description, modelName: name.replace(/\./g, '_'),
    module, sharedWith: [], usageHints: [description],
    presentation: { locale: 'de-DE', singular: name, plural: name, approval: name },
    executionKind: 'endpoint', method: 'GET', path: `/api/${suffix}`, authBindingRef: 'endpoint-authorization', allowedRoles: [],
    operationGroup: 'read', riskClass: 'safe-read', enabled, requiresApproval: false,
    inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  };
}

const artifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready',
  tools: [
    tool('a1', 'tasks.list', 'task_query', 'Lists the tasks of the caller, filtered by status.'),
    tool('a2', 'tasks.create', 'task_mutation', 'Creates a task with a title and an optional due date.'),
    tool('a3', 'notes.list', 'notes', 'Lists the notes of the caller.'),
    tool('a4', 'reports.export', 'reports', 'Exports a weekly report.', false),
  ],
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('a1'), id('a2'), id('a3')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
});

function contracts(search: Record<string, ToolSearchFacts>) {
  return artifact.tools.map((entry) => ({
    toolId: entry.toolId,
    stableKey: `GET ${entry.executionKind === 'endpoint' ? entry.path : ''}`,
    ...(search[entry.name] ? { search: search[entry.name] } : {}),
  }));
}

describe('evaluateRouting', () => {
  it('passes when every example finds its tool among the first hits of its module', () => {
    const evaluation = evaluateRouting({
      artifact,
      contracts: contracts({
        'tasks.list': { synonyms: ['Aufgaben anzeigen', 'offene Aufgaben'], examples: ['Zeig meine offenen Aufgaben', 'Welche Aufgaben sind noch offen?', 'list my open tasks'] },
        'tasks.create': { synonyms: ['Aufgabe anlegen', 'neue Aufgabe'], examples: ['Leg eine neue Aufgabe an', 'Erstelle eine Aufgabe mit Titel Bericht', 'create a task'] },
      }),
    });
    expect(evaluation).toEqual({
      schemaVersion: 1,
      top: 3,
      summary: { tools: 3, evaluated: 2, sentences: 6, passed: 6, failed: 0, withoutExamples: ['notes.list'] },
      tools: [
        { tool: 'tasks.create', stableKey: 'GET /api/a2', module: 'task_mutation', sentences: 3, failures: [] },
        { tool: 'tasks.list', stableKey: 'GET /api/a1', module: 'task_query', sentences: 3, failures: [] },
      ],
    });
  });

  it('names the competing tools of an ambiguous example and stays byte-stable', () => {
    const input = {
      artifact,
      contracts: contracts({
        'tasks.list': { examples: ['show my tasks', 'list my open tasks', 'tasks filtered by status'] },
        'notes.list': { examples: ['Zeig meine Notizen', 'list my notes', 'notes of the caller'] },
      }),
    };
    const evaluation = evaluateRouting(input);
    expect(JSON.stringify(evaluateRouting(input))).toBe(JSON.stringify(evaluation));
    expect(evaluation.summary).toMatchObject({ sentences: 6, passed: 4, failed: 2 });
    expect(evaluation.tools.find((entry) => entry.tool === 'tasks.list')?.failures).toEqual([
      { sentence: 'show my tasks', rank: 2, competitors: ['tasks.create'], moduleMismatch: true },
    ]);
    expect(evaluation.tools.find((entry) => entry.tool === 'notes.list')?.failures).toEqual([
      { sentence: 'Zeig meine Notizen', rank: null, competitors: [], moduleMismatch: false },
    ]);
  });

  it('never evaluates or ranks a disabled tool', () => {
    const evaluation = evaluateRouting({ artifact, contracts: contracts({ 'reports.export': { examples: ['export the weekly report'] } }) });
    expect(evaluation.summary).toMatchObject({ tools: 3, evaluated: 0, sentences: 0 });
  });
});
