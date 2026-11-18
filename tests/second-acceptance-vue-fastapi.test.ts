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
import { createReadResultTool } from '../src/server/core/read-result-tool.js';
import { buildResultOverview } from '../src/server/core/result-overview.js';
import { createResultStore } from '../src/server/core/result-store.js';
import { compactHistoryResult } from '../src/server/adapters/nextjs/history-compaction.js';
import { collectIdLabels, redactIds, type IdLabels } from '../src/server/adapters/nextjs/hide-ids.js';
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
 * (and the gap leaves the list in the acceptance doc).
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

  it('KNOWN GAP SA-01: the history drops playlist_id beyond maxItems, so "entry 14 of that list" has no id', async () => {
    // KNOWN GAP SA-01 (src/server/core/result-overview.ts:95-98 IDENTITY_ID_KEYS, used by
    // src/server/adapters/nextjs/history-compaction.ts:134 identityOf): an entry's own id
    // under `<entity>_id` is no identity key, so entries 11 to 60 keep only their name.
    const list = await call(chatTools(), 'playlists_list', {});
    const compacted = compactHistoryResult(list) as Json;
    const playlists = compacted.playlists as Entry[];
    expect(playlists[0]).toEqual({ playlist_id: 1, displayName: 'Morning Loop', status: 'published' });
    expect(playlists[13]).toEqual({ displayName: 'Opening Loop' });
    expect(compacted._history).toMatchObject({ field: 'playlists', showing: 60, full: 10, total: 60, keys: ['displayName'] });
  });

  it('KNOWN GAP SA-02: an overview under size pressure drops playlist_id first, as a foreign key, and keeps the names', async () => {
    // KNOWN GAP SA-02 (src/server/core/result-overview.ts:121 FOREIGN_KEY, :249 valueRank,
    // :439-441 the kept identity keys): `playlist_id` ranks with foreign keys (left out
    // first), and only id/uuid/key/slug/code count as the entry's own id. 4,000 is a valid
    // `x-glirastes-max-result-chars`; at 16,000 the 60 small entries still fit.
    const raw = await api('/api/playlists');
    const overview = buildResultOverview({ success: true, ...raw }, { id: 'ro_abcdefgh', maxChars: 4_000, readOnly: true }) as Json;
    expect((overview.playlists as Entry[])[0]).toEqual({ displayName: 'Morning Loop', ownerKey: 'ada' });
    expect((overview._result as { omitted: Array<{ path: string }> }).omitted.map((field) => field.path))
      .toEqual(['playlists[].items', 'playlists[].status', 'playlists[].playlist_id']);
  });

  it('KNOWN GAP SA-03: read_result names the entries it reads below the array without their playlist_id', async () => {
    // KNOWN GAP SA-03 (src/server/core/read-result-tool.ts:313 via identityFieldsOf,
    // src/server/core/result-overview.ts:95-98): only id/uuid/key/slug/code and the name keys
    // are added, so the items of entry 10 come back with its name and no id.
    const tools = chatTools();
    const list = await call(tools, 'playlists_list', {});
    const resultId = (list._result as { id: string }).id;
    const items = await call(tools, 'read_result', { resultId, fields: ['playlists[].items'], offset: 9, limit: 1 });
    expect(Object.keys((items.playlists as Entry[])[0]!)).toEqual(['displayName', 'items']);
    const names = await call(tools, 'read_result', { resultId, fields: ['playlists[].displayName'] });
    expect((names.playlists as Entry[])[13]).toEqual({ displayName: 'Opening Loop' });
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
  const subjects = async (args: Json, withUsers = true) => {
    const messages = await browserHistory(withUsers);
    return resolveApprovalSubjects(args, collectEntitySightings(messages), collectSeenEntityIds(messages));
  };

  it('names a user by its `id` with its displayName', async () => {
    expect(await subjects({ user_id: 2 })).toEqual([
      { path: 'user_id', id: '2', status: 'named', name: 'Grace Hopper', label: 'User' },
    ]);
  });

  it('KNOWN GAP SA-04: a listed playlist is `unknown` on the card: playlist_id is no record id', async () => {
    // KNOWN GAP SA-04 (src/react/utils/entity-names.ts:5 ID_KEYS = id, _id, uuid): the 60
    // listed playlists are neither sightings nor seen ids.
    expect(await subjects({ playlist_id: 7 })).toEqual([{ path: 'playlist_id', id: '7', status: 'unknown', label: 'Playlist' }]);
    const messages = await browserHistory(false);
    expect(collectEntitySightings(messages).size).toBe(0);
  });

  it('KNOWN GAP SA-05: playlist 3 is named after user 3, without an ambiguity warning', async () => {
    // KNOWN GAP SA-05 (src/react/utils/entity-names.ts:5, src/react/utils/approval-subjects.ts:85):
    // sightings are keyed by the bare id value, so the only record shown with id 3 (a user)
    // names the playlist; `ambiguous` needs two names for one id, and playlists add none.
    expect(await subjects({ playlist_id: 3 })).toEqual([
      { path: 'playlist_id', id: '3', status: 'named', name: 'Linus Torvalds', label: 'Playlist' },
    ]);
    // Deleting user 1 after only the playlists were shown: no name at all.
    expect(await subjects({ user_id: 1 }, false)).toEqual([{ path: 'user_id', id: '1', status: 'unknown', label: 'User' }]);
  });

  it('KNOWN GAP SA-06: a channel deleted by its `key` gets no subject on the card', async () => {
    // KNOWN GAP SA-06 (src/react/utils/approval-subjects.ts:13-20 isIdKey, src/react/utils/entity-names.ts:5):
    // `key` is no id argument and channels are no sightings, so the card names nothing.
    expect(await subjects({ key: 'lobby' })).toEqual([]);
  });

  it('KNOWN GAP SA-07: a listed version is `unknown`, not `seen` with "Version number 3"', async () => {
    // KNOWN GAP SA-07 (src/react/utils/entity-names.ts:5 ID_KEYS in collectSeenEntityIds):
    // version_id is no record id, so its versionNumber fallback is never used.
    expect(await subjects({ playlist_id: 3, version_id: 303 })).toEqual([
      { path: 'playlist_id', id: '3', status: 'named', name: 'Linus Torvalds', label: 'Playlist' },
      { path: 'version_id', id: '303', status: 'unknown', label: 'Version' },
    ]);
    // The same record under `id` would be seen with its fallback.
    const asId = history(toolPart('versions', { versions: [{ id: 303, versionNumber: 3 }] }));
    expect(resolveApprovalSubjects({ version_id: 303 }, collectEntitySightings(asId), collectSeenEntityIds(asId)))
      .toEqual([{ path: 'version_id', id: '303', status: 'seen', label: 'Version', fallback: 'Version number 3' }]);
  });

  it('KNOWN GAP SA-08: a revision with `rev` has no fallback, even when seen under `id`', async () => {
    // KNOWN GAP SA-08 (src/react/utils/entity-names.ts:125 FALLBACK_KEYS: versionNumber,
    // version, number, code, slug): `rev` is not among them. With the fixture's
    // `revision_id` the revision is not even seen (SA-07).
    expect(await subjects({ key: 'lobby', revision_id: 503 })).toEqual([
      { path: 'revision_id', id: '503', status: 'unknown', label: 'Revision' },
    ]);
    const asId = history(toolPart('revisions', { revisions: [{ id: 503, rev: 3, channelKey: 'lobby' }] }));
    expect(resolveApprovalSubjects({ revision_id: 503 }, collectEntitySightings(asId), collectSeenEntityIds(asId)))
      .toEqual([{ path: 'revision_id', id: '503', status: 'seen', label: 'Revision' }]);
  });
});

describe.skipIf(!PYTHON_READY)('second acceptance fixture: ids in the answer (hideIds)', () => {
  it('KNOWN GAP SA-09: integer ids are never learnt, so "(ID: 3)" stays in the answer', async () => {
    // KNOWN GAP SA-09 (src/server/adapters/nextjs/hide-ids.ts:23-32 and :77): only
    // string ids of 8+ characters with a digit (or UUIDs) are collected; integer
    // `playlist_id`/`id` values are skipped. Only the result handle is learnt.
    const tools = chatTools();
    const labels: IdLabels = new Map();
    for (const output of [
      await call(tools, 'playlists_list', {}),
      await call(tools, 'users_list', {}),
      await call(tools, 'channels_list', {}),
    ]) collectIdLabels(output, labels);
    expect([...labels.keys()]).toEqual([expect.stringMatching(/^ro_/)]);
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
