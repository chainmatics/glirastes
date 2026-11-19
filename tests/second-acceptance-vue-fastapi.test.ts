import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import { DEFAULT_LOCAL_LIMITS } from '../src/runtime/index.js';
import { createHttpEndpointCaller, toolsToAiTools } from '../src/server/index.js';
import { createAiChatHandler } from '../src/server/adapters/nextjs/create-ai-chat-handler.js';
import { createReadResultTool } from '../src/server/core/read-result-tool.js';
import { buildResultOverview } from '../src/server/core/result-overview.js';
import { createResultStore } from '../src/server/core/result-store.js';
import { compactHistoryResult } from '../src/server/adapters/nextjs/history-compaction.js';
import { collectDeclaredIdLabels, collectIdLabels, redactIds, type IdLabels } from '../src/server/adapters/nextjs/hide-ids.js';
import { entityDeclarationsOfTools } from '../src/server/adapters/nextjs/tool-entities.js';
import { collectEntitySightings, collectSeenEntityIds } from '../src/react/utils/entity-names.js';
import { resolveApprovalSubjects } from '../src/react/utils/approval-subjects.js';
import {
  assertBuiltSdk,
  bootFastapiApp,
  closeFastapiApps,
  copyApp,
  FIXTURE_TENANT_ID,
  pythonReady,
  removeCopiedApps,
  VUE_APP,
  type BootedFastapiApp,
} from './support/tool-runtime.js';
import { artifactOf, chatBody, passingCheck, toolNamed } from './support/tool-sync.js';

/**
 * Model-free part of the second acceptance run (docs/acceptance/second-app-vue-fastapi.md):
 * the real responses of the Vue+FastAPI fixture's playlists, channels and users
 * (integer ids under `playlist_id`, a `key`, `displayName`, nameless versions,
 * colliding user ids, signed `fileUrl`s) fed into the SDK's result, history,
 * id-hiding and approval functions.
 *
 * Tests titled `KNOWN GAP SA-nn` assert today's behaviour where the SDK only
 * fits the pilot's shapes. They are findings, not the intended behaviour: a fix
 * makes the assertion fail, and the test then changes to the fixed behaviour
 * (and the gap leaves the list in the acceptance doc). The app declares its
 * object identity (`x-glirastes-entity`, `x-glirastes-entities`,
 * `x-glirastes-entity-ref`, tools.json `identity`); tests marked "without
 * declarations" show that an app without them keeps the field-name fallback.
 */
const PYTHON_READY = pythonReady();

type Json = Record<string, unknown>;
type Entry = Record<string, unknown>;
type AiTools = ReturnType<typeof toolsToAiTools>;

let app: BootedFastapiApp;
let root: string;

beforeAll(async () => {
  if (!PYTHON_READY) return;
  assertBuiltSdk();
  root = await copyApp(VUE_APP, '.second-acceptance-');
  await runToolsPipeline({ root, mode: 'write' });
  app = await bootFastapiApp(root);
}, 240_000);
afterAll(async () => {
  await closeFastapiApps();
  await removeCopiedApps();
});

/** The fixture's own HTTP response, as Alice. */
async function api(path: string): Promise<Json> {
  const response = await fetch(`${app.apiOrigin}${path}`, { headers: { authorization: `Bearer ${app.token}` } });
  expect(response.status).toBe(200);
  return await response.json() as Json;
}

/** The endpoint tools of one turn as the chat handler builds them: with a result store and `read_result`. */
function chatTools(): AiTools {
  const turn = app.turn({ authorization: `Bearer ${app.token}` });
  const store = createResultStore();
  const context = {
    currentDate: new Date('2026-11-18T00:00:00Z'),
    locale: 'en-US',
    callEndpoint: createHttpEndpointCaller({
      baseUrl: app.apiOrigin,
      request: new Request(`${app.apiOrigin}/api/chat`, { headers: { authorization: `Bearer ${app.token}` } }),
    }),
  };
  return toolsToAiTools({ ...turn.registry, read_result: createReadResultTool(store) }, context, { resultStore: store });
}

async function call(tools: AiTools, name: string, input: Json): Promise<Json> {
  const tool = tools[name];
  if (!tool) throw new Error(`No tool ${name}`);
  return await tool.execute(input) as Json;
}

/** A finished tool part of the browser's message history. */
const toolPart = (name: string, output: unknown) => ({
  type: `tool-${name}`, toolCallId: randomUUID(), state: 'output-available', input: {}, output,
});
const history = (...parts: ReturnType<typeof toolPart>[]) => [{ id: randomUUID(), role: 'assistant', parts }];

