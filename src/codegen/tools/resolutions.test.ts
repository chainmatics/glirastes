import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_CONVENTIONS,
  loadToolResolutions,
  resolutionOrigin,
  validateResolutionEntry,
} from './resolutions.js';

const roots: string[] = [];
const DIGEST = `sha256:${'R'.repeat(43)}`;
const evidence = { pathParams: ['id'], queryKeys: ['q'], bodyKeys: ['title'] as ReadonlyArray<string> | 'opaque' };

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

  it('accepts backed JSON Schema entries and strips the meta-schema', () => {
    const result = validateResolutionEntry({
      stableKey: 'PATCH /api/tasks/:id',
      raw: {
        interfaceDigest: DIGEST,
        origin: 'agent',
        input: { jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...objectSchema({ id: { type: 'string' }, title: { type: 'string' } }) } },
      },
      evidence,
    });
    expect(result.findings).toEqual([]);
    expect(result.entry?.input?.jsonSchema).toEqual(objectSchema({ id: { type: 'string' }, title: { type: 'string' } }));
    expect(result.entry?.origin).toBe('agent');
  });

  it.each([
    ['unbacked keys', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: {}, secretFlag: {} }) } }],
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
    const result = validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw, evidence });
    expect(result.entry).toBeUndefined();
    expect(result.findings.map((finding) => finding.code)).toEqual(['resolution-rejected']);
  });

  it('names patternProperties as the reason, also for an opaque body', () => {
    const jsonSchema = { ...objectSchema({ title: {} }), patternProperties: { '^x-': { type: 'string' } } };
    for (const bodyKeys of [['title'], 'opaque'] as const) {
      const result = validateResolutionEntry({
        stableKey: 'PATCH /api/tasks/:id',
        raw: { interfaceDigest: DIGEST, input: { jsonSchema } },
        evidence: { ...evidence, bodyKeys },
      });
      expect(result.entry).toBeUndefined();
      expect(result.findings[0]?.message).toContain('input schemas may not use patternProperties');
    }
  });

  it('allows any body keys when the body is opaque and accepts schema references', async () => {
    expect(validateResolutionEntry({
      stableKey: 'POST /api/tasks',
      raw: { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ anything: {} }) } },
      evidence: { pathParams: [], queryKeys: [], bodyKeys: 'opaque' },
    }).entry).toBeDefined();
    const ref = validateResolutionEntry({
      stableKey: 'POST /api/tasks',
      raw: { interfaceDigest: DIGEST, input: { schemaRef: { module: 'src/lib/schemas.ts', export: 'createTask' } } },
      evidence,
    });
    expect(ref.entry?.input?.schemaRef).toEqual({ module: 'src/lib/schemas.ts', export: 'createTask', property: [] });
    const { resolutions } = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': { interfaceDigest: DIGEST, origin: 'agent' } },
    })));
    expect(resolutionOrigin(resolutions, 'POST /api/tasks')).toBe('agent');
    expect(resolutionOrigin(resolutions, 'GET /api/none')).toBeUndefined();
  });
});
