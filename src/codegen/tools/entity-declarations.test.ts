import { describe, expect, it } from 'vitest';
import {
  entitiesOf,
  entitySitesOf,
  entityTypeOfName,
  operationEntityDeclarations,
  parameterEntityRef,
  resolveToolEntities,
  routeEntityType,
  schemaEntityDeclarations,
  type EntityResolutionTool,
} from './entity-declarations.js';

const components: Record<string, unknown> = {
  Playlist: {
    type: 'object',
    'x-glirastes-entity': { id: 'playlist_id', name: 'displayName' },
    properties: {
      playlist_id: { type: 'integer' },
      displayName: { type: 'string' },
      items: { type: 'array', items: { $ref: '#/components/schemas/PlaylistItem' } },
    },
  },
  PlaylistItem: {
    type: 'object',
    properties: { item_id: { type: 'integer' }, displayName: { type: 'string' } },
  },
  PlaylistPage: {
    type: 'object',
    properties: { playlists: { type: 'array', items: { $ref: '#/components/schemas/Playlist' } }, total: { type: 'integer' } },
  },
};
const resolveRef = (ref: string) => {
  const name = ref.split('/').at(-1)!;
  return components[name] ? { schema: components[name], name } : undefined;
};

const codes = (findings: ReadonlyArray<{ code: string }>) => findings.map((finding) => finding.code);

function tool(overrides: Partial<EntityResolutionTool> = {}): EntityResolutionTool {
  return {
    stableKey: 'GET /api/playlists',
    definitionId: 'playlists.list',
    modelName: 'playlists_list',
    method: 'GET',
    path: '/api/playlists',
    params: { path: [], query: ['limit'], body: [] },
    ...overrides,
  };
}

describe('entity sites of a response schema', () => {
  it('walks $refs, arrays and nested arrays in the model view, typed by component name', () => {
    const sites = entitySitesOf({ $ref: '#/components/schemas/PlaylistPage' }, resolveRef);
    expect(sites.map((site) => [site.path, site.type, site.fields])).toEqual([
      ['', 'playlist-page', ['playlists', 'total']],
      ['playlists[]', 'playlist', ['playlist_id', 'displayName', 'items']],
      ['playlists[].items[]', 'playlist-item', ['item_id', 'displayName']],
    ]);
    expect(sites[1]!.extension).toEqual({ id: 'playlist_id', name: 'displayName' });
  });

  it('puts a list response under data and a nullable object through anyOf', () => {
    expect(entitySitesOf({ type: 'array', items: { $ref: '#/components/schemas/PlaylistItem' } }, resolveRef)[0]!.path).toBe('data[]');
    const nullable = entitySitesOf({ anyOf: [{ $ref: '#/components/schemas/PlaylistItem' }, { type: 'null' }] }, resolveRef);
    expect(nullable.map((site) => site.path)).toEqual(['']);
  });

  it('derives kebab types and singular route types', () => {
    expect(entityTypeOfName('PlaylistVersion')).toBe('playlist-version');
    expect(entityTypeOfName('ChannelRevisionList')).toBe('channel-revision-list');
    expect(routeEntityType('/api/channels/:key/revisions')).toBe('revision');
    expect(routeEntityType('/api/categories')).toBe('category');
  });
});

describe('declarations read from OpenAPI', () => {
  it('takes x-glirastes-entity with its site path; an untyped extension without a component is invalid', () => {
    const sites = entitySitesOf({ $ref: '#/components/schemas/PlaylistPage' }, resolveRef);
    expect(schemaEntityDeclarations(sites, 'GET /x', 'openapi.json GET /x').output).toEqual([
      { id: 'playlist_id', name: 'displayName', type: 'playlist', path: 'playlists[]' },
    ]);
    const untyped = schemaEntityDeclarations([{ path: '', extension: { id: 'id' } }], 'GET /x', 'w');
    expect(codes(untyped.findings)).toEqual(['entity-declaration-invalid']);
    const extra = schemaEntityDeclarations([{ path: '', type: 'x', extension: { id: 'id', path: 'a[]' } }], 'GET /x', 'w');
    expect(codes(extra.findings)).toEqual(['entity-declaration-invalid']);
  });

  it('keeps the valid entries of x-glirastes-entities and reports each invalid one without its value', () => {
    const read = operationEntityDeclarations([
      { type: 'playlist-version', id: 'version_id', fallback: 'versionNumber', path: 'versions[]' },
      { type: 'Bad Type', id: 'secret-value-123' },
    ], 'GET /v', 'openapi.json GET /v');
    expect(read.output).toEqual([{ type: 'playlist-version', id: 'version_id', fallback: 'versionNumber', path: 'versions[]' }]);
    expect(codes(read.findings)).toEqual(['entity-declaration-invalid']);
    expect(read.findings[0]!.message).not.toContain('secret-value-123');
    expect(codes(operationEntityDeclarations({ nope: 1 }, 's', 'w').findings)).toEqual(['entity-declaration-invalid']);
  });

  it('reads x-glirastes-entity-ref on a parameter or its schema, with x-glirastes-id-kind', () => {
    expect(parameterEntityRef('key', [{ name: 'key' }, { 'x-glirastes-entity-ref': { type: 'channel' }, 'x-glirastes-id-kind': 'speaking' }], 's', 'w'))
      .toEqual({ ref: { type: 'channel', args: 'key', idKind: 'speaking' }, findings: [] });
    expect(parameterEntityRef('id', [{ 'x-glirastes-entity-ref': { type: 'user', role: 'parent' } }], 's', 'w').ref)
      .toEqual({ type: 'user', role: 'parent', args: 'id' });
    expect(codes(parameterEntityRef('id', [{ 'x-glirastes-entity-ref': { type: 'user', role: 'owner' } }], 's', 'w').findings))
      .toEqual(['entity-ref-invalid']);
    expect(codes(parameterEntityRef('id', [{ 'x-glirastes-id-kind': 'readable' }], 's', 'w').findings)).toEqual(['entity-ref-invalid']);
    expect(parameterEntityRef('id', [{}], 's', 'w')).toEqual({ findings: [] });
  });
});

