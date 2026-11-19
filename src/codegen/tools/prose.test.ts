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

  it('keeps the code module, but lets a maintained semantics entry beat the code texts and says so', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [{
        name: 'tasks.create', module: 'from_semantics', description: 'From semantics.', usageHints: ['From semantics.'],
        presentation: { locale: 'en-US', singular: 'New task', plural: 'New tasks', approval: 'Create the task?' },
      }],
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
      description: 'From semantics.',
      descriptionOrigin: 'human',
      usageHints: ['From semantics.'],
      presentation: { singular: 'New task', approval: 'Create the task?' },
    });
    expect(prose.findings.map((finding) => [finding.code, finding.message])).toEqual([
      ['semantics-overrides-code', expect.stringContaining('The description in tool-semantics.json')],
      ['semantics-overrides-code', expect.stringContaining('The usageHints in tool-semantics.json')],
      ['semantics-overrides-code', expect.stringContaining('The presentation in tool-semantics.json')],
    ]);
    for (const finding of prose.findings) expect(finding.message).not.toContain('From semantics');
  });

  it('keeps agent-written and code-copied semantics fields below the code, as before', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [{
        name: 'tasks.create', description: 'Agent text.', usageHints: ['Agent hint.'],
        presentation: { locale: 'en-US', singular: 'Agent', plural: 'Agents', approval: 'Agent?' },
        origin: { description: 'agent', usageHints: 'code', presentation: 'agent' },
      }],
    }));
    const prose = resolveToolProse({
      ...base,
      semantics,
      jsDoc: 'Creates a task.',
      hints: {
        usageHints: ['From the contract.'],
        presentation: { locale: 'en-US', singular: 'Create task', plural: 'Create tasks', approval: 'Create this task?' },
      },
    });
    expect(prose).toMatchObject({
      description: 'Creates a task.',
      descriptionOrigin: 'code',
      usageHints: ['From the contract.'],
      presentation: { singular: 'Create task' },
      findings: [],
    });
  });

  it('ranks usage hints and the approval hint each by their own origin', async () => {
    const hints = { usageHints: ['From the contract.'] };
    const load = async (value: unknown) => (await semanticsFile(JSON.stringify({ schemaVersion: 1, tools: [value] }))).semantics;
    // An agent wrote the usage hints, a person the approval hint: the code hints stay, the approval hint is added.
    const mixed = await load({ name: 'tasks.create', usageHints: ['Agent hint.'], approvalHint: 'Confirm shared tasks.', origin: { usageHints: 'agent' } });
    expect(resolveToolProse({ ...base, semantics: mixed, hints }).usageHints).toEqual(['From the contract.', 'Confirm shared tasks.']);
    // A person wrote the usage hints, an agent the approval hint: the entry's hints win, the agent's approval hint stays out.
    const reverse = await load({ name: 'tasks.create', usageHints: ['Human hint.'], approvalHint: 'Agent approval.', origin: { approvalHint: 'agent' } });
    expect(resolveToolProse({ ...base, semantics: reverse, hints }).usageHints).toEqual(['Human hint.']);
    // Without code hints both are used, as before.
    expect(resolveToolProse({ ...base, semantics: reverse }).usageHints).toEqual(['Human hint.', 'Agent approval.']);
  });

  it('lets a locked field beat the code even when an agent wrote it first', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [{ name: 'tasks.create', description: 'Reviewed.', origin: { description: 'code' }, locked: { description: `sha256:${'A'.repeat(43)}` } }],
    }));
    expect(resolveToolProse({ ...base, semantics, jsDoc: 'Creates a task.' }).description).toBe('Reviewed.');
  });

  it('sends the model one description: English, else another layer, else the first language', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1, tools: [{ name: 'tasks.create', description: { de: 'Legt eine Aufgabe an.', pl: 'Tworzy zadanie.' } }],
    }));
    // The entry has no English text: the plain JSDoc serves English.
    expect(resolveToolProse({ ...base, semantics, jsDoc: 'Creates a task.' }).description).toBe('Creates a task.');
    expect(resolveToolProse({ ...base, semantics }).description).toBe('Legt eine Aufgabe an.');
    expect(resolveToolProse({ ...base, hints: { declaredDescription: { en: 'Declared.', de: 'Deklariert.' } }, jsDoc: 'Doc.' }).description)
      .toBe('Declared.');
  });

  describe('labels per language (tools.json languages)', () => {
    const languages = ['en', 'de', 'pl'];

    it('leaves the labels out and the presentation unchanged without languages', () => {
      const prose = resolveToolProse({ ...base, hints: { title: { de: 'Aufgabe anlegen', pl: 'Utwórz zadanie' } } });
      expect(prose.labels).toBeUndefined();
      expect(prose.presentation).toEqual({ locale: 'en-US', singular: 'Create tasks', plural: 'Create tasks', approval: 'Create tasks' });
    });

    it('keeps the presentation of a templated tool in the app locale, also for a locale without a template', () => {
      for (const locale of ['fr-FR', 'de-DE', 'en-US']) {
        expect(resolveToolProse({ ...base, locale, languages: ['de', 'en'] }).presentation)
          .toEqual(resolveToolProse({ ...base, locale }).presentation);
      }
    });

    it('mixes the semantics entry and the endpoint per language, the maintained entry first', async () => {
      const { semantics } = await semanticsFile(JSON.stringify({
        schemaVersion: 1, tools: [{ name: 'tasks.create', title: { de: 'Neue Aufgabe' } }],
      }));
      const prose = resolveToolProse({
        ...base, semantics, languages, locale: 'de-DE',
        hints: { title: { de: 'Aufgabe anlegen', pl: 'Utwórz zadanie' } },
      });
      expect(prose.labels).toEqual({
        en: { singular: 'Create tasks', plural: 'Create tasks', approval: 'Create tasks' },
        de: { singular: 'Neue Aufgabe', plural: 'Neue Aufgabe', approval: 'Neue Aufgabe' },
        pl: { singular: 'Utwórz zadanie', plural: 'Utwórz zadanie', approval: 'Utwórz zadanie' },
      });
      expect(prose.presentation).toEqual({ locale: 'de-DE', singular: 'Neue Aufgabe', plural: 'Neue Aufgabe', approval: 'Neue Aufgabe' });
      expect(prose.missingLabelLanguages).toBeUndefined();
    });

    it('takes a presentation per language before a title and reports languages without an own label', async () => {
      const { semantics } = await semanticsFile(JSON.stringify({
        schemaVersion: 1,
        tools: [{
          name: 'tasks.create',
          presentation: { de: { singular: 'Aufgabe', plural: 'Aufgaben', approval: 'Aufgabe anlegen?' } },
          title: { de: 'Aufgabe anlegen' },
        }],
      }));
      const prose = resolveToolProse({ ...base, semantics, languages: ['en', 'de', 'pl-PL'] });
      expect(prose.labels?.de).toEqual({ singular: 'Aufgabe', plural: 'Aufgaben', approval: 'Aufgabe anlegen?' });
      // No Polish label anywhere: English (the template) before the first available language.
      expect(prose.labels?.['pl-PL']).toEqual({ singular: 'Create tasks', plural: 'Create tasks', approval: 'Create tasks' });
      expect(prose.missingLabelLanguages).toEqual(['pl-PL']);
    });

    it('uses a language-free endpoint title for every language the entry lacks', () => {
      const prose = resolveToolProse({ ...base, languages, hints: { title: 'Task wizard' } });
      expect(Object.values(prose.labels ?? {}).map((labels) => labels.approval)).toEqual(['Task wizard', 'Task wizard', 'Task wizard']);
      expect(prose.missingLabelLanguages).toBeUndefined();
    });

    it('keeps a language-free contract title for the languages the OpenAPI title lacks', () => {
      const prose = resolveToolProse({ ...base, languages, hints: { title: { de: 'Aufgabe anlegen' }, contractTitle: 'New task' } });
      expect(Object.fromEntries(Object.entries(prose.labels ?? {}).map(([language, labels]) => [language, labels.approval])))
        .toEqual({ en: 'New task', de: 'Aufgabe anlegen', pl: 'New task' });
    });

    it('drops a secret-looking label instead of shipping it', () => {
      const prose = resolveToolProse({ ...base, languages, hints: { title: { pl: `Bearer ${'a'.repeat(30)}` } } });
      expect(JSON.stringify(prose)).not.toContain('Bearer');
    });
  });

  it('reports an agent entry that does not parse as rejected agent output', async () => {
    const loaded = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'POST /api/tasks', description: 'x', origin: { description: 'agent' }, agent: { model: 'codex' } },
        { stableKey: 'GET /api/tasks', description: 'y', mood: 'happy' },
      ],
    }));
    expect(loaded.findings.map((finding) => [finding.code, finding.subjectRef, finding.message])).toEqual([
      ['resolution-rejected', '.glirastes/tool-semantics.json#0', 'Entry 0 of tool-semantics.json is invalid at agent.interfaceDigest and is ignored.'],
      ['tool-semantics-invalid', '.glirastes/tool-semantics.json#1', 'Entry 1 of tool-semantics.json is invalid and is ignored.'],
    ]);
  });

  it('never echoes file-controlled map keys into a rejected-entry message', async () => {
    const secretKey = `sk-or-v1-${'a'.repeat(64)}`;
    const controlKey = '\u001b[31mevil\nline';
    const loaded = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [
        { stableKey: 'POST /api/tasks', origin: { [secretKey]: 'agent' } },
        { stableKey: 'GET /api/tasks', locked: { [controlKey]: 'x' } },
        { stableKey: 'GET /api/users', origin: { description: 'agent' }, agent: { model: 'codex' } },
      ],
    }));
    expect(loaded.findings.map((finding) => [finding.code, finding.message])).toEqual([
      ['resolution-rejected', 'Entry 0 of tool-semantics.json is invalid at origin.<key> and is ignored.'],
      ['tool-semantics-invalid', 'Entry 1 of tool-semantics.json is invalid at locked.<key> and is ignored.'],
      ['resolution-rejected', 'Entry 2 of tool-semantics.json is invalid at agent.interfaceDigest and is ignored.'],
    ]);
    for (const finding of loaded.findings) {
      expect(finding.message).not.toContain('sk-or-v1');
      // eslint-disable-next-line no-control-regex
      expect(finding.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });

  it('uses the entry the pipeline checked and adds its approval hint to the usage hints', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [{ stableKey: 'POST /api/tasks', description: 'From semantics.', approvalHint: 'Confirm when the task is shared with a team.' }],
    }));
    const prose = resolveToolProse({ ...base, semantics });
    expect(prose.usageHints).toEqual(['Confirm when the task is shared with a team.']);
    const rejected = resolveToolProse({ ...base, semantics, entry: null });
    expect(rejected).toMatchObject({ descriptionOrigin: 'template', description: 'Create tasks (POST /api/tasks).' });
  });

  it('reports malformed semantics files and entries without failing', async () => {
    expect((await semanticsFile('{')).findings.map((finding) => finding.code)).toEqual(['tool-semantics-invalid']);
    const partial = await semanticsFile(JSON.stringify({ schemaVersion: 1, tools: [{ description: 'no key' }, { name: 'tasks.create', description: 'Kept.' }] }));
    expect(partial.findings.map((finding) => finding.subjectRef)).toEqual(['.glirastes/tool-semantics.json#0']);
    expect(partial.semantics.byName.get('tasks.create')?.description).toBe('Kept.');
  });
});

