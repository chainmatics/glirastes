import { describe, expect, it } from 'vitest';
import { jsonSchemaDigest } from './canonical.js';
import {
  contractEntryItem,
  OPAQUE_SCHEMA_DIGEST,
  probeItemFor,
  probeKey,
  resolveEndpointContract,
  type EndpointEvidence,
  type ResolveEndpointContractInput,
} from './contract-tiers.js';
import type { ProbedContractEntry, ProbedSchema, SchemaProbeItem, SchemaProbeResult } from './schema-probe.js';
import type { SchemaBindingRef, ToolContract } from './types.js';

const digest = (character: string) => `sha256:${character.repeat(43)}`;
const NOTE = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const SCHEMAS: SchemaBindingRef = { module: 'src/app/api/notes/schemas.ts', export: 'createNote', property: [] };
const CONTRACT_MODULE = 'src/app/api/notes/contract.ts';

const probed = (json: Record<string, unknown> | null, value: string, description: string | null = null): ProbedSchema => ({
  ok: true, kind: 'schema', digest: value, jsonSchema: json, description,
});
const probes = (...entries: Array<[SchemaProbeItem, SchemaProbeResult]>) => new Map(
  entries.map(([item, result]) => [probeKey(item), result] as const),
);
const evidence = (overrides: Partial<EndpointEvidence> = {}): EndpointEvidence => ({
  schemaUses: [], queryKeys: [], repeatedQueryKeys: [], bodyKeys: [], readsBody: false, ...overrides,
});
const bodyUse = { role: 'body' as const, via: 'parse' as const, binding: SCHEMAS };
const entry = (overrides: Partial<ProbedContractEntry> = {}): ProbedContractEntry => ({
  ok: true,
  kind: 'contract-entry',
  input: probed(NOTE, digest('C')),
  output: probed({ type: 'object', properties: { id: { type: 'string' } } }, digest('O')),
  description: 'Create a note',
  effect: 'write',
  id: 'notes.add',
  module: 'notes',
  usageHints: ['Add a note for the caller'],
  presentation: null,
  moduleDigest: digest('M'),
  ...overrides,
});

function resolve(overrides: Partial<ResolveEndpointContractInput>) {
  return resolveEndpointContract({
    stableKey: 'POST /api/notes',
    method: 'POST',
    path: '/api/notes',
    pathParams: [],
    evidence: evidence(),
    probes: new Map(),
    ...overrides,
  });
}