describe('resolving the levels', () => {
  const playlist = { type: 'playlist', id: 'playlist_id', name: 'displayName', path: 'playlists[]' };

  it('declares nothing and finds nothing without declarations', () => {
    const resolved = resolveToolEntities({ tools: [tool()] });
    expect(resolved.byKey.size).toBe(0);
    expect(resolved.findings).toEqual([]);
  });

  it('lets tool code win over the operation, the operation over the schema, the schema over tools.json', () => {
    const resolved = resolveToolEntities({
      tools: [tool({
        entities: {
          code: { where: 'contract.ts', output: [{ ...playlist, name: 'title' }] },
          operation: { where: 'op', output: [playlist] },
          schema: { where: 's', output: [{ ...playlist, fallback: 'status' }] },
          sites: [{ path: 'playlists[]', type: 'playlist', fields: ['playlist_id', 'displayName', 'title', 'status'] }],
        },
      })],
      identity: { tools: { 'playlists.list': { output: [{ ...playlist, id: 'id' }] } } },
    });
    expect(resolved.byKey.get('GET /api/playlists')).toEqual({ outputEntities: [{ ...playlist, name: 'title' }] });
    expect(codes(resolved.findings)).toEqual(['entity-declaration-overridden', 'entity-declaration-overridden', 'entity-declaration-overridden']);
  });

  it('reports two different declarations at one path of one level as entity-id-conflict and keeps the first', () => {
    const resolved = resolveToolEntities({
      tools: [tool({ entities: { operation: { where: 'op', output: [playlist, { ...playlist, id: 'id' }] } } })],
    });
    expect(resolved.byKey.get('GET /api/playlists')?.outputEntities).toEqual([playlist]);
    expect(resolved.findings.map((finding) => [finding.code, finding.severity])).toEqual([['entity-id-conflict', 'error']]);
  });

  it('reports one type with different ids in two tools as entity-id-conflict; both keep their own', () => {
    const resolved = resolveToolEntities({
      tools: [
        tool({ entities: { operation: { where: 'op', output: [playlist] } } }),
        tool({
          stableKey: 'GET /api/playlists/:id', definitionId: 'playlists.get', modelName: 'playlists_get', path: '/api/playlists/:id',
          entities: { operation: { where: 'op', output: [{ type: 'playlist', id: 'id', path: '' }] } },
        }),
      ],
    });
    expect(codes(resolved.findings)).toEqual(['entity-id-conflict']);
    expect(resolved.byKey.size).toBe(2);
  });

  it('lets a denied field win: a denied id drops the declaration, a denied name only the name', () => {
    const denied = resolveToolEntities({
      tools: [tool({
        entities: { operation: { where: 'op', output: [playlist, { type: 'owner', id: 'ownerKey', path: 'owners[]' }] } },
        outputDeniedFields: ['**.displayName', 'owners[].ownerKey'],
      })],
    });
    expect(denied.byKey.get('GET /api/playlists')?.outputEntities).toEqual([{ type: 'playlist', id: 'playlist_id', path: 'playlists[]' }]);
    expect(codes(denied.findings)).toEqual(['entity-field-denied', 'entity-field-denied']);
    const notAllowed = resolveToolEntities({
      tools: [tool({ entities: { operation: { where: 'op', output: [playlist] } }, outputAllowedFields: ['playlists[].displayName'] })],
    });
    expect(notAllowed.byKey.size).toBe(0);
    expect(codes(notAllowed.findings)).toEqual(['entity-field-denied']);
  });

  it('warns about a field the schema does not have at that path', () => {
    const resolved = resolveToolEntities({
      tools: [tool({
        entities: {
          operation: { where: 'op', output: [{ ...playlist, name: 'name' }] },
          sites: [{ path: 'playlists[]', fields: ['playlist_id', 'displayName'] }],
        },
      })],
    });
    expect(codes(resolved.findings)).toEqual(['entity-field-unknown']);
    expect(resolved.byKey.get('GET /api/playlists')?.outputEntities).toEqual([{ ...playlist, name: 'name' }]);
  });

  it('applies tools.json identity.entities by schema type, else by the route of a read tool, and reports unused entries', () => {
    const bySite = resolveToolEntities({
      tools: [tool({
        stableKey: 'GET /api/channels', definitionId: 'channels.list', modelName: 'channels_list', path: '/api/channels',
        entities: { sites: [{ path: '', fields: ['channels'] }, { path: 'channels[]', type: 'channel', fields: ['key', 'title'] }] },
      })],
      identity: {
        entities: { channel: { id: 'key', name: 'title', idKind: 'speaking' }, ghost: { id: 'id' } },
        tools: { nope_list: { output: [] } },
      },
    });
    expect(bySite.byKey.get('GET /api/channels')).toEqual({
      outputEntities: [{ type: 'channel', id: 'key', name: 'title', idKind: 'speaking', path: 'channels[]' }],
    });
    expect(codes(bySite.findings)).toEqual(['entity-declaration-unused', 'entity-declaration-unused']);
    const byRoute = resolveToolEntities({
      tools: [tool({ stableKey: 'GET /api/channels', path: '/api/channels', definitionId: 'channels.list', modelName: 'channels_list' })],
      identity: { entities: { channel: { id: 'key' } } },
    });
    expect(byRoute.byKey.get('GET /api/channels')).toEqual({ outputEntities: [{ type: 'channel', id: 'key' }] });
    const invalid = resolveToolEntities({ tools: [tool()], identity: { entities: { channel: { id: 'key', path: 'x[]' } } } });
    expect(codes(invalid.findings)).toEqual(['entity-declaration-invalid']);
  });

  it('keeps input references whose args are parameters, the higher level first', () => {
    const resolved = resolveToolEntities({
      tools: [tool({
        stableKey: 'DELETE /api/channels/:key', definitionId: 'channels.delete', modelName: 'channels_delete', method: 'DELETE',
        path: '/api/channels/:key', params: { path: ['key'], query: [], body: [] },
        entities: { operation: { where: 'op', input: [{ type: 'channel', args: 'key', idKind: 'speaking' }, { type: 'x', args: 'missing' }] } },
      })],
      identity: { tools: { channels_delete: { input: [{ type: 'channel', args: 'key' }, { type: 'bad type', args: 'key' }] } } },
    });
    expect(resolved.byKey.get('DELETE /api/channels/:key')).toEqual({
      inputEntities: [{ type: 'channel', args: 'key', idKind: 'speaking' }],
    });
    expect(codes(resolved.findings).sort()).toEqual(['entity-declaration-overridden', 'entity-ref-invalid', 'entity-ref-invalid']);
  });
});

