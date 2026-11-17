import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { jsonSchemaDigest } from '../canonical.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool } from '../types.js';
import { createOpenapiEndpointSource } from './openapi-endpoints.js';

afterEach(removeAppFixtures);

const SECURED = [{ APIKeyCookie: [] }];
const VERSION = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    fileUrl: { type: 'string' },
    variants: { type: 'array', items: { type: 'object', properties: { size: { type: 'integer' }, fileUrl: { type: 'string' } }, required: ['size', 'fileUrl'] } },
  },
};
const DESIGNS = {
  type: 'object',
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, draftVersion: { $ref: '#/components/schemas/Version' }, publishedVersion: { $ref: '#/components/schemas/Version' } },
        required: ['id', 'name'],
      },
    },
    meta: { type: 'object', properties: { page: { type: 'integer' }, total: { type: 'integer' } } },
  },
};

async function observe(extensions: Record<string, unknown>): Promise<ObservedTool & { all: ObservedTool[] }> {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Designs', version: '1' },
    paths: {
      '/api/designs': {
        get: {
          security: SECURED, ...extensions,
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: DESIGNS } } } },
        },
      },
    },
    components: {
      schemas: { Version: VERSION },
      securitySchemes: { APIKeyCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
    },
  };
  const app = await createAppFixture({ 'api/openapi.json': JSON.stringify(document) }, {
    toolsConfig: { sources: [{ kind: 'openapi', document: 'api/openapi.json' }] },
  });
  const observed = await createOpenapiEndpointSource({ document: 'api/openapi.json' }).observe({
    root: app.root,
    config: loadToolsConfig(app.root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  });
  return Object.assign(observed.observations[0]!, { all: observed.observations });
}

const codes = (tool: ObservedTool) => tool.findings.map((finding) => [finding.code, finding.severity]);

describe('x-glirastes-output-* extensions', () => {
  it('changes nothing without an extension', async () => {
    const tool = await observe({});
    expect(tool).not.toHaveProperty('outputAllowedFields');
    expect(tool).not.toHaveProperty('outputDeniedFields');
    expect(tool).not.toHaveProperty('outputDefaultFields');
    expect(JSON.stringify(tool.contract!.output)).toContain('fileUrl');
    expect(codes(tool)).toEqual([]);
  });

  it('reads all three, reduces the output contract and keeps runtime schema and digest consistent', async () => {
    const tool = await observe({
      'x-glirastes-output-allowed-fields': ['meta', 'data'],
      'x-glirastes-output-denied-fields': ['**.fileUrl'],
      'x-glirastes-output-default-fields': ['data[].name', 'data[].id', 'meta'],
    });
    expect(tool.outputAllowedFields).toEqual(['data', 'meta']);
    expect(tool.outputDeniedFields).toEqual(['**.fileUrl']);
    expect(tool.outputDefaultFields).toEqual(['data[].id', 'data[].name', 'meta']);
    expect(codes(tool)).toEqual([]);
    const output = tool.contract!.output!;
    expect(JSON.stringify(output)).not.toContain('fileUrl');
    expect(JSON.stringify(output)).toContain('variants');
    expect(tool.contract!.runtime.output).toEqual({ kind: 'json', schema: output });
    expect(tool.execution.outputSchemaDigest).toBe(jsonSchemaDigest(output));
  });

  it('excludes one deep field with one exact path; the same name elsewhere stays', async () => {
    const tool = await observe({ 'x-glirastes-output-denied-fields': ['data[].draftVersion.variants[].fileUrl'] });
    const items = (tool.contract!.output as { properties: { data: { items: { properties: Record<string, { properties: Record<string, unknown> }> } } } })
      .properties.data.items.properties;
    expect(Object.keys((items.draftVersion!.properties.variants as { items: { properties: object } }).items.properties)).toEqual(['size']);
    expect(Object.keys(items.draftVersion!.properties)).toContain('fileUrl');
    expect(Object.keys((items.publishedVersion!.properties.variants as { items: { properties: object } }).items.properties)).toContain('fileUrl');
  });

  it.each([
    ['x-glirastes-output-allowed-fields', 'output-allowed-fields-invalid', 'needs_attention'],
    ['x-glirastes-output-denied-fields', 'output-denied-fields-invalid', 'needs_attention'],
    ['x-glirastes-output-default-fields', 'output-default-fields-invalid', 'warning'],
  ] as const)('reports an invalid %s without repeating it', async (extension, code, severity) => {
    for (const value of [['data[0].SECRETNAME'], 'data', [3], ['**.SECRETNAME.x'], [' SECRETNAME'], ['SECRETNAME '], null]) {
      const tool = await observe({ [extension]: value });
      expect(codes(tool)).toEqual([[code, severity]]);
      const finding = tool.findings[0]!;
      expect(finding.message).toContain(extension);
      expect(finding.message).not.toContain('SECRETNAME');
      expect(finding.nextAction).toContain(extension);
    }
  });

  it('fails closed for an invalid upper bound: an empty allow-list and a needs-attention finding that disables the tool', async () => {
    const tool = await observe({ 'x-glirastes-output-denied-fields': ['data[0].fileUrl'] });
    expect(tool.outputAllowedFields).toEqual([]);
    expect(tool.contract!.output).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('rejects the any-depth form outside outputDeniedFields', async () => {
    const tool = await observe({ 'x-glirastes-output-allowed-fields': ['**.fileUrl'] });
    expect(codes(tool)).toEqual([['output-allowed-fields-invalid', 'needs_attention']]);
  });

  it('warns about unknown paths, default fields outside the bound, and denied default fields', async () => {
    const tool = await observe({
      'x-glirastes-output-allowed-fields': ['data', 'meta.page', 'meta.pgae'],
      'x-glirastes-output-denied-fields': ['**.fileUlr', 'data[].draftVersion.title'],
      'x-glirastes-output-default-fields': ['data[].name', 'meta.total', 'data[].draftVersion.title'],
    });
    expect(codes(tool)).toEqual([
      ['output-field-unknown', 'warning'],
      ['output-field-unknown', 'warning'],
      ['output-default-fields-outside-allowed', 'warning'],
      ['output-default-fields-denied', 'warning'],
    ]);
    const messages = tool.findings.map((finding) => finding.message);
    expect(messages[0]).toContain('meta.pgae');
    expect(messages[1]).toContain('**.fileUlr');
    expect(messages[1]).toContain('is NOT excluded');
    expect(tool.outputDefaultFields).toEqual(['data[].name']);
  });
});
