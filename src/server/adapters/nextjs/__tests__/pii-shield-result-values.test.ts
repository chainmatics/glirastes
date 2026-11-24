import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPiiShield, createRegexPiiDetector } from '../../../pii-shield/index.js';
import { defineTool } from '../../../../types.js';
import { createAiChatHandler, type AiChatHandlerFullConfig } from '../create-ai-chat-handler.js';

/**
 * The PII shield must find personal values in the string VALUES of a tool
 * result, not in its JSON text: there a line break is the escape `\n`, and a
 * detector that reads `nmax@…` or misses `\nDE89…` lets the original reach
 * the model. Real handler, real shield, real regex detector, scripted model.
 */

const EMAIL = 'max.mustermann@firma.de';
const IBAN = 'DE89370400440532013000';
const PHONE = '030 12345678';
/** The identifying part of each value: a pseudonym may share a format prefix, never these. */
const CORES = ['max.mustermann', '370400440532013000', '12345678'];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** Each value right after a character JSON.stringify escapes, nested in objects and arrays. */
const contact = {
  note: `Kontakt:\n${EMAIL}`,
  crlf: `Konto:\r\n${IBAN}`,
  tab: `Tel:\t${PHONE}`,
  control: `x\u0001${EMAIL}`,
  surrogate: `x\ud800${IBAN}`,
  nested: [{ deep: { text: `Info\n${PHONE}` } }],
};

const post = () => new Request('https://app.example/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Zeig den Kontakt' }] }] }),
});

/** Every string in a prompt, with JSON-encoded strings (tool outputs) decoded. */
function promptStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    if (/^[[{]/.test(value)) {
      try { promptStrings(JSON.parse(value), out); } catch { /* not JSON */ }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) promptStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { out.push(key); promptStrings(item, out); }
  }
  return out;
}

async function turn(config: Partial<AiChatHandlerFullConfig>) {
  const looked: unknown[] = [];
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      step += 1;
      let chunks: unknown[];
      if (step === 1) {
        chunks = [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'contact_get', input: '{}' }];
      } else if (step === 2) {
        // The model writes back what it saw for the e-mail after the line break.
        const seen = promptStrings(options.prompt).map((s) => /Kontakt:\n(\S+)/.exec(s)?.[1]).find(Boolean) ?? 'none';
        chunks = [{ type: 'tool-call', toolCallId: 'call-2', toolName: 'contact_lookup', input: JSON.stringify({ email: seen }) }];
      } else {
        chunks = [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Fertig.' }, { type: 'text-end', id: 't' }];
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
  const tools = {
    contact_get: defineTool({ id: 'contact.get', description: 'Get the contact.', inputSchema: z.object({}).strict(), execute: async () => contact }),
    contact_lookup: defineTool({
      id: 'contact.lookup', description: 'Look up by e-mail.', inputSchema: z.object({ email: z.string() }),
      execute: async (input: { email: string }) => { looked.push(input.email); return { found: true }; },
    }),
  };
  const piiShield = createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });
  const handler = createAiChatHandler({ tools, model, systemPrompt: 'A', piiShield, ...config } as AiChatHandlerFullConfig);
  await (await handler(post())).text();
  return { prompts: model.doStreamCalls.map((call) => promptStrings(call.prompt).join('\u0000')), looked };
}

describe('PII shield on tool-result values with JSON escapes', () => {
  it.each([
    ['with result handles', {}],
    ['without result handles', { resultHandles: false }],
  ] as const)('%s: no original reaches the model, and the pseudonym the model sends back reaches the tool as the original', async (_name, config) => {
    const { prompts, looked } = await turn(config);
    expect(prompts).toHaveLength(3);
    const seen = prompts.slice(1).join('\u0000');
    // The tool result reached the model (pseudonymized), so the check below is not vacuous.
    expect(seen).toContain('Kontakt:\n');
    for (const core of CORES) expect(seen).not.toContain(core);
    expect(looked).toEqual([EMAIL]);
  });
});

describe('PII shield on two tool calls of one step at the same time', () => {
  /** The model calls both tools in one step; the second result is only protected by a value of the first. */
  async function parallelTurn(config: Partial<AiChatHandlerFullConfig>) {
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        step += 1;
        const chunks = step === 1
          ? [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'a_get', input: '{}' },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'c_get', input: '{}' },
          ]
          : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }];
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            ...chunks,
            { type: 'finish', finishReason: { unified: step < 2 ? 'tool-calls' : 'stop', raw: undefined }, usage },
          ] as never),
        };
      },
    });
    const tools = {
      a_get: defineTool({ id: 'a.get', description: 'A.', inputSchema: z.object({}).strict(), execute: async () => ({ note: 'Tel 030 1234567\nRueckruf' }) }),
      c_get: defineTool({
        id: 'c.get', description: 'C.', inputSchema: z.object({}).strict(),
        execute: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return { note: 'Tel030 1234567' }; },
      }),
    };
    const inner = createRegexPiiDetector();
    // A detector that answers after 20 ms, as a remote one does.
    const piiShield = createPiiShield({
      locale: 'de',
      detector: { detect: async (text, locales) => { await new Promise((resolve) => setTimeout(resolve, 20)); return inner.detect(text, locales); } },
    });
    const handler = createAiChatHandler({ tools, model, systemPrompt: 'A', piiShield, ...config } as AiChatHandlerFullConfig);
    await (await handler(post())).text();
    return model.doStreamCalls.map((call) => promptStrings(call.prompt).join('\u0000'));
  }

  it.each([
    ['with result handles', {}],
    ['without result handles', { resultHandles: false }],
  ] as const)('%s: neither result reaches the model with the number', async (_name, config) => {
    const prompts = await parallelTurn(config);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Rueckruf');
    expect(prompts[1]).not.toContain('1234567');
  });
});
