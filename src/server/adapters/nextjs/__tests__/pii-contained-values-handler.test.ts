import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type ToolRegistry } from '../../../../types.js';
import { createPiiShield, createRegexPiiDetector } from '../../../pii-shield/index.js';
import { createAiChatHandler, type AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';

/**
 * A value the session knows from the user message that is part of a longer
 * value in a tool result or the view context: the model gets the longer
 * value as one pseudonym, never a piece of it in clear text, and a tool call
 * with the pseudonyms gets the originals back.
 */

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** Short value (in the user message) and the longer value that contains it (in the tool result). */
const PAIRS = {
  email: ['max@firma.de', 'johannes.max@firma.de'],
  url: ['https://firma.de', 'https://firma.de/u/max.mustermann@firma.de'],
  phone: ['+49 151 23456789', '+49 151 23456789-12'],
  iban: ['DE89 3704 0044 0532 0130 00', 'DE89 3704 0044 0532 0130 0012 34'],
} as const;

type Field = keyof typeof PAIRS;

/**
 * Every piece of `original` of at least six characters that `text` still
 * holds. Pieces of or with `https://` are left aside: pseudonym URLs share them.
 */
function fragmentsOf(original: string, text: string, min = 6): string[] {
  const found: string[] = [];
  for (let start = 0; start + min <= original.length; start += 1) {
    const piece = original.slice(start, start + min);
    if (!'https://'.includes(piece) && !piece.includes('://') && text.includes(piece)) found.push(piece);
  }
  return found;
}

const longValues = Object.fromEntries(Object.entries(PAIRS).map(([field, [, long]]) => [field, long])) as Record<Field, string>;

function registry(sent: unknown[]): ToolRegistry {
  return {
    contacts_get: defineTool({
      id: 'contacts.get',
      description: 'Read the contact.',
      method: 'GET',
      inputSchema: z.object({}),
      execute: async () => ({ ...longValues, note: `Kontakt ${longValues.email}, Profil ${longValues.url}` }),
    }),
    mail_send: defineTool({
      id: 'mail.send',
      description: 'Send a mail.',
      method: 'POST',
      inputSchema: z.object({ to: z.string(), cc: z.string(), body: z.string() }),
      execute: async (input: unknown) => {
        sent.push(input);
        return { ok: true };
      },
    }),
  };
}

const text = (delta: string) => [
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta }, { type: 'text-end', id: 't' },
];

/** The tool result the model got for `contacts_get`, as the prompt holds it. */
function toolResultOf(prompt: unknown): Record<string, string> {
  for (const message of prompt as Array<{ role: string; content: unknown }>) {
    if (message.role !== 'tool') continue;
    for (const part of message.content as Array<{ type: string; toolName?: string; output?: { value?: unknown } }>) {
      if (part.type === 'tool-result' && part.toolName === 'contacts_get') return part.output!.value as Record<string, string>;
    }
  }
  throw new Error('no tool result');
}

/** One model turn: read the contact, send a mail with the pseudonyms, answer. */
async function turn(): Promise<{ prompts: string[]; result: Record<string, string>; userText: string; sent: unknown[] }> {
  const sent: unknown[] = [];
  let result: Record<string, string> = {};
  let userText = '';
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      step += 1;
      let chunks: unknown[];
      if (step === 1) {
        userText = JSON.stringify(options.prompt);
        chunks = [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'contacts_get', input: '{}' }];
      } else if (step === 2) {
        result = toolResultOf(options.prompt);
        const shortEmail = /Mail an (\S+?),/.exec(userText)![1]!;
        chunks = [{
          type: 'tool-call', toolCallId: 'call-2', toolName: 'mail_send',
          input: JSON.stringify({ to: result.email, cc: shortEmail, body: `Hallo ${result.email}, siehe ${result.url}` }),
        }];
      } else {
        chunks = text('Done.');
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          ...chunks,
          { type: 'finish', finishReason: { unified: step < 3 ? 'tool-calls' : 'stop', raw: undefined }, usage },
        ] as never),
      };
    },
  });
  const shield = createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });
  const handler = createAiChatHandler({
    tools: registry(sent), systemPrompt: 'Assistant', model, piiShield: shield,
  } as AiChatHandlerFullConfig);
  const message = `Mail an ${PAIRS.email[0]}, Seite ${PAIRS.url[0]} , Telefon ${PAIRS.phone[0]} , IBAN ${PAIRS.iban[0]} bitte.`;
  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: message }] }] }),
  }));
  await response.text();
  return { prompts: model.doStreamCalls.map((call) => JSON.stringify(call.prompt)), result, userText, sent };
}

describe('pii shield in the chat handler: a known value inside a longer value of a tool result', () => {
  it('the model gets no piece of any original, in the user message or the tool result', async () => {
    const { prompts, result } = await turn();
    expect(prompts).toHaveLength(3);
    const seen = prompts.join('\n');
    for (const field of Object.keys(PAIRS) as Field[]) {
      const [short, long] = PAIRS[field];
      expect({ field, pieces: fragmentsOf(long, seen) }).toEqual({ field, pieces: [] });
      expect({ field, pieces: fragmentsOf(short, seen) }).toEqual({ field, pieces: [] });
      expect(result[field]).not.toBe(long);
    }
  });

  it('a tool call with the pseudonyms of the long and the short value gets the originals', async () => {
    const { sent } = await turn();
    expect(sent).toEqual([{
      to: PAIRS.email[1],
      cc: PAIRS.email[0],
      body: `Hallo ${PAIRS.email[1]}, siehe ${PAIRS.url[1]}`,
    }]);
  });
});

describe('pii shield in the chat handler: view context with a label and an id that contains it', () => {
  it('sends the id as one pseudonym, no piece of it in clear text', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          ...text('Answer.'),
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ] as never),
      }),
    });
    const getOrder = defineTool({
      id: 'orders.get',
      description: 'Read one order.',
      method: 'GET',
      inputSchema: z.object({ orderId: z.string() }),
      outputEntities: [{ type: 'order', id: 'id', name: 'name' }],
      inputEntities: [{ type: 'order', args: 'orderId' }],
      execute: async () => ({ id: 'x', name: 'y' }),
    });
    const handler = createAiChatHandler({
      tools: { orders_get: getOrder }, systemPrompt: 'Assistant', model,
      piiShield: createPiiShield({ locale: 'de', detector: createRegexPiiDetector() }),
    } as AiChatHandlerFullConfig);
    const response = await handler(new Request('https://app.example/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Schreib max@firma.de dazu, siehe https://firma.de .' }] }],
        glirastesViewContext: {
          version: 1,
          current: [
            { entity: { type: 'order', id: 'johannes.max@firma.de' }, label: 'Max <max@firma.de>' },
            { entity: { type: 'order', id: 'o-2' }, label: 'https://firma.de/u/max.mustermann@firma.de' },
          ],
        },
      }),
    }));
    expect(response.status).toBe(200);
    await response.text();
    const seen = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(seen).toContain('<view-context>');
    expect(fragmentsOf('johannes.max@firma.de', seen)).toEqual([]);
    expect(fragmentsOf('max@firma.de', seen)).toEqual([]);
    expect(fragmentsOf('https://firma.de/u/max.mustermann@firma.de', seen)).toEqual([]);
  });
});
