import { afterEach, describe, expect, it } from 'vitest';
import { runToolsCheck } from '../../cli/commands/tools/check.js';
import type { OutputEntityDeclaration } from '../../contracts/entity-declaration.js';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { canonicalJson } from './canonical.js';
import { analyzeChatInteractions, deriveChatInteractions, type ChatMentionsConfig } from './chat-interactions.js';
import { DEFAULT_GENERATED_MODULE, TOOLS_PATHS, ToolsConfigSchema } from './config.js';
import { renderGeneratedModule } from './emit-module.js';
import { nextActionFor } from './findings.js';
import { runToolsPipeline } from './pipeline.js';
import type { JsonSchemaLike, ToolContract, ToolContractsEntry, ToolTitle } from './types.js';

const digest = (character: string) => `sha256:${character.repeat(43)}`;
const id = (index: number) => `019fb700-0000-7000-8000-${String(index).padStart(12, '0')}`;
const STRING = { type: 'string' };
const CONFIG = '.glirastes/tools.json';

type Labels = NonNullable<ToolContractsEntry['labels']>;

interface Spec {
  name: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path?: string;
  enabled?: boolean;
  input: JsonSchemaLike;
  output?: JsonSchemaLike;
  params?: ToolContract['params'];
  uiAction?: ToolContract['uiAction'];
  title?: ToolTitle;
  labels?: Labels;
  outputEntities?: OutputEntityDeclaration[];
  riskClass?: string;
}

const object = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties: props, required, additionalProperties: false,
});
const query = (...names: string[]) => ({ path: [], query: names, body: [] });
const ITEM = object({ id: STRING, displayName: STRING, status: STRING, size: { type: 'number' } });

/** `GET /api/files?q=` answering `{ items: [...] }`, declared as `media-file` at `items[]`. */
const FILES: Spec = {
  name: 'files.list', method: 'GET', path: '/api/files',
  input: object({ q: STRING, limit: STRING }), params: query('limit', 'q'),
  output: object({ items: { type: 'array', items: ITEM }, total: { type: 'number' } }),
  outputEntities: [{ type: 'media-file', id: 'id', name: 'displayName', path: 'items[]' }],
};
const FILE_RENAME: Spec = {
  name: 'files.rename', method: 'PATCH', path: '/api/files/:id',
  input: object({ id: STRING, displayName: STRING }, ['id']), params: { path: ['id'], query: [], body: ['displayName'] },
};
const FILE_TAG: Spec = {
  name: 'tags.attach', method: 'POST', path: '/api/tags/:id/attach',
  input: object({ id: STRING, fileId: STRING }, ['id', 'fileId']), params: { path: ['id'], query: [], body: ['fileId'] },
};
const TAGS: Spec = {
  name: 'tags.list', method: 'GET', path: '/api/tags',
  input: object({ search: STRING }), params: query('search'),
  output: { type: 'array', items: object({ id: STRING, name: STRING }) },
};
const PEOPLE: Spec = {
  name: 'people.list', method: 'GET', path: '/api/people',
  input: object({ q: STRING }), params: query('q'),
  output: { type: 'array', items: object({ id: STRING, name: STRING, email: STRING }) },
};
const NAVIGATE: Spec = {
  name: 'ui.navigate',
  input: object({
    destination: { type: 'string', enum: ['/files', '/files/:fileId', '/tags/:id'] },
    params: object({ fileId: STRING, id: STRING }),
  }, ['destination']),
  uiAction: { kind: 'navigate' },
};

function catalog(specs: ReadonlyArray<Spec>) {
  const artifact = AppSetupArtifactSchema.parse({
    schemaVersion: 1, artifactId: id(9001), runId: id(9002), appId: id(9003), discoveryDigest: digest('D'),
    assessmentMode: 'autonomous', status: 'ready',
    tools: specs.map((spec, index) => ({
      toolId: id(index + 1), sourceFingerprint: digest('F'), name: spec.name, description: `Run ${spec.name}.`,
      modelName: spec.name.replace(/\./g, '_'),
      executionKind: spec.uiAction ? 'ui' : 'endpoint',
      ...(spec.uiAction ? { actionBindingRef: 'glirastes.navigate' } : { method: spec.method, path: spec.path }),
      allowedRoles: [], operationGroup: spec.uiAction ? 'ui' : spec.method === 'GET' ? 'read' : 'update',
      riskClass: spec.riskClass ?? (spec.uiAction || spec.method === 'GET' ? 'safe-read' : 'write'), enabled: spec.enabled ?? true,
      requiresApproval: !spec.uiAction && spec.method !== 'GET', inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
    })),
    planner: { plannerId: id(9004), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [] },
    prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
    warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
  });
  const contracts: ToolContractsEntry[] = specs.map((spec, index) => ({
    toolId: id(index + 1), stableKey: spec.uiAction ? `UI ${spec.name}` : `${spec.method} ${spec.path}`, definitionId: spec.name,
    defaults: { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.labels ? { labels: spec.labels } : {}),
    ...(spec.outputEntities ? { outputEntities: spec.outputEntities } : {}),
    contract: {
      source: spec.uiAction ? 'ui-bridge' : 'native', loadBearing: true, input: spec.input,
      ...(spec.output ? { output: spec.output } : {}),
      params: spec.params ?? { path: [], query: [], body: [] }, interfaceDigest: digest('N'),
      runtime: { input: { kind: 'json', schema: spec.input }, output: { kind: 'json', schema: spec.output ?? {} } },
      ...(spec.uiAction ? { uiAction: spec.uiAction } : {}),
    },
  }));
  return { artifact, contracts };
}