const ENDPOINT_TOOLS = [
  ['channels.delete', 'DELETE', '/api/channels/:key', 'delete', true],
  ['channels.list', 'GET', '/api/channels', 'safe-read', false],
  ['channelsRevisions.list', 'GET', '/api/channels/:key/revisions', 'safe-read', false],
  ['channelsRevisionsRollback.create', 'POST', '/api/channels/:key/revisions/:revision_id/rollback', 'write', true],
  ['playlists.delete', 'DELETE', '/api/playlists/:playlist_id', 'delete', true],
  ['playlists.get', 'GET', '/api/playlists/:playlist_id', 'safe-read', false],
  ['playlists.list', 'GET', '/api/playlists', 'safe-read', false],
  ['playlistsVersions.list', 'GET', '/api/playlists/:playlist_id/versions', 'safe-read', false],
  ['playlistsVersionsRollback.create', 'POST', '/api/playlists/:playlist_id/versions/:version_id/rollback', 'write', true],
  ['tasks.create', 'POST', '/api/tasks', 'write', true],
  ['tasks.list', 'GET', '/api/tasks', 'safe-read', false],
  ['users.delete', 'DELETE', '/api/users/:user_id', 'delete', true],
  ['users.list', 'GET', '/api/users', 'safe-read', false],
] as const;

