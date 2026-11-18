import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { resolveToolEntities } from '../entity-declarations.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool } from '../types.js';
import { createOpenapiEndpointSource } from './openapi-endpoints.js';

afterEach(removeAppFixtures);

const SECURED = [{ APIKeyCookie: [] }];

async function observe(
  playlist: Record<string, unknown>,
  operation: Record<string, unknown> = {},
  parameterSchema: Record<string, unknown> = { type: 'integer' },
): Promise<ObservedTool> {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Playlists', version: '1' },
    paths: {
      '/api/owners/{owner_id}/playlists': {
        get: {
          security: SECURED,
          parameters: [{ name: 'owner_id', in: 'path', required: true, schema: parameterSchema }],
          ...operation,
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaylistPage' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Playlist: { type: 'object', properties: { playlist_id: { type: 'integer' }, displayName: { type: 'string' } }, ...playlist },
        PlaylistPage: { type: 'object', properties: { playlists: { type: 'array', items: { $ref: '#/components/schemas/Playlist' } } } },
      },
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
  return observed.observations[0]!;
}

const entityCodes = (tool: ObservedTool) => tool.findings.filter((finding) => finding.code.startsWith('entity')).map((finding) => finding.code);

describe('entity declarations of an OpenAPI operation', () => {
  it('declares nothing without an extension: only the response sites are known', async () => {
    const tool = await observe({});
    expect(tool.entities).toEqual({
      sites: [
        { path: '', type: 'playlist-page', fields: ['playlists'] },
        { path: 'playlists[]', type: 'playlist', fields: ['playlist_id', 'displayName'] },
      ],
    });
    expect(entityCodes(tool)).toEqual([]);
  });

  it('reads x-glirastes-entity on a $ref component, typed by the component name, at its result path', async () => {
    const tool = await observe({ 'x-glirastes-entity': { id: 'playlist_id', name: 'displayName' } });
    expect(tool.entities?.schema?.output).toEqual([{ id: 'playlist_id', name: 'displayName', type: 'playlist', path: 'playlists[]' }]);
  });

  it('reads x-glirastes-entities and x-glirastes-entity-ref on a parameter schema (FastAPI json_schema_extra)', async () => {
    const tool = await observe(
      {},
      { 'x-glirastes-entities': [{ type: 'playlist', id: 'playlist_id', path: 'playlists[]' }] },
      { type: 'integer', 'x-glirastes-entity-ref': { type: 'owner', role: 'parent' } },
    );
    expect(tool.entities?.operation).toMatchObject({
      output: [{ type: 'playlist', id: 'playlist_id', path: 'playlists[]' }],
      input: [{ type: 'owner', role: 'parent', args: 'owner_id' }],
    });
    const resolved = resolveToolEntities({
      tools: [{
        stableKey: tool.execution.stableKey,
        definitionId: tool.execution.definitionId,
        modelName: 'x',
        params: tool.contract!.params,
        ...(tool.entities ? { entities: tool.entities } : {}),
      }],
    });
    expect(resolved.findings).toEqual([]);
    expect(resolved.byKey.get(tool.execution.stableKey)?.inputEntities).toEqual([{ type: 'owner', role: 'parent', args: 'owner_id' }]);
  });

  it('reports invalid declarations without their values and keeps the tool', async () => {
    const tool = await observe(
      { 'x-glirastes-entity': { id: '' } },
      { 'x-glirastes-entities': 'SECRETVALUE' },
      { type: 'integer', 'x-glirastes-entity-ref': { type: 'Owner SECRETVALUE' } },
    );
    expect(entityCodes(tool).sort()).toEqual(['entity-declaration-invalid', 'entity-declaration-invalid', 'entity-ref-invalid']);
    expect(JSON.stringify(tool.findings)).not.toContain('SECRETVALUE');
    expect(tool.findings.every((finding) => finding.severity !== 'needs_attention')).toBe(true);
  });
});