const analyze = (specs: ReadonlyArray<Spec>, mentions?: ChatMentionsConfig) => analyzeChatInteractions({
  ...catalog(specs), ...(mentions ? { mentions } : {}),
});
const codes = (findings: ReadonlyArray<{ code: string }>) => findings.map((finding) => finding.code);
const undeclared = (spec: Spec): Spec => {
  const { outputEntities: _dropped, ...rest } = spec;
  return rest;
};

describe('declared mention sources', () => {
  it('takes id, name and list from the identity declaration of the type', () => {
    const { data, findings } = analyze([FILES, FILE_RENAME], {
      sources: { 'media-file': { tool: 'files.list', queryParam: 'q', label: { de: 'Datei', en: 'File', pl: 'Plik' }, aliases: { de: ['datei'] } } },
    });
    expect(findings).toEqual([]);
    expect(data.entities).toEqual([{
      type: 'media-file',
      label: { de: 'Datei', en: 'File', pl: 'Plik' },
      aliases: { de: ['datei'] },
      search: {
        tool: 'files.list', path: '/api/files', queryParam: 'q', itemsPath: ['items'],
        idField: 'id', labelField: 'displayName', descriptionField: 'status', limitParam: 'limit',
      },
      // Actions stay derived from the collection of the source's tool.
      actions: [{ id: 'media-file.files.rename', label: { en: 'Rename', de: 'Umbenennen' }, entityArg: 'id', args: [{ name: 'displayName', label: 'Display name' }], run: { kind: 'tool', tool: 'files.rename' } }],
    }]);
  });

  it('resolves the tool by its model name and lets explicit values win over the declaration', () => {
    const { data, findings } = analyze([{ ...FILES, input: object({ q: STRING, size: STRING }), params: query('q', 'size') }], {
      sources: { 'media-file': { tool: 'files_list', queryParam: 'q', labelField: 'status', idField: 'displayName', descriptionField: 'displayName', limitParam: 'size', itemsPath: ['items'] } },
    });
    expect(findings).toEqual([]);
    expect(data.entities[0]!.search).toEqual({
      tool: 'files.list', path: '/api/files', queryParam: 'q', itemsPath: ['items'],
      idField: 'displayName', labelField: 'status', descriptionField: 'displayName', limitParam: 'size',
    });
  });

  it('uses a source the tool does not declare by identity with the given fields and a warning', () => {
    const { data, findings } = analyze([undeclared(FILES)], {
      sources: { 'media-file': { tool: 'files.list', queryParam: 'q', idField: 'id', labelField: 'displayName' } },
    });
    expect(data.entities.map((entity) => [entity.type, entity.search!.itemsPath])).toEqual([['media-file', ['items']]]);
    expect(findings).toEqual([expect.objectContaining({
      code: 'mention-source-undeclared-type', severity: 'warning', subjectRef: `${CONFIG}#mentions.sources.media-file`,
      nextAction: nextActionFor('mention-source-undeclared-type'),
    })]);
    expect(findings[0]!.message).toContain('files.list');
  });

  it('needs id and label fields without a declaration', () => {
    const { data, findings } = analyze([undeclared(FILES)], {
      sources: { 'media-file': { tool: 'files.list', queryParam: 'q', labelField: 'displayName' } },
    });
    // The derived candidate of the same tool is replaced by the (invalid) declaration's absence: it is offered again.
    expect(data.entities.map((entity) => entity.type)).toEqual(['file']);
    expect(codes(findings)).toEqual(['mention-source-invalid']);
    expect(findings[0]!.message).toContain('needs idField');
  });

  it('reads a bare list answer and a { data: [] } answer from the declared path data[]', () => {
    const bare: Spec = {
      ...FILES, output: { type: 'array', items: ITEM },
      outputEntities: [{ type: 'media-file', id: 'id', name: 'displayName', path: 'data[]' }],
    };
    const wrapped: Spec = { ...bare, output: object({ data: { type: 'array', items: ITEM } }) };
    const sources = { 'media-file': { tool: 'files.list', queryParam: 'q' } };
    const fromBare = analyze([bare], { sources });
    const fromWrapped = analyze([wrapped], { sources });
    expect(fromBare.findings).toEqual([]);
    expect(fromWrapped.findings).toEqual([]);
    expect(fromBare.data.entities[0]!.search!.itemsPath).toEqual([]);
    expect(fromWrapped.data.entities[0]!.search!.itemsPath).toEqual(['data']);
    // A path-less declaration reads the response's one list.
    const pathless = analyze([{ ...FILES, outputEntities: [{ type: 'media-file', id: 'id', name: 'displayName' }] }], { sources });
    expect(pathless.data.entities[0]!.search!.itemsPath).toEqual(['items']);
  });

  it('reports each invalid entry once, ignores it and never throws', () => {
    const composite: Spec = { ...FILES, outputEntities: [{ type: 'media-file', id: ['bucket', 'id'], name: 'displayName', path: 'items[]' }] };
    const withPathParam: Spec = { ...TAGS, name: 'folders.files', path: '/api/folders/:folderId/files', params: { path: ['folderId'], query: ['search'], body: [] } };
    const write: Spec = { ...TAGS, name: 'tags.create', method: 'POST', path: '/api/tags/new' };
    const disabled: Spec = { ...PEOPLE, name: 'people.archived', path: '/api/people/archived', enabled: false };
    const sources: Record<string, unknown> = {
      unknown: { tool: 'nope.list', queryParam: 'q' },
      'path-param': { tool: 'folders.files', queryParam: 'search', idField: 'id', labelField: 'name' },
      written: { tool: 'tags.create', queryParam: 'search', idField: 'id', labelField: 'name' },
      off: { tool: 'people.archived', queryParam: 'q', idField: 'id', labelField: 'name' },
      'media-file': { tool: 'files.list', queryParam: 'q' },
      'no-query': { tool: 'people.list', idField: 'id', labelField: 'name' },
      'wrong-query': { tool: 'people.list', queryParam: 'search', idField: 'id', labelField: 'name' },
      'Bad Type': { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'name' },
      'no-label-field': { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'fullName' },
      'number-label': { tool: 'files.list', queryParam: 'q', idField: 'id', labelField: 'size' },
      'bad-label': { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'name', label: { 'not a tag!': 'x' } },
      'bad-alias': { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'name', aliases: ['two words'] },
      'bad-items': { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'name', itemsPath: ['people'] },
      extra: { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'name', icon: 'x' },
      scalar: 'people.list',
    };
    let result: ReturnType<typeof analyze> | undefined;
    expect(() => { result = analyze([composite, withPathParam, write, disabled, PEOPLE], { sources }); }).not.toThrow();
    const invalid = result!.findings.filter((finding) => finding.code === 'mention-source-invalid');
    // A key that is no entity type is shown quoted.
    expect(invalid.map((finding) => finding.subjectRef.replace(`${CONFIG}#mentions.sources.`, '')))
      .toEqual(Object.keys(sources).map((key) => (key === 'Bad Type' ? '"Bad Type"' : key)));
    expect(invalid.every((finding) => finding.severity === 'warning' && finding.nextAction === nextActionFor('mention-source-invalid'))).toBe(true);
    const message = (type: string) => invalid.find((finding) => finding.subjectRef.endsWith(`.${type}`))!.message;
    expect(message('unknown')).toContain('no generated tool');
    expect(message('path-param')).toContain('path has a parameter');
    expect(message('written')).toContain('no read endpoint');
    expect(message('off')).toContain('disabled');
    expect(message('media-file')).toContain('composite id');
    expect(message('no-query')).toContain('no queryParam');
    expect(message('wrong-query')).toContain('no query parameter');
    expect(message('"Bad Type"')).toContain('no entity type');
    expect(message('no-label-field')).toContain('do not have');
    expect(message('number-label')).toContain('no text');
    expect(message('bad-label')).toContain('label');
    expect(message('bad-alias')).toContain('aliases');
    expect(message('bad-items')).toContain('no list');
    expect(message('extra')).toContain('unknown keys');
    // Nothing declared survives; the derived candidates stay as without the block.
    expect(result!.data).toEqual(deriveChatInteractions(catalog([composite, withPathParam, write, disabled, PEOPLE])));
  });
});

