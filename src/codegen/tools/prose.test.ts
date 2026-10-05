import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_SEMANTICS, loadToolSemantics, resolveToolProse, type ResolveToolProseInput } from './prose.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function semanticsFile(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-semantics-'));
  roots.push(root);
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(join(root, '.glirastes/tool-semantics.json'), content);
  return loadToolSemantics(root);
}

const base: ResolveToolProseInput = {
  stableKey: 'POST /api/tasks',
  definitionId: 'tasks.create',
  method: 'POST',
  path: '/api/tasks',
  operationGroup: 'create',
  locale: 'en-US',
  semantics: EMPTY_SEMANTICS,
};

describe('tool prose', () => {
  it.each([
    [{ policyDescription: 'Policy text.', jsDoc: 'Doc text.' }, 'Policy text.', 'human'],
    [{ jsDoc: 'Doc text.', hints: { contractDescription: 'Contract text.' } }, 'Doc text.', 'code'],
    [{ hints: { contractDescription: 'Contract text.', schemaDescription: 'Schema text.' } }, 'Contract text.', 'code'],
    [{ hints: { schemaDescription: 'Schema text.' } }, 'Schema text.', 'code'],
    [{ jsDoc: `Bearer ${'a'.repeat(30)}`, hints: { schemaDescription: 'Schema text.' } }, 'Schema text.', 'code'],
  ] as const)('chooses the description by precedence (%#)', (overrides, description, origin) => {
    const prose = resolveToolProse({ ...base, ...overrides });
    expect(prose).toMatchObject({ description, descriptionOrigin: origin, findings: [] });
  });

  it('falls back to tool-semantics.json by stable key before name and keeps its origin', async () => {
    const { semantics, findings } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [
        { name: 'tasks.create', description: 'By name.', module: 'task_mutation' },
        {
          stableKey: 'POST /api/tasks', description: 'By key.', module: 'task_mutation',
          sharedWith: ['task_mutation', 'calendar'], usageHints: ['Use for new tasks.'],
          presentation: { locale: 'de-DE', singular: 'Aufgabe anlegen', plural: 'Aufgaben anlegen', approval: 'Aufgabe anlegen?' },
          origin: { description: 'agent' },
        },
      ],
    }));
    expect(findings).toEqual([]);
    expect(resolveToolProse({ ...base, semantics })).toEqual({
      description: 'By key.',
      descriptionOrigin: 'agent',
      module: 'task_mutation',
      sharedWith: ['calendar'],
      usageHints: ['Use for new tasks.'],
      presentation: { locale: 'de-DE', singular: 'Aufgabe anlegen', plural: 'Aufgaben anlegen', approval: 'Aufgabe anlegen?' },
      findings: [],
    });
  });

  it('uses locale templates with a visible warning when no prose exists', () => {
    const english = resolveToolProse({ ...base, definitionId: 'tasksByDate.list', stableKey: 'GET /api/tasks-by-date', method: 'GET', path: '/api/tasks-by-date', operationGroup: 'read' });
    expect(english).toMatchObject({
      description: 'List tasks by date (GET /api/tasks-by-date).',
      descriptionOrigin: 'template',
      module: 'tasksByDate',
      sharedWith: [],
      usageHints: ['List tasks by date (GET /api/tasks-by-date).'],
      presentation: { locale: 'en-US', singular: 'List tasks by date', plural: 'List tasks by date', approval: 'List tasks by date' },
    });
    expect(english.findings.map((finding) => [finding.code, finding.severity])).toEqual([['description-templated', 'warning']]);
    const german = resolveToolProse({ ...base, locale: 'de-DE', definitionId: 'tasks.get', method: 'GET', path: '/api/tasks/:id', operationGroup: 'read' });
    expect(german.description).toBe('Tasks anzeigen (GET /api/tasks/:id).');
    expect(german.presentation.locale).toBe('de-DE');
  });

  it('prefers contract module, hints and presentation over semantics', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1, tools: [{ name: 'tasks.create', module: 'from_semantics', usageHints: ['From semantics.'] }],
    }));
    const prose = resolveToolProse({
      ...base,
      semantics,
      jsDoc: 'Creates a task.',
      hints: {
        module: 'task_mutation',
        usageHints: ['From the contract.'],
        presentation: { locale: 'en-US', singular: 'Create task', plural: 'Create tasks', approval: 'Create this task?' },
      },
    });
    expect(prose).toMatchObject({
      module: 'task_mutation',
      usageHints: ['From the contract.'],
      presentation: { singular: 'Create task', approval: 'Create this task?' },
    });
  });

  it('reports malformed semantics files and entries without failing', async () => {
    expect((await semanticsFile('{')).findings.map((finding) => finding.code)).toEqual(['tool-semantics-invalid']);
    const partial = await semanticsFile(JSON.stringify({ schemaVersion: 1, tools: [{ description: 'no key' }, { name: 'tasks.create', description: 'Kept.' }] }));
    expect(partial.findings.map((finding) => finding.subjectRef)).toEqual(['.glirastes/tool-semantics.json#0']);
    expect(partial.semantics.byName.get('tasks.create')?.description).toBe('Kept.');
  });
});
