import { describe, expect, it } from 'vitest';
import { UI_OUTCOME_MODEL_TEXTS, type RuntimeMetricEvent } from '../../../../contracts/index.js';
import { createJsonSchemaLike } from '../../../../runtime/json-schema.js';
import type { RuntimeMetricsSink } from '../../../../runtime/index.js';
import { uiActionToolToTool } from '../../../core/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import {
  SECRET,
  callingModel,
  clientMessage,
  fakeBackend,
  ok,
  promptText,
  referenceTools,
  streamChunks,
  subjectsPart,
  user,
} from './approval-subject-fixtures.js';

/** Server approval subjects next to the UI-action outcome protocol (#115) in one step. */

const navigate = uiActionToolToTool({
  id: 'ui.navigate',
  toolName: 'ui_navigate',
  description: 'Open a page of the app.',
  inputSchema: createJsonSchemaLike({ type: 'object', properties: { destination: { type: 'string' } } }),
  needsApproval: false,
  action: { kind: 'navigate' },
});

function metricsSink() {
  const events: RuntimeMetricEvent[] = [];
  const sink: RuntimeMetricsSink = {
    identity: {
      appId: '019fb900-0000-7000-8000-0000000000a1',
      environmentId: '019fb900-0000-7000-8000-0000000000e1',
      buildId: null,
      instanceId: 'web-1',
    },
    record: (event) => { events.push(event); },
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

const post = (messages: unknown[]) => new Request('https://app.example/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer user-token' },
  body: JSON.stringify({ messages, glirastesUiOutcomes: 1 }),
});

describe('approval subjects and UI-action outcomes in one step', () => {
  it('asks with server subjects and a v2 id, hands the UI action off, and continues as an approval with both', async () => {
    const backend = fakeBackend({
      'GET /playlists/7': () => ok({ playlist_id: 7, displayName: 'Lobby Loop' }),
      'DELETE /playlists/7': () => ok({ deleted: 7 }),
    });
    const tools = { ...referenceTools(), ui_navigate: navigate };
    const { sink, events } = metricsSink();
    const first = callingModel([
      { toolName: 'delete_playlist', input: { playlist_id: 7 }, id: 'call-del' },
      { toolName: 'ui_navigate', input: { destination: '/playlists' }, id: 'call-nav' },
    ]);
    const handler = createAiChatHandler({
      tools, model: first.model, systemPrompt: 'Assistant', approvalSecret: SECRET, endpointCaller: backend.endpointCaller, metrics: sink,
    });
    const chunks = await streamChunks(await handler(post([user])));
    expect(subjectsPart(chunks, 'call-del')!.data.subjects[0]).toMatchObject({ status: 'named', name: 'Lobby Loop' });
    const request = chunks.find((chunk) => chunk.type === 'tool-approval-request') as { approvalId: string };
    expect(request.approvalId).toMatch(/^glirastes-approval\.v2\./);
    const uiOutput = chunks.find((chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'call-nav')!.output as Record<string, unknown>;
    expect(uiOutput).toMatchObject({ handedOff: true, awaitsOutcome: true });

    // The browser approves the card and reports the UI outcome in the same message.
    const message = await clientMessage(chunks);
    const answered = JSON.parse(JSON.stringify({
      ...message,
      parts: message.parts.map((part) => {
        const record = part as Record<string, unknown>;
        if (record.state === 'approval-requested') {
          return { ...record, state: 'approval-responded', approval: { id: (record.approval as { id: string }).id, approved: true } };
        }
        if (record.toolCallId === 'call-nav') {
          return { ...record, output: { ...(record.output as object), outcome: { v: 1, code: 'ok', at: 1 } } };
        }
        return record;
      }),
    }));
    expect(answered.parts.some((part: { type: string }) => part.type === 'data-approval-subjects')).toBe(true);

    const finished: Array<Record<string, unknown>> = [];
    const second = callingModel([]);
    const resume = createAiChatHandler({
      tools, model: second.model, systemPrompt: 'Assistant', approvalSecret: SECRET, endpointCaller: backend.endpointCaller, metrics: sink,
      onFinish: (event) => { finished.push(event as unknown as Record<string, unknown>); },
    });
    const continued = await streamChunks(await resume(post([user, answered])));

    // The v2 approval survives the continuation and runs once.
    expect(continued.find((chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'call-del')).toBeDefined();
    expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    // The model gets the outcome's fixed text, never the data part or the looked-up name.
    const sent = promptText(second.prompts);
    expect(sent).toContain(UI_OUTCOME_MODEL_TEXTS.ok);
    expect(sent).not.toContain('data-approval-subjects');
    expect(sent).not.toContain('Lobby Loop');
    // The continuation predicate and the metric see an approval continuation, as without subjects.
    expect(finished).toEqual([expect.objectContaining({ continuation: 'approval' })]);
    expect(events.map((event) => event.eventType)).toEqual(['turn.finished', 'turn.continued']);
    expect(events[1]).toMatchObject({ continuation: 'approval' });
  });
});