describe('declared sources from config text', () => {
  it('ignores a source whose optional fields are null instead of failing the refresh', () => {
    for (const field of ['label', 'aliases', 'idField', 'labelField', 'itemsPath', 'descriptionField', 'limitParam']) {
      const { data, findings } = analyze([FILES], {
        policy: 'declared', sources: { 'media-file': { tool: 'files.list', queryParam: 'q', [field]: null } },
      });
      expect(data.entities, field).toEqual([]);
      expect(codes(findings), field).toContain('mention-source-invalid');
    }
  });

  it('never carries control characters or line breaks of tools.json keys and tool names into a finding', () => {
    const { findings } = analyze([PEOPLE], {
      sources: {
        'bad\ntype\u0000\u2028': { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'name' },
        tagged: { tool: 'nope\r\nINJECTED\u0085', queryParam: 'q' },
        keyed: { tool: 'people.list', queryParam: 'q', ['x\ny']: 1 },
      },
    });
    expect(codes(findings)).toEqual(['mention-source-invalid', 'mention-source-invalid', 'mention-source-invalid']);
    for (const finding of findings) {
      expect(`${finding.subjectRef} ${finding.message}`).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/);
    }
    expect(findings[0]!.subjectRef).toBe(`${CONFIG}#mentions.sources."bad\\ntype\\u0000\\u2028"`);
    expect(findings[1]!.message).toContain('names the tool "nope\\r\\nINJECTED\\u0085", which is no generated tool');
    expect(findings[2]!.message).toContain('"x\\ny"');
  });

  it('takes label and description fields only of exactly type string, as the derivation does', () => {
    const nullable = { type: ['string', 'null'] };
    const people: Spec = {
      ...PEOPLE,
      output: { type: 'array', items: object({ id: STRING, name: STRING, email: nullable, status: STRING, nick: nullable }) },
    };
    const derived = deriveChatInteractions(catalog([people]));
    const { findings } = analyze([people], { policy: 'declared' });
    const pasted = analyze([people], { policy: 'declared', sources: findings[0]!.expected as Record<string, unknown> });
    expect(pasted.data.entities).toEqual(derived.entities);
    expect(pasted.data.entities[0]!.search!.descriptionField).toBe('status');
    const nick = analyze([people], { sources: { member: { tool: 'people.list', queryParam: 'q', idField: 'id', labelField: 'nick' } } });
    expect(nick.findings.map((finding) => [finding.code, finding.message.includes('no text (type string)')]))
      .toEqual([['mention-source-invalid', true]]);
  });
});

