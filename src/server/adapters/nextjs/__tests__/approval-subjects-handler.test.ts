import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool, defineTool, type PiiShield } from '../../../../types.js';
import { endpointToolsToRegistry } from '../../../core/index.js';
import { createApprovalBinder } from '../approval-binding.js';
import { APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS } from '../approval-subject-lookup.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import {
  SECRET,
  answered,
  callingModel,
  failure,
  fakeBackend,
  ok,
  post,
  promptText,
  referenceTools,
  streamChunks,
  subjectsPart,
  turn,
  user,
} from './approval-subject-fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const BIDI_OR_BREAK = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069\\n\\r]');

function deletePlaylist(backendRoute: Parameters<typeof fakeBackend>[0][string], extra: Parameters<typeof referenceTools>[0] = {}) {
  const backend = fakeBackend({
    'GET /playlists/7': backendRoute,
    'DELETE /playlists/7': () => ok({ deleted: 7 }),
  });
  const { model, prompts } = callingModel([{ toolName: 'delete_playlist', input: { playlist_id: 7 } }]);
  const config = { tools: referenceTools(extra), model, systemPrompt: 'Assistant', approvalSecret: SECRET, endpointCaller: backend.endpointCaller };
  return { backend, prompts, config };
}

const writes = (calls: ReturnType<typeof fakeBackend>['calls']) => calls.filter((call) => call.method !== 'GET');

