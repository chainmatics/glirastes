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
import { generateText, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, defineUiTool, type ModuleDefinition } from '../../../../types.js';
import { uiToolToTool } from '../../../core/index.js';
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
function leaksOf(haystack: string, source: Source | Record<string, string>): string[] {
  const found = new Set<string>();
  const flat = haystack.replace(/\s+/g, '');
  for (const value of Object.values(typeof source === 'string' ? PII[source] : source)) {
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

  // KNOWN DEFECT (precondition: originals in an earlier assistant text, see
  // the two-request block below: the handler itself does not restore answers,
  // so this needs an app that restores them, or a value the model named that
  // the shield never saw). `anonymizeMessages` shields only user messages.
  it.fails('main chat: no original of an earlier assistant text that carries originals', async () => {
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

  // KNOWN DEFECT: same for earlier assistant text (precondition as above:
  // originals in the assistant text).
  it.fails('intent classifier: no original of an earlier assistant text that carries originals', async () => {
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

  // KNOWN DEFECT (precondition: originals in an earlier assistant text; see
  // the two-request block): also without a pipeline `anonymizeMessages`
  // leaves an earlier assistant text as it is.
  it.fails('main chat: no original of an earlier assistant text that carries originals', async () => {
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

// ============================================================================
// Two real requests: what the browser gets, and what goes back to the model
// ============================================================================

/** A value the model names itself; the shield never saw it. */
const MODEL_NAMED = { email: 'kontakt@unbekannt-gmbh.de', phone: '0391 5820467' };

type Prompt = Array<{ role: string; content: unknown }>;

/** Pseudonyms the way a model would copy them out of a text. */
function valuesIn(text: string): { email: string; iban: string; phone: string } {
  return {
    email: text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/)?.[0] ?? '',
    iban: text.match(/DE\d{2}(?: [A-Z0-9]{4}){4} [A-Z0-9]{2}/)?.[0] ?? '',
    phone: text.match(/\+49 \d{2,5} \d{3,10}/)?.[0] ?? '',
  };
}

function textOf(message: { content: unknown }): string {
  return typeof message.content === 'string'
    ? message.content
    : (message.content as Array<{ type: string; text?: string }>)
      .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
      .join(' ');
}

const lastUserText = (prompt: Prompt) => textOf([...prompt].reverse().find((message) => message.role === 'user')!);

function scripted(steps: Array<(prompt: Prompt) => unknown[]>, prompts: Prompt[]) {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      const prompt = options.prompt as Prompt;
      prompts.push(prompt);
      const step = steps[Math.min(prompts.length - 1, steps.length - 1)]!;
      return {
        stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...step(prompt)] as never),
      } as never;
    },
  });
}

const toolCalls = (calls: Array<{ id: string; name: string; input: unknown }>) => [
  ...calls.map((call) => ({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) })),
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
];
const answer = (text: string) => [
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: text },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

/** The UI message chunks of the response, as the transport sends them. */
async function browserChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

/** The assistant message the browser keeps (useChat / readUIMessageStream). */
async function browserMessage(chunks: Array<Record<string, unknown>>): Promise<UIMessage> {
  const stream = convertArrayToReadableStream(
    chunks.filter((chunk) => !String(chunk.type).startsWith('data-')) as UIMessageChunk[],
  );
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, terminateOnError: false })) last = message;
  return { ...last!, id: 'a1' };
}

const U1_TEXT = `Schreib an ${PII.user.email}, IBAN ${PII.user.iban}, Telefon ${PII.user.phone}.`;

async function twoRequests(options: { restoreAnswers?: boolean } = {}) {
  const shield = createPiiShield({ locale: 'de', detector: createRegexPiiDetector() });
  const lookupArgs: Array<Record<string, unknown>> = [];
  const tools = {
    crm_lookup: defineTool({
      id: 'crm.lookup',
      description: 'Look up a contact by e-mail.',
      inputSchema: z.object({ email: z.string() }),
      method: 'GET',
      execute: async (input: { email: string }) => {
        lookupArgs.push({ ...input });
        return { email: PII.tool.email, iban: PII.tool.iban, phone: PII.tool.phone };
      },
    }),
    ui_compose: uiToolToTool(defineUiTool({
      id: 'ui.compose',
      toolName: 'ui_compose',
      description: 'Open the mail composer.',
      inputSchema: z.object({ to: z.string() }),
      uiAction: { type: 'compose.open', payload: { to: '$to' } },
    } as never)),
  };
  const post = (model: unknown, messages: unknown[]) => createAiChatHandler({
    tools, model, systemPrompt: 'App prompt.', piiShield: shield,
  } as never)(new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
  }));

  // Request 1: the model repeats the pseudonyms it got, calls a tool and a UI tool.
  const prompts1: Prompt[] = [];
  let pseudonyms1 = { email: '', iban: '', phone: '' };
  const model1 = scripted([
    (prompt) => {
      pseudonyms1 = valuesIn(lastUserText(prompt));
      return toolCalls([
        { id: 'call-1', name: 'crm_lookup', input: { email: pseudonyms1.email } },
        { id: 'call-2', name: 'ui_compose', input: { to: pseudonyms1.email } },
      ]);
    },
    () => answer(`Ich schreibe an ${pseudonyms1.email}, IBAN ${pseudonyms1.iban}, Telefon ${pseudonyms1.phone}. `
      + `Neu: ${MODEL_NAMED.email}, Telefon ${MODEL_NAMED.phone}.`),
  ], prompts1);
  const user1 = user('u1', U1_TEXT);
  const chunks1 = await browserChunks(await post(model1, [user1]));
  const assistant1 = await browserMessage(chunks1);

  // What an app that restores answers itself would keep (session `ai-u1`).
  const kept = options.restoreAnswers
    ? {
        ...assistant1,
        parts: assistant1.parts.map((part) => (part.type === 'text'
          ? { ...part, text: shield.inbound(part.text, 'ai-u1') }
          : part)),
      }
    : assistant1;

  // Request 2: the history exactly as the browser sends it back, plus a new message.
  const prompts2: Prompt[] = [];
  const model2 = scripted([
    (prompt) => {
      const earlier = prompt.filter((message) => message.role === 'assistant').map(textOf).find((text) => text.includes('@')) ?? '';
      return toolCalls([{ id: 'call-3', name: 'crm_lookup', input: { email: valuesIn(earlier).email } }]);
    },
    () => answer('Okay.'),
  ], prompts2);
  await (await post(model2, [user1, kept, user('u2', 'Wie ist der Stand bei dem Kontakt?')])).text();

  return { chunks1, assistant1, pseudonyms1, prompts1, prompts2, lookupArgs };
}