describe('tools.json identity', () => {
  it('accepts entities by type and tools by name, and rejects other keys', async () => {
    const { ToolsConfigSchema } = await import('./config.js');
    const base = {
      schemaVersion: 1, appId: '019fb007-0000-7000-8000-000000000004', targetAppKey: 'x', locale: 'en-US', sources: ['openapi'],
    };
    expect(ToolsConfigSchema.safeParse({
      ...base,
      identity: { entities: { channel: { id: 'key' } }, tools: { 'channels.delete': { input: [{ type: 'channel', args: 'key' }] } } },
    }).success).toBe(true);
    expect(ToolsConfigSchema.safeParse({ ...base, identity: { types: {} } }).success).toBe(false);
  });

  it('keeps at most 20 declarations of one tool, the first in path order, with a finding', () => {
    const sites = Array.from({ length: 25 }, (_, index) => ({ path: `group${String(index).padStart(2, '0')}[]`, type: 'playlist' }));
    const resolved = resolveToolEntities({
      tools: [tool({ entities: { sites } })],
      identity: { entities: { playlist: { id: 'playlist_id' } } },
    });
    const output = resolved.byKey.get('GET /api/playlists')!.outputEntities!;
    expect(output).toHaveLength(20);
    expect(output.at(-1)!.path).toBe('group19[]');
    expect(codes(resolved.findings)).toEqual(['entity-declaration-invalid']);
  });
});

describe('code-defined tools', () => {
  it('records schema sites also without a contract.ts declaration, so tools.json identity can apply', () => {
    const output = { type: 'object', properties: { playlists: { type: 'array', items: { type: 'object', title: 'Playlist', properties: { playlist_id: { type: 'integer' } } } } } };
    expect(entitiesOf(undefined, output).entities?.sites?.map((site) => [site.path, site.type])).toEqual([['', undefined], ['playlists[]', 'playlist']]);
    expect(entitiesOf(undefined, undefined)).toEqual({});
  });
});
