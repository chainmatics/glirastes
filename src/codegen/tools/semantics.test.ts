import { describe, expect, it } from 'vitest';
import { lockDigest } from './agentic.js';
import {
  requiredLanguages,
  SemanticsEntrySchema,
  semanticsFacts,
  semanticsSearch,
  validateSemanticsEntry,
  type ToolSemanticsEntry,
} from './semantics.js';

const INTERFACE = `sha256:${'I'.repeat(43)}`;
const INPUT = {
  type: 'object',
  properties: { title: { type: 'string', minLength: 1 }, due: { type: 'string', format: 'date' } },
  required: ['title'],
  additionalProperties: false,
};
const context = { stableKey: 'POST /api/tasks', interfaceDigest: INTERFACE, input: INPUT };

function agentEntry(overrides: Partial<ToolSemanticsEntry> = {}): ToolSemanticsEntry {
  return SemanticsEntrySchema.parse({
    stableKey: 'POST /api/tasks',
    description: 'Creates a task for the caller. Use it to add work; to change an existing task use tasks.update.',
    synonyms: { de: ['Aufgabe anlegen', 'neue Aufgabe'], en: ['add task'] },
    examples: {
      de: ['Leg eine Aufgabe Angebot schreiben an', 'Neue Aufgabe: Bericht prüfen', 'Erstelle eine Aufgabe für morgen'],
      en: ['Add a task to call the supplier', 'Create a task for tomorrow', 'New task: review the report'],
    },
    exampleCalls: [{ sentence: 'Create a task for tomorrow', input: { title: 'Call the supplier', due: '2026-10-06' } }],
    origin: { description: 'agent', synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' },
    agent: { model: 'claude-code', interfaceDigest: INTERFACE },
    ...overrides,
  });
}

describe('tool-semantics.json entries', () => {
  it('reads the Get It Done format and refuses unknown fields', () => {
    expect(SemanticsEntrySchema.safeParse({
      name: 'tasks.list', modelName: 'tasks_list', module: 'task_query', sharedWith: [], usageHints: ['x'], description: 'x',
      presentation: { locale: 'de-DE', singular: 'a', plural: 'b', approval: 'c' },
    }).success).toBe(true);
    expect(SemanticsEntrySchema.safeParse({ name: 'tasks.list', notes: 'x' }).success).toBe(false);
    expect(SemanticsEntrySchema.safeParse({ name: 'tasks.list', examples: { de: ['only one'] } }).success).toBe(false);
    expect(SemanticsEntrySchema.safeParse({ name: 'tasks.list', origin: { color: 'agent' } }).success).toBe(false);
  });

  it('accepts a complete agent entry and reports it stale for another interface', () => {
    expect(validateSemanticsEntry(agentEntry(), context)).toEqual({ entry: agentEntry(), findings: [], stale: false });
    const stale = validateSemanticsEntry(agentEntry(), { ...context, interfaceDigest: `sha256:${'J'.repeat(43)}` });
    expect(stale).toMatchObject({ findings: [], stale: true });
  });

  it.each([
    ['an agent entry without its agent block', { agent: undefined }, 'names its model and the interfaceDigest'],
    ['an e-mail address in an example', { examples: { en: ['Mail anna@kunde.de', 'b two', 'c three'] } }, 'business data'],
    ['a provider key prefix', { description: 'Use sk-or-v1 here.' }, 'provider key prefix'],
    ['an overlong description', { description: 'x'.repeat(1_001) }, 'longer than 1000 characters'],
    ['an invalid presentation', { presentation: { locale: 'de-DE' } }, 'presentation does not match'],
    ['a module that is no name', { module: 'Task Mutation!' }, 'module and sharedWith must be module names'],
    ['an example call the schema refuses', { exampleCalls: [{ input: { title: '' } }] }, 'example call 1 does not match the input schema'],
    ['an example call with an unknown key', { exampleCalls: [{ input: { title: 'x', priority: 1 } }] }, 'example call 1 does not match'],
  ])('rejects %s', (_label, overrides, reason) => {
    const result = validateSemanticsEntry(agentEntry(overrides as Partial<ToolSemanticsEntry>), context);
    expect(result.entry).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ code: 'resolution-rejected', severity: 'warning', subjectRef: 'POST /api/tasks' });
    expect(result.findings[0]?.message).toContain(reason);
  });

  it('protects locked fields from later changes and from agent origin', () => {
    const description = 'Reviewed description.';
    const reviewed = SemanticsEntrySchema.parse({
      stableKey: 'POST /api/tasks', description, origin: { description: 'human' }, locked: { description: lockDigest(description) },
    });
    expect(validateSemanticsEntry(reviewed, context).entry).toEqual(reviewed);
    const overwritten = validateSemanticsEntry({ ...reviewed, description: 'Agent text.' }, context);
    expect(overwritten.findings[0]).toMatchObject({ code: 'resolution-rejected' });
    expect(overwritten.findings[0]?.message).toContain('the locked field description was changed after review');
    const relabelled = validateSemanticsEntry({ ...reviewed, origin: { description: 'agent' }, agent: { model: 'codex', interfaceDigest: INTERFACE } }, context);
    expect(relabelled.findings[0]?.message).toContain('the locked field description is marked as agent output');
  });

  it('reports a broken human entry as invalid semantics, and refuses keys whoever claims to have written them', () => {
    const human = SemanticsEntrySchema.parse({ stableKey: 'POST /api/tasks', exampleCalls: [{ input: { nope: true } }] });
    expect(validateSemanticsEntry(human, context).findings.map((finding) => finding.code)).toEqual(['tool-semantics-invalid']);
    expect(validateSemanticsEntry(human, { stableKey: 'POST /api/tasks' }).findings[0]?.message)
      .toContain('example calls need a tool with an input contract');
    // An entry without an origin counts as human; it still never carries a key into search or the module.
    const unlabelled = SemanticsEntrySchema.parse({ stableKey: 'POST /api/tasks', synonyms: { en: ['sk-or-v1 key'] } });
    expect(validateSemanticsEntry(unlabelled, context).findings.map((finding) => [finding.code, finding.message])).toEqual([[
      'tool-semantics-invalid', 'The tool-semantics.json entry was rejected: it contains a provider key prefix (sk-or-v1).',
    ]]);
  });

  it('names protected fields, synonyms and missing example languages', () => {
    const entry = agentEntry({ module: 'task_mutation', origin: { synonyms: 'agent', examples: 'agent', exampleCalls: 'agent' } });
    expect(semanticsFacts(entry, ['de', 'en'])).toEqual({
      protectedFields: ['description', 'module'],
      hasSynonyms: true,
      missingExamples: [],
    });
    expect(semanticsFacts(undefined, requiredLanguages('de-DE'))).toEqual({
      protectedFields: [], hasSynonyms: false, missingExamples: ['de', 'en'],
    });
    expect(requiredLanguages('en-US')).toEqual(['en']);
    expect(semanticsSearch(entry)).toEqual({
      synonyms: ['Aufgabe anlegen', 'add task', 'neue Aufgabe'],
      examples: [
        'Add a task to call the supplier', 'Create a task for tomorrow', 'Erstelle eine Aufgabe für morgen',
        'Leg eine Aufgabe Angebot schreiben an', 'Neue Aufgabe: Bericht prüfen', 'New task: review the report',
      ],
    });
  });
});