/** What the openapi source sets: its names without a dot come from `x-glirastes-name`. */
const FROM_ROUTE = { resourceFromRoute: true } as const;

describe('tool prose for endpoint names without a dot', () => {
  const named = (definitionId: string, method: string, path: string, operationGroup: ResolveToolProseInput['operationGroup'], locale: string) => (
    resolveToolProse({ ...base, stableKey: `${method} ${path}`, definitionId, method, path, operationGroup, locale, hints: FROM_ROUTE })
  );

  it.each([
    ['update_tag', 'PATCH', '/api/tags/:id', 'update', 'en-US', 'Update tags'],
    ['update_tag', 'PATCH', '/api/tags/:id', 'update', 'de-DE', 'Tags ändern'],
    ['list_tags', 'GET', '/api/tags', 'read', 'en-US', 'List tags'],
    ['list_tags', 'GET', '/api/tags', 'read', 'de-DE', 'Tags auflisten'],
    ['create_tag', 'POST', '/api/tags', 'create', 'de-DE', 'Tags anlegen'],
    ['delete_tag', 'DELETE', '/api/tags/:id', 'delete', 'en-US', 'Delete tags'],
  ] as const)('labels %s (%s %s, %s) without repeating the verb', (definitionId, method, path, group, locale, label) => {
    const prose = named(definitionId, method, path, group, locale);
    expect(prose.presentation).toMatchObject({ singular: label, plural: label, approval: label });
    expect(prose.description).toBe(`${label} (${method} ${path}).`);
  });

  it('takes the module from the path, never from the name', () => {
    expect(named('list_tags', 'GET', '/api/tags', 'read', 'en-US').module).toBe('tags');
    expect(named('update_tag', 'PATCH', '/api/tags/:id', 'update', 'en-US').module).toBe('tags');
    // A dotted name keeps the part before the first dot.
    expect(named('labels.rename', 'PATCH', '/api/tags/:id', 'update', 'en-US').module).toBe('labels');
  });

  it('puts a group hint (x-glirastes-group) above tool-semantics.json and the name', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [{ stableKey: 'GET /api/tags', module: 'labels', description: 'Lists the tags.' }],
    }));
    const prose = resolveToolProse({
      ...base, stableKey: 'GET /api/tags', definitionId: 'list_tags', method: 'GET', path: '/api/tags',
      operationGroup: 'read', semantics, hints: { ...FROM_ROUTE, module: 'tag' },
    });
    expect(prose.module).toBe('tag');
    expect(resolveToolProse({
      ...base, stableKey: 'GET /api/tags', definitionId: 'list_tags', method: 'GET', path: '/api/tags', operationGroup: 'read', semantics,
      hints: FROM_ROUTE,
    }).module).toBe('labels');
  });

  // Backward compatibility: next-app, nest and contract-module sources never set the hint.
  it.each([
    ['listTags', 'GET', '/api/tags', 'read', 'en-US', 'List list tags'],
    ['listTags', 'GET', '/api/tags', 'read', 'de-DE', 'List tags auflisten'],
    ['update_tag', 'PATCH', '/api/tags/:id', 'update', 'en-US', 'Update update tag'],
    ['removeTag', 'DELETE', '/api/tags/:id', 'delete', 'de-DE', 'Remove tag löschen'],
  ] as const)('keeps module and label of %s (%s %s, %s) from the name for every other source', (definitionId, method, path, group, locale, label) => {
    // The rule before method and path were considered: the part before the first dot, split into words.
    const resource = definitionId.split('.')[0]!;
    const words = resource.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
    for (const hints of [undefined, {}, { usageHints: ['Use it.'] }]) {
      const prose = resolveToolProse({
        ...base, stableKey: `${method} ${path}`, definitionId, method, path, operationGroup: group, locale,
        ...(hints ? { hints } : {}),
      });
      expect(prose.module).toBe(resource);
      expect(prose.presentation).toMatchObject({ singular: label, plural: label, approval: label });
      expect(prose.presentation.singular.toLowerCase()).toContain(words);
      expect(prose.description).toBe(`${label} (${method} ${path}).`);
    }
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