describe('PII shield across two real requests (default configuration)', () => {
  const run = twoRequests();
  const texts = (message: UIMessage) => message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ');
  const toolPart = (message: UIMessage, type: string) =>
    message.parts.find((part) => part.type === type) as { input?: unknown; output?: unknown } | undefined;

  it('request 1: the main model gets pseudonyms, the tool runs with the originals', async () => {
    const { prompts1, pseudonyms1, lookupArgs } = await run;
    expect(leaksOf(JSON.stringify(prompts1), 'user')).toEqual([]);
    expect(pseudonyms1.email).not.toBe('');
    expect(lookupArgs[0]).toEqual({ email: PII.user.email });
  });

  // Fact (product question): the handler does not restore model output; the
  // browser shows the pseudonyms the model wrote.
  it('request 1: the browser text shows pseudonyms, not the user\'s values', async () => {
    const { assistant1, pseudonyms1 } = await run;
    expect(texts(assistant1)).toContain(pseudonyms1.email);
    expect(texts(assistant1)).toContain(pseudonyms1.iban);
    expect(leaksOf(texts(assistant1), 'user')).toEqual([]);
  });

  it('request 1: tool input, tool result and UI action reach the browser as pseudonyms', async () => {
    const { assistant1, pseudonyms1 } = await run;
    expect(toolPart(assistant1, 'tool-crm_lookup')?.input).toEqual({ email: pseudonyms1.email });
    expect(leaksOf(JSON.stringify(toolPart(assistant1, 'tool-crm_lookup')?.output), 'tool')).toEqual([]);
    const ui = toolPart(assistant1, 'tool-ui_compose');
    expect(ui?.input).toEqual({ to: pseudonyms1.email });
    expect(ui?.output).toMatchObject({ uiAction: { type: 'compose.open' } });
    expect(leaksOf(JSON.stringify(ui?.output), 'user')).toEqual([]);
  });

  it('request 1: nothing in the whole response stream carries a user or tool original', async () => {
    const { chunks1 } = await run;
    expect(leaksOf(JSON.stringify(chunks1), 'user')).toEqual([]);
    expect(leaksOf(JSON.stringify(chunks1), 'tool')).toEqual([]);
  });

  it('request 2: the main model gets no user or tool original from the history the browser sent', async () => {
    const { prompts2 } = await run;
    expect(prompts2.length).toBeGreaterThan(0);
    expect(leaksOf(JSON.stringify(prompts2), 'user')).toEqual([]);
    expect(leaksOf(JSON.stringify(prompts2), 'tool')).toEqual([]);
  });

  // KNOWN DEFECT (consistency, not a leak): the shield session is
  // `ai-<id of the last user message>` and changes with every new message, so
  // request 2 maps the same e-mail to a new pseudonym while the earlier answer
  // still names the one of request 1.
  it.fails('request 2: the user\'s e-mail keeps the pseudonym of request 1', async () => {
    const { prompts2, pseudonyms1 } = await run;
    const firstUser = textOf(prompts2[0]!.find((message) => message.role === 'user')!);
    expect(valuesIn(firstUser).email).toBe(pseudonyms1.email);
  });

  // KNOWN DEFECT (consistency): a pseudonym from an earlier answer is not
  // known to the new session, so the tool runs with the fake value.
  it.fails('request 2: a tool called with the pseudonym of an earlier answer runs with the original', async () => {
    const { lookupArgs } = await run;
    expect(lookupArgs[1]).toEqual({ email: PII.user.email });
  });

  // Fact: model output is never shielded; a value the model names itself
  // reaches the browser as written.
  it('request 1: a value the model names itself reaches the browser as written', async () => {
    const { assistant1 } = await run;
    expect(texts(assistant1)).toContain(MODEL_NAMED.email);
  });

  // KNOWN DEFECT (low weight: the value came from the model itself): a
  // personal value in an earlier assistant text goes back unshielded.
  it.fails('request 2: no original of a value the model named in an earlier answer', async () => {
    const { prompts2 } = await run;
    expect(leaksOf(JSON.stringify(prompts2), MODEL_NAMED)).toEqual([]);
  });
});

describe('PII shield across two real requests (app restores answers itself)', () => {
  const run = twoRequests({ restoreAnswers: true });

  // KNOWN DEFECT: an app that restores answers for its users (shield.inbound)
  // stores the user's originals in the assistant text; `anonymizeMessages`
  // passes assistant text unchanged, so request 2 sends them to the model.
  it.fails('request 2: no original of the user in the restored earlier answer', async () => {
    const { prompts2 } = await run;
    expect(leaksOf(JSON.stringify(prompts2), 'user')).toEqual([]);
  });
});
