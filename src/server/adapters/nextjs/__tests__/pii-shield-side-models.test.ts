/**
 * Repro: which model inputs of one chat request does the PII shield cover?
 *
 * Runs the real `createAiChatHandler` with a real shield (regex detector,
 * locale `de`) and fake models that record what they receive:
 * - the main chat model (streamText),
 * - the LLM intent classifier of `createLocalAiPipeline` (generateText),
 * - the chat-memory summary model (generateText, auto-compact),
 * - a legacy `intentRouter` callback (consumer hook that may call a model).
 *
 * The history carries an e-mail, an IBAN and a phone number in an earlier
 * user message, in an earlier assistant text and in an earlier tool result,
 * each with its own values so a leak names its source. A model input leaks
 * when it contains an original value, whole or as a fragment of 6+ chars.
 *
 * `it.fails` marks a KNOWN DEFECT: the assertion states the intended
 * behaviour and fails today, so the file stays green.
 */
import { generateText } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type ModuleDefinition } from '../../../../types.js';
import { createLocalAiPipeline } from '../../../local-pipeline.js';
import { createPiiShield, createRegexPiiDetector } from '../../../pii-shield/index.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** Originals per source; each detected by the regex detector (locale de). */
const PII = {
  user: { email: 'quirin.zeller@kanzlei-moos.de', iban: 'DE44 5001 0517 5407 3249 31', phone: '+49 171 2938475' },
  assistant: { email: 'wiebke.harms@friesenhof-kiel.de', iban: 'DE27 8304 6619 2750 8813 04', phone: '+49 160 4719362' },
  tool: { email: 'ottokar.brandl@almhuette-tirol.de', iban: 'DE53 3907 2241 6638 1590 72', phone: '+49 152 8357014' },
  latest: { email: 'svenja.kowalski@werft-rostock.de', iban: 'DE91 6215 9930 4827 0466 15', phone: '+49 176 6092841' },
} as const;
type Source = keyof typeof PII;

/** Whole values and every 6-char window of each value (with and without spaces). */
function leaksOf(haystack: string, source: Source): string[] {
  const found = new Set<string>();
  const flat = haystack.replace(/\s+/g, '');
  for (const value of Object.values(PII[source])) {
    if (haystack.includes(value)) found.add(value);
    const compact = value.replace(/\s+/g, '');
    for (let i = 0; i + 6 <= compact.length; i += 1) {
      const window = compact.slice(i, i + 6);
      if (flat.includes(window)) found.add(window);
    }
  }
  return [...found];
}

const contacts = defineTool({
  id: 'contacts.lookup',
  description: 'Look up a contact.',
  inputSchema: z.object({}),
  method: 'GET',
  execute: async () => ({ found: false }),
});
const modules: ModuleDefinition[] = [{
  id: 'contacts',
  name: 'Contacts',
  description: 'Contacts, invoices and payment details',
  tools: ['contacts_lookup'],
}];

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });

function conversation(latestWithPii: boolean): unknown[] {
  const p = PII;
  return [
    user('u1', `Meine Mail ist ${p.user.email}, IBAN ${p.user.iban}, Telefon ${p.user.phone}.`),
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-contacts_lookup',
          toolCallId: 'call-1',
          state: 'output-available',
          input: {},
          output: { email: p.tool.email, iban: p.tool.iban, phone: p.tool.phone },
        },
        { type: 'text', text: `Gespeichert. Ihre Ansprechpartnerin erreichen Sie unter ${p.assistant.email}, IBAN ${p.assistant.iban}, Telefon ${p.assistant.phone}.` },
      ],
    },
    user('u2', 'Bitte lege eine Notiz zur Rechnung an.'),
    { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Die Notiz zur Rechnung ist angelegt.' }] },
    user('u3', 'Welche Rechnungen sind noch offen?'),
    { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: 'Zwei Rechnungen sind offen.' }] },
    user('u4', latestWithPii
      ? `Schick die Rechnung an ${p.latest.email}, IBAN ${p.latest.iban}, Telefon ${p.latest.phone}.`
      : 'Zeig mir bitte die offenen Rechnungen der Kontakte.'),
  ];
}

interface Recorded {
  chat: string[];
  classifier: string[];
  summary: string[];
  router: string[];
}

async function runTurn(mode: 'pipeline' | 'legacy-router' | 'default', latestWithPii: boolean): Promise<Recorded> {
  const recorded: Recorded = { chat: [], classifier: [], summary: [], router: [] };
  const chatModel = new MockLanguageModelV3({
    doStream: async (options) => {
      recorded.chat.push(JSON.stringify(options.prompt));
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Okay.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] as never),
      } as never;
    },
  });
  const textModel = (into: string[], text: string) => new MockLanguageModelV3({
    doGenerate: async (options) => {
      into.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      } as never;
    },
  });
  const classifierModel = textModel(recorded.classifier, '{"moduleId":"contacts","confidence":0.9}');
  const summaryModel = textModel(recorded.summary, 'Kurze Zusammenfassung.');
  const shield = createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });

  const handler = createAiChatHandler({
    tools: { contacts_lookup: contacts },
    model: chatModel,
    systemPrompt: 'App prompt.',
    piiShield: shield,
    memory: { model: summaryModel, chat: { autoCompact: 120 } },
    ...(mode === 'pipeline'
      ? {
          pipeline: createLocalAiPipeline({
            modules,
            classifier: { modules, model: classifierModel },
            generateText: (options) => generateText(options as never),
          }),
        }
      : mode === 'legacy-router'
        ? {
            intentRouter: async (text: string, toolNames: string[]) => {
              recorded.router.push(text);
              return { toolNames };
            },
          }
        : {}),
  } as never);

  const response = await handler(new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: conversation(latestWithPii) }),
  }));
  await response.text();
  return recorded;
}