describe('mention policy, order and candidates', () => {
  it('offers declared sources first in their key order, then the derived ones by type', () => {
    const { data } = analyze([undeclared(FILES), TAGS, PEOPLE], {
      sources: {
        tag: { tool: 'tags.list', queryParam: 'search', idField: 'id', labelField: 'name' },
        file: { tool: 'files.list', queryParam: 'q', idField: 'id', labelField: 'displayName' },
      },
    });
    expect(data.entities.map((entity) => entity.type)).toEqual(['tag', 'file', 'person']);
    const text = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.ts', ...catalog([undeclared(FILES), TAGS, PEOPLE]),
      mentions: { sources: { tag: { tool: 'tags.list', queryParam: 'search', idField: 'id', labelField: 'name' } } },
    });
    expect(text.indexOf('"type": "tag"')).toBeLessThan(text.indexOf('"type": "file"'));
    expect(text.indexOf('"type": "file"')).toBeLessThan(text.indexOf('"type": "person"'));
  });

  it('replaces a derived candidate of the same type or the same tool', () => {
    const { data } = analyze([undeclared(FILES), TAGS], {
      sources: { document: { tool: 'files.list', queryParam: 'q', idField: 'id', labelField: 'displayName' } },
    });
    expect(data.entities.map((entity) => [entity.type, entity.search!.tool])).toEqual([['document', 'files.list'], ['tag', 'tags.list']]);
    const sameType = analyze([TAGS, { ...PEOPLE, name: 'labels.list', path: '/api/labels' }], {
      sources: { tag: { tool: 'labels.list', queryParam: 'q', idField: 'id', labelField: 'name' } },
    });
    expect(sameType.data.entities.map((entity) => [entity.type, entity.search!.tool])).toEqual([['tag', 'labels.list']]);
  });

  it('offers only declared sources with policy declared and reports each other candidate with a ready entry', () => {
    const mentions: ChatMentionsConfig = {
      policy: 'declared',
      sources: { 'media-file': { tool: 'files.list', queryParam: 'q' } },
    };
    const { data, findings } = analyze([FILES, TAGS, PEOPLE], mentions);
    expect(data.entities.map((entity) => entity.type)).toEqual(['media-file']);
    expect(findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['mention-source-candidate', `${CONFIG}#mentions.sources.person`],
      ['mention-source-candidate', `${CONFIG}#mentions.sources.tag`],
    ]);
    expect(findings[0]!.expected).toEqual({
      person: { tool: 'people.list', queryParam: 'q', labelField: 'name', idField: 'id', itemsPath: [], descriptionField: 'email' },
    });
    expect(findings[0]!.message).toContain('"person":{"tool":"people.list"');
    // Pasting the entries gives the derived entities back, after the declared one.
    const pasted = analyze([FILES, TAGS, PEOPLE], {
      ...mentions,
      sources: { ...mentions.sources, ...(findings[0]!.expected as object), ...(findings[1]!.expected as object) },
    });
    expect(pasted.data.entities).toEqual([
      data.entities[0],
      ...deriveChatInteractions(catalog([TAGS, PEOPLE])).entities.filter((entity) => entity.type === 'person'),
      ...deriveChatInteractions(catalog([TAGS, PEOPLE])).entities.filter((entity) => entity.type === 'tag'),
    ]);
    expect(codes(pasted.findings)).toEqual(['mention-source-undeclared-type', 'mention-source-undeclared-type']);
  });

  it('neither offers nor reports an ignored type', () => {
    expect(analyze([TAGS, PEOPLE], { ignore: ['tag'] }).data.entities.map((entity) => entity.type)).toEqual(['person']);
    const declared = analyze([TAGS, PEOPLE], { policy: 'declared', ignore: ['tag'] });
    expect(declared.data.entities).toEqual([]);
    expect(declared.findings.map((finding) => finding.subjectRef)).toEqual([`${CONFIG}#mentions.sources.person`]);
  });

  it('gives exactly the output before mentions for an app without the block or with policy derived', () => {
    const specs = [undeclared(FILES), FILE_RENAME, FILE_TAG, TAGS, PEOPLE, NAVIGATE];
    const before = deriveChatInteractions(catalog(specs));
    expect(before.entities.map((entity) => entity.type)).toEqual(['file', 'person', 'tag']);
    for (const mentions of [undefined, {}, { policy: 'derived' as const }, { sources: {} }]) {
      const result = analyze(specs, mentions);
      expect(JSON.stringify(result.data)).toBe(JSON.stringify(before));
      expect(result.findings).toEqual([]);
    }
  });
});

