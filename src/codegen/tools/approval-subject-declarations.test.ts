import { describe, expect, it } from 'vitest';
import {
  approvalLevelOf,
  CODE_FIELD_NAMES,
  OPENAPI_FIELD_NAMES,
  readApprovalDeclarations,
  resolveApprovalSubjects,
  type ApprovalResolutionTool,
} from './approval-subject-declarations.js';
import { deriveToolPolicyDefaults } from '../../contracts/tool-policy.js';
import { ToolContractsFileSchema } from './files.js';

const codes = (findings: ReadonlyArray<{ code: string }>) => findings.map((finding) => finding.code).sort();

const PLAYLIST = { type: 'playlist', id: 'playlist_id', name: 'title', path: '' };

/** `GET /playlists/{playlist_id}`: the read source. */
function getPlaylist(overrides: Partial<ApprovalResolutionTool> = {}): ApprovalResolutionTool {
  return {
    stableKey: 'GET /playlists/{playlist_id}',
    definitionId: 'playlists.get',
    modelName: 'playlists_get',
    method: 'GET',
    path: '/playlists/{playlist_id}',
    params: { path: ['playlist_id'], query: [], body: [] },
    requiresApproval: false,
    outputEntities: [PLAYLIST],
    ...overrides,
  };
}

/** `DELETE /playlists/{playlist_id}`: the write tool. */
function deletePlaylist(overrides: Partial<ApprovalResolutionTool> = {}): ApprovalResolutionTool {
  return {
    stableKey: 'DELETE /playlists/{playlist_id}',
    definitionId: 'playlists.delete',
    modelName: 'playlists_delete',
    method: 'DELETE',
    path: '/playlists/{playlist_id}',
    params: { path: ['playlist_id'], query: [], body: [] },
    requiresApproval: true,
    inputEntities: [{ type: 'playlist', args: 'playlist_id' }],
    ...overrides,
  };
}

const LOOKUP = { type: 'playlist', params: { playlist_id: 'playlist_id' } };
const operation = (declarations: Record<string, unknown>, where = 'GET /playlists/{playlist_id} in api/openapi.json') =>
  approvalLevelOf(declarations, OPENAPI_FIELD_NAMES, where)!;
const code = (declarations: Record<string, unknown>) => approvalLevelOf(declarations, CODE_FIELD_NAMES, 'src/contract.ts')!;

