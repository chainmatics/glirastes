import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSetupToolCandidateSchema, ToolPresentationSchema } from '../../contracts/index.js';
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

  describe('template bounds', () => {
    const template = (overrides: Partial<ResolveToolProseInput>) => resolveToolProse({ ...base, ...overrides });
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

    it.each([
      ['an English create label for a 194-char resource', { definitionId: `${'a'.repeat(194)}.create` }, 'Create '],
      ['a camelCase resource that gains a space at every boundary', { definitionId: `${'aB'.repeat(75)}.create` }, 'Create '],
      ['a 200-char first segment on a read tool', { definitionId: `${'x'.repeat(200)}.list`, operationGroup: 'read' as const }, 'List '],
    ])('keeps %s inside the presentation bounds', (_name, overrides, prefix) => {
      const prose = template(overrides);
      expect(prose.presentation.singular.length).toBeLessThanOrEqual(200);
      expect(prose.presentation.singular.startsWith(prefix)).toBe(true);
      expect(ToolPresentationSchema.safeParse(prose.presentation).success).toBe(true);
      expect(prose.description.length).toBeLessThanOrEqual(1_000);
      expect(prose.findings.map((finding) => finding.code)).toEqual(['description-templated']);
    });

    it('keeps the German verb when the resource words are clamped', () => {
      const prose = template({ locale: 'de-DE', operationGroup: 'update', definitionId: `${'a'.repeat(199)}.update` });
      expect(prose.presentation.singular).toHaveLength(200);
      expect(prose.presentation.singular.startsWith('A')).toBe(true);
      expect(prose.presentation.singular.endsWith(' ändern')).toBe(true);
      expect(prose.presentation.plural).toBe(prose.presentation.singular);
      expect(prose.presentation.approval).toBe(prose.presentation.singular);
      expect(ToolPresentationSchema.safeParse(prose.presentation).success).toBe(true);
    });

    it('bounds the template description for a maximum-length route path', () => {
      const path = `/${'p'.repeat(2_047)}`;
      const prose = template({ path, definitionId: 'tasks.create' });
      expect(prose.description.length).toBeLessThanOrEqual(1_000);
      expect(prose.description.startsWith('Create tasks (POST /ppp')).toBe(true);
      expect(prose.usageHints.every((hint) => hint.length >= 1 && hint.length <= 500)).toBe(true);
      expect(AppSetupToolCandidateSchema.shape.description.safeParse(prose.description).success).toBe(true);
      expect(AppSetupToolCandidateSchema.shape.path.safeParse(path).success).toBe(true);
    });

    it('does not cut a surrogate pair at the clamp boundary', () => {
      const prose = template({ definitionId: `${'a'.repeat(192)}\u{1F600}tail.create`, path: `/${'\u{1F600}'.repeat(600)}` });
      expect(prose.presentation.singular).not.toMatch(loneSurrogate);
      expect(prose.presentation.singular.length).toBeLessThanOrEqual(200);
      expect(prose.description).not.toMatch(loneSurrogate);
      expect(prose.description.length).toBeLessThanOrEqual(1_000);
    });

    it('leaves a short template untouched', () => {
      const prose = template({});
      expect(prose.description).toBe('Create tasks (POST /api/tasks).');
      expect(prose.presentation.singular).toBe('Create tasks');
    });
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

describe('tool prose for UI tools', () => {
  it('names a client action template after its id, not after the ui namespace', () => {
    const prose = resolveToolProse({
      stableKey: 'UI action task-details.open',
      definitionId: 'ui.taskDetails.open',
      operationGroup: 'ui',
      locale: 'en-US',
      semantics: EMPTY_SEMANTICS,
    });
    expect(prose).toMatchObject({
      description: 'Run task details open.',
      descriptionOrigin: 'template',
      module: 'ui',
      presentation: { singular: 'Run task details open' },
      findings: [expect.objectContaining({ code: 'description-templated' })],
    });
    expect(resolveToolProse({
      stableKey: 'UI action tasks.highlight', definitionId: 'ui.tasks.highlight', operationGroup: 'ui',
      locale: 'de-DE', semantics: EMPTY_SEMANTICS,
    }).description).toBe('Tasks highlight ausführen.');
  });
});