describe.each([false, true])('PII shield over every model input (pipeline, latest message with PII=%s)', (latestWithPii) => {
  it('reaches all three models (the test sees each input)', async () => {
    const recorded = await runTurn('pipeline', latestWithPii);
    expect(recorded.chat.length).toBeGreaterThan(0);
    expect(recorded.classifier).toHaveLength(1);
    expect(recorded.summary.length).toBeGreaterThan(0);
    // The classifier prompt carries the history at all.
    expect(recorded.classifier[0]).toContain('Conversation history');
  });

  // Control: the main chat model gets pseudonyms for the user's own words.
  it('main chat: no original of an earlier user message', async () => {
    const { chat } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(chat.join('\n'), 'user')).toEqual([]);
  });

  it('main chat: no original of the latest user message', async () => {
    const { chat } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(chat.join('\n'), 'latest')).toEqual([]);
  });

  // KNOWN DEFECT: `anonymizeMessages` (create-ai-chat-handler.ts) shields only
  // user messages; the restored (real) values the chat shows in an earlier
  // assistant text go back to the main model in the clear.
  it.fails('main chat: no original of an earlier assistant text', async () => {
    const { chat } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(chat.join('\n'), 'assistant')).toEqual([]);
  });

  // Holds here because the history window leaves earlier tool results out
  // (HISTORY_TEXT_ONLY_NOTE), not because `anonymizeMessages` shields them:
  // it passes non-user parts on unchanged. A live tool result is sealed by
  // `wrapToolsWithShield`, so the chat normally stores pseudonyms there.
  it('main chat: no original of an earlier tool result', async () => {
    const { chat } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(chat.join('\n'), 'tool')).toEqual([]);
  });

  // KNOWN DEFECT: `extractConversationHistory` hands earlier user text to the
  // intent classifier model without `piiShield.outbound`.
  it.fails('intent classifier: no original of an earlier user message', async () => {
    const { classifier } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(classifier.join('\n'), 'user')).toEqual([]);
  });

  // KNOWN DEFECT: same for earlier assistant text.
  it.fails('intent classifier: no original of an earlier assistant text', async () => {
    const { classifier } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(classifier.join('\n'), 'assistant')).toEqual([]);
  });

  // Tool parts are dropped from the classifier history.
  it('intent classifier: no original of an earlier tool result', async () => {
    const { classifier } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(classifier.join('\n'), 'tool')).toEqual([]);
  });

  // The latest message is shielded before `pipeline.process`.
  it('intent classifier: no original of the latest user message', async () => {
    const { classifier } = await runTurn('pipeline', latestWithPii);
    expect(leaksOf(classifier.join('\n'), 'latest')).toEqual([]);
  });

  it.each(['user', 'assistant', 'tool', 'latest'] as const)(
    'memory summary: no original from source %s',
    async (source) => {
      const { summary } = await runTurn('pipeline', latestWithPii);
      expect(leaksOf(summary.join('\n'), source)).toEqual([]);
    },
  );
});

describe('PII shield and the legacy intentRouter callback', () => {
  // KNOWN DEFECT: legacy mode runs `piiShield.outbound` on the latest text
  // but discards the result; `intentRouter` gets the raw text. The router is
  // an app callback that may hand the text to a model of its own.
  it.fails('intentRouter: no original of the latest user message', async () => {
    const { router } = await runTurn('legacy-router', true);
    expect(router).toHaveLength(1);
    expect(leaksOf(router.join('\n'), 'latest')).toEqual([]);
  });

  it('intentRouter: gets only the latest message (no history)', async () => {
    const { router } = await runTurn('legacy-router', false);
    expect(router).toHaveLength(1);
    for (const source of ['user', 'assistant', 'tool'] as const) {
      expect(leaksOf(router.join('\n'), source)).toEqual([]);
    }
  });
});

describe('PII shield with the default configuration (no pipeline, no intentRouter)', () => {
  it('makes no classifier or router call', async () => {
    const recorded = await runTurn('default', true);
    expect(recorded.classifier).toEqual([]);
    expect(recorded.router).toEqual([]);
    expect(recorded.chat.length).toBeGreaterThan(0);
  });

  it('main chat: no original of an earlier or the latest user message', async () => {
    const { chat } = await runTurn('default', true);
    expect(leaksOf(chat.join('\n'), 'user')).toEqual([]);
    expect(leaksOf(chat.join('\n'), 'latest')).toEqual([]);
  });

  // KNOWN DEFECT: also without any pipeline, `anonymizeMessages` leaves an
  // earlier assistant text as it is; the chat stores the restored originals.
  it.fails('main chat: no original of an earlier assistant text', async () => {
    const { chat } = await runTurn('default', false);
    expect(leaksOf(chat.join('\n'), 'assistant')).toEqual([]);
  });

  it.each(['user', 'assistant', 'tool', 'latest'] as const)(
    'memory summary: no original from source %s',
    async (source) => {
      const { summary } = await runTurn('default', true);
      expect(summary.length).toBeGreaterThan(0);
      expect(leaksOf(summary.join('\n'), source)).toEqual([]);
    },
  );
});