describe('resolveEndpointContract', () => {
  it('uses a native body schema with an inferred output (tier 1)', () => {
    const inferred = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const result = resolve({
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'), 'Create a note for the caller')]),
      inferredOutput: inferred,
    });
    expect(result.findings).toEqual([]);
    expect(result.contract).toMatchObject({
      source: 'native',
      loadBearing: true,
      input: NOTE,
      output: inferred,
      params: { path: [], query: [], body: ['title'] },
      runtime: { input: { kind: 'module-export', ...SCHEMAS }, output: { kind: 'json', schema: inferred } },
    });
    expect(result.inputSchemaDigest).toBe(digest('N'));
    expect(result.outputSchemaDigest).toBe(jsonSchemaDigest(inferred));
    expect(result.prose.schemaDescription).toBe('Create a note for the caller');
  });

  it('warns about an opaque output', () => {
    const result = resolve({
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
    });
    expect(result.outputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([['output-contract-opaque', 'warning']]);
  });

  it('combines path parameters with the body schema', () => {
    const result = resolve({
      stableKey: 'PATCH /api/notes/:id', method: 'PATCH', path: '/api/notes/:id', pathParams: ['id'],
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
    });
    const combined = {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: ['id', 'title'],
      additionalProperties: false,
    };
    expect(result.contract?.input).toEqual(combined);
    expect(result.contract?.runtime.input).toEqual({ kind: 'json', schema: combined });
    expect(result.inputSchemaDigest).toBe(jsonSchemaDigest(combined));
    expect(result.contract?.params).toEqual({ path: ['id'], query: [], body: ['title'] });
  });

  it.each([
    ['a parameter collision', { pathParams: ['title'], path: '/api/notes/:title', stableKey: 'PATCH /api/notes/:title', method: 'PATCH' as const }, [[probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]], [bodyUse], 'parameter-collision'],
    ['an unexported schema', {}, [], [{ role: 'body' as const, via: 'parse' as const, problem: 'not-exported' as const }], 'schema-not-exported'],
    ['an unloadable schema', {}, [[probeItemFor(SCHEMAS, 'input'), { ok: false as const, reason: 'import-failed' as const }]], [bodyUse], 'schema-module-unloadable'],
    ['a schema with secret-looking content', {}, [[probeItemFor(SCHEMAS, 'input'), { ok: false as const, reason: 'content-rejected' as const }]], [bodyUse], 'schema-content-rejected'],
    ['a query schema on a write method', {}, [[probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]], [{ ...bodyUse, role: 'query' as const }], 'input-role-unsupported'],
  ] as const)('reports %s as needing attention', (_label, route, probeEntries, uses, code) => {
    const result = resolve({
      ...route,
      evidence: evidence({ schemaUses: [...uses], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes(...probeEntries.map(([item, outcome]) => [item, outcome] as [SchemaProbeItem, SchemaProbeResult])),
    });
    expect(result.contract).toBeUndefined();
    expect(result.inputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([[code, 'needs_attention']]);
  });

  it('lets a current resolution rescue an unclear native role, but not a stale one', () => {
    const unclear = evidence({ schemaUses: [{ role: 'unclear', via: 'parse', binding: SCHEMAS }], readsBody: true, bodyKeys: 'opaque' });
    const first = resolve({ evidence: unclear });
    expect(first.findings.map((finding) => finding.code)).toEqual(['input-role-unclear']);
    const rescued = resolve({
      evidence: unclear,
      resolution: { origin: 'agent', interfaceDigest: first.interfaceDigest, input: { jsonSchema: NOTE } },
    });
    expect(rescued.contract).toMatchObject({ source: 'resolution', loadBearing: false, input: NOTE });
    expect(rescued.inputSchemaDigest).toBe(jsonSchemaDigest(NOTE));
    const stale = resolve({
      evidence: unclear,
      resolution: { origin: 'agent', interfaceDigest: digest('S'), input: { jsonSchema: NOTE } },
    });
    expect(stale.contract).toBeUndefined();
    expect(stale.findings.map((finding) => finding.code)).toEqual(['contract-stale']);
  });

  it('uses a load-bearing contract module with its metadata (tier 2)', () => {
    const result = resolve({
      evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
      contractModule: { module: CONTRACT_MODULE, loadBearing: true, result: entry() },
    });
    expect(result.contract).toMatchObject({
      source: 'contract-module',
      loadBearing: true,
      runtime: {
        input: { kind: 'module-export', module: CONTRACT_MODULE, export: 'contract', property: ['POST', 'input'] },
        output: { kind: 'module-export', module: CONTRACT_MODULE, export: 'contract', property: ['POST', 'output'] },
      },
    });
    expect(result.contract?.binding).toBeUndefined();
    expect(result).toMatchObject({
      explicitId: 'notes.add',
      declaredEffect: 'write',
      inputSchemaDigest: digest('C'),
      outputSchemaDigest: digest('O'),
      prose: { contractDescription: 'Create a note', module: 'notes', usageHints: ['Add a note for the caller'] },
    });
  });

  it('binds descriptive contract modules to the interface and keeps a stale binding', () => {
    const base = { evidence: evidence({ readsBody: true, bodyKeys: ['title'] }) };
    const fresh = resolve({ ...base, contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry() } });
    expect(fresh.contract?.binding).toEqual({ interfaceDigest: fresh.interfaceDigest, contractModuleDigest: digest('M') });
    const previous: ToolContract = { ...fresh.contract!, binding: { interfaceDigest: digest('X'), contractModuleDigest: digest('M') } };
    const stale = resolve({ ...base, previousContract: previous, contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry() } });
    expect(stale.findings.map((finding) => [finding.code, finding.severity])).toEqual([['contract-stale', 'needs_attention']]);
    expect(stale.contract?.binding).toEqual(previous.binding);
    const updated = resolve({
      ...base,
      previousContract: previous,
      contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry({ moduleDigest: digest('L') }) },
    });
    expect(updated.findings).toEqual([]);
    expect(updated.contract?.binding).toEqual({ interfaceDigest: updated.interfaceDigest, contractModuleDigest: digest('L') });
  });

  it('keeps contract metadata when the native schema wins', () => {
    const result = resolve({
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
      contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry() },
    });
    expect(result.contract?.source).toBe('native');
    expect(result).toMatchObject({ explicitId: 'notes.add', declaredEffect: 'write', outputSchemaDigest: digest('O') });
  });

  describe('invalid contract metadata', () => {
    const codes = (result: ReturnType<typeof resolve>) => result.findings.map((finding) => [finding.code, finding.severity]);
    const withModule = (overrides: Partial<ProbedContractEntry>, loadBearing = true) => ({
      module: CONTRACT_MODULE, loadBearing, result: entry(overrides),
    });

    it('makes a mistyped effect visible and fails closed for the tool', () => {
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
        contractModule: withModule({ effect: null, invalidFields: ['effect'] }),
      });
      expect(result.contract?.source).toBe('contract-module');
      expect(result.declaredEffect).toBeUndefined();
      expect(codes(result)).toEqual([['contract-effect-invalid', 'needs_attention']]);
      expect(result.findings[0]?.message).toContain(CONTRACT_MODULE);
      expect(result.findings[0]?.message).toContain('effect');
    });

    it('warns about an invalid presentation and leaves it out of the prose', () => {
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
        contractModule: withModule({ presentation: null, invalidFields: ['presentation'] }),
      });
      expect(result.contract?.source).toBe('contract-module');
      expect(result.prose).not.toHaveProperty('presentation');
      expect(codes(result)).toEqual([['contract-presentation-invalid', 'warning']]);
      expect(result.findings[0]?.message).toContain(CONTRACT_MODULE);
    });

    it('reports both fields when both are invalid', () => {
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
        contractModule: withModule({ effect: null, presentation: null, invalidFields: ['effect', 'presentation'] }),
      });
      expect(codes(result)).toEqual([
        ['contract-effect-invalid', 'needs_attention'], ['contract-presentation-invalid', 'warning'],
      ]);
    });

    it('still reports them when the native schema wins over a descriptive contract module', () => {
      const result = resolve({
        evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
        probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
        contractModule: withModule({ effect: null, invalidFields: ['effect'] }, false),
      });
      expect(result.contract?.source).toBe('native');
      expect(codes(result)).toEqual([['contract-effect-invalid', 'needs_attention']]);
    });

    it('still reports them when the contract module itself cannot be composed', () => {
      const result = resolve({
        stableKey: 'POST /api/notes/:id',
        path: '/api/notes/:id',
        pathParams: ['id'],
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
        contractModule: withModule({ input: probed(null, digest('C')), effect: null, invalidFields: ['effect'] }),
      });
      expect(result.contract).toBeUndefined();
      expect(codes(result)).toEqual([
        ['schema-json-unavailable', 'needs_attention'], ['contract-effect-invalid', 'needs_attention'],
      ]);
    });

    it('reports nothing for a contract module whose metadata is valid', () => {
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
        contractModule: withModule({ invalidFields: [] }),
      });
      expect(result.findings).toEqual([]);
    });
  });

  describe('secret-looking schema content', () => {
    const rejected = { ok: false as const, reason: 'content-rejected' as const };
    const codes = (result: ReturnType<typeof resolve>) => result.findings.map((finding) => [finding.code, finding.severity]);

    it('fails closed with an opaque output when the output schema is rejected', () => {
      const outputBinding: SchemaBindingRef = { module: 'src/app/api/notes/schemas.ts', export: 'noteResponse', property: [] };
      const result = resolve({
        evidence: evidence({
          schemaUses: [bodyUse, { role: 'output', via: 'parse', binding: outputBinding }],
          readsBody: true,
          bodyKeys: 'opaque',
        }),
        probes: probes(
          [probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))],
          [probeItemFor(outputBinding, 'output'), rejected],
        ),
        inferredOutput: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      });
      expect(result.contract?.output).toEqual({});
      expect(result.contract?.runtime.output).toEqual({ kind: 'json', schema: {} });
      expect(result.outputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
    });

    it('fails closed when a tool-resolutions.json output schema reference is rejected', () => {
      const unresolved = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
      const outputRef: SchemaBindingRef = { module: 'src/app/api/notes/schemas.ts', export: 'noteResponse', property: [] };
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }),
        probes: probes([probeItemFor(outputRef, 'output'), rejected]),
        resolution: {
          origin: 'agent',
          interfaceDigest: unresolved.interfaceDigest,
          input: { jsonSchema: NOTE },
          output: { schemaRef: outputRef },
        },
      });
      expect(result.contract?.source).toBe('resolution');
      expect(result.contract?.output).toEqual({});
      expect(result.outputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
    });

    it('reports a rejected contract module that is the only candidate', () => {
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
        contractModule: { module: CONTRACT_MODULE, loadBearing: true, result: rejected },
      });
      expect(result.contract).toBeUndefined();
      expect(result.inputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
      expect(result.findings[0]?.message).toContain(CONTRACT_MODULE);
    });

    it('still reports a rejected contract module when the native schema wins', () => {
      const result = resolve({
        evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
        probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
        contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: rejected },
      });
      expect(result.contract?.source).toBe('native');
      expect(codes(result)).toEqual([
        ['output-contract-opaque', 'warning'], ['schema-content-rejected', 'needs_attention'],
      ]);
    });

    it('reports a rejected tool-resolutions.json input schema reference', () => {
      const unresolved = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }),
        probes: probes([probeItemFor(SCHEMAS, 'input'), rejected]),
        resolution: { origin: 'agent', interfaceDigest: unresolved.interfaceDigest, input: { schemaRef: SCHEMAS } },
      });
      expect(result.contract).toBeUndefined();
      expect(codes(result)).toEqual([['schema-content-rejected', 'needs_attention']]);
    });

    it('does not flag a missing contract module', () => {
      const result = resolve({
        evidence: evidence({ readsBody: true, bodyKeys: ['title'] }),
        contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: { ok: false, reason: 'missing' } },
      });
      expect(result.contract?.source).toBe('derived');
      expect(result.findings.map((finding) => finding.code)).toEqual(['output-contract-opaque', 'contract-derived']);
    });
  });

  it('derives a weak contract from query and body keys (tier 5)', () => {
    const list = resolve({
      stableKey: 'GET /api/notes', method: 'GET',
      evidence: evidence({ queryKeys: ['q', 'status'], repeatedQueryKeys: ['status'] }),
    });
    expect(list.contract?.input).toEqual({
      type: 'object',
      properties: { q: { type: 'string' }, status: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    });
    expect(list.contract?.source).toBe('derived');
    expect(list.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['output-contract-opaque', 'warning'], ['contract-derived', 'warning'],
    ]);
    const create = resolve({ evidence: evidence({ readsBody: true, bodyKeys: ['title'] }) });
    expect(create.contract?.params).toEqual({ path: [], query: [], body: ['title'] });
    const misuse = resolve({ stableKey: 'GET /api/notes', method: 'GET', evidence: evidence({ readsBody: true, bodyKeys: ['title'] }) });
    expect(misuse.findings.map((finding) => finding.code)).toEqual(['input-role-unsupported']);
  });

  it('needs attention when nothing describes an opaque body (tier 6)', () => {
    const result = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
    expect(result.contract).toBeUndefined();
    expect(result.outputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(result.findings.map((finding) => finding.code)).toEqual(['input-contract-unresolved']);
  });

  it('ignores cosmetic handler text when structured evidence exists', () => {
    const shared = { schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' as const };
    expect(resolve({ evidence: evidence({ ...shared, normalizedText: 'a' }) }).interfaceDigest)
      .toBe(resolve({ evidence: evidence({ ...shared, normalizedText: 'b' }) }).interfaceDigest);
    expect(contractEntryItem(CONTRACT_MODULE, 'POST')).toEqual({
      kind: 'contract-entry', io: 'input', module: CONTRACT_MODULE, export: 'contract', property: ['POST'],
    });
  });
});