describe('derived type follows the declared identity', () => {
  const specs = [FILES, FILE_RENAME, FILE_TAG, NAVIGATE];

  it('types the entity, its id and label by the declaration and keeps arguments and pages on it', () => {
    const { data, findings } = analyze(specs);
    const entity = data.entities.find((entry) => entry.type === 'media-file')!;
    expect(data.entities.map((entry) => entry.type)).toEqual(['media-file']);
    expect(entity.search).toMatchObject({ idField: 'id', labelField: 'displayName', itemsPath: ['items'] });
    expect(entity.actions!.map((action) => action.id)).toEqual(['media-file.files.rename', 'media-file.open']);
    expect(entity.actions!.find((action) => action.id === 'media-file.open')!.entityArg).toBe('params.fileId');
    // `fileId` (the route stem) refers to the declared type.
    const tagAttach = deriveChatInteractions(catalog([...specs, TAGS])).entities
      .find((entry) => entry.type === 'tag')!.actions!.find((action) => action.id === 'tag.tags.attach')!;
    expect(tagAttach.args).toEqual([{ name: 'fileId', label: 'File id', required: true, entity: 'media-file' }]);
    expect(findings).toEqual([expect.objectContaining({
      code: 'mention-type-follows-identity', severity: 'warning', subjectRef: `${CONFIG}#mentions.acknowledgedTypes.media-file`,
    })]);
    expect(findings[0]!.message).toContain('media-file instead of file');
    expect(findings[0]!.message).toContain('{{mention:file:');
  });

  it('is silenced by acknowledgedTypes or a declared source, without changing the output', () => {
    const plain = analyze(specs);
    const acknowledged = analyze(specs, { acknowledgedTypes: ['media-file'] });
    expect(acknowledged.findings).toEqual([]);
    expect(JSON.stringify(acknowledged.data)).toBe(JSON.stringify(plain.data));
    const declared = analyze(specs, { sources: { 'media-file': { tool: 'files.list', queryParam: 'q' } } });
    expect(declared.findings).toEqual([]);
    expect(JSON.stringify(declared.data)).toBe(JSON.stringify(plain.data));
  });

  it('keeps the route type when the declaration is not the only one at the list or names a composite id', () => {
    const two = analyze([{ ...FILES, outputEntities: [
      { type: 'media-file', id: 'id', name: 'displayName' }, { type: 'owner', id: 'ownerId', path: 'items[].owner' },
    ] }]);
    expect(two.data.entities.map((entity) => entity.type)).toEqual(['file']);
    const composite = analyze([{ ...FILES, outputEntities: [{ type: 'media-file', id: ['bucket', 'id'], path: 'items[]' }] }]);
    expect(composite.data.entities.map((entity) => entity.type)).toEqual(['file']);
    const elsewhere = analyze([{ ...FILES, outputEntities: [{ type: 'media-file', id: 'id', path: 'total' }] }]);
    expect(elsewhere.data.entities.map((entity) => entity.type)).toEqual(['file']);
    expect([...two.findings, ...composite.findings, ...elsewhere.findings]).toEqual([]);
  });

  it('keeps every derived entity when an identity type is not unique, with one ambiguity warning per type', () => {
    const media: Spec = { ...FILES, name: 'media.list', path: '/api/media' };
    const documents: Spec = { ...undeclared(FILES), name: 'documents.list', path: '/api/documents' };
    const filesAsDocument: Spec = { ...FILES, outputEntities: [{ type: 'document', id: 'id', name: 'displayName', path: 'items[]' }] };
    const pairs = (data: { entities: ReadonlyArray<{ type: string; search?: { tool: string } }> }) =>
      data.entities.map((entity) => `${entity.type}:${entity.search!.tool}`).sort();
    for (const shape of [[FILES, media], [documents, filesAsDocument]]) {
      const before = deriveChatInteractions(catalog(shape.map(undeclared)));
      const { data, findings } = analyze(shape);
      // The same search tools under the same route types as without identity declarations.
      expect(pairs(data)).toEqual(pairs(before));
      expect(JSON.stringify(data)).toBe(JSON.stringify(before));
      expect(codes(findings)).toEqual(['mention-type-ambiguous']);
      expect(findings[0]!.nextAction).toBe(nextActionFor('mention-type-ambiguous'));
    }
    expect(pairs(analyze([FILES, media]).data)).toEqual(['file:files.list', 'media:media.list']);
    const ambiguous = analyze([FILES, media]).findings[0]!;
    expect(ambiguous.subjectRef).toBe(`${CONFIG}#mentions.sources.media-file`);
    expect(ambiguous.message).toContain('files.list (/api/files, kept as file)');
    expect(ambiguous.message).toContain('media.list (/api/media, kept as media)');
    expect(ambiguous.message).toContain('declare it under mentions.sources.media-file');
    const shadowing = analyze([documents, filesAsDocument]);
    expect(pairs(shadowing.data)).toEqual(['document:documents.list', 'file:files.list']);
    expect(shadowing.findings[0]!.message).toContain('documents.list (/api/documents)');
    // fileId arguments keep their entity.
    const attach = analyze([documents, filesAsDocument, FILE_TAG, TAGS]).data.entities
      .find((entry) => entry.type === 'tag')!.actions!.find((action) => action.id === 'tag.tags.attach')!;
    expect(attach.args).toEqual([{ name: 'fileId', label: 'File id', required: true, entity: 'file' }]);
    // Byte-stable whatever the tool order.
    expect(JSON.stringify(analyze([media, FILES]))).toBe(JSON.stringify(analyze([FILES, media])));
  });

  it('never maps a word that is one entity\'s type and another one\'s route name to the wrong entity', () => {
    // /api/files declares `document`, /api/documents declares `archive`: both types are unique and adopted.
    const filesAsDocument: Spec = { ...FILES, outputEntities: [{ type: 'document', id: 'id', name: 'displayName', path: 'items[]' }] };
    const documentsAsArchive: Spec = {
      ...FILES, name: 'documents.list', path: '/api/documents',
      outputEntities: [{ type: 'archive', id: 'id', name: 'displayName', path: 'items[]' }],
    };
    const attach: Spec = {
      name: 'tags.attach', method: 'POST', path: '/api/tags/:id/attach',
      input: object({ id: STRING, documentId: STRING, fileId: STRING }, ['id', 'documentId', 'fileId']),
      params: { path: ['id'], query: [], body: ['documentId', 'fileId'] },
    };
    const navigate: Spec = {
      name: 'ui.navigate',
      input: object({
        destination: { type: 'string', enum: ['/documents/:documentId', '/files/:fileId', '/documents/:id'] },
        params: object({ documentId: STRING, fileId: STRING, id: STRING }),
      }, ['destination']),
      uiAction: { kind: 'navigate' },
    };
    const { data } = analyze([filesAsDocument, documentsAsArchive, attach, TAGS, navigate]);
    const entity = (type: string) => data.entities.find((entry) => entry.type === type)!;
    expect(data.entities.map((entry) => `${entry.type}:${entry.search!.tool}`).sort())
      .toEqual(['archive:documents.list', 'document:files.list', 'tag:tags.list']);
    // `documentId` could mean the type `document` (files) or the route /documents (archive): no entity picker.
    // `fileId` only names the route /files, whose entity is `document`.
    expect(entity('tag').actions!.find((action) => action.id === 'tag.tags.attach')!.args).toEqual([
      { name: 'documentId', label: 'Document id', required: true },
      { name: 'fileId', label: 'File id', required: true, entity: 'document' },
    ]);
    // A page is resolved by its collection segment: /documents/… opens the entity searched at /api/documents.
    expect(entity('archive').actions!.find((action) => action.id === 'archive.open')!.run.args).toEqual({ destination: '/documents/:documentId' });
    expect(entity('document').actions!.find((action) => action.id === 'document.open')!.run.args).toEqual({ destination: '/files/:fileId' });
  });

  it('keeps the route type of a derived candidate whose identity type another tool declares in mentions.sources', () => {
    const media: Spec = { ...undeclared(FILES), name: 'media.list', path: '/api/media' };
    const { data, findings } = analyze([FILES, media], {
      sources: { 'media-file': { tool: 'media.list', queryParam: 'q', idField: 'id', labelField: 'displayName', itemsPath: ['items'] } },
    });
    expect(data.entities.map((entity) => `${entity.type}:${entity.search!.tool}`)).toEqual(['media-file:media.list', 'file:files.list']);
    expect(codes(findings)).toEqual(['mention-source-undeclared-type', 'mention-type-ambiguous']);
    expect(findings[1]!.message).toContain('mentions.sources.media-file already names media.list');
  });

  it('names the changed action ids and the lapsed hidden patches in the type-change warning', () => {
    const { findings } = analyze(specs);
    expect(findings[0]!.message).toContain('action ids change too (file.… → media-file.…)');
    expect(findings[0]!.message).toContain('hidden: true patches included, no longer apply');
  });

  it('follows a declaration at data[] of a bare list answer and keeps the derived label field when the declared name is no text', () => {
    const bare: Spec = {
      ...PEOPLE, outputEntities: [{ type: 'member', id: 'id', name: 'rank', path: 'data[]' }],
      output: { type: 'array', items: object({ id: STRING, name: STRING, rank: { type: 'integer' } }) },
    };
    const { data } = analyze([bare]);
    expect(data.entities[0]).toMatchObject({ type: 'member', search: { itemsPath: [], idField: 'id', labelField: 'name' } });
  });

  it('renders the same module from the observed contracts and from tool-contracts.json', () => {
    const { artifact, contracts } = catalog([...specs, TAGS, PEOPLE]);
    const fromFile = JSON.parse(canonicalJson({ tools: contracts })).tools as ToolContractsEntry[];
    const mentions: ChatMentionsConfig = { sources: { tag: { tool: 'tags.list', queryParam: 'search' } }, ignore: ['person'] };
    const render = (entries: ToolContractsEntry[]) => renderGeneratedModule({ modulePath: 'm.ts', artifact, contracts: entries, mentions });
    expect(render(fromFile)).toBe(render(contracts));
  });
});

