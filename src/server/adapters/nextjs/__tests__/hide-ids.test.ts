import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { collectIdLabels, createHideIdsTransform, redactIds, type IdLabels } from '../hide-ids.js';

const TASK = '3f2a9c1e-4b7d-4e2a-9f10-2c3d4e5f6a7b';
const TEAM = '9b8a7c6d-1e2f-4a3b-8c9d-0e1f2a3b4c5d';
const UNKNOWN = '00000000-1111-4222-8333-444444444444';

function labels(): IdLabels {
  const map: IdLabels = new Map();
  collectIdLabels({
    tasks: [{ id: TASK, taskIdentifier: 'MAR-5', title: 'Flyer drucken', teamId: TEAM, teamName: 'Marketing' }],
  }, map);
  return map;
}

describe('redactIds', () => {
  it('replaces a known id with its readable label and removes an unknown one', () => {
    expect(redactIds(`Aufgabe ${TASK} ist erledigt.`, labels())).toBe('Aufgabe MAR-5 ist erledigt.');
    expect(redactIds(`Team ${TEAM} hat drei Aufgaben.`, labels())).toBe('Team Marketing hat drei Aufgaben.');
    expect(redactIds(`Gelöscht: ${UNKNOWN}.`, labels())).toBe('Gelöscht:.');
  });

  it('drops wrapped and prefixed ids entirely', () => {
    expect(redactIds(`MAR-5 (ID: ${TASK}) ist offen.`, labels())).toBe('MAR-5 ist offen.');
    expect(redactIds(`Marketing [\`${TEAM}\`]`, labels())).toBe('Marketing');
    expect(redactIds(`Flyer drucken, ID: ${UNKNOWN}`, labels())).toBe('Flyer drucken');
    expect(redactIds(`- MAR-5 – UUID ${TASK}`, labels())).toBe('- MAR-5');
  });

  it('leaves ordinary text, keys and dates alone', () => {
    const text = 'MAR-5 ist seit 2026-06-15 überfällig, siehe Abschnitt 3-b.';
    expect(redactIds(text, labels())).toBe(text);
  });

  it('removes a non-UUID id a tool returned', () => {
    const map: IdLabels = new Map();
    collectIdLabels({ id: 'a1b2c3d4e5f60718ab' }, map);
    expect(redactIds('Die Freigabe a1b2c3d4e5f60718ab ist aktiv.', map)).toBe('Die Freigabe ist aktiv.');
  });
});

async function run(chunks: string[], map: IdLabels = labels()): Promise<string> {
  const parts = [
    { type: 'text-start', id: 't' },
    ...chunks.map((text) => ({ type: 'text-delta', id: 't', text })),
    { type: 'text-end', id: 't' },
  ];
  const stream = convertArrayToReadableStream(parts as never)
    .pipeThrough(createHideIdsTransform(map)({ tools: {}, stopStream: () => {} }) as never);
  let text = '';
  for await (const part of stream as unknown as AsyncIterable<{ type: string; text?: string }>) {
    if (part.type === 'text-delta') text += part.text;
  }
  return text;
}

describe('createHideIdsTransform', () => {
  it('replaces an id split over several chunks', async () => {
    const chunks = ['Aufgabe (I', 'D: 3f2a9c1e-4b7d', '-4e2a-9f10-2c3d4e5f6a7b) ist ', 'offen. Team ', TEAM.slice(0, 10), TEAM.slice(10), ' ok'];
    expect(await run(chunks)).toBe('Aufgabe ist offen. Team Marketing ok');
  });

  it('streams ordinary text unchanged', async () => {
    const chunks = ['Drei ', 'Aufgaben ', 'sind überfällig: MAR-1, ', 'MAR-2 und FIN-1.'];
    expect(await run(chunks)).toBe(chunks.join(''));
  });

  it('learns labels from tool results earlier in the stream', async () => {
    const map: IdLabels = new Map();
    const parts = [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'teams', input: {}, output: { teams: [{ id: TEAM, name: 'Vertrieb' }] } },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', text: `Team ${TEAM} gefunden.` },
      { type: 'text-end', id: 't' },
    ];
    const stream = convertArrayToReadableStream(parts as never)
      .pipeThrough(createHideIdsTransform(map)({ tools: {}, stopStream: () => {} }) as never);
    let text = '';
    for await (const part of stream as unknown as AsyncIterable<{ type: string; text?: string }>) {
      if (part.type === 'text-delta') text += part.text;
    }
    expect(text).toBe('Team Vertrieb gefunden.');
  });
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function chat(hideIds?: boolean) {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: `Erledigt: Aufgabe ${UNKNOWN}.` },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] as never),
      };
    },
  });
  const handler = createAiChatHandler({
    tools: [],
    model,
    systemPrompt: 'Assistent.',
    intentRouting: false,
    ...(hideIds === undefined ? {} : { hideIds }),
  } as never);
  const request = new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Erledige sie' }] }] }),
  });
  return { prompts, response: () => handler(request) };
}

describe('createAiChatHandler hideIds', () => {
  it('forbids ids in the prompt and removes them from the answer by default', async () => {
    const { prompts, response } = chat();
    const body = await (await response()).text();
    expect(body).not.toContain(UNKNOWN);
    expect(JSON.stringify(prompts[0])).toContain('Never write technical ids');
  });

  it('leaves prompt and answer untouched with hideIds: false', async () => {
    const { prompts, response } = chat(false);
    const body = await (await response()).text();
    expect(body).toContain(UNKNOWN);
    expect(JSON.stringify(prompts[0])).not.toContain('Never write technical ids');
  });
});
