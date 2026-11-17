import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createInMemoryMemoryStore, verifyMemoryStore, type MemoryStore } from '../../../core/memory-store.js';
import { contextWindowOf, createChatMemory, parseAutoCompact } from '../chat-memory.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const textStream = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ] as never),
});

type Prompt = Array<{ role: string; content: unknown }>;

/** Answers with text; `toolCall` makes the first step call that tool. */
function chatModel(toolCall?: { toolName: string; input: unknown }) {
  const prompts: Prompt[] = [];
  const toolNames: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(options.prompt as Prompt);
      toolNames.push((options.tools ?? []).map((entry) => entry.name));
      if (toolCall && prompts.length === 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-1', toolName: toolCall.toolName, input: JSON.stringify(toolCall.input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ] as never),
        } as never;
      }
      return textStream('Okay.') as never;
    },
  });
  return { model, prompts, toolNames };
}

function summaryModel(text = 'User plans the Q3 launch; task "Landing page" was created.') {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      } as never;
    },
  });
  return { model, prompts };
}

const registry = {
  tasks_list: defineTool({
    id: 'tasks.list', description: 'List tasks.', inputSchema: z.object({}), execute: async () => ({ tasks: [] }),
  }),
};

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const assistant = (id: string, text: string, extra: unknown[] = []) =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }, ...extra] });

function request(messages: unknown[], extra: Record<string, unknown> = {}) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, ...extra }),
  });
}

async function streamParts(response: Response): Promise<Array<{ type: string; data?: unknown; transient?: boolean }>> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

const promptText = (prompt: Prompt) => JSON.stringify(prompt);

const conversation = [
  user('u1', 'We plan the Q3 launch, the codename is Heron.'),
  assistant('a1', 'Noted, the launch is called Heron.'),
  user('u2', 'Create a task for the landing page.'),
  assistant('a2', 'Done, the task Landing page exists.'),
  user('u3', 'Who is on the team?'),
  assistant('a3', 'Mara and Jonas.'),
  user('u4', 'What was the codename again?'),
];

