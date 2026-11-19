import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { ModelInputEvent } from '../types.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function model() {
  const prompts: unknown[] = [];
  return {
    prompts,
    model: new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Done.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ] as never),
        };
      },
    }),
  };
}

const playlists = defineTool({
  id: 'playlists.list',
  description: 'List playlists.',
  inputSchema: z.object({}),
  method: 'GET',
  outputEntities: [{ type: 'playlist', id: 'playlist_id', name: 'displayName', path: 'data[]' }],
  execute: async () => ({ data: [] }),
});

/** A list turn, `chats` turns without tools, then the current question. */
function request(chats: number) {
  const messages: unknown[] = [
    { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Playlists?' }] },
    {
      id: 'a0', role: 'assistant', parts: [{
        type: 'tool-playlists_list', toolCallId: 'c1', state: 'output-available', input: {},
        output: { success: true, data: [{ playlist_id: 17, displayName: 'Morning Mix' }] },
      }, { type: 'text', text: 'One playlist.' }],
    },
  ];
  for (let index = 1; index <= chats; index += 1) {
    messages.push(
      { id: `u${index}`, role: 'user', parts: [{ type: 'text', text: `thanks ${index}` }] },
      { id: `a${index}`, role: 'assistant', parts: [{ type: 'text', text: 'Welcome.' }] },
    );
  }
  messages.push({ id: 'uq', role: 'user', parts: [{ type: 'text', text: 'Rename Morning Mix' }] });
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, onModelInput: true, debug: true }),
  });
}

const promptText = (prompts: unknown[]) => JSON.stringify(prompts);

describe('onModelInput', () => {
  it('receives the messages of every model step and the history breakdown, and none of it reaches the stream', async () => {
    const events: ModelInputEvent[] = [];
    const { model: chatModel, prompts } = model();
    const handler = createAiChatHandler({
      tools: { playlists_list: playlists }, model: chatModel, systemPrompt: 'A.', intentRouting: false,
      onModelInput: (event: ModelInputEvent) => events.push(event),
    } as never);
    const body = await (await handler(request(1))).text();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stepNumber: 0,
      breakdown: { pipeline: 'turn-aware', toolTurnCounting: 'all-turns', turns: [{ mode: 'text' }, { mode: 'text' }] },
    });
    expect(events[0]!.estimatedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(events[0]!.messages)).toContain('Rename Morning Mix');
    expect(prompts).toHaveLength(1);
    expect(body).not.toContain('breakdown');
    expect(body).not.toContain('estimatedTokens');
  });

  it('is never called without the server option, whatever the request says', async () => {
    const { model: chatModel } = model();
    const handler = createAiChatHandler({ tools: { playlists_list: playlists }, model: chatModel, systemPrompt: 'A.', intentRouting: false } as never);
    const body = await (await handler(request(1))).text();
    expect(body).not.toContain('breakdown');
  });

  it('a throwing hook does not break the turn', async () => {
    const { model: chatModel } = model();
    const handler = createAiChatHandler({
      tools: { playlists_list: playlists }, model: chatModel, systemPrompt: 'A.', intentRouting: false,
      onModelInput: () => { throw new Error('boom'); },
    } as never);
    const body = await (await handler(request(1))).text();
    expect(body).toContain('Done.');
  });

  it('with chat memory the memo keeps the declared ids of turns the summary folded', async () => {
    const events: ModelInputEvent[] = [];
    const { model: chatModel, prompts } = model();
    const handler = createAiChatHandler({
      tools: { playlists_list: playlists }, model: chatModel, systemPrompt: 'A.', intentRouting: false,
      memory: { chat: { autoCompact: 1_000_000 } },
      history: { seenObjects: true },
      onModelInput: (event: ModelInputEvent) => events.push(event),
    } as never);
    const body = JSON.parse(await request(1).text()) as { messages: Array<{ parts: unknown[] }> };
    // The summary of the conversation up to the list turn travels on the next answer.
    body.messages[3]!.parts.push({ type: 'data-memory-summary', data: { summary: 'The user listed playlists.', upTo: 'a0' } });
    const folded = new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await (await handler(folded)).text();
    expect(events[0]!.breakdown.earlierMessages).toBe(2);
    expect(promptText(prompts)).toContain('The user listed playlists.');
    expect(promptText(prompts)).toContain('playlist: {\\"playlist_id\\":17,\\"displayName\\":\\"Morning Mix\\"}');
  });

  it('with seenObjects and toolTurnCounting the declared list survives turns without tools and the message window', async () => {
    const events: ModelInputEvent[] = [];
    const { model: chatModel, prompts } = model();
    const handler = createAiChatHandler({
      tools: { playlists_list: playlists }, model: chatModel, systemPrompt: 'A.', intentRouting: false,
      maxContextMessages: 4,
      history: { seenObjects: true },
      onModelInput: (event: ModelInputEvent) => events.push(event),
    } as never);
    await (await handler(request(3))).text();
    // The list turn fell out of the 4-message window; the memo still names it.
    expect(promptText(prompts)).toContain('playlist: {\\"playlist_id\\":17,\\"displayName\\":\\"Morning Mix\\"}');
    expect(events[0]!.breakdown.earlierMessages).toBe(5);
    expect(events[0]!.breakdown.seenObjects?.objects).toEqual([{ type: 'playlist', id: [['playlist_id', 17]], label: ['displayName', 'Morning Mix'] }]);

    const { model: plainModel, prompts: plainPrompts } = model();
    const plain = createAiChatHandler({
      tools: { playlists_list: playlists }, model: plainModel, systemPrompt: 'A.', intentRouting: false,
      maxContextMessages: 60,
      history: { toolTurnCounting: 'tool-turns' },
    } as never);
    await (await plain(request(3))).text();
    expect(promptText(plainPrompts)).toContain('Morning Mix');
    expect(promptText(plainPrompts)).toContain('"playlist_id":17');
    expect(promptText(plainPrompts)).not.toContain('seen-objects');
  });
});