describe('server approval subjects in the chat handler', () => {
  it('names the record from the read source, with the user\'s credentials, before the approval request (SA-04)', async () => {
    const { backend, config, prompts } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop', secretNote: 'x' }));
    const { chunks } = await turn(config);
    const partIndex = chunks.findIndex((chunk) => chunk.type === 'data-approval-subjects');
    const requestIndex = chunks.findIndex((chunk) => chunk.type === 'tool-approval-request');
    expect(partIndex).toBeGreaterThan(-1);
    expect(partIndex).toBe(requestIndex - 1);
    expect(subjectsPart(chunks)).toEqual({
      type: 'data-approval-subjects',
      id: 'call-1',
      data: {
        v: 1,
        toolCallId: 'call-1',
        subjects: [{
          type: 'playlist', role: 'target', id: '7', ids: { playlist_id: '7' }, path: 'playlist_id',
          status: 'named', check: 'found', name: 'Lobby Loop', idKind: 'opaque',
        }],
      },
    });
    expect(chunks[requestIndex]!.approvalId).toMatch(/^glirastes-approval\.v2\./);
    // Only the declared source, with the request's own credentials; the write did not run.
    expect(backend.calls).toEqual([{ method: 'GET', path: '/playlists/7', authorization: 'Bearer user-token', signal: expect.any(AbortSignal) }]);
    // The model never sees the looked-up name.
    expect(promptText(prompts)).not.toContain('Lobby Loop');
  });

  it('runs the approved write once and keeps the data part out of the model input', async () => {
    const { backend, config, prompts } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }));
    const { handler, message } = await turn(config);
    const part = message.parts.find((entry) => entry.type === 'data-approval-subjects');
    expect(part).toBeDefined();
    const second = await streamChunks(await handler(post([user, answered(message, true)])));
    expect(second.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({ toolCallId: 'call-1' });
    expect(writes(backend.calls)).toHaveLength(1);
    expect(promptText(prompts)).not.toContain('Lobby Loop');
    expect(promptText(prompts)).not.toContain('data-approval-subjects');
  });

  it('refuses a call for a record that does not exist: no card, the model gets not_found (404)', async () => {
    const { backend, config, prompts } = deletePlaylist(() => failure(404, { detail: 'Playlist 7 is gone, owner alice' }));
    const { chunks } = await turn(config);
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(chunks.some((chunk) => chunk.type === 'data-approval-subjects')).toBe(false);
    expect(chunks.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({
      toolCallId: 'call-1', errorText: APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS.approval_subject_not_found,
    });
    expect(writes(backend.calls)).toHaveLength(0);
    const text = promptText(prompts);
    expect(text).toContain('approval_subject_not_found');
    expect(text).not.toContain('alice');
  });

  it('gives the model the same text for 403 as for 404, and the chat the same text', async () => {
    const outcome = async (status: number) => {
      const { config, prompts } = deletePlaylist(() => failure(status, { detail: `status ${status} detail` }));
      const { chunks } = await turn(config);
      const tool = (prompts[1] as Array<{ role: string; content: unknown }>).find((message) => message.role === 'tool');
      return { tool: JSON.stringify(tool), chat: chunks.find((chunk) => chunk.type === 'tool-output-error')?.errorText };
    };
    const notFound = await outcome(404);
    const forbidden = await outcome(403);
    expect(forbidden).toEqual(notFound);
    expect(forbidden.tool).not.toContain('403');
  });

  it('shows a card that warns for a 403 when the tool says onForbidden: warn', async () => {
    const { config } = deletePlaylist(() => failure(403), { deletePlaylist: { approvalSubject: { onForbidden: 'warn' } } });
    const { chunks } = await turn(config);
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ status: 'unknown', check: 'unchecked', reason: 'forbidden' });
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
  });

  it('keeps the warning card for a 403 with onForbidden: warn also under onUnavailable: block', async () => {
    const { config } = deletePlaylist(() => failure(403), { deletePlaylist: { approvalSubject: { onForbidden: 'warn', onUnavailable: 'block' } } });
    const { chunks } = await turn(config);
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'forbidden' });
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
  });

  it.each([400, 422])('refuses an id the read source rejects (%i) as invalid_id', async (status) => {
    const { config, prompts } = deletePlaylist(() => failure(status));
    const { chunks } = await turn(config);
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(promptText(prompts)).toContain('approval_subject_invalid_id');
  });

  it.each([
    ['a 5xx', () => failure(503), 'unavailable'],
    ['a 429', () => failure(429), 'rate_limited'],
    ['a network error', () => { throw new Error('ECONNRESET'); }, 'unavailable'],
    ['a different id', () => ok({ playlist_id: 8, displayName: 'Other' }), 'mismatch'],
    ['an answer without the declared id', () => ok({ name: 'x' }), 'invalid_response'],
  ] as const)('warns on the card for %s (not checkable, never named)', async (_label, route, reason) => {
    const { config } = deletePlaylist(route as never);
    const { chunks } = await turn(config);
    const subject = subjectsPart(chunks)!.data.subjects[0]!;
    expect(subject).toMatchObject({ status: 'unknown', check: 'unchecked', reason });
    expect(subject.name).toBeUndefined();
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
  });

  it('refuses a not checkable call with onUnavailable: block (approval_subject_unavailable)', async () => {
    const { config, prompts, backend } = deletePlaylist(() => failure(503), { deletePlaylist: { approvalSubject: { onUnavailable: 'block' } } });
    const { chunks } = await turn(config);
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(promptText(prompts)).toContain('approval_subject_unavailable');
    expect(writes(backend.calls)).toHaveLength(0);
  });

  it('keeps block for a role whose tool set has no read source: not checkable, refused', async () => {
    const { config, prompts, backend } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }), {
      deletePlaylist: { approvalSubject: { onUnavailable: 'block' } },
    });
    const tools = { ...config.tools };
    delete tools.get_playlist;
    const { chunks } = await turn({ ...config, tools });
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(promptText(prompts)).toContain('approval_subject_unavailable');
    expect(backend.calls).toHaveLength(0);
  });

  it('warns for a declared write tool whose read source is not in the tool set (v2, source_unavailable)', async () => {
    const { config } = deletePlaylist(() => ok({}), { deletePlaylist: { approvalSubject: {} } });
    const tools = { ...config.tools };
    delete tools.get_playlist;
    const { chunks } = await turn({ ...config, tools });
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'source_unavailable', ids: { playlist_id: '7' } });
    expect(chunks.find((chunk) => chunk.type === 'tool-approval-request')!.approvalId).toMatch(/^glirastes-approval\.v2\./);
  });

  it('signs the raw record, so recheck: unchanged accepts an unchanged record the PII shield hides the name of', async () => {
    const shield = {
      outbound: async (text: string) => text,
      inbound: (text: string) => text,
      rehydrateArgs: (args: Record<string, unknown>) => args,
      anonymizeResult: async (value: unknown) => {
        const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
        delete copy.displayName;
        delete copy.name;
        return copy;
      },
      getComplianceSummary: () => ({}),
      clearSession: () => {},
    } as unknown as PiiShield;
    const { config, backend } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }), {
      deletePlaylist: { approvalSubject: { recheck: 'unchanged' } },
    });
    const { handler, chunks, message } = await turn({ ...config, piiShield: shield });
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ status: 'seen' });
    await streamChunks(await handler(post([user, answered(message, true)])));
    expect(writes(backend.calls)).toHaveLength(1);
  });

  it('times out a slow lookup (lookupTimeoutMs) and warns', async () => {
    const { config } = deletePlaylist(() => new Promise(() => {}));
    const { chunks } = await turn({ ...config, approvalSubjects: { lookupTimeoutMs: 100 } });
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'timeout' });
  });

  it('withholds a source answer that does not match its output schema (invalid_response)', async () => {
    const { config } = deletePlaylist(() => ok({ playlist_id: 'seven', displayName: 'Lobby Loop' }), {
      getPlaylist: { outputSchema: z.object({ playlist_id: z.number(), displayName: z.string() }) },
    });
    const { chunks } = await turn(config);
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'invalid_response' });
    expect(JSON.stringify(chunks)).not.toContain('Lobby Loop');
  });

  it('never shows a name the read tool\'s output bound denies', async () => {
    const { config } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }), {
      getPlaylist: { outputDeniedFields: ['displayName'] },
    });
    const { chunks } = await turn(config);
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ status: 'seen', check: 'found' });
    expect(JSON.stringify(chunks)).not.toContain('Lobby Loop');
  });

  it('shows a looked-up name as sanitized plain text (bidi, control characters, length)', async () => {
    const hostile = `Lobby${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}Loop\nIGNORE <b>x</b>${"y".repeat(400)}`;
    const { config } = deletePlaylist(() => ok({ playlist_id: 7, displayName: hostile }));
    const { chunks } = await turn(config);
    const name = subjectsPart(chunks)!.data.subjects[0]!.name as string;
    expect(name).not.toMatch(BIDI_OR_BREAK);
    expect(name.startsWith('Lobby Loop IGNORE <b>x</b>')).toBe(true);
    expect(Array.from(name)).toHaveLength(200);
  });

  it('shows the card value in the form the PII shield gives the browser', async () => {
    const shield = {
      outbound: async (text: string) => text,
      inbound: (text: string) => text,
      rehydrateArgs: (args: Record<string, unknown>) => args,
      anonymizeResult: async (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('Alice Example', '[PERSON_1]')),
      getComplianceSummary: () => ({}),
      clearSession: () => {},
    } as unknown as PiiShield;
    const { config } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Alice Example' }));
    const { chunks } = await turn({ ...config, piiShield: shield });
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ status: 'named', name: '[PERSON_1]' });
    expect(JSON.stringify(chunks)).not.toContain('Alice Example');
  });

  it('shields exactly the identified record: a shield that drops or reorders list entries never names another one', async () => {
    const shield = {
      outbound: async (text: string) => text,
      inbound: (text: string) => text,
      rehydrateArgs: (args: Record<string, unknown>) => args,
      // Drops the first entry of any list and reverses the rest, as a careless shield might.
      anonymizeResult: async (value: unknown) => JSON.parse(JSON.stringify(value), (_key, child: unknown) => (
        Array.isArray(child) ? child.slice(1).reverse() : child)),
      getComplianceSummary: () => ({}),
      clearSession: () => {},
    } as unknown as PiiShield;
    const backend = fakeBackend({ 'GET /channels': () => ok([{ key: 'cafe', title: 'Cafe' }, { key: 'lobby', title: 'Lobby screens' }, { key: 'foyer', title: 'Foyer' }]) });
    const { model } = callingModel([{ toolName: 'delete_channel', input: { key: 'lobby' } }]);
    const { chunks } = await turn({
      tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller, piiShield: shield,
    });
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ status: 'named', name: 'Lobby screens', id: 'lobby' });
  });

  it('types the subject by its declaration: playlist 3, never user 3 (SA-05)', async () => {
    const backend = fakeBackend({
      'GET /playlists/3': () => ok({ playlist_id: 3, displayName: 'Lobby Loop' }),
      'GET /users/3': () => ok({ id: 3, displayName: 'Linus Torvalds' }),
    });
    const { model } = callingModel([{ toolName: 'delete_playlist', input: { playlist_id: 3 } }]);
    const { chunks } = await turn({ tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(subjectsPart(chunks)!.data.subjects).toEqual([expect.objectContaining({ type: 'playlist', name: 'Lobby Loop' })]);
    expect(backend.calls.map((call) => call.path)).toEqual(['/playlists/3']);
  });

  it('finds a speaking key in a complete list exactly, never a case-only match, and refuses one that is not on it (SA-06)', async () => {
    const channels = [{ key: 'lobby', title: 'Lobby screens' }, { key: 'cafe', title: 'Cafe' }];
    const run = async (key: string, idCase?: 'ignore-case') => {
      const backend = fakeBackend({ 'GET /channels': () => ok(channels) });
      const { model, prompts } = callingModel([{ toolName: 'delete_channel', input: { key } }]);
      const tools = referenceTools();
      if (idCase) (tools.list_channels as { entityLookup?: unknown }).entityLookup = { type: 'channel', params: {}, complete: true, idCase };
      const { chunks } = await turn({ tools, model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
      return { chunks, prompts };
    };
    const found = await run('lobby');
    expect(subjectsPart(found.chunks)!.data.subjects[0]).toMatchObject({ status: 'named', name: 'Lobby screens', idKind: 'speaking', id: 'lobby' });
    // `LOBBY` may be another record on a backend that tells case apart: not checkable, never named, never refused.
    const caseOnly = await run('LOBBY');
    expect(subjectsPart(caseOnly.chunks)!.data.subjects[0]).toMatchObject({ status: 'unknown', check: 'unchecked', reason: 'mismatch' });
    expect(subjectsPart(caseOnly.chunks)!.data.subjects[0]!.name).toBeUndefined();
    expect(caseOnly.chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
    expect((await run(' lobby')).chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
    // Only a lookup that declares ids ignore case finds it.
    const declared = await run('LOBBY', 'ignore-case');
    expect(subjectsPart(declared.chunks)!.data.subjects[0]).toMatchObject({ status: 'named', name: 'Lobby screens' });
    const missing = await run('garage');
    expect(missing.chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(promptText(missing.prompts)).toContain('approval_subject_not_found');
  });

  it('never proves absence through nested lists, also with an empty part next to a broken one', async () => {
    const backend = fakeBackend({ 'GET /channels': () => ok({ groups: [{ items: [] }, null] }) });
    const { model, prompts } = callingModel([{ toolName: 'delete_channel', input: { key: 'garage' } }]);
    const tools = referenceTools();
    Object.assign(tools.list_channels!, { outputEntities: [{ type: 'channel', id: 'key', name: 'title', path: 'groups[].items[]' }] });
    const { chunks } = await turn({ tools, model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ check: 'unchecked' });
    expect(promptText(prompts)).not.toContain('approval_subject_not_found');
  });

  it('never refuses on a complete list with an entry without the declared id (invalid_response)', async () => {
    for (const answer of [[{ key: 'lobby', title: 'Lobby screens' }, { title: 'No key' }], [null], ['lobby']]) {
      const backend = fakeBackend({ 'GET /channels': () => ok(answer) });
      const { model } = callingModel([{ toolName: 'delete_channel', input: { key: 'garage' } }]);
      const { chunks } = await turn({ tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
      expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'invalid_response' });
    }
  });

  it('looks a version up through its parent playlist and shows the fallback (SA-07, composite lookup by ref)', async () => {
    const backend = fakeBackend({
      'GET /playlists/3': () => ok({ playlist_id: 3, displayName: 'Lobby Loop' }),
      'GET /playlists/3/versions': () => ok([{ version_id: 301, versionNumber: 1 }, { version_id: 303, versionNumber: 3 }]),
    });
    const { model } = callingModel([{ toolName: 'roll_back_playlist', input: { playlist_id: 3, version_id: 303 } }]);
    const { chunks } = await turn({ tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(subjectsPart(chunks)!.data.subjects).toEqual([
      expect.objectContaining({ type: 'playlist', role: 'parent', status: 'named', name: 'Lobby Loop' }),
      expect.objectContaining({ type: 'playlist-version', role: 'target', status: 'seen', fallbackField: 'versionNumber', fallbackValue: 3, ids: { version_id: '303' } }),
    ]);
  });

  it('never says "does not exist" for an object missing from one page of a list: not checkable (list-page case)', async () => {
    const backend = fakeBackend({
      'GET /users?limit=2': () => ok({ items: [{ user_id: 1, name: 'Ann' }, { user_id: 2, name: 'Bob' }] }),
      'DELETE /users/9': () => ok({}),
    });
    const { model, prompts } = callingModel([{ toolName: 'delete_user', input: { user_id: 9 } }]);
    const { chunks } = await turn({ tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ status: 'unknown', check: 'unchecked', reason: 'not_in_page' });
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
    expect(promptText(prompts)).not.toContain('approval_subject_not_found');
    // Exactly one page: the declared page size, no paging.
    expect(backend.calls.map((call) => call.path)).toEqual(['/users?limit=2']);
  });

  it('reads one list once for twenty calls of a request (cache) and limits the lookups of a request', async () => {
    const keys = Array.from({ length: 20 }, (_, index) => `c${index}`);
    const backend = fakeBackend({ 'GET /channels': () => ok(keys.map((key) => ({ key, title: key.toUpperCase() }))) });
    const { model } = callingModel(keys.map((key, index) => ({ toolName: 'delete_channel', input: { key }, id: `call-${index + 1}` })));
    const { chunks } = await turn({ tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(backend.calls).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === 'data-approval-subjects')).toHaveLength(20);

    const playlists = fakeBackend({
      'GET /playlists/1': () => ok({ playlist_id: 1, displayName: 'One' }),
      'GET /playlists/2': () => ok({ playlist_id: 2, displayName: 'Two' }),
      'GET /playlists/3': () => ok({ playlist_id: 3, displayName: 'Three' }),
    });
    const limited = callingModel([1, 2, 3].map((id) => ({ toolName: 'delete_playlist', input: { playlist_id: id }, id: `call-${id}` })));
    const result = await turn({
      tools: referenceTools(), model: limited.model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: playlists.endpointCaller,
      approvalSubjects: { maxLookupsPerTurn: 2 },
    });
    expect(playlists.calls).toHaveLength(2);
    expect(subjectsPart(result.chunks, 'call-3')!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'limit' });
  });

  it('stops asking a source that answered 429 for the rest of the request', async () => {
    const backend = fakeBackend({ 'GET /playlists/1': () => failure(429), 'GET /playlists/2': () => ok({ playlist_id: 2, displayName: 'Two' }) });
    const { model } = callingModel([1, 2].map((id) => ({ toolName: 'delete_playlist', input: { playlist_id: id }, id: `call-${id}` })));
    const { chunks } = await turn({ tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(backend.calls).toHaveLength(1);
    expect(subjectsPart(chunks, 'call-2')!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'rate_limited' });
  });

  it('limits the subjects of one call (maxSubjectsPerCall)', async () => {
    const backend = fakeBackend({
      'GET /playlists/3': () => ok({ playlist_id: 3, displayName: 'Lobby Loop' }),
      'GET /playlists/3/versions': () => ok([{ version_id: 303, versionNumber: 3 }]),
    });
    const { model } = callingModel([{ toolName: 'roll_back_playlist', input: { playlist_id: 3, version_id: 303 } }]);
    const { chunks } = await turn({
      tools: referenceTools(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller,
      approvalSubjects: { maxSubjectsPerCall: 1 },
    });
    expect(subjectsPart(chunks)!.data.subjects.map((subject) => subject.reason ?? subject.check)).toEqual(['found', 'limit']);
    expect(backend.calls).toHaveLength(1);
  });

  it('treats a read source that itself needs approval as not available', async () => {
    const { config, backend } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }), { getPlaylist: { needsApproval: true } });
    const { chunks } = await turn(config);
    expect(subjectsPart(chunks)!.data.subjects[0]).toMatchObject({ check: 'unchecked', reason: 'source_unavailable' });
    expect(backend.calls).toHaveLength(0);
  });

  it('refuses a v1 approval id for a declared tool (no downgrade), and ignores the client\'s copy of the subjects', async () => {
    const { config, backend } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }));
    const { handler, message } = await turn(config);
    const v1 = createApprovalBinder({ secret: SECRET }).issue({ toolCallId: 'call-1', toolName: 'delete_playlist', input: { playlist_id: 7 } });
    const downgraded = answered(message, true, (part) => (part.type === 'data-approval-subjects'
      ? { ...part, data: { ...(part.data as object), subjects: [] } }
      : { ...part, approval: { ...(part.approval as object), id: v1 } }));
    const second = await streamChunks(await handler(post([user, downgraded])));
    expect(second.some((chunk) => chunk.type === 'tool-output-available')).toBe(false);
    expect(writes(backend.calls)).toHaveLength(0);
  });

  it('checks again before an approved call runs with recheck: exists (approval_subject_gone)', async () => {
    let gone = false;
    const { config, backend, prompts } = deletePlaylist(() => (gone ? failure(404) : ok({ playlist_id: 7, displayName: 'Lobby Loop' })), {
      deletePlaylist: { approvalSubject: { recheck: 'exists' } },
    });
    const { handler, message } = await turn(config);
    gone = true;
    const second = await streamChunks(await handler(post([user, answered(message, true)])));
    expect(second.some((chunk) => chunk.type === 'tool-output-available')).toBe(false);
    expect(writes(backend.calls)).toHaveLength(0);
    expect(promptText(prompts)).toContain('no longer exists');
  });

  it('rechecks the validated input (schema defaults), not the raw one of the history', async () => {
    let gone = false;
    const backend = fakeBackend({
      'GET /playlists/7': () => (gone ? failure(404) : ok({ playlist_id: 7, displayName: 'Lobby Loop' })),
      'DELETE /playlists/7': () => ok({}),
    });
    const { model } = callingModel([{ toolName: 'delete_playlist', input: {} }]);
    const tools = referenceTools({
      deletePlaylist: { inputSchema: z.object({ playlist_id: z.number().int().default(7) }).strict(), approvalSubject: { recheck: 'exists' } },
    });
    const first = await turn({ tools, model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(subjectsPart(first.chunks)!.data.subjects[0]).toMatchObject({ name: 'Lobby Loop' });
    gone = true;
    await streamChunks(await first.handler(post([user, answered(first.message, true)])));
    expect(writes(backend.calls)).toHaveLength(0);
  });

  it('refuses an approved call whose record changed with recheck: unchanged, and runs an unchanged one', async () => {
    let name = 'Lobby Loop';
    const { config, backend, prompts } = deletePlaylist(() => ok({ playlist_id: 7, displayName: name }), {
      deletePlaylist: { approvalSubject: { recheck: 'unchanged' } },
    });
    const first = await turn(config);
    name = 'Renamed';
    await streamChunks(await first.handler(post([user, answered(first.message, true)])));
    expect(writes(backend.calls)).toHaveLength(0);
    expect(promptText(prompts)).toContain('has changed since the approval');

    name = 'Lobby Loop';
    const again = await turn({ ...config, model: callingModel([{ toolName: 'delete_playlist', input: { playlist_id: 7 } }]).model });
    await streamChunks(await again.handler(post([user, answered(again.message, true)])));
    expect(writes(backend.calls)).toHaveLength(1);
  });

  it('builds a preview from a POST dry-run that declares lookupEffect: read, without lowering its own approval', async () => {
    const preview = defineEndpointTool({
      id: 'assignments.preview', toolName: 'preview_assignment', description: 'Preview an assignment.', method: 'POST',
      path: '/playlists/:playlist_id/assignment/preview',
      inputSchema: z.object({ playlist_id: z.number().int(), group: z.string() }).strict(),
      lookupEffect: 'read',
    });
    const assign = defineEndpointTool({
      id: 'assignments.create', toolName: 'assign_playlist', description: 'Assign.', method: 'POST',
      path: '/playlists/:playlist_id/assignment',
      inputSchema: z.object({ playlist_id: z.number().int(), group: z.string() }).strict(),
      inputEntities: [{ type: 'playlist', args: 'playlist_id' }],
      approvalSubject: {
        preview: {
          tool: 'preview_assignment',
          params: { playlist_id: 'playlist_id', group: 'group' },
          fields: [{ path: 'devices', label: { en: 'Devices', de: 'Geräte' }, format: 'count' }, { path: 'summary', label: 'Summary' }],
        },
      },
    });
    const backend = fakeBackend({
      'GET /playlists/7': () => ok({ playlist_id: 7, displayName: 'Lobby Loop' }),
      'POST /playlists/7/assignment/preview': (request) => ok({ devices: [1, 2, 3], summary: `to ${(request.body as { group: string }).group}` }),
    });
    const tools = { ...referenceTools(), ...endpointToolsToRegistry([preview, assign]) };
    const { model } = callingModel([{ toolName: 'assign_playlist', input: { playlist_id: 7, group: 'lobby' } }]);
    const { chunks } = await turn({ tools, model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(subjectsPart(chunks)!.data.preview).toEqual({
      check: 'found',
      fields: [
        { key: 'devices', label: { en: 'Devices', de: 'Geräte' }, value: 3, format: 'count' },
        { key: 'summary', label: 'Summary', value: 'to lobby' },
      ],
    });
    expect(backend.calls.find((call) => call.method === 'POST')).toMatchObject({ body: { group: 'lobby' } });
    // The dry-run keeps its own approval when the model calls it.
    expect(tools.preview_assignment!.needsApproval).toBe(true);
    expect(tools.preview_assignment!.lookupEffect).toBe('read');
  });

  it('never uses a POST without lookupEffect as a preview source', async () => {
    const preview = defineEndpointTool({
      id: 'assignments.preview', toolName: 'preview_assignment', description: 'Preview.', method: 'POST',
      path: '/playlists/:playlist_id/assignment/preview', inputSchema: z.object({ playlist_id: z.number().int() }).strict(),
    });
    const assign = defineEndpointTool({
      id: 'assignments.create', toolName: 'assign_playlist', description: 'Assign.', method: 'POST', path: '/playlists/:playlist_id/assignment',
      inputSchema: z.object({ playlist_id: z.number().int() }).strict(),
      approvalSubject: { preview: { tool: 'preview_assignment', params: { playlist_id: 'playlist_id' }, fields: [{ path: 'devices', label: 'Devices', format: 'count' }] } },
    });
    const backend = fakeBackend({});
    const { model } = callingModel([{ toolName: 'assign_playlist', input: { playlist_id: 7 } }]);
    const { chunks } = await turn({ tools: endpointToolsToRegistry([preview, assign]), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller });
    expect(subjectsPart(chunks)!.data.preview).toEqual({ check: 'unchecked', reason: 'source_unavailable', fields: [] });
    expect(backend.calls).toHaveLength(0);
  });

  it('makes no lookup with approvalSubjects: false, and the card falls back to the history (v1 ids)', async () => {
    const { config, backend } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }));
    const { chunks } = await turn({ ...config, approvalSubjects: false });
    expect(chunks.some((chunk) => chunk.type === 'data-approval-subjects')).toBe(false);
    expect(chunks.find((chunk) => chunk.type === 'tool-approval-request')!.approvalId).toMatch(/^glirastes-approval\.v1\./);
    expect(backend.calls).toHaveLength(0);
  });

  it('refuses a direct command of a tool that declares block or a recheck (no lookup runs there), runs one that declares neither', async () => {
    const command = formatChatCommandMessage({
      commandId: 'playlists.delete', tool: 'playlists.delete', args: { playlist_id: 7 }, label: '/Delete playlist',
    });
    for (const [option, refused] of [
      [{ onUnavailable: 'block' }, true],
      [{ recheck: 'exists' }, true],
      [{}, false],
    ] as const) {
      const backend = fakeBackend({ 'GET /playlists/7': () => ok({ playlist_id: 7, displayName: 'Lobby Loop' }) });
      const { model } = callingModel([]);
      const handler = createAiChatHandler({
        tools: referenceTools({ deletePlaylist: { approvalSubject: option } }), model, systemPrompt: 'A', approvalSecret: SECRET,
        endpointCaller: backend.endpointCaller,
      });
      const chunks = await streamChunks(await handler(post([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: command }] }])));
      const error = chunks.find((chunk) => chunk.type === 'tool-output-error');
      if (refused) expect(error).toMatchObject({ errorText: 'approval_subject_check_required' });
      else expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true);
      expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    }
  });

  it('makes no lookup for a custom streamHandler', async () => {
    const { config, backend } = deletePlaylist(() => ok({ playlist_id: 7, displayName: 'Lobby Loop' }));
    let seen: unknown = 'unset';
    const response = await (await import('../create-ai-chat-handler.js')).createAiChatHandler({
      ...config,
      streamHandler: async (ctx) => {
        seen = ctx.approvalSubjects;
        return new Response('ok');
      },
    })(post([user]));
    await response.text();
    expect(seen).toBeUndefined();
    expect(backend.calls).toHaveLength(0);
  });

  it('counts nothing new for a code-defined tool without a declaration', async () => {
    const run = vi.fn(async () => ({ success: true }));
    const { model } = callingModel([{ toolName: 'tasks_archive', input: { id: 't1' } }]);
    const { chunks } = await turn({
      tools: { tasks_archive: defineTool({ id: 'tasks.archive', description: 'Archive.', inputSchema: z.object({ id: z.string() }), needsApproval: true, execute: run }) },
      model, systemPrompt: 'A', approvalSecret: SECRET,
    });
    expect(chunks.some((chunk) => chunk.type === 'data-approval-subjects')).toBe(false);
    expect(chunks.find((chunk) => chunk.type === 'tool-approval-request')!.approvalId).toMatch(/^glirastes-approval\.v1\./);
  });
});