describe('chat memory: auto-compact', () => {
  it('summarizes the older turns once the history passes the threshold', async () => {
    const chat = chatModel();
    const summary = summaryModel();
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { model: summary.model, chat: { autoCompact: 120 } },
    });

    const parts = await streamParts(await handler(request(conversation)));

    expect(parts.find((part) => part.type === 'data-memory-summary')).toMatchObject({
      data: { summary: expect.stringContaining('Q3 launch'), upTo: 'a2' },
    });
    expect(parts.find((part) => part.type === 'data-memory-summary')?.transient).toBeUndefined();
    // The fold ends before the last earlier turn; that turn stays verbatim.
    expect(summary.prompts[0]).toContain('codename is Heron');
    expect(summary.prompts[0]).not.toContain('Mara and Jonas');
    // This turn still sees everything.
    expect(promptText(chat.prompts[0]!)).toContain('codename is Heron');
  });

  it('keeps the history verbatim below the threshold, past maxContextMessages', async () => {
    const chat = chatModel();
    const summary = summaryModel();
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.', maxContextMessages: 2,
      memory: { model: summary.model, chat: { autoCompact: 8000 } },
    });

    const parts = await streamParts(await handler(request(conversation)));

    expect(summary.prompts).toHaveLength(0);
    expect(parts.some((part) => part.type === 'data-memory-summary')).toBe(false);
    expect(promptText(chat.prompts[0]!)).toContain('codename is Heron');
  });

  it('sends the summary instead of the turns it covers', async () => {
    const chat = chatModel();
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { model: summaryModel().model, chat: { autoCompact: 8000 } },
    });
    const history = [
      ...conversation.slice(0, 5),
      assistant('a3', 'Mara and Jonas.', [
        { type: 'data-memory-summary', data: { summary: 'Launch codename: Heron.', upTo: 'a2' } },
      ]),
      conversation[6],
    ];

    await (await handler(request(history))).text();

    const prompt = chat.prompts[0]!;
    expect(prompt[0]!.role).toBe('system');
    expect(prompt[1]!.role).toBe('user');
    expect(promptText([prompt[1]!])).toContain('Launch codename: Heron.');
    expect(promptText(prompt)).not.toContain('Create a task for the landing page');
    expect(promptText(prompt)).toContain('Who is on the team?');
  });

  it('ignores a summary whose message is no longer in the history', async () => {
    const chat = chatModel();
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { model: summaryModel().model, chat: { autoCompact: 8000 } },
    });
    const history = [
      user('u3', 'Who is on the team?'),
      assistant('a3', 'Mara and Jonas.', [
        { type: 'data-memory-summary', data: { summary: 'Launch codename: Heron.', upTo: 'gone' } },
      ]),
      user('u4', 'Thanks.'),
    ];

    await (await handler(request(history))).text();

    expect(promptText(chat.prompts[0]!)).not.toContain('Heron');
  });

  it('answers the turn when the summary model fails', async () => {
    const chat = chatModel();
    const onError = vi.fn();
    const failing = new MockLanguageModelV3({ doGenerate: async () => { throw new Error('down'); } });
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { model: failing, chat: { autoCompact: 20 }, onError },
    });

    const parts = await streamParts(await handler(request(conversation)));

    expect(parts.some((part) => part.type === 'text-delta')).toBe(true);
    expect(parts.some((part) => part.type === 'data-memory-summary')).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reads a long message to its end, in several summary calls', async () => {
    const chat = chatModel();
    const summary = summaryModel();
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { model: summary.model, chat: { autoCompact: 120 } },
    });
    const long = `${'Background of the project. '.repeat(600)}The budget limit is 4711 euros.`;

    const parts = await streamParts(await handler(request([user('u1', long), ...conversation.slice(1)])));

    expect(summary.prompts.length).toBeGreaterThan(1);
    expect(summary.prompts.join('')).toContain('4711 euros');
    expect(parts.find((part) => part.type === 'data-memory-summary')).toMatchObject({ data: { upTo: 'a2' } });
  });

  it('covers only what one turn can read and leaves the rest verbatim', async () => {
    const chat = chatModel();
    const summary = summaryModel();
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { model: summary.model, chat: { autoCompact: 120 } },
    });
    const block = (marker: string) => `${marker} ${'x'.repeat(20_000)}`;
    const messages = [
      user('u1', block('first-block')), assistant('a1', 'Ok.'),
      user('u2', block('second-block')), assistant('a2', 'Ok.'),
      user('u3', block('third-block')), assistant('a3', 'Ok.'),
      user('u4', 'And now?'), assistant('a4', 'Ok.'),
      user('u5', 'Go on.'),
    ];

    const parts = await streamParts(await handler(request(messages)));

    expect(summary.prompts.join('')).toContain('second-block');
    expect(summary.prompts.join('')).not.toContain('third-block');
    expect(parts.find((part) => part.type === 'data-memory-summary')).toMatchObject({ data: { upTo: 'a2' } });
  });

  it('keeps the steps that were summarized when a later one fails', async () => {
    const chat = chatModel();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        if (++calls > 1) throw new Error('summary model down');
        return {
          content: [{ type: 'text', text: 'First part.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        } as never;
      },
    });
    const onError = vi.fn();
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { model, chat: { autoCompact: 120 }, onError },
    });
    const block = (marker: string) => `${marker} ${'x'.repeat(10_000)}`;
    const messages = [
      user('u1', block('one')), assistant('a1', 'Ok.'),
      user('u2', block('two')), assistant('a2', 'Ok.'),
      user('u3', 'And now?'), assistant('a3', 'Ok.'),
      user('u4', 'Go on.'),
    ];

    const parts = await streamParts(await handler(request(messages)));

    expect(parts.find((part) => part.type === 'data-memory-summary')).toMatchObject({
      data: { summary: 'First part.', upTo: 'a1' },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reads the threshold from GLIRASTES_AUTOCOMPACT', () => {
    expect(parseAutoCompact('0.3')).toEqual({ kind: 'share', value: 0.3 });
    expect(parseAutoCompact('8000')).toEqual({ kind: 'tokens', value: 8000 });
    expect(parseAutoCompact('off')).toEqual({ kind: 'off' });
    expect(parseAutoCompact(undefined)).toEqual({ kind: 'default' });
    expect(parseAutoCompact('soon')).toBeNull();
    expect(createChatMemory({}, { GLIRASTES_AUTOCOMPACT: 'off' })).toBeNull();
    expect(createChatMemory({}, { GLIRASTES_AUTOCOMPACT: '0.3' })).not.toBeNull();
    expect(() => createChatMemory({ chat: { autoCompact: -1 } }, {})).toThrow(/autoCompact/);
  });

  it('knows the context window of common model families', () => {
    expect(contextWindowOf({ modelId: 'anthropic/claude-sonnet-4' })).toBe(200_000);
    expect(contextWindowOf('openai/gpt-4o-mini')).toBe(128_000);
    expect(contextWindowOf({ modelId: 'something-new' })).toBe(128_000);
  });
});