describe('seen-objects memo with the PII shield', () => {
  const PLAIN = 'Max Mustermann';
  const PSEUDONYM = 'Erika Beispiel';
  const swap = (text: string, from: string, to: string) => text.split(from).join(to);
  const shield = {
    outbound: async (text: string) => swap(text, PLAIN, PSEUDONYM),
    inbound: (text: string) => swap(text, PSEUDONYM, PLAIN),
    rehydrateArgs: (args: Record<string, unknown>) => args,
    rehydrateArgsAsync: async (args: Record<string, unknown>) => args,
    anonymizeResult: async (result: unknown) => JSON.parse(swap(JSON.stringify(result), PLAIN, PSEUDONYM)),
    getComplianceSummary: () => ({}),
    clearSession: () => {},
  };
  const owners = defineTool({
    id: 'owners.list',
    description: 'List owners.',
    inputSchema: z.object({}),
    method: 'GET',
    outputEntities: [{ type: 'owner', id: 'owner_id', name: 'displayName', path: 'data[]' }],
    execute: async () => ({ data: [{ owner_id: 5, displayName: PLAIN }] }),
  });

  it('keeps the pseudonym the shield sealed when the tool ran, after the result left the window', async () => {
    // Turn 1: the model calls the tool; the stream carries the sealed result.
    let calls = 0;
    const first = new MockLanguageModelV3({
      doStream: async () => {
        calls += 1;
        return {
          stream: convertArrayToReadableStream((calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'c1', toolName: 'owners_list', input: '{}' },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'One owner.' },
                { type: 'text-end', id: 't1' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ]) as never),
        };
      },
    });
    const config = { tools: { owners_list: owners }, systemPrompt: 'A.', intentRouting: false, piiShield: shield };
    const turn1 = await (await createAiChatHandler({ ...config, model: first } as never)(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u0', role: 'user', parts: [{ type: 'text', text: 'Owners?' }] }] }),
    }))).text();
    const output = turn1.split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; output?: unknown })
      .find((part) => part.type === 'tool-output-available')!.output;
    expect(JSON.stringify(output)).toContain(PSEUDONYM);

    // Later: the list turn is outside the window; the memo carries the sealed value.
    const { model: chatModel, prompts } = model();
    const messages: unknown[] = [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: `Owners of ${PLAIN}?` }] },
      { id: 'a0', role: 'assistant', parts: [{ type: 'tool-owners_list', toolCallId: 'c1', state: 'output-available', input: {}, output }, { type: 'text', text: 'One owner.' }] },
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Welcome.' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Rename the owner' }] },
    ];
    await (await createAiChatHandler({ ...config, model: chatModel, maxContextMessages: 3, history: { seenObjects: true } } as never)(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
    }))).text();
    const sent = promptText(prompts);
    expect(sent).toContain(`owner: {\\"owner_id\\":5,\\"displayName\\":\\"${PSEUDONYM}\\"}`);
    expect(sent).not.toContain(PLAIN);
  });
});