describe('apps without a server declaration (golden)', () => {
  /** The stream text with the random parts (message ids, approval nonces and MACs) replaced. */
  const normalized = async (response: Response) => (await response.text())
    .replace(/"messageId":"[^"]+"/g, '"messageId":"<id>"')
    .replace(/"(updatedAt|createdAt)":"[^"]+"/g, '"$1":"<time>"')
    .replace(/glirastes-approval\.v1\.\d+\.\d+\.[\w-]+\.[\w-]+/g, 'glirastes-approval.v1.<iat>.<exp>.<nonce>.<mac>');

  const undeclared = () => {
    // Identity declared as in #110, but no entityLookup anywhere.
    const tools = referenceTools({ getPlaylist: { entityLookup: undefined } });
    for (const name of ['list_playlist_versions', 'list_channels', 'list_users']) delete (tools[name] as { entityLookup?: unknown }).entityLookup;
    return tools;
  };

  it('streams byte for byte what it streams with the lookups turned off', async () => {
    const run = async (extra: Record<string, unknown>) => {
      const backend = fakeBackend({ 'GET /playlists/7': () => ok({ playlist_id: 7, displayName: 'Lobby Loop' }) });
      const { model } = callingModel([{ toolName: 'delete_playlist', input: { playlist_id: 7 } }]);
      const handler = createAiChatHandler({
        tools: undeclared(), model, systemPrompt: 'A', approvalSecret: SECRET, endpointCaller: backend.endpointCaller, ...extra,
      });
      return { text: await normalized(await handler(post([user]))), calls: backend.calls.length };
    };
    const on = await run({});
    const off = await run({ approvalSubjects: false });
    expect(on.text).toBe(off.text);
    expect(on.calls).toBe(0);
    const types = on.text.split('\n').filter((line) => line.startsWith('data: {'))
      .map((line) => (JSON.parse(line.slice(6)) as { type: string }).type);
    expect(types).toEqual([
      'data-tool-entities', 'data-pipeline-state', 'start', 'start-step', 'tool-input-available', 'data-step-report',
      'tool-approval-request', 'finish-step', 'data-pipeline-state', 'finish',
    ]);
    expect(on.text).toContain('glirastes-approval.v1.<iat>');
    expect(on.text).not.toContain('data-approval-subjects');
  });
});