describe('entity and action labels per language', () => {
  const reviewed = (singular: string, plural: string) => ({ singular, plural, approval: `${plural}?` });

  it('labels the entity in every language the search tool has a reviewed label for', () => {
    const labels: Labels = {
      en: reviewed('File', 'Files'), de: reviewed('Datei', 'Dateien'), pl: reviewed('Plik', 'Pliki'),
      // A templated label and a title as label repeat one text: never an entity label.
      fr: { singular: 'Lister les fichiers', plural: 'Lister les fichiers', approval: 'Lister les fichiers' },
      // The English fallback of a language without its own label.
      it: reviewed('File', 'Files'),
    };
    const { data } = analyze([{ ...FILES, labels }]);
    expect(data.entities[0]!.label).toEqual({ en: 'File', de: 'Datei', pl: 'Plik' });
    const templated: Labels = { en: { singular: 'List files', plural: 'List files', approval: 'List files' }, de: { singular: 'Dateien auflisten', plural: 'Dateien auflisten', approval: 'Dateien auflisten' } };
    // Without a reviewed noun the label comes from the route (`/api/files`), also for the declared type `media-file`.
    expect(analyze([{ ...FILES, labels: templated }]).data.entities[0]!.label).toEqual({ en: 'File', de: 'File' });
  });

  it('keeps the label of a derived entity when its type follows the declared identity', () => {
    const withIdentity = analyze([FILES]).data.entities[0]!;
    const withoutIdentity = analyze([undeclared(FILES)]).data.entities[0]!;
    expect([withIdentity.type, withoutIdentity.type]).toEqual(['media-file', 'file']);
    expect(withIdentity.label).toEqual(withoutIdentity.label);
    expect(withIdentity.label).toEqual({ en: 'File', de: 'File' });

    // A reviewed noun names the entity as before, with and without the declaration.
    const labels: Labels = { en: reviewed('Media item', 'Media items'), de: reviewed('Medium', 'Medien') };
    expect(analyze([{ ...FILES, labels }]).data.entities[0]!.label).toEqual({ en: 'Media item', de: 'Medium' });
    expect(analyze([{ ...undeclared(FILES), labels }]).data.entities[0]!.label).toEqual({ en: 'Media item', de: 'Medium' });

    // A pasted candidate of the adopted type is exactly the derived entity, label included.
    const { findings } = analyze([FILES], { policy: 'declared' });
    expect(Object.keys(findings[0]!.expected as object)).toEqual(['media-file']);
    const pasted = analyze([FILES], { policy: 'declared', sources: findings[0]!.expected as Record<string, unknown> });
    expect(pasted.data.entities).toEqual([withIdentity]);
  });

  it('names a declared source without a label after its route, else after its type', () => {
    const source = { queryParam: 'q', idField: 'id', labelField: 'name' };
    const routed = analyze([PEOPLE], { sources: { member: { tool: 'people.list', ...source } } }).data.entities[0]!;
    expect([routed.type, routed.label]).toEqual(['member', { en: 'Person', de: 'Person' }]);
    // `/search` names no type: the declared type is the label.
    const bare = analyze([{ ...PEOPLE, path: '/search' }], { sources: { member: { tool: 'people.list', ...source } } }).data.entities[0]!;
    expect([bare.type, bare.label]).toEqual(['member', { en: 'Member', de: 'Member' }]);
  });

  it('keeps every language of an action label and drops the noun in each', () => {
    const labels: Labels = { en: reviewed('File', 'Files'), de: reviewed('Datei', 'Dateien'), pl: reviewed('Plik', 'Pliki') };
    const archive: Spec = {
      name: 'files.archive', method: 'POST', path: '/api/files/:id/archive',
      input: object({ id: STRING }, ['id']), params: { path: ['id'], query: [], body: [] },
      title: { en: 'Archive file', de: 'Datei archivieren', pl: 'Plik archiwizuj', 'pt-BR': 'Arquivar arquivo' },
    };
    const { data } = analyze([{ ...FILES, labels }, archive]);
    expect(data.entities[0]!.actions![0]!.label).toEqual({
      en: 'Archive file', de: 'Archivieren', pl: 'Archiwizuj', 'pt-BR': 'Arquivar arquivo',
    });
  });
});