describe('reading the declarations of one level', () => {
  it('keeps valid ones, one lookup as a list, and names every invalid one without its value', () => {
    const read = readApprovalDeclarations({
      entityLookup: [LOOKUP, { type: 'Bad SECRETVALUE', params: {} }, { ...LOOKUP, const: { limit: 5 } }],
      approvalSubject: { recheck: 'SECRETVALUE' },
      lookupEffect: 'write',
    }, OPENAPI_FIELD_NAMES);
    expect(read.declarations).toEqual({ entityLookup: [LOOKUP] });
    expect(read.issues).toHaveLength(4);
    expect(read.issues.join(' ')).toContain('x-glirastes-entity-lookup[1]');
    expect(read.issues.join(' ')).toContain('a second time');
    expect(read.issues.join(' ')).not.toContain('SECRETVALUE');
    expect(readApprovalDeclarations({ entityLookup: LOOKUP, approvalSubject: false, lookupEffect: 'read' }, CODE_FIELD_NAMES).declarations)
      .toEqual({ entityLookup: [LOOKUP], approvalSubject: false, lookupEffect: 'read' });
    expect(approvalLevelOf({}, CODE_FIELD_NAMES, 'x')).toBeUndefined();
  });

  it('drops a secret-looking value', () => {
    const read = readApprovalDeclarations({ entityLookup: { ...LOOKUP, const: { token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' } } }, CODE_FIELD_NAMES);
    expect(read.declarations).toEqual({});
    expect(read.issues.join(' ')).toContain('secret');
  });
});

describe('resolving approval subjects', () => {
  it('keeps a valid lookup on a GET source and reports nothing', () => {
    const resolved = resolveApprovalSubjects({
      tools: [getPlaylist({ declarations: { operation: operation({ 'entityLookup': LOOKUP }) } }), deletePlaylist()],
    });
    expect(resolved.findings).toEqual([]);
    expect(resolved.byKey.get('GET /playlists/{playlist_id}')).toEqual({ entityLookup: [LOOKUP] });
    expect(resolved.byKey.has('DELETE /playlists/{playlist_id}')).toBe(false);
  });

  it('precedence per field: tool code > OpenAPI operation > tools.json', () => {
    const codeLookup = { type: 'playlist', params: { playlist_id: 'playlist_id' }, result: 'one' as const };
    const resolved = resolveApprovalSubjects({
      tools: [
        getPlaylist({ declarations: { code: code({ entityLookup: codeLookup }), operation: operation({ entityLookup: LOOKUP }) } }),
        deletePlaylist({ declarations: { operation: operation({ approvalSubject: { onUnavailable: 'block' } }, 'DELETE') } }),
      ],
      lookups: { playlist: { tool: 'playlists_get', params: { playlist_id: 'playlist_id' }, complete: true } },
      approvalSubjects: { tools: { 'playlists.delete': false } },
    });
    expect(resolved.byKey.get('GET /playlists/{playlist_id}')?.entityLookup).toEqual([codeLookup]);
    expect(resolved.byKey.get('DELETE /playlists/{playlist_id}')?.approvalSubject).toEqual({ onUnavailable: 'block' });
    // The replaced tools.json lookup says so.
    expect(codes(resolved.findings)).toEqual(['approval-subject-unused']);
    expect(resolved.findings[0]!.message).toContain('replaced');
  });

  it('applies tools.json identity.lookups and approvalSubjects.tools by definition id or model name', () => {
    const resolved = resolveApprovalSubjects({
      tools: [getPlaylist(), deletePlaylist()],
      lookups: { playlist: { tool: 'playlists.get', params: { playlist_id: 'playlist_id' } } },
      approvalSubjects: { tools: { playlists_delete: { recheck: 'exists' } } },
    });
    expect(resolved.findings).toEqual([]);
    expect(resolved.byKey.get('GET /playlists/{playlist_id}')).toEqual({ entityLookup: [LOOKUP] });
    expect(resolved.byKey.get('DELETE /playlists/{playlist_id}')).toEqual({ approvalSubject: { recheck: 'exists' } });
  });

  it('reports tools.json entries that are invalid or apply to no tool', () => {
    const resolved = resolveApprovalSubjects({
      tools: [getPlaylist(), deletePlaylist()],
      lookups: {
        playlist: { tool: 'playlists_nope', params: { playlist_id: 'playlist_id' } },
        version: { type: 'version', tool: 'playlists_get', params: {} },
        Bad: { tool: 'playlists_get', params: {} },
        owner: { params: {} },
      },
      approvalSubjects: { tools: { nope: false, 'playlists.delete': { recheck: 'always' } } },
    });
    expect(codes(resolved.findings)).toEqual([
      'approval-subject-invalid', 'approval-subject-invalid', 'approval-subject-invalid', 'approval-subject-invalid',
      // No lookup applies, so the GET route with the same path is suggested.
      'approval-subject-suggested',
      'approval-subject-unused', 'approval-subject-unused',
    ]);
    expect(resolved.findings.find((finding) => finding.code === 'approval-subject-invalid')!.severity).toBe('error');
    expect(resolved.byKey.size).toBe(0);
  });

  it('rejects a source that is not provably read-only, and accepts a POST with lookupEffect read', () => {
    const post = getPlaylist({
      stableKey: 'POST /playlists/search', definitionId: 'playlists.search', modelName: 'playlists_search', method: 'POST',
      path: '/playlists/search', params: { path: [], query: [], body: ['playlist_id'] }, requiresApproval: true,
    });
    const withoutEffect = resolveApprovalSubjects({
      tools: [{ ...post, declarations: { operation: operation({ entityLookup: LOOKUP }) } }, deletePlaylist()],
    });
    expect(codes(withoutEffect.findings)).toEqual(['approval-subject-invalid']);
    expect(withoutEffect.findings[0]!.message).toContain('lookupEffect');
    expect(withoutEffect.byKey.size).toBe(0);
    const withEffect = resolveApprovalSubjects({
      tools: [{ ...post, declarations: { operation: operation({ entityLookup: LOOKUP, lookupEffect: 'read' }) } }, deletePlaylist()],
    });
    expect(withEffect.findings).toEqual([]);
    expect(withEffect.byKey.get('POST /playlists/search')).toEqual({ entityLookup: [LOOKUP], lookupEffect: 'read' });
    // A GET that requires approval is not read-only either, unless it declares lookupEffect.
    const approvedGet = resolveApprovalSubjects({
      tools: [getPlaylist({ requiresApproval: true, declarations: { operation: operation({ entityLookup: LOOKUP }) } }), deletePlaylist()],
    });
    expect(codes(approvedGet.findings)).toEqual(['approval-subject-invalid']);
    expect(approvedGet.findings[0]!.message).toContain('requires approval');
  });

  it('checks a lookup against the source: declared type, id fields, parameters', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'version', params: { playlist_id: 'playlist_id' } }, 'outputEntities'],
      [{ type: 'playlist', params: { playlist_id: 'title' } }, 'no id field'],
      [{ type: 'playlist', params: { pid: 'playlist_id' } }, 'no parameter'],
      [{ type: 'playlist', params: { playlist_id: 'playlist_id' }, const: { limit: 5 } }, 'no parameter'],
    ];
    for (const [lookup, message] of cases) {
      const resolved = resolveApprovalSubjects({
        tools: [getPlaylist({ declarations: { operation: operation({ entityLookup: lookup }) } }), deletePlaylist()],
      });
      expect(codes(resolved.findings), message).toEqual(['approval-subject-invalid', 'approval-subject-suggested']);
      expect(resolved.findings.find((finding) => finding.code === 'approval-subject-invalid')!.message).toContain(message);
      expect(resolved.byKey.size).toBe(0);
    }
    // An opaque body skips the parameter check.
    const opaque = resolveApprovalSubjects({
      tools: [
        getPlaylist({ params: { path: [], query: [], body: 'opaque' }, declarations: { operation: operation({ entityLookup: { type: 'playlist', params: { pid: 'playlist_id' } } }) } }),
        deletePlaylist(),
      ],
    });
    expect(opaque.findings).toEqual([]);
  });

  it('composite keys, a { ref } param, a speaking key and a complete list', () => {
    const version = {
      stableKey: 'GET /playlists/{playlist_id}/versions', definitionId: 'versions.list', modelName: 'versions_list', method: 'GET',
      path: '/playlists/{playlist_id}/versions', params: { path: ['playlist_id'], query: ['channel', 'rev'], body: [] as string[] },
      requiresApproval: false,
      outputEntities: [{ type: 'version', id: ['channel', 'rev'], path: 'data[]' }],
    };
    const channel = {
      stableKey: 'GET /channels', definitionId: 'channels.list', modelName: 'channels_list', method: 'GET',
      path: '/channels', params: { path: [], query: [], body: [] as string[] }, requiresApproval: false,
      outputEntities: [{ type: 'channel', id: 'key', name: 'title', idKind: 'speaking' as const, path: 'data[]' }],
    };
    const lookups = {
      version: { type: 'version', params: { playlist_id: { ref: 'playlist' }, channel: 'channel', rev: 'rev' } },
      channel: { type: 'channel', params: {}, complete: true },
    };
    const write = deletePlaylist({
      stableKey: 'POST /playlists/{playlist_id}/publish', definitionId: 'versions.publish', modelName: 'versions_publish', method: 'POST',
      path: '/playlists/{playlist_id}/publish', params: { path: ['playlist_id'], query: [], body: ['channel', 'rev', 'channel_key'] },
      inputEntities: [
        { type: 'playlist', role: 'parent', args: 'playlist_id' },
        { type: 'version', args: ['channel', 'rev'] },
        { type: 'channel', role: 'reference', args: 'channel_key' },
      ],
      declarations: { code: code({ approvalSubject: { refs: ['channel,rev', 'channel_key'] } }) },
    });
    const resolved = resolveApprovalSubjects({
      tools: [
        { ...version, declarations: { operation: operation({ entityLookup: lookups.version }) } },
        { ...channel, declarations: { operation: operation({ entityLookup: lookups.channel }) } },
        getPlaylist({ declarations: { operation: operation({ entityLookup: LOOKUP }) } }),
        write,
      ],
    });
    expect(resolved.findings).toEqual([]);
    expect(resolved.byKey.get(version.stableKey)?.entityLookup).toEqual([lookups.version]);
    expect(resolved.byKey.get(channel.stableKey)?.entityLookup).toEqual([lookups.channel]);
    expect(resolved.byKey.get(write.stableKey)?.approvalSubject).toEqual({ refs: ['channel,rev', 'channel_key'] });
  });

  it('warns about an unbounded list lookup and keeps it', () => {
    const list = getPlaylist({
      stableKey: 'GET /playlists', definitionId: 'playlists.list', modelName: 'playlists_list', path: '/playlists',
      params: { path: [], query: ['limit'], body: [] }, outputEntities: [{ ...PLAYLIST, path: 'data[]' }],
    });
    const unbounded = resolveApprovalSubjects({
      tools: [{ ...list, declarations: { operation: operation({ entityLookup: { type: 'playlist', params: {} } }) } }, deletePlaylist()],
    });
    expect(codes(unbounded.findings)).toEqual(['approval-subject-unbounded-list']);
    expect(unbounded.findings[0]!.severity).toBe('warning');
    expect(unbounded.byKey.get(list.stableKey)?.entityLookup).toEqual([{ type: 'playlist', params: {} }]);
    for (const bounded of [
      { type: 'playlist', params: {}, complete: true },
      { type: 'playlist', params: {}, const: { limit: 100 } },
      { type: 'playlist', params: {}, result: 'one' },
    ]) {
      const resolved = resolveApprovalSubjects({
        tools: [{ ...list, declarations: { operation: operation({ entityLookup: bounded }) } }, deletePlaylist()],
      });
      expect(resolved.findings).toEqual([]);
    }
  });

  it('reports a lookup no write tool needs', () => {
    const resolved = resolveApprovalSubjects({
      tools: [getPlaylist({ declarations: { operation: operation({ entityLookup: LOOKUP }) } }), deletePlaylist({ inputEntities: [] })],
    });
    expect(codes(resolved.findings)).toEqual(['approval-subject-unused']);
    // It stays declared: harmless, and the next write tool may need it.
    expect(resolved.byKey.get('GET /playlists/{playlist_id}')?.entityLookup).toEqual([LOOKUP]);
  });

  it('suggests a lookup on the GET route with the same path, never applied', () => {
    const resolved = resolveApprovalSubjects({ tools: [getPlaylist(), deletePlaylist()] });
    expect(codes(resolved.findings)).toEqual(['approval-subject-suggested']);
    expect(resolved.findings[0]!.message).toContain('x-glirastes-entity-lookup: {"type":"playlist","params":{"playlist_id":"playlist_id"}}');
    expect(resolved.byKey.size).toBe(0);
    // Not with approvalSubject false, not for a reference, not without a matching id param.
    expect(resolveApprovalSubjects({ tools: [getPlaylist(), deletePlaylist({ declarations: { code: code({ approvalSubject: false }) } })] }).findings)
      .toEqual([]);
    expect(resolveApprovalSubjects({ tools: [getPlaylist(), deletePlaylist({ inputEntities: [{ type: 'playlist', role: 'reference', args: 'playlist_id' }] })] }).findings)
      .toEqual([]);
    expect(resolveApprovalSubjects({ tools: [getPlaylist({ outputEntities: [{ ...PLAYLIST, id: 'id' }] }), deletePlaylist()] }).findings)
      .toEqual([]);
  });

  it('rejects approvalSubject refs that no inputEntities declare', () => {
    const resolved = resolveApprovalSubjects({
      tools: [
        getPlaylist({ declarations: { operation: operation({ entityLookup: LOOKUP }) } }),
        deletePlaylist({ declarations: { code: code({ approvalSubject: { refs: ['owner_id'] } }) } }),
      ],
    });
    expect(codes(resolved.findings)).toEqual(['approval-subject-invalid']);
    expect(resolved.byKey.has('DELETE /playlists/{playlist_id}')).toBe(false);
  });

  describe('previews', () => {
    const impact = {
      stableKey: 'POST /playlists/{playlist_id}/impact', definitionId: 'playlists.impact', modelName: 'playlists_impact', method: 'POST',
      path: '/playlists/{playlist_id}/impact', params: { path: ['playlist_id'], query: [], body: ['dry_run'] }, requiresApproval: true,
      outputDeniedFields: ['impact.secretCount'],
    };
    const preview = (overrides: Record<string, unknown> = {}) => ({
      tool: 'playlists_impact',
      params: { playlist_id: 'playlist_id', dry_run: { const: true } },
      fields: [{ path: 'impact.devices', label: { en: 'Devices', de: 'Geräte' }, format: 'count' }],
      ...overrides,
    });
    const run = (option: Record<string, unknown>, source: Partial<ApprovalResolutionTool> = {}) => resolveApprovalSubjects({
      tools: [
        getPlaylist({ declarations: { operation: operation({ entityLookup: LOOKUP }) } }),
        { ...impact, declarations: { operation: operation({ lookupEffect: 'read' }) }, ...source },
        deletePlaylist({ declarations: { operation: operation({ approvalSubject: option }) } }),
      ],
    });

    it('keeps a preview through a POST source with lookupEffect read', () => {
      const resolved = run({ preview: preview(), onUnavailable: 'block' });
      expect(resolved.findings).toEqual([]);
      expect(resolved.byKey.get('DELETE /playlists/{playlist_id}')?.approvalSubject).toEqual({ preview: preview(), onUnavailable: 'block' });
    });

    it('drops the preview (keeps the rest) for a non-read source, unknown tool, unknown params', () => {
      for (const [option, source, message] of [
        [{ preview: preview() }, { declarations: {} }, 'lookupEffect'],
        [{ preview: preview({ tool: 'nope' }) }, {}, 'no generated endpoint tool'],
        [{ preview: preview({ params: { nope: 'playlist_id' } }) }, {}, 'has no parameter for'],
        [{ preview: preview({ params: { playlist_id: 'owner.id' } }) }, {}, 'no parameter of this tool'],
      ] as Array<[Record<string, unknown>, Partial<ApprovalResolutionTool>, string]>) {
        const resolved = run({ ...option, recheck: 'exists' }, source);
        expect(codes(resolved.findings), message).toEqual(['approval-subject-invalid']);
        expect(resolved.findings[0]!.message).toContain(message);
        expect(resolved.byKey.get('DELETE /playlists/{playlist_id}')?.approvalSubject).toEqual({ recheck: 'exists' });
      }
    });

    it('drops a field the source denies, and the preview when none is left', () => {
      const fields = [
        { path: 'impact.devices', label: 'Devices', format: 'count' },
        { path: 'impact.secretCount', label: 'Hidden' },
      ];
      const one = run({ preview: preview({ fields }) });
      expect(codes(one.findings)).toEqual(['approval-subject-field-denied']);
      expect(one.byKey.get('DELETE /playlists/{playlist_id}')?.approvalSubject).toEqual({ preview: preview({ fields: [fields[0]] }) });
      const none = run({ preview: preview({ fields: [fields[1]] }) });
      expect(codes(none.findings)).toEqual(['approval-subject-field-denied', 'approval-subject-field-denied']);
      expect(none.byKey.get('DELETE /playlists/{playlist_id}')?.approvalSubject).toEqual({});
      // An allow-list that does not cover the field denies it too; an any-depth pattern on a segment as well.
      expect(codes(run({ preview: preview() }, { outputAllowedFields: ['summary'] }).findings)).toContain('approval-subject-field-denied');
      expect(codes(run({ preview: preview() }, { outputDeniedFields: ['**.impact'] }).findings)).toContain('approval-subject-field-denied');
    });
  });

  it('reports the issues of each level as a non-blocking error, never as the tool', () => {
    const resolved = resolveApprovalSubjects({
      tools: [getPlaylist({ declarations: { operation: operation({ lookupEffect: 'write' }) } }), deletePlaylist()],
    });
    const invalid = resolved.findings.filter((finding) => finding.code === 'approval-subject-invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ severity: 'error', subjectRef: 'GET /playlists/{playlist_id}' });
    expect(invalid[0]!.message).toContain('x-glirastes-lookup-effect');
    expect(invalid[0]!.message).toContain('stays enabled');
  });

  it('is deterministic regardless of the input order', () => {
    const tools = [
      getPlaylist({ declarations: { operation: operation({ entityLookup: LOOKUP }) } }),
      deletePlaylist({ declarations: { code: code({ approvalSubject: { refs: ['nope'] } }) } }),
    ];
    expect(resolveApprovalSubjects({ tools: [...tools].reverse() })).toEqual(resolveApprovalSubjects({ tools }));
  });
});

describe('tool-contracts.json entries', () => {
  const file = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    appId: '00000000-0000-4000-8000-000000000001',
    tools: [{
      toolId: '00000000-0000-4000-8000-000000000002',
      stableKey: 'GET /playlists/:playlist_id',
      definitionId: 'playlists.get',
      contract: null,
      defaults: deriveToolPolicyDefaults({ executionKind: 'endpoint', method: 'GET', path: '/playlists/:playlist_id', definitionId: 'playlists.get', evidence: { externalCall: false } }),
      ...extra,
    }],
  });

  it('accepts valid declarations and rejects anything else (strict)', () => {
    expect(ToolContractsFileSchema.safeParse(file({})).success).toBe(true);
    expect(ToolContractsFileSchema.safeParse(file({ entityLookup: [LOOKUP], approvalSubject: false, lookupEffect: 'read' })).success).toBe(true);
    expect(ToolContractsFileSchema.safeParse(file({ approvalSubject: { recheck: 'unchanged' } })).success).toBe(true);
    for (const invalid of [
      { entityLookup: LOOKUP },
      { entityLookup: [] },
      { entityLookup: [LOOKUP, LOOKUP] },
      { entityLookup: [{ type: 'playlist' }] },
      { approvalSubject: true },
      { approvalSubject: { recheck: 'always' } },
      { lookupEffect: 'write' },
    ]) {
      expect(ToolContractsFileSchema.safeParse(file(invalid)).success, JSON.stringify(invalid)).toBe(false);
    }
  });
});
