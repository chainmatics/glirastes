import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { modelFacingToolName } from '../../../runtime/local-tool-bindings.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { resolveApprovalSubjects } from '../approval-subject-declarations.js';
import { loadToolsConfig } from '../config.js';
import { resolveToolEntities } from '../entity-declarations.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool } from '../types.js';
import { createOpenapiEndpointSource } from './openapi-endpoints.js';

afterEach(removeAppFixtures);

const SECURED = [{ APIKeyCookie: [] }];
const ok = (ref: string) => ({
  '200': { description: 'Successful Response', content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } },
});
/** A FastAPI path parameter: numeric, with a title. */
const pathParam = (name: string, schema: Record<string, unknown> = { type: 'integer' }) => ({
  name, in: 'path', required: true, schema: { title: name, ...schema },
});

/** A FastAPI-shaped export: `openapi_extra` puts the extensions on the operation itself. */
function fastapiDocument(impactExtra: Record<string, unknown>) {
  return {
    openapi: '3.1.0',
    info: { title: 'FastAPI', version: '0.1.0' },
    paths: {
      '/playlists': {
        get: {
          operationId: 'list_playlists_playlists_get',
          security: SECURED,
          parameters: [],
          'x-glirastes-entities': [{ type: 'playlist', id: 'playlist_id', name: 'title', path: 'playlists[]' }],
          // The whole list, so a missing id does not exist.
          'x-glirastes-entity-lookup': { type: 'playlist', params: {}, complete: true },
          responses: ok('PlaylistPage'),
        },
      },
      '/playlists/:playlist_id': {
        get: {
          operationId: 'get_playlist_playlists__playlist_id__get',
          security: SECURED,
          parameters: [pathParam('playlist_id')],
          'x-glirastes-entities': [{ type: 'playlist', id: 'playlist_id', name: 'title', path: '' }],
          responses: ok('Playlist'),
        },
        delete: {
          operationId: 'delete_playlist_playlists__playlist_id__delete',
          security: SECURED,
          parameters: [pathParam('playlist_id', { type: 'integer', 'x-glirastes-entity-ref': { type: 'playlist' } })],
          'x-glirastes-approval-subject': {
            preview: {
              tool: 'playlists_impact',
              params: { playlist_id: 'playlist_id' },
              fields: [{ path: 'impact.devices', label: { en: 'Affected devices', de: 'Betroffene Geräte' }, format: 'count' }],
            },
            onUnavailable: 'block',
          },
          responses: ok('Playlist'),
        },
      },
      '/playlists/{playlist_id}/impact': {
        post: {
          operationId: 'impact_playlists__playlist_id__impact_post',
          'x-glirastes-name': 'playlists.impact',
          security: SECURED,
          parameters: [pathParam('playlist_id')],
          ...impactExtra,
          responses: ok('Impact'),
        },
      },
      '/playlists/{playlist_id}/versions/{channel}/{rev}': {
        get: {
          operationId: 'get_version',
          security: SECURED,
          parameters: [pathParam('playlist_id'), pathParam('channel', { type: 'string' }), pathParam('rev')],
          'x-glirastes-entities': [{ type: 'version', id: ['channel', 'rev'], path: '' }],
          'x-glirastes-entity-lookup': [{ type: 'version', params: { playlist_id: { ref: 'playlist' }, channel: 'channel', rev: 'rev' } }],
          responses: ok('Version'),
        },
        put: {
          operationId: 'publish_version',
          security: SECURED,
          parameters: [
            pathParam('playlist_id', { type: 'integer', 'x-glirastes-entity-ref': { type: 'playlist', role: 'parent' } }),
            pathParam('channel', { type: 'string' }),
            pathParam('rev'),
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Publish' } } } },
          'x-glirastes-name': 'versions.publish',
          responses: ok('Version'),
        },
      },
      '/channels/{key}': {
        get: {
          operationId: 'get_channel',
          security: SECURED,
          parameters: [pathParam('key', { type: 'string' })],
          'x-glirastes-entities': [{ type: 'channel', id: 'key', name: 'title', idKind: 'speaking', path: '' }],
          'x-glirastes-entity-lookup': { type: 'channel', params: { key: 'key' } },
          responses: ok('Channel'),
        },
      },
    },
    components: {
      schemas: {
        Playlist: { title: 'Playlist', type: 'object', properties: { playlist_id: { type: 'integer' }, title: { type: 'string' } } },
        PlaylistPage: { title: 'PlaylistPage', type: 'object', properties: { playlists: { type: 'array', items: { $ref: '#/components/schemas/Playlist' } } } },
        Impact: { title: 'Impact', type: 'object', properties: { impact: { type: 'object', properties: { devices: { type: 'array', items: { type: 'string' } } } } } },
        Version: { title: 'Version', type: 'object', properties: { channel: { type: 'string' }, rev: { type: 'integer' } } },
        Channel: { title: 'Channel', type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' } } },
        Publish: {
          title: 'Publish', type: 'object', required: ['note'],
          properties: { note: { type: 'string' }, channel_key: { type: 'string', 'x-glirastes-entity-ref': { type: 'channel', role: 'reference' } } },
        },
      },
      securitySchemes: { APIKeyCookie: { type: 'apiKey', in: 'cookie', name: 'session' } },
    },
  };
}

async function observe(impactExtra: Record<string, unknown>): Promise<ObservedTool[]> {
  const app = await createAppFixture({ 'api/openapi.json': JSON.stringify(fastapiDocument(impactExtra)) }, {
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
  return observed.observations;
}

function resolve(observations: ReadonlyArray<ObservedTool>) {
  const definitionId = (tool: ObservedTool) => tool.execution.definitionId;
  const entities = resolveToolEntities({
    tools: observations.map((tool) => ({
      stableKey: tool.execution.stableKey,
      definitionId: definitionId(tool),
      modelName: modelFacingToolName(definitionId(tool)),
      ...(tool.contract ? { params: tool.contract.params } : {}),
      ...(tool.entities ? { entities: tool.entities } : {}),
    })),
    // A composite key reference is declared at the app level (a parameter names one argument).
    identity: { tools: { 'versions.publish': { input: [{ type: 'version', args: ['channel', 'rev'] }] } } },
  });
  return resolveApprovalSubjects({
    tools: observations.map((tool) => {
      const method = tool.execution.executionKind === 'endpoint' ? tool.execution.method : undefined;
      const resolved = entities.byKey.get(tool.execution.stableKey);
      return {
        stableKey: tool.execution.stableKey,
        definitionId: definitionId(tool),
        modelName: modelFacingToolName(definitionId(tool)),
        ...(method ? { method } : {}),
        ...(tool.execution.executionKind === 'endpoint' ? { path: tool.execution.path } : {}),
        requiresApproval: method !== 'GET',
        ...(tool.contract ? { params: tool.contract.params } : {}),
        ...(tool.approvalDeclarations ? { declarations: tool.approvalDeclarations } : {}),
        ...(resolved?.outputEntities ? { outputEntities: resolved.outputEntities } : {}),
        ...(resolved?.inputEntities ? { inputEntities: resolved.inputEntities } : {}),
      };
    }),
  });
}

describe('approval subjects of a FastAPI OpenAPI export', () => {
  it('reads openapi_extra declarations: numeric ids, composite keys, a { ref } param, a speaking key, a complete list, a POST preview with lookupEffect read', async () => {
    const observations = await observe({ 'x-glirastes-lookup-effect': 'read' });
    const byKey = new Map(observations.map((tool) => [tool.execution.stableKey, tool] as const));
    expect(byKey.get('GET /channels/:key')?.approvalDeclarations?.operation).toMatchObject({
      entityLookup: [{ type: 'channel', params: { key: 'key' } }],
    });
    // Nothing of it is a finding of the tool itself (that would disable it).
    expect(observations.flatMap((tool) => tool.findings).filter((finding) => finding.code.startsWith('approval'))).toEqual([]);
    const resolved = resolve(observations);
    expect(resolved.findings).toEqual([]);
    expect(resolved.byKey.get('GET /playlists')).toEqual({ entityLookup: [{ type: 'playlist', params: {}, complete: true }] });
    expect(resolved.byKey.get('GET /playlists/:playlist_id/versions/:channel/:rev')).toEqual({
      entityLookup: [{ type: 'version', params: { playlist_id: { ref: 'playlist' }, channel: 'channel', rev: 'rev' } }],
    });
    expect(resolved.byKey.get('GET /channels/:key')).toEqual({ entityLookup: [{ type: 'channel', params: { key: 'key' } }] });
    expect(resolved.byKey.get('POST /playlists/:playlist_id/impact')).toEqual({ lookupEffect: 'read' });
    expect(resolved.byKey.get('DELETE /playlists/:playlist_id')?.approvalSubject).toMatchObject({
      onUnavailable: 'block',
      preview: { tool: 'playlists_impact', fields: [{ path: 'impact.devices', format: 'count' }] },
    });
  }, 30_000);

  it('drops the preview through the same POST without x-glirastes-lookup-effect and keeps the tools', async () => {
    const observations = await observe({});
    const resolved = resolve(observations);
    expect(resolved.findings.map((finding) => [finding.code, finding.subjectRef])).toEqual([
      ['approval-subject-invalid', 'DELETE /playlists/:playlist_id'],
    ]);
    expect(resolved.findings[0]!.message).toContain('playlists.impact');
    expect(resolved.byKey.get('DELETE /playlists/:playlist_id')?.approvalSubject).toEqual({ onUnavailable: 'block' });
    expect(observations.every((tool) => tool.findings.every((finding) => finding.severity !== 'needs_attention'))).toBe(true);
  }, 30_000);

  it('reports an invalid extension without its value', async () => {
    const observations = await observe({ 'x-glirastes-lookup-effect': 'SECRETVALUE', 'x-glirastes-entity-lookup': 'SECRETVALUE' });
    const impact = observations.find((tool) => tool.execution.stableKey === 'POST /playlists/:playlist_id/impact')!;
    expect(impact.approvalDeclarations?.operation?.issues).toHaveLength(2);
    const resolved = resolve(observations);
    const invalid = resolved.findings.filter((finding) => finding.subjectRef === impact.execution.stableKey);
    expect(invalid.map((finding) => finding.code)).toEqual(['approval-subject-invalid', 'approval-subject-invalid']);
    expect(JSON.stringify(resolved.findings)).not.toContain('SECRETVALUE');
  }, 30_000);
});