describe('tools.json mentions in refresh and check (OpenAPI source)', () => {
  afterEach(removeAppFixtures);

  const operation = (schema: unknown, parameters: unknown[]) => ({
    security: [{ session: [] }], parameters,
    responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
  });
  const queryParam = (name: string) => ({ name, in: 'query', required: false, schema: { type: 'string' } });
  const openapi = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Media', version: '1' },
    paths: {
      '/api/files': { get: operation({ $ref: '#/components/schemas/FilePage' }, [queryParam('q')]) },
      '/api/tags': { get: operation({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } }, [queryParam('search')]) },
    },
    components: {
      schemas: {
        MediaFile: {
          type: 'object', properties: { id: { type: 'string' }, displayName: { type: 'string' } },
          'x-glirastes-entity': { id: 'id', name: 'displayName' },
        },
        FilePage: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/MediaFile' } } } },
      },
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 's' } },
    },
  });
  const app = (mentions?: unknown) => createAppFixture({ 'api/openapi.json': openapi }, {
    toolsConfig: { sources: [{ kind: 'openapi', document: 'api/openapi.json' }], ...(mentions !== undefined ? { mentions } : {}) },
  });
  const chatOf = (module: string) => JSON.parse(/export const chatInteractions = (\{[\s\S]*?\n\}) as const;/.exec(module)![1]!) as {
    entities: Array<{ type: string; search: { tool: string } }>;
  };

  it('follows the schema identity, reports the change, and keeps it out of the setup artifact', async () => {
    const fixture = await app();
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    expect(chatOf(module).entities.map((entity) => entity.type)).toEqual(['media-file', 'tag']);
    const follows = result.findings.filter((finding) => finding.code === 'mention-type-follows-identity');
    expect(follows.map((finding) => finding.subjectRef)).toEqual([`${CONFIG}#mentions.acknowledgedTypes.media-file`]);
    const report = JSON.parse(await fixture.read(TOOLS_PATHS.report)) as { findings: Array<{ code: string }> };
    expect(report.findings.map((finding) => finding.code)).toContain('mention-type-follows-identity');
    const artifact = JSON.parse(await fixture.read(TOOLS_PATHS.setupArtifact)) as { warnings: Array<{ code: string }> };
    expect(artifact.warnings.map((warning) => warning.code)).not.toContain('mention-type-follows-identity');
    const frozen = await runToolsPipeline({ root: fixture.root, mode: 'frozen' });
    expect(frozen.driftPaths).toEqual([]);
    const integrity = await runToolsPipeline({ root: fixture.root, mode: 'integrity' });
    expect(integrity.driftPaths).toEqual([]);
  }, 120_000);

  it('offers only declared sources and shows candidates with expected in the check JSON', async () => {
    const fixture = await app({ policy: 'declared', sources: { 'media-file': { tool: 'files.list', queryParam: 'q' } } });
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    expect(chatOf(module).entities.map((entity) => entity.type)).toEqual(['media-file']);
    const lines: string[] = [];
    const exit = await runToolsCheck(['--json', '--no-skills', '--root', fixture.root], {
      cwd: fixture.root, env: {}, log: (line) => lines.push(line), error: () => {}, runPipeline: runToolsPipeline,
    });
    expect(exit).toBe(0);
    const output = JSON.parse(lines[0]!) as { findings: Array<{ code: string; expected?: unknown }> };
    const candidate = output.findings.find((finding) => finding.code === 'mention-source-candidate');
    expect(candidate?.expected).toEqual({
      tag: { tool: 'tags.list', queryParam: 'search', labelField: 'name', idField: 'id', itemsPath: [] },
    });
    expect(output.findings.map((finding) => finding.code)).not.toContain('mention-source-invalid');
  }, 120_000);
});

describe('tools.json mentions schema', () => {
  const base = { schemaVersion: 1, appId: '019fb007-0000-7000-8000-0000000000a1', targetAppKey: 'x', locale: 'en', sources: ['next-app'] };

  it('accepts the block with unchecked source entries and rejects unknown keys and policies', () => {
    const mentions = { policy: 'declared', sources: { tag: { anything: true } }, ignore: ['person'], acknowledgedTypes: ['media-file'] };
    expect(ToolsConfigSchema.parse({ ...base, mentions }).mentions).toEqual(mentions);
    expect(ToolsConfigSchema.safeParse({ ...base, mentions: { policy: 'all' } }).success).toBe(false);
    expect(ToolsConfigSchema.safeParse({ ...base, mentions: { source: {} } }).success).toBe(false);
  });
});