describe.skipIf(!PYTHON_READY)('second acceptance fixture: generated tools', () => {
  it('generates every playlist, channel and user route with its risk, and the check is clean', async () => {
    await passingCheck(root);
    const artifact = await artifactOf(root);
    const endpoints = artifact.tools.filter((tool) => tool.executionKind === 'endpoint')
      .map((tool) => [tool.name, tool.method, tool.path, tool.riskClass, tool.requiresApproval]).sort();
    // The derived names of nested routes (`channelsRevisionsRollback.create`) are recorded as they are.
    expect(endpoints).toEqual(ENDPOINT_TOOLS.map((row) => [...row]));
    expect(artifact.tools.every((tool) => tool.enabled)).toBe(true);
    expect(toolNamed(artifact, 'playlists.list').riskClass).toBe('safe-read');
    expect(app.disabled).toEqual([]);
  });

  it('gives every endpoint tool the app-wide **.fileUrl deny, and the playlist list its allow-list and default view', () => {
    const { registry } = app.turn({ authorization: `Bearer ${app.token}` });
    for (const [name] of ENDPOINT_TOOLS) {
      expect(registry[name.replace('.', '_')]?.outputDeniedFields, name).toEqual(['**.fileUrl']);
    }
    expect(registry.playlists_list).toMatchObject({
      outputAllowedFields: [
        'limit', 'offset', 'playlists[].displayName', 'playlists[].items', 'playlists[].ownerKey',
        'playlists[].playlist_id', 'playlists[].status', 'total',
      ],
      outputDefaultFields: ['playlists[].displayName', 'playlists[].playlist_id', 'playlists[].status', 'total'],
    });
  });

  it('seeds the same data on every start: 60 playlists, every 10th with 64 items, signed file URLs', async () => {
    const all = await api('/api/playlists');
    const playlists = all.playlists as Entry[];
    expect(all.total).toBe(60);
    expect(playlists.map((playlist) => playlist.playlist_id)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(playlists.filter((playlist) => (playlist.items as unknown[]).length >= 60).map((playlist) => playlist.playlist_id))
      .toEqual([10, 20, 30, 40, 50, 60]);
    expect(new Set(playlists.map((playlist) => playlist.displayName)).size).toBe(60);
    expect(JSON.stringify(all).length).toBeGreaterThan(16_000);
    expect((playlists[0]!.items as Entry[])[0]!.fileUrl).toMatch(/^https:\/\/media\.example\.test\/.+X-Amz-Signature=[0-9a-f]{64}$/);
    expect(await api('/api/playlists?limit=5&offset=10&status=draft')).toMatchObject({ total: 12, limit: 5, offset: 10 });
    expect((await api('/api/users')).users).toEqual([
      { id: 1, displayName: 'Ada Lovelace' }, { id: 2, displayName: 'Grace Hopper' }, { id: 3, displayName: 'Linus Torvalds' },
      { id: 4, displayName: 'Margaret Hamilton' }, { id: 5, displayName: 'Alan Turing' },
    ]);
  });
});

describe.skipIf(!PYTHON_READY)('second acceptance fixture: results the model sees', () => {
  it('lists 60 playlists as an overview with a handle, ids and names kept, file URLs nowhere', async () => {
    const list = await call(chatTools(), 'playlists_list', {});
    const playlists = list.playlists as Entry[];
    expect(playlists).toHaveLength(60);
    expect(playlists[13]).toEqual({ playlist_id: 14, displayName: 'Opening Loop', status: 'archived' });
    expect(list._result).toMatchObject({
      id: expect.stringMatching(/^ro_/), showing: 60, total: 60,
      omitted: [
        expect.objectContaining({ path: 'playlists[].items' }),
        expect.objectContaining({ path: 'playlists[].ownerKey' }),
        expect.objectContaining({ path: 'limit' }),
        expect.objectContaining({ path: 'offset' }),
      ],
    });
    expect(JSON.stringify(list)).not.toContain('fileUrl');
    expect(JSON.stringify(list)).not.toContain('X-Amz-Signature');
  });

  it('denies fileUrl in nested items: a get, and read_result over all items and one indexed entry', async () => {
    const tools = chatTools();
    const one = await call(tools, 'playlists_get', { playlist_id: 10 });
    expect((one.items as Entry[])).toHaveLength(64);
    expect(Object.keys((one.items as Entry[])[0]!)).toEqual(['item_id', 'displayName', 'durationSec']);
    const list = await call(tools, 'playlists_list', {});
    const resultId = (list._result as { id: string }).id;
    const items = await call(tools, 'read_result', { resultId, fields: ['playlists[].items'], offset: 9, limit: 1 });
    const indexed = await call(tools, 'read_result', { resultId, fields: ['playlists[19].items'] });
    const whole = await call(tools, 'read_result', { resultId, fields: ['playlists[]'], limit: 2 });
    for (const answer of [one, items, indexed, whole]) {
      expect(JSON.stringify(answer)).not.toContain('fileUrl');
      expect(JSON.stringify(answer)).not.toContain('X-Amz-Signature');
    }
    expect(((items.playlists as Entry[])[0]!.items as Entry[])).toHaveLength(64);
  });

  it('answers a missing playlist with a 404 failure the model can read, and refuses a non-integer id', async () => {
    expect(await call(chatTools(), 'playlists_get', { playlist_id: 9999 })).toEqual({
      success: false, error: 'Playlist 9999 not found', retryable: false, status: 404, body: { detail: 'Playlist 9999 not found' },
      hint: expect.stringContaining('no record matches the path parameter "playlist_id"'),
    });
    const turn = app.turn({ authorization: `Bearer ${app.token}` });
    await expect(turn.execute('playlists_get', { playlist_id: 'banana' })).rejects.toThrow('Input does not match');
  });

  it('keeps a `key` with its title in an overview and beyond maxItems in the history', async () => {
    const channels = await call(chatTools(), 'channels_list', {});
    const compacted = compactHistoryResult(channels, { maxItems: 1 }) as Json;
    expect(compacted.channels).toEqual([
      { key: 'lobby', title: 'Lobby screens', playlist_id: 3, live: true },
      { key: 'foyer', title: 'Foyer wall' },
      { key: 'cafeteria', title: 'Cafeteria' },
    ]);
    const users = await call(chatTools(), 'users_list', {});
    expect((compactHistoryResult(users, { maxItems: 2 }) as Json).users)
      .toEqual(expect.arrayContaining([{ id: 5, displayName: 'Alan Turing' }]));
  });

  it('SA-01 (fixed in 0.17.2): the history keeps playlist_id beyond maxItems, so "entry 14 of that list" has its id', async () => {
    // An entry without a recognised id (`id`, `uuid`, `key`, `slug`, `code`) keeps every
    // id-like field (src/contracts/record-identity.ts idLikeFieldsOf).
    const list = await call(chatTools(), 'playlists_list', {});
    const compacted = compactHistoryResult(list) as Json;
    const playlists = compacted.playlists as Entry[];
    expect(playlists[0]).toEqual({ playlist_id: 1, displayName: 'Morning Loop', status: 'published' });
    expect(playlists[13]).toEqual({ playlist_id: 14, displayName: 'Opening Loop' });
    expect(compacted._history).toMatchObject({ field: 'playlists', showing: 60, full: 10, total: 60, keys: ['playlist_id', 'displayName'] });
  });

  it('SA-02 (fixed in 0.17.2): an overview under size pressure keeps playlist_id with the names', async () => {
    // `playlist_id` still ranks with foreign keys, but an entry without a recognised id keeps
    // every id-like field: other fields go first, then trailing entries. 4,000 is a valid
    // `x-glirastes-max-result-chars`; at 16,000 the 60 small entries still fit.
    const raw = await api('/api/playlists');
    const overview = buildResultOverview({ success: true, ...raw }, { id: 'ro_abcdefgh', maxChars: 4_000, readOnly: true }) as Json;
    expect(JSON.stringify(overview).length).toBeLessThanOrEqual(4_000);
    const playlists = overview.playlists as Entry[];
    for (const [index, entry] of playlists.entries()) expect(entry).toMatchObject({ playlist_id: index + 1, displayName: expect.any(String) });
    expect(playlists[0]).toEqual({ playlist_id: 1, displayName: 'Morning Loop' });
    expect((overview._result as { omitted: Array<{ path: string }> }).omitted.map((field) => field.path))
      .toEqual(['playlists[].items', 'playlists[].status', 'playlists[].ownerKey']);
  });

  it('SA-03 (fixed in 0.17.2): read_result names the entries it reads below the array with their playlist_id', async () => {
    // identityFieldsOf adds the id-like fields of an entry without a recognised id.
    const tools = chatTools();
    const list = await call(tools, 'playlists_list', {});
    const resultId = (list._result as { id: string }).id;
    const items = await call(tools, 'read_result', { resultId, fields: ['playlists[].items'], offset: 9, limit: 1 });
    expect(Object.keys((items.playlists as Entry[])[0]!)).toEqual(['playlist_id', 'displayName', 'items']);
    expect((items.playlists as Entry[])[0]!.playlist_id).toBe(10);
    const names = await call(tools, 'read_result', { resultId, fields: ['playlists[].displayName'] });
    expect((names.playlists as Entry[])[13]).toEqual({ playlist_id: 14, displayName: 'Opening Loop' });
  });
});

describe.skipIf(!PYTHON_READY)('second acceptance fixture: approval subjects', () => {
  /** The browser's history after listing playlists, versions of playlist 3, channels, lobby revisions and users. */
  async function browserHistory(withUsers = true) {
    const tools = chatTools();
    return history(
      toolPart('playlists_list', await call(tools, 'playlists_list', {})),
      toolPart('playlistsVersions_list', await call(tools, 'playlistsVersions_list', { playlist_id: 3 })),
      toolPart('channels_list', await call(tools, 'channels_list', {})),
      toolPart('channelsRevisions_list', await call(tools, 'channelsRevisions_list', { key: 'lobby' })),
      ...(withUsers ? [toolPart('users_list', await call(tools, 'users_list', {}))] : []),
    );
  }
  /**
   * The card's subjects as the browser resolves them. `declared` (default): with the
   * declarations the chat handler sends (`data-tool-entities`, from the generated tools'
   * `outputEntities`/`inputEntities`); `false`: an app without any, the field-name guess.
   */
  const subjects = async (args: Json, withUsers = true, toolName?: string, declared = true) => {
    const messages = await browserHistory(withUsers);
    const declarations = declared ? entityDeclarationsOfTools(chatTools()) : undefined;
    const inputEntities = declarations && toolName ? declarations[toolName]?.input : undefined;
    return resolveApprovalSubjects(args, collectEntitySightings(messages, declarations), collectSeenEntityIds(messages, declarations), {
      ...(toolName ? { toolName } : {}),
      ...(inputEntities ? { inputEntities, userTexts: [], declarations } : {}),
    });
  };

  it('names a user by its `id` with its displayName, with and without declarations', async () => {
    for (const declared of [true, false]) {
      expect(await subjects({ user_id: 2 }, true, undefined, declared)).toEqual([
        { path: 'user_id', id: '2', status: 'named', name: 'Grace Hopper', label: 'User' },
      ]);
    }
  });

  it('SA-04 (fixed in 0.18.0): a listed playlist is named on the card by its declared playlist_id', async () => {
    // `x-glirastes-entity` on the Playlist schema: id playlist_id, name displayName.
    expect(await subjects({ playlist_id: 7 })).toEqual([
      { path: 'playlist_id', id: '7', status: 'named', name: 'Weekend Loop', label: 'Playlist' },
    ]);
    // With the tool's `x-glirastes-entity-ref`, the subject is typed.
    expect(await subjects({ playlist_id: 7 }, true, 'playlists_delete')).toEqual([{
      path: 'playlist_id', id: '7', status: 'named', name: 'Weekend Loop', label: 'Playlist',
      type: 'playlist', role: 'target', idKind: 'opaque', provenance: 'tool-result',
    }]);
    const messages = await browserHistory(false);
    expect(collectEntitySightings(messages, entityDeclarationsOfTools(chatTools())).get('7')?.name).toBe('Weekend Loop');
  });

  it('without declarations a listed playlist stays `unknown` (the field-name fallback, as before)', async () => {
    expect(await subjects({ playlist_id: 7 }, true, undefined, false))
      .toEqual([{ path: 'playlist_id', id: '7', status: 'unknown', label: 'Playlist' }]);
    expect(collectEntitySightings(await browserHistory(false)).size).toBe(0);
  });

  it('SA-05 (fixed in 0.17.2): id 3 of a user, a playlist and versions names the kind the call picks, or none', async () => {
    // Without declarations. Id 3 was the own id of user 3 (`id`), of playlist 3 (`playlist_id`,
    // no recognised id) and of the versions of playlist 3 (`playlist_id` next to `version_id`,
    // no name): three kinds (src/contracts/entity-identity.ts). The argument picks one, or none.
    const guessed = (args: Json, withUsers = true, toolName?: string) => subjects(args, withUsers, toolName, false);
    expect(await guessed({ playlist_id: 3 })).toEqual([
      { path: 'playlist_id', id: '3', status: 'named', name: 'Lobby Loop', label: 'Playlist' },
    ]);
    expect(await guessed({ id: 3 }, true, 'playlists_delete')).toEqual([{ path: 'id', id: '3', status: 'named', name: 'Lobby Loop' }]);
    expect(await guessed({ user_id: 3 })).toEqual([{ path: 'user_id', id: '3', status: 'named', name: 'Linus Torvalds', label: 'User' }]);
    expect(await guessed({ id: 3 })).toEqual([{
      path: 'id', id: '3', status: 'ambiguous', names: ['Linus Torvalds', 'Lobby Loop'],
      candidates: [{ label: 'User', name: 'Linus Torvalds' }, { label: 'Version' }, { label: 'Playlist', name: 'Lobby Loop' }],
    }]);
    // Deleting user 1 after only the playlists were shown: no name at all.
    expect(await guessed({ user_id: 1 }, false)).toEqual([{ path: 'user_id', id: '1', status: 'unknown', label: 'User' }]);
  });

  it('with declarations id 3 collides only between the user and the playlist; a version is no candidate', async () => {
    // The versions declare `version_id` as their id: their `playlist_id` names the parent, not them.
    expect(await subjects({ id: 3 })).toEqual([{
      path: 'id', id: '3', status: 'ambiguous', names: ['Linus Torvalds', 'Lobby Loop'],
      candidates: [{ label: 'User', name: 'Linus Torvalds' }, { label: 'Playlist', name: 'Lobby Loop' }],
    }]);
    expect(await subjects({ id: 3 }, true, 'playlists_delete')).toEqual([{ path: 'id', id: '3', status: 'named', name: 'Lobby Loop' }]);
    expect(await subjects({ user_id: 3 }, true, 'users_delete')).toEqual([{
      path: 'user_id', id: '3', status: 'named', name: 'Linus Torvalds', label: 'User',
      type: 'user', role: 'target', idKind: 'opaque', provenance: 'tool-result',
    }]);
    expect(await subjects({ user_id: 1 }, false, 'users_delete')).toEqual([{
      path: 'user_id', id: '1', status: 'unknown', label: 'User', type: 'user', role: 'target', idKind: 'opaque',
    }]);
  });

  it('SA-06 (fixed in 0.18.0): a channel deleted by its declared `key` gets a typed, named subject', async () => {
    // tools.json `identity.entities.channel`: id key (speaking), name title; `x-glirastes-entity-ref` on `key`.
    expect(await subjects({ key: 'lobby' }, true, 'channels_delete')).toEqual([{
      path: 'key', id: 'lobby', status: 'named', name: 'Lobby screens', label: 'Channel',
      type: 'channel', role: 'target', idKind: 'speaking', provenance: 'tool-result',
    }]);
    // A speaking key the user typed (case-insensitive) is valid provenance: seen, no warning.
    const declarations = entityDeclarationsOfTools(chatTools())!;
    expect(resolveApprovalSubjects({ key: 'atrium' }, new Map(), new Map(), {
      toolName: 'channels_delete', inputEntities: declarations.channels_delete!.input!, userTexts: ['Delete the ATRIUM channel'],
    })).toEqual([{
      path: 'key', id: 'atrium', status: 'seen', label: 'Channel', type: 'channel', role: 'target', idKind: 'speaking', provenance: 'user-message',
    }]);
    // Without the user's words it stays unknown, but speaking: the card shows no warning for it.
    expect(resolveApprovalSubjects({ key: 'atrium' }, new Map(), new Map(), {
      toolName: 'channels_delete', inputEntities: declarations.channels_delete!.input!, userTexts: [],
    })).toEqual([{ path: 'key', id: 'atrium', status: 'unknown', label: 'Channel', type: 'channel', role: 'target', idKind: 'speaking' }]);
  });

  it('without declarations a channel deleted by its `key` gets no subject (as before)', async () => {
    expect(await subjects({ key: 'lobby' }, true, 'channels_delete', false)).toEqual([]);
  });

  it('SA-07 (fixed in 0.18.0): a listed version is `seen` with its declared fallback "Version number 3"', async () => {
    // `x-glirastes-entities` on the versions list: id version_id, fallback versionNumber.
    expect(await subjects({ playlist_id: 3, version_id: 303 })).toEqual([
      { path: 'playlist_id', id: '3', status: 'named', name: 'Lobby Loop', label: 'Playlist' },
      { path: 'version_id', id: '303', status: 'seen', label: 'Version', fallback: 'Version number 3', fallbackField: 'versionNumber' },
    ]);
    expect(await subjects({ playlist_id: 3, version_id: 303 }, true, 'playlistsVersionsRollback_create')).toEqual([
      {
        path: 'playlist_id', id: '3', status: 'named', name: 'Lobby Loop', label: 'Playlist',
        type: 'playlist', role: 'parent', idKind: 'opaque', provenance: 'tool-result',
      },
      {
        path: 'version_id', id: '303', status: 'seen', label: 'Playlist version', fallback: 'Version number 3', fallbackField: 'versionNumber',
        type: 'playlist-version', role: 'target', idKind: 'opaque', provenance: 'tool-result',
      },
    ]);
  });

  it('without declarations a listed version stays `unknown`; under `id` it would be seen (as before)', async () => {
    expect(await subjects({ playlist_id: 3, version_id: 303 }, true, undefined, false)).toEqual([
      { path: 'playlist_id', id: '3', status: 'named', name: 'Lobby Loop', label: 'Playlist' },
      { path: 'version_id', id: '303', status: 'unknown', label: 'Version' },
    ]);
    const asId = history(toolPart('versions', { versions: [{ id: 303, versionNumber: 3 }] }));
    expect(resolveApprovalSubjects({ version_id: 303 }, collectEntitySightings(asId), collectSeenEntityIds(asId)))
      .toEqual([{ path: 'version_id', id: '303', status: 'seen', label: 'Version', fallback: 'Version number 3' }]);
  });

  it('SA-08 (fixed in 0.18.0): a revision is `seen` with its declared fallback `rev`', async () => {
    expect(await subjects({ key: 'lobby', revision_id: 503 })).toEqual([
      { path: 'revision_id', id: '503', status: 'seen', label: 'Revision', fallback: 'Rev 3', fallbackField: 'rev' },
    ]);
  });

  it('without declarations `rev` is no fallback, even for a record seen under `id` (as before)', async () => {
    expect(await subjects({ key: 'lobby', revision_id: 503 }, true, undefined, false)).toEqual([
      { path: 'revision_id', id: '503', status: 'unknown', label: 'Revision' },
    ]);
    const asId = history(toolPart('revisions', { revisions: [{ id: 503, rev: 3, channelKey: 'lobby' }] }));
    expect(resolveApprovalSubjects({ revision_id: 503 }, collectEntitySightings(asId), collectSeenEntityIds(asId)))
      .toEqual([{ path: 'revision_id', id: '503', status: 'seen', label: 'Revision' }]);
  });
});

describe.skipIf(!PYTHON_READY)('second acceptance fixture: server approval subjects (docs/approval-subjects.md)', () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  /** One model-free turn through the built-in chat handler: the model calls `toolName` once. */
  async function approvalTurn(toolName: string, input: Json, token = app.token) {
    let step = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        step += 1;
        prompts.push(options.prompt);
        const parts = step === 1
          ? [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]
          : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Ok.' }, { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }];
        return { stream: new ReadableStream({ start(controller) { for (const part of [{ type: 'stream-start', warnings: [] }, ...parts]) controller.enqueue(part); controller.close(); } }) as never };
      },
    });
    const handler = createAiChatHandler({
      tools: app.turn({ authorization: `Bearer ${token}` }).registry,
      model,
      systemPrompt: 'Assistant',
      approvalSecret: 'acceptance-approval-secret-32-chars!',
      endpointCaller: (request) => createHttpEndpointCaller({ baseUrl: app.apiOrigin, request }),
    });
    const response = await handler(new Request(`${app.apiOrigin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Please do it' }] }] }),
    }));
    const chunks = (await response.text()).split('\n').filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as Json);
    const part = chunks.find((chunk) => chunk.type === 'data-approval-subjects') as { data: { subjects: Json[] } } | undefined;
    return {
      subjects: part?.data.subjects,
      approvalId: chunks.find((chunk) => chunk.type === 'tool-approval-request')?.approvalId as string | undefined,
      error: chunks.find((chunk) => chunk.type === 'tool-output-error')?.errorText,
      prompt: JSON.stringify(prompts),
    };
  }

  it('SA-04 through the server: delete_playlist(7) is named by get_playlist, with a v2 approval id', async () => {
    const turn = await approvalTurn('playlists_delete', { playlist_id: 7 });
    expect(turn.subjects).toEqual([{
      type: 'playlist', role: 'target', id: '7', ids: { playlist_id: '7' }, path: 'playlist_id',
      status: 'named', check: 'found', name: 'Weekend Loop', idKind: 'opaque',
    }]);
    expect(turn.approvalId).toMatch(/^glirastes-approval\.v2\./);
    expect(turn.prompt).not.toContain('Weekend Loop');
  });

  it('SA-04 through the server: a playlist that does not exist gets no card, the model gets not_found', async () => {
    const turn = await approvalTurn('playlists_delete', { playlist_id: 999 });
    expect(turn.approvalId).toBeUndefined();
    expect(turn.prompt).toContain('approval_subject_not_found');
  });

  it('SA-05 through the server: id 3 is the playlist "Lobby Loop", never user 3', async () => {
    const turn = await approvalTurn('playlists_delete', { playlist_id: 3 });
    expect(turn.subjects).toEqual([expect.objectContaining({ type: 'playlist', status: 'named', name: 'Lobby Loop' })]);
    expect(JSON.stringify(turn.subjects)).not.toContain('Linus');
  });

  it('SA-06 through the server: delete_channel by key over the complete list_channels; a missing key is refused', async () => {
    expect((await approvalTurn('channels_delete', { key: 'lobby' })).subjects).toEqual([
      expect.objectContaining({ type: 'channel', status: 'named', name: 'Lobby screens', idKind: 'speaking' }),
    ]);
    const missing = await approvalTurn('channels_delete', { key: 'garage' });
    expect(missing.approvalId).toBeUndefined();
    expect(missing.prompt).toContain('approval_subject_not_found');
  });

  it('SA-07 through the server: roll_back_playlist(3, 303) finds version_id 303 in its playlist\'s versions', async () => {
    expect((await approvalTurn('playlistsVersionsRollback_create', { playlist_id: 3, version_id: 303 })).subjects).toEqual([
      expect.objectContaining({ type: 'playlist', role: 'parent', status: 'named', name: 'Lobby Loop' }),
      expect.objectContaining({ type: 'playlist-version', role: 'target', status: 'seen', fallbackField: 'versionNumber', fallbackValue: 3 }),
    ]);
  });

  it('SA-08 through the server: revision 503 of channel lobby is seen as "Rev 3"', async () => {
    expect((await approvalTurn('channelsRevisionsRollback_create', { key: 'lobby', revision_id: 503 })).subjects).toEqual([
      expect.objectContaining({ type: 'channel', role: 'parent', status: 'named', name: 'Lobby screens' }),
      expect.objectContaining({ type: 'channel-revision', role: 'target', status: 'seen', fallbackField: 'rev', fallbackValue: 3 }),
    ]);
  });

  it('list-page case: a user missing from the one page list_users reads is not checkable, never "does not exist"', async () => {
    const onPage = await approvalTurn('users_delete', { user_id: 2 });
    expect(onPage.subjects).toEqual([expect.objectContaining({ type: 'user', status: 'named', name: 'Grace Hopper' })]);
    const offPage = await approvalTurn('users_delete', { user_id: 3 });
    expect(offPage.subjects).toEqual([expect.objectContaining({ type: 'user', status: 'unknown', check: 'unchecked', reason: 'not_in_page' })]);
    expect(offPage.approvalId).toMatch(/^glirastes-approval\.v2\./);
    expect(offPage.prompt).not.toContain('approval_subject_not_found');
  });
});

describe.skipIf(!PYTHON_READY)('second acceptance fixture: ids in the answer (hideIds)', () => {
  /** The labels `hideIds` learns from the three lists, with or without the tools' declarations. */
  async function learnt(declared: boolean): Promise<IdLabels> {
    const tools = chatTools();
    const labels: IdLabels = new Map();
    const declarations = declared ? entityDeclarationsOfTools(tools) : undefined;
    for (const name of ['playlists_list', 'users_list', 'channels_list']) {
      const output = await call(tools, name, {});
      collectIdLabels(output, labels);
      collectDeclaredIdLabels(output, declarations?.[name]?.output, labels);
    }
    return labels;
  }

  it('SA-09 (fixed in 0.18.0): declared integer ids are learnt, so "(ID: 3)" leaves the answer; a bare number stays', async () => {
    const labels = await learnt(true);
    expect(labels.get('14')).toBe('Opening Loop');
    // Speaking channel keys stay readable: never learnt.
    expect(labels.has('lobby')).toBe(false);
    expect(redactIds('Deleted Lobby Loop (ID: 3) and user 1.', labels)).toBe('Deleted Lobby Loop and user 1.');
    expect(redactIds('3 playlists are drafts (3 of 60), ID 14 is archived.', labels)).toBe('3 playlists are drafts (3 of 60) is archived.');
  });

  it('without declarations integer ids are never learnt, so "(ID: 3)" stays (as before)', async () => {
    const labels = await learnt(false);
    // Only result handles (`ro_…`) can be learnt; integer `playlist_id`/`id` values are skipped.
    expect([...labels.keys()].every((key) => key.startsWith('ro_'))).toBe(true);
    expect(redactIds('Deleted Lobby Loop (ID: 3) and user 1.', labels)).toBe('Deleted Lobby Loop (ID: 3) and user 1.');
  });
});

describe.skipIf(!PYTHON_READY)('second acceptance fixture: runtime wiring', () => {
  it('keeps the model unconfigured without ACCEPTANCE_MODEL and builds an OpenRouter chat model with it', async () => {
    const { chatModel } = await import(pathToFileURL(join(root, 'runtime/model.mjs')).href) as {
      chatModel(env: Record<string, string | undefined>): { modelId: string; provider: string };
    };
    expect(() => chatModel({})).toThrow('Configure the chat model in runtime/model.mjs');
    expect(() => chatModel({ ACCEPTANCE_MODEL: 'openai/gpt-4o' })).toThrow('OPENROUTER_API_KEY is not');
    // A placeholder, not a key: building the model sends nothing.
    const model = chatModel({ ACCEPTANCE_MODEL: 'openai/gpt-4o', OPENROUTER_API_KEY: 'placeholder' });
    expect(model).toMatchObject({ modelId: 'openai/gpt-4o', provider: 'openai.chat' });
  });

  it('keeps the CI limits by default and offers the acceptance and SDK-default profiles', async () => {
    const { LIMIT_PROFILES } = await import(pathToFileURL(join(root, 'runtime/chat.mjs')).href) as {
      LIMIT_PROFILES: Record<string, { localLimits: Json; maxSteps?: number; maxOutputTokens?: number }>;
    };
    expect(LIMIT_PROFILES.fixture).toMatchObject({ maxSteps: 3, maxOutputTokens: 200, localLimits: { maxModelSteps: 4, maxToolCalls: 8, maxInputTokens: 10_000 } });
    expect(LIMIT_PROFILES.acceptance).toMatchObject({ maxSteps: 10, maxOutputTokens: 2_000, localLimits: { maxModelSteps: 10, maxToolCalls: 20, maxInputTokens: 120_000 } });
    expect(LIMIT_PROFILES['sdk-default']).toEqual({ localLimits: DEFAULT_LOCAL_LIMITS });
  });

  it('stops a fan-out over every playlist at the SDK-default tool-call limit with a German notice', async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    // Scripted: one step that fetches all 60 playlists one by one; no model is called.
    const model = new MockLanguageModelV3({ doStream: async () => ({
      stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (let id = 1; id <= 60; id += 1) {
          controller.enqueue({ type: 'tool-call', toolCallId: randomUUID(), toolName: 'playlists_get', input: JSON.stringify({ playlist_id: id }) });
        }
        controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        controller.close();
      } }),
    }) });
    const { createChatRuntime } = await import(pathToFileURL(join(root, 'runtime/chat.mjs')).href) as {
      createChatRuntime(options: Json): { server: Server };
    };
    const chat = createChatRuntime({
      apiOrigin: () => app.apiOrigin, model: () => model, tenantId: FIXTURE_TENANT_ID, limits: 'sdk-default', locale: 'de-DE',
    });
    await new Promise<void>((listening) => chat.server.listen(0, '127.0.0.1', listening));
    try {
      const origin = `http://127.0.0.1:${(chat.server.address() as AddressInfo).port}`;
      const response = await fetch(`${origin}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
        body: chatBody('Zeig mir die Dateien aller Playlists'),
      });
      expect(response.status).toBe(200);
      const stream = await response.text();
      expect(stream).toContain('das Limit für diese Anfrage ist erreicht (Tool-Aufrufe: 8)');
      expect(stream).not.toContain('fileUrl');
    } finally {
      await new Promise<void>((closed) => chat.server.close(() => closed()));
    }
  }, 60_000);
});