describe('chat memory: notes', () => {
  it('shows browser notes to the model and returns them after a change', async () => {
    const chat = chatModel({ toolName: 'memory_remember', input: { note: 'Prefers short answers.', scope: 'user' } });
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { chat: false, user: true },
    });
    const known = { id: 'n1', content: 'Works in the Berlin team.', createdAt: '2026-01-01T00:00:00.000Z' };

    const parts = await streamParts(await handler(
      request([user('u1', 'Please keep answers short from now on.')], { glirastesMemory: { user: [known] } }),
    ));

    expect(promptText([chat.prompts[0]![1]!])).toContain('Works in the Berlin team.');
    expect(chat.toolNames[0]).toEqual(expect.arrayContaining(['memory_remember', 'memory_forget']));
    const notes = parts.find((part) => part.type === 'data-memory-notes');
    expect(notes?.transient).toBe(true);
    expect((notes?.data as { user: Array<{ content: string }> }).user.map((entry) => entry.content))
      .toEqual(['Works in the Berlin team.', 'Prefers short answers.']);
  });

  it('keeps user notes in the store under the key of the caller', async () => {
    const store = createInMemoryMemoryStore();
    await store.add({ kind: 'user', key: 'other' }, { content: 'Someone else.' });
    const chat = chatModel({ toolName: 'memory_remember', input: { note: 'Prefers short answers.', scope: 'user' } });
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { chat: false, user: { store }, scope: () => ({ user: 'user-1' }) },
    });

    const parts = await streamParts(await handler(
      // A client cannot plant notes when a store is configured.
      request([user('u1', 'Short answers please.')], { glirastesMemory: { user: [{ id: 'x', content: 'Planted.' }] } }),
    ));

    expect(await store.list({ kind: 'user', key: 'user-1' })).toMatchObject([
      { content: 'Prefers short answers.', authorId: 'user-1' },
    ]);
    expect(promptText(chat.prompts[0]!)).not.toContain('Planted.');
    expect(promptText(chat.prompts[0]!)).not.toContain('Someone else.');
    expect(parts.some((part) => part.type === 'data-memory-notes')).toBe(false);
  });

  it('asks before a shared note is written', async () => {
    const store = createInMemoryMemoryStore();
    await store.add({ kind: 'shared', key: 'tenant-1' }, { content: 'Sprints start on Mondays.' });
    const chat = chatModel({ toolName: 'memory_remember', input: { note: 'Releases go out on Thursdays.', scope: 'shared' } });
    const handler = createAiChatHandler({
      tools: registry, model: chat.model, systemPrompt: 'App prompt.',
      memory: { chat: false, shared: { store }, scope: () => ({ user: 'user-1', shared: 'tenant-1' }) },
    });

    const parts = await streamParts(await handler(request([user('u1', 'Remember for everyone: releases on Thursdays.')])));

    expect(promptText(chat.prompts[0]!)).toContain('Sprints start on Mondays.');
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(true);
    expect(await store.list({ kind: 'shared', key: 'tenant-1' })).toHaveLength(1);
  });

  it('offers no shared scope to a caller who may not write it', async () => {
    const store = createInMemoryMemoryStore();
    const memory = createChatMemory({
      chat: false, shared: { store, canWrite: () => false }, scope: () => ({ shared: 'tenant-1' }),
    }, {})!;
    const turn = await memory.begin(new Request('https://app.example'), {});
    expect(turn.tools).toHaveLength(0);
  });

  it('removes a note by the id the model was shown', async () => {
    const store = createInMemoryMemoryStore();
    await store.add({ kind: 'user', key: 'user-1' }, { content: 'Works in the Berlin team.' });
    const memory = createChatMemory({ chat: false, user: { store }, scope: () => ({ user: 'user-1' }) }, {})!;
    const turn = await memory.begin(new Request('https://app.example'), {});
    const alias = /\[(u-[a-z0-9]+)\]/.exec(turn.prepare({ messages: [], model: 'm' }).preamble!)![1]!;
    const forget = turn.tools.find((tool) => tool.id === 'memory_forget')!;

    const context = { currentDate: new Date(), locale: 'en-US' };

    // The text an approval card shows must be the note's, or nothing is removed.
    expect(await forget.execute({ id: alias, note: 'Something else.' }, context)).toMatchObject({ success: false });
    expect(await store.list({ kind: 'user', key: 'user-1' })).toHaveLength(1);
    expect(await forget.execute({ id: alias, note: 'works in the  Berlin team.' }, context)).toEqual({ success: true });
    expect(await store.list({ kind: 'user', key: 'user-1' })).toHaveLength(0);
  });

  it('refuses a note beyond the limit', async () => {
    const store = createInMemoryMemoryStore();
    const memory = createChatMemory({
      chat: false, user: { store, maxNotes: 1 }, scope: () => ({ user: 'user-1' }),
    }, {})!;
    await store.add({ kind: 'user', key: 'user-1' }, { content: 'First.' });
    const turn = await memory.begin(new Request('https://app.example'), {});
    const remember = turn.tools.find((tool) => tool.id === 'memory_remember')!;

    expect(await remember.execute({ note: 'Second note.', scope: 'user' }, { currentDate: new Date(), locale: 'en-US' }))
      .toMatchObject({ success: false });
  });

  it('takes back a note that another request pushed beyond the limit', async () => {
    const store = createInMemoryMemoryStore();
    const scope = { kind: 'user', key: 'user-1' } as const;
    const memory = createChatMemory({
      chat: false, user: { store, maxNotes: 1 }, scope: () => ({ user: 'user-1' }),
    }, {})!;
    const turn = await memory.begin(new Request('https://app.example'), {});
    await store.add(scope, { content: 'Written by a parallel request.' });
    const remember = turn.tools.find((tool) => tool.id === 'memory_remember')!;

    expect(await remember.execute({ note: 'Second note.', scope: 'user' }, { currentDate: new Date(), locale: 'en-US' }))
      .toMatchObject({ success: false });
    expect((await store.list(scope)).map((entry) => entry.content)).toEqual(['Written by a parallel request.']);
  });

  it('needs a scope callback for a store', () => {
    expect(() => createChatMemory({ user: { store: createInMemoryMemoryStore() } }, {})).toThrow(/memory\.scope/);
  });
});

describe('verifyMemoryStore', () => {
  it('accepts the in-memory store', async () => {
    await expect(verifyMemoryStore(createInMemoryMemoryStore())).resolves.toBeUndefined();
  });

  it('rejects a store that mixes scopes', async () => {
    const all = createInMemoryMemoryStore();
    const one = { kind: 'user' as const, key: 'everything' };
    const leaky: MemoryStore = {
      list: () => all.list(one),
      add: (_scope, note) => all.add(one, note),
      remove: (_scope, id) => all.remove(one, id),
    };
    await expect(verifyMemoryStore(leaky)).rejects.toThrow(/verifyMemoryStore/);
  });
});
