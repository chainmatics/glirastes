import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_CONVENTIONS,
  inputEvidenceProblem,
  loadToolResolutions,
  resolutionLockDigest,
  resolutionOrigin,
  ResolutionEntrySchema,
  validateResolutionEntry,
} from './resolutions.js';

const roots: string[] = [];
const DIGEST = `sha256:${'R'.repeat(43)}`;
const evidence = { pathParams: ['id'], queryKeys: [] as ReadonlyArray<string>, bodyKeys: ['title'] as ReadonlyArray<string> | 'opaque' };

async function appWith(content?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-resolutions-'));
  roots.push(root);
  if (content !== undefined) {
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeFile(join(root, '.glirastes/tool-resolutions.json'), content);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const objectSchema = (properties: Record<string, unknown>) => ({
  type: 'object', properties, additionalProperties: false,
});

describe('tool resolutions', () => {
  it('is empty without a file', async () => {
    const { resolutions, findings } = loadToolResolutions(await appWith());
    expect(resolutions.conventions).toEqual(EMPTY_CONVENTIONS);
    expect(resolutions.entries.size).toBe(0);
    expect(findings).toEqual([]);
  });

  it('reads conventions and keeps raw per-tool entries', async () => {
    const { resolutions, findings } = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1,
      conventions: {
        handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
        authHelpers: ['resolveSession'],
      },
      tools: { 'GET /api/tasks': { interfaceDigest: DIGEST } },
    })));
    expect(findings).toEqual([]);
    expect(resolutions.conventions).toEqual({
      handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
      bodyReaders: [],
      authHelpers: ['resolveSession'],
      filterValues: {},
    });
    expect([...resolutions.entries.keys()]).toEqual(['GET /api/tasks']);
  });

  it('ignores malformed files and invalid conventions with a visible warning', async () => {
    const malformed = loadToolResolutions(await appWith('{'));
    expect(malformed.findings.map((finding) => [finding.code, finding.severity])).toEqual([['resolution-rejected', 'warning']]);
    const badConventions = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1,
      conventions: { handlerWrappers: [{ module: '../outside.js', export: 'query' }] },
      tools: { 'GET /api/tasks': {} },
    })));
    expect(badConventions.resolutions.conventions).toEqual(EMPTY_CONVENTIONS);
    expect(badConventions.resolutions.entries.size).toBe(1);
    expect(badConventions.findings.map((finding) => finding.subjectRef)).toEqual(['conventions']);
  });

  it('accepts JSON Schema entries and strips the meta-schema', () => {
    const result = validateResolutionEntry({
      stableKey: 'PATCH /api/tasks/:id',
      raw: {
        interfaceDigest: DIGEST,
        origin: 'agent',
        model: 'codex',
        input: { jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...objectSchema({ id: { type: 'string' }, title: { type: 'string' } }) } },
      },
    });
    expect(result.findings).toEqual([]);
    expect(result.entry?.input?.jsonSchema).toEqual(objectSchema({ id: { type: 'string' }, title: { type: 'string' } }));
    expect(result.entry?.origin).toBe('agent');
  });

  it.each([
    ['a non-object input', { interfaceDigest: DIGEST, input: { jsonSchema: { type: 'string' } } }],
    ['open additional properties', { interfaceDigest: DIGEST, input: { jsonSchema: { type: 'object', properties: { title: {} } } } }],
    ['an oversized schema', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: { description: 'x'.repeat(33_000) } }) } }],
    ['an unknown keyword', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: { type: 'string', looksLike: 'x' } }) } }],
    ['secret-looking content', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: { description: `sk-or-v1-${'a'.repeat(32)}` } }) } }],
    ['a missing interface digest', { input: { jsonSchema: objectSchema({ title: {} }) } }],
    ['both schema forms', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({}), schemaRef: { module: 'src/a.ts', export: 'a' } } }],
    ['pattern-matched keys beside properties', { interfaceDigest: DIGEST, input: { jsonSchema: { ...objectSchema({ title: {} }), patternProperties: { '^x-': { type: 'string' } } } } }],
    ['pattern-matched keys without properties', { interfaceDigest: DIGEST, input: { jsonSchema: { type: 'object', patternProperties: { '^.*$': {} }, additionalProperties: false } } }],
  ])('rejects %s', (_label, raw) => {
    const result = validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw });
    expect(result.entry).toBeUndefined();
    expect(result.findings.map((finding) => finding.code)).toEqual(['resolution-rejected']);
  });

  it('names patternProperties as the reason', () => {
    const jsonSchema = { ...objectSchema({ title: {} }), patternProperties: { '^x-': { type: 'string' } } };
    const result = validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw: { interfaceDigest: DIGEST, input: { jsonSchema } } });
    expect(result.entry).toBeUndefined();
    expect(result.findings[0]?.message).toContain('input schemas may not use patternProperties');
  });

  it('leaves the input keys to the interface check, which decides first whether the entry is stale', () => {
    // contract-tiers compares interfaceDigest, then calls inputEvidenceProblem for a current entry.
    const result = validateResolutionEntry({
      stableKey: 'PATCH /api/tasks/:id',
      raw: { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: {}, removedLater: {} }) } },
    });
    expect(result.findings).toEqual([]);
    expect(result.entry?.input?.jsonSchema).toEqual(objectSchema({ title: {}, removedLater: {} }));
  });

  it('accepts schema references', async () => {
    const ref = validateResolutionEntry({
      stableKey: 'POST /api/tasks',
      raw: { interfaceDigest: DIGEST, input: { schemaRef: { module: 'src/lib/schemas.ts', export: 'createTask' } } },
    });
    expect(ref.entry?.input?.schemaRef).toEqual({ module: 'src/lib/schemas.ts', export: 'createTask', property: [] });
    const { resolutions } = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': { interfaceDigest: DIGEST, origin: 'agent', model: 'claude-code' } },
    })));
    expect(resolutionOrigin(resolutions, 'POST /api/tasks')).toBe('agent');
    expect(resolutionOrigin(resolutions, 'GET /api/none')).toBeUndefined();
  });

  it.each([
    ['an unknown field', { interfaceDigest: DIGEST, notes: 'x' }, 'does not match the entry schema'],
    ['an agent entry without its model', { interfaceDigest: DIGEST, origin: 'agent' }, 'does not match the entry schema at model'],
    ['a provider key prefix', { interfaceDigest: DIGEST, origin: 'agent', model: 'sk-or-v1' }, 'provider key prefix'],
  ])('rejects %s with a reason', (_label, raw, reason) => {
    const result = validateResolutionEntry({ stableKey: 'POST /api/tasks', raw });
    expect(result.entry).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ code: 'resolution-rejected', severity: 'warning' });
    expect(result.findings[0]?.message).toContain(reason);
  });

  it('lets effects raise the risk but never lower it below the code', () => {
    const raw = (effect: string) => ({ interfaceDigest: DIGEST, effect });
    const check = (effect: string) => validateResolutionEntry({
      stableKey: 'POST /api/tasks/:id/archive', raw: raw(effect), codeRiskClass: 'write',
    });
    expect(check('destructive').entry?.effect).toBe('destructive');
    expect(check('write').entry?.effect).toBe('write');
    expect(check('read').entry).toBeUndefined();
    expect(check('read').findings[0]?.message).toContain('would lower the risk below write');
  });

  it('keeps a reviewed entry only while its lock matches', () => {
    const reviewed = ResolutionEntrySchema.parse({
      interfaceDigest: DIGEST, model: 'codex', input: { jsonSchema: objectSchema({ id: {}, title: {} }) },
    });
    const locked = { ...reviewed, locked: resolutionLockDigest(reviewed) };
    expect(validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw: locked }).entry?.locked)
      .toBe(locked.locked);
    const edited = { ...locked, input: { jsonSchema: objectSchema({ id: {}, title: { type: 'string' } }) } };
    const result = validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw: edited });
    expect(result.entry).toBeUndefined();
    expect(result.findings[0]?.message).toContain('was changed after review');
    expect(validateResolutionEntry({
      stableKey: 'PATCH /api/tasks/:id', raw: { ...locked, origin: 'agent' },
    }).findings[0]?.message).toContain('at locked');
  });
});

describe('inputEvidenceProblem', () => {
  const read = { pathParams: [], queryKeys: ['q'], bodyKeys: ['title'] } as const;

  it.each([
    ['an unbacked key', objectSchema({ q: {}, title: {}, secretFlag: {} }), read, 'input keys without code evidence: secretFlag'],
    ['a dropped query parameter', objectSchema({ title: {} }), read, 'the input schema drops parameters the handler reads: q'],
    ['a dropped body field', objectSchema({ q: {} }), read, 'the input schema drops parameters the handler reads: title'],
    ['a dropped query parameter beside an opaque body', objectSchema({ anything: {} }), { ...read, bodyKeys: 'opaque' as const }, 'the input schema drops parameters the handler reads: q'],
  ])('names %s', (_label, schema, keys, problem) => {
    expect(inputEvidenceProblem(schema, keys)).toBe(problem);
  });

  it('admits path parameters and any body key of an opaque body', () => {
    expect(inputEvidenceProblem(objectSchema({ id: {}, title: {} }), evidence)).toBeUndefined();
    expect(inputEvidenceProblem(objectSchema({ anything: {} }), { pathParams: [], queryKeys: [], bodyKeys: 'opaque' })).toBeUndefined();
  });
});
