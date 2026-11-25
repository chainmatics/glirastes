// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode, useEffect, useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Renders of finished messages while a later answer streams, counted, never timed:
 * - a bubble render: one call of the default bubble's part reader (`readStepFailurePartCodes`, called once per
 *   `useMessageParts`), attributed to the message by its `parts` array;
 * - a Markdown parse: one render of react-markdown's `Markdown` (it parses its whole text on every render),
 *   attributed by the `ref-<id>` token every text of the conversation carries;
 * - custom `components` count their own renders.
 */
const bubbleRenders = new Map<string, number>();
const parses = new Map<string, number>();
const partsOwner = new WeakMap<object, string>();
/** The chat under test: a bubble's `parts` belong to its message there (also before `track` ran). */
let liveChat: { messages: ReadonlyArray<ChatMessage> } | null = null;
const ownerOf = (parts: object) => partsOwner.get(parts) ?? liveChat?.messages.find((message) => message.parts === parts)?.id;
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const calledFromBubble = () => (new Error().stack ?? '').split('\n').slice(2, 4)
  .some((line) => /message-bubble\.tsx/.test(line));

vi.mock('../../contracts/step-failure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contracts/step-failure.js')>();
  return {
    ...actual,
    readStepFailurePartCodes: (...args: Parameters<typeof actual.readStepFailurePartCodes>) => {
      const owner = ownerOf(args[0] as object);
      if (owner && calledFromBubble()) bump(bubbleRenders, owner);
      return actual.readStepFailurePartCodes(...args);
    },
  };
});
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Counted = (options: Parameters<typeof actual.default>[0]) => {
    const token = /ref-(\w+)/.exec(String(options.children ?? ''))?.[1];
    if (token) bump(parses, token);
    return actual.default(options);
  };
  return { ...actual, default: Counted };
});

import ReactMarkdown from 'react-markdown';
import { UiActionBus } from '../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import { useMessageParts } from '../components/message-bubble.js';
import { useChatEntityLinks } from '../entity-links/entity-links-react.js';
import type { ChatEntityLinksConfig } from '../entity-links/entity-links.js';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../provider/chat-context.js';
import type {
  AiChatProviderConfig,
  ChatComponents,
  ChatMessage,
  MentionChipProps,
  MessageBubbleProps,
  MessagePartsProps,
} from '../types.js';
import { StreamingChat } from './streaming-chat.js';
import { clarificationAnswerMessage } from '../utils/clarification.js';
import { stubControlledFetch, textChunks } from './controlled-fetch.js';
import { VercelAiChat } from '../transports/vercel/index.js';

const DECLARED: EntityDeclarationsByTool = {
  channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
};

/** Registers each message's `parts` array, so a bubble render counts for its message. */
function track(messages: ReadonlyArray<ChatMessage>): void {
  for (const message of messages) partsOwner.set(message.parts as object, message.id);
}

/**
 * `turns` finished turns as the consumer's chat has them: each question with a marker chip, each answer a
 * declared tool result (20 records), a Markdown list with two marker chips, two known names and a task key
 * (6 chips per turn), every third answer with a decided approval.
 */
function conversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ id: `q${turn}`, role: 'user', parts: [{ type: 'text', text: `ref-q${turn} is {{mention:channel:c${turn}_0:Channel ${turn} zero}} live?` }] });
    const approval = turn % 3 === 0
      ? [{
        type: 'tool-channel_archive', toolCallId: `w${turn}`, state: 'output-available', input: { key: `c${turn}_4` },
        approval: { id: `ap${turn}`, approved: true }, output: { message: 'archived' },
      }]
      : [];
    messages.push({
      id: `r${turn}`, role: 'assistant', parts: [
        {
          type: 'tool-channels_list', toolCallId: `t${turn}`, state: 'output-available', input: {},
          output: { channels: Array.from({ length: 20 }, (_, record) => ({ key: `c${turn}_${record}`, title: `Channel ${turn} n${record}` })) },
        },
        ...approval,
        {
          type: 'text',
          text: `**ref-r${turn}**: {{mention:channel:c${turn}_1:Channel ${turn} n1}} and Channel ${turn} n2 run.\n\n`
            + `- {{mention:channel:c${turn}_3:Channel ${turn} n3}}\n- MAR-${turn}\n- a *third* item with Channel ${turn} n5`,
        },
      ],
    } as unknown as ChatMessage);
  }
  return messages;
}

/**
 * 26 finished messages (78 chips, with the streamed answer's about 90); with the question, its answer and one more
 * question 29: all visible (the first page holds 30), so no message leaves the page (its names would leave the links).
 */
const TURNS = 13;
const STREAMING = 'streaming';

function streamingText(chunk: number): string {
  const lines = [`**ref-${STREAMING}** answer`];
  for (let line = 0; line <= chunk; line += 1) lines.push(`- point ${line} with {{mention:channel:c0_${line % 20}:Live ${line}}}`);
  return lines.join('\n');
}

const counts = { bubble: new Map<string, number>(), parts: new Map<string, number>(), chip: new Map<string, number>(), markdown: new Map<string, number>() };
const ownerOfText = (text: string) => /ref-(\w+)/.exec(text)?.[1] ?? '?';

function CountingChip({ mention, onOpen, openLabel }: MentionChipProps) {
  // Keyed by label: the streaming answer's chips are `Live <n>`, the finished ones `Channel …` and `MAR-…`.
  bump(counts.chip, mention.displayName);
  return <button type="button" aria-label={openLabel} onClick={onOpen} data-chip={mention.id}>{mention.displayName}</button>;
}
/** An app's own Markdown: react-markdown with the chat's entity links. */
function CountingMarkdown({ content }: { content: string }) {
  bump(counts.markdown, ownerOfText(content));
  const links = useChatEntityLinks();
  return <div data-component="markdown" data-owner={ownerOfText(content)}><ReactMarkdown components={links.markdownComponents}>{content}</ReactMarkdown></div>;
}
function CountingBubble({ message }: MessageBubbleProps) {
  bump(counts.bubble, message.id);
  const parts = useMessageParts(message);
  if (!parts.visible) return null;
  return (
    <div data-component="message-bubble" data-role={message.role} data-id={message.id}>
      {parts.activity}{parts.text}{parts.toolResults}{parts.footer}
    </div>
  );
}
function CountingParts({ message, children }: MessagePartsProps) {
  bump(counts.parts, message.id);
  return <>{children}</>;
}

let ctx: ChatContextValue;
function Probe() {
  ctx = useChatContext();
  return null;
}

const bus = new UiActionBus();
const matchers = [{ type: 'task', pattern: /MAR-\d+/, resolve: (key: string) => ({ id: key, label: key }) }];
const LINKS: ChatEntityLinksConfig = { mentionMarkers: 'markdown', matchers, open: () => {} };

function baseConfig(): Partial<AiChatProviderConfig> {
  return {
    entityLinks: LINKS,
    entityDeclarations: DECLARED,
    uiActionBus: bus,
    messageFooter: true,
    approvalDisplay: { decided: 'entry', open: 'inline' },
  };
}

function Host({ chat, config, strict }: { chat: StreamingChat; config: Partial<AiChatProviderConfig>; strict?: boolean }) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), [chat]);
  const tree = (
    <AiChatProvider transport={chat.transport} {...config}>
      <Probe />
      <AiChatPanel />
    </AiChatProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

function reset() {
  bubbleRenders.clear();
  parses.clear();
  for (const map of Object.values(counts)) map.clear();
}

async function settle() {
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
}

/** Renders the finished conversation and waits until Markdown and the matcher chips are there. */
async function mount(config: Partial<AiChatProviderConfig>, options: { strict?: boolean; turns?: number } = {}) {
  const chat = new StreamingChat();
  chat.messages = conversation(options.turns ?? TURNS);
  liveChat = chat;
  track(chat.messages);
  const view = render(<Host chat={chat} config={config} strict={options.strict} />);
  await waitFor(() => expect(document.querySelectorAll('[data-component="markdown"]').length).toBeGreaterThan(0), { timeout: 5000 });
  await waitFor(() => expect(document.querySelector('[data-element="markdown-skeleton"]')).toBeNull(), { timeout: 5000 });
  await settle();
  return { chat, view };
}

/** Sends a question and streams the first chunk of its answer (the question stops being the latest message). */
async function startAnswer(chat: StreamingChat) {
  await act(async () => { void chat.sendMessage({ text: 'ref-question next?' }); });
  track(chat.messages);
  await act(async () => { chat.stream([{ type: 'text', text: streamingText(0) }]); });
  track(chat.messages);
  // The streaming message's id is the transport's; name it for the counters.
  const last = chat.messages[chat.messages.length - 1]!;
  return last.id;
}

async function streamChunks(chat: StreamingChat, chunks: number) {
  for (let chunk = 1; chunk <= chunks; chunk += 1) {
    await act(async () => { chat.stream([{ type: 'text', text: streamingText(chunk) }]); });
    track(chat.messages);
  }
}

const finishedIds = (turns = TURNS) => Array.from({ length: turns }, (_, turn) => [`q${turn}`, `r${turn}`]).flat();
const sum = (map: Map<string, number>, ids: ReadonlyArray<string>) => ids.reduce((total, id) => total + (map.get(id) ?? 0), 0);
const byId = (map: Map<string, number>, ids: ReadonlyArray<string>) => Object.fromEntries(ids.map((id) => [id, map.get(id) ?? 0]).filter(([, n]) => n !== 0));

beforeEach(() => {
  reset();
});
afterEach(() => {
  cleanup();
});
vi.setConfig({ testTimeout: 30_000 });

describe('a finished message while a later answer streams (10 chunks)', () => {
  it('default components: no render and no Markdown parse of any finished message', async () => {
    const { chat } = await mount(baseConfig());
    // Chips are there, as the consumer's chat has them.
    expect(document.querySelectorAll('[data-component="mention-chip"]').length).toBe(TURNS * 6);
    const streamingId = await startAnswer(chat);
    reset();
    await streamChunks(chat, 10);
    expect(byId(bubbleRenders, finishedIds())).toEqual({});
    expect(byId(parses, finishedIds())).toEqual({});
    // The streaming answer itself renders and parses on every chunk.
    expect(bubbleRenders.get(streamingId)).toBeGreaterThanOrEqual(10);
    expect(parses.get(STREAMING)).toBeGreaterThanOrEqual(10);
    expect(document.body.textContent).toContain('point 10');
  });

  it('StrictMode: no render and no Markdown parse of any finished message', async () => {
    const { chat } = await mount(baseConfig(), { strict: true });
    const streamingId = await startAnswer(chat);
    reset();
    await streamChunks(chat, 10);
    expect(byId(bubbleRenders, finishedIds())).toEqual({});
    expect(byId(parses, finishedIds())).toEqual({});
    expect(bubbleRenders.get(streamingId)).toBeGreaterThanOrEqual(10);
  });

  it('custom MessageBubble (useMessageParts), MentionChip and Markdown: none of them renders for a finished message', async () => {
    const components: ChatComponents = { MessageBubble: CountingBubble, MentionChip: CountingChip, Markdown: CountingMarkdown };
    const { chat } = await mount({ ...baseConfig(), components });
    expect(counts.chip.size).toBeGreaterThan(40);
    const streamingId = await startAnswer(chat);
    reset();
    await streamChunks(chat, 10);
    expect(byId(counts.bubble, finishedIds())).toEqual({});
    expect(byId(counts.markdown, finishedIds())).toEqual({});
    expect([...counts.chip.keys()].filter((label) => !label.startsWith('Live'))).toEqual([]);
    expect(counts.bubble.get(streamingId)).toBeGreaterThanOrEqual(10);
    expect(counts.markdown.get(STREAMING)).toBeGreaterThanOrEqual(10);
  });

  it('an app that renders on every chunk with inline config objects (same functions): no render of a finished message', async () => {
    const chat = new StreamingChat();
    chat.messages = conversation(TURNS);
    liveChat = chat;
    const seenLinks = new Set<unknown>();
    function LinksIdentity() {
      seenLinks.add(useChatEntityLinks());
      return null;
    }
    function App() {
      const [, force] = useReducer((count: number) => count + 1, 0);
      useEffect(() => chat.subscribe(force), []);
      return (
        <AiChatProvider
          transport={chat.transport}
          uiActionBus={bus}
          messageFooter
          locale={{ copyMessageLabel: 'Copy' }}
          classNames={{ messageBubble: 'bubble' }}
          entityDeclarations={{ channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] } }}
          entityLinks={{ mentionMarkers: 'markdown', matchers, open: LINKS.open }}
          approvalDisplay={{ decided: 'entry', open: 'inline' }}
        >
          <LinksIdentity />
          <Probe />
          <AiChatPanel />
        </AiChatProvider>
      );
    }
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll('[data-component="mention-chip"]').length).toBe(TURNS * 6), { timeout: 5000 });
    await settle();
    const streamingId = await startAnswer(chat);
    reset();
    seenLinks.clear();
    await streamChunks(chat, 10);
    expect(byId(bubbleRenders, finishedIds())).toEqual({});
    expect(byId(parses, finishedIds())).toEqual({});
    expect(bubbleRenders.get(streamingId)).toBeGreaterThanOrEqual(10);
    // A new `entityLinks` object with the same fields keeps the links.
    expect(seenLinks.size).toBe(1);
    expect(document.querySelectorAll('.bubble').length).toBe(TURNS * 2 + 2);
  });

  it('VercelAiChat (AI SDK useChat, floating window): no render and no Markdown parse of any finished message', async () => {
    const { requests } = stubControlledFetch();
    try {
      liveChat = { get messages() { return ctx.messages; } };
      const history = conversation(TURNS);
      render(
        <VercelAiChat
          endpoint="/api/chat"
          defaultOpen
          headerActions={<Probe />}
          session={{ load: async () => history }}
          {...baseConfig()}
        />,
      );
      await waitFor(() => expect(document.querySelectorAll('[data-component="mention-chip"]').length).toBe(TURNS * 6), { timeout: 5000 });
      await settle();
      await act(async () => { ctx.send('ref-question next?'); });
      await waitFor(() => expect(requests.length).toBe(1));
      await act(async () => { for (const chunk of textChunks(streamingText(0))) requests[0]!.push(chunk); });
      await waitFor(() => expect(document.body.textContent).toContain('point 0'));
      await settle();
      reset();
      for (let chunk = 1; chunk <= 10; chunk += 1) {
        await act(async () => {
          requests[0]!.push({ type: 'text-delta', id: 't', delta: `\n- point ${chunk} with more` });
          await new Promise((done) => setTimeout(done, 0));
        });
      }
      await waitFor(() => expect(document.body.textContent).toContain('point 10'));
      expect(byId(bubbleRenders, finishedIds())).toEqual({});
      expect(byId(parses, finishedIds())).toEqual({});
      expect(parses.get(STREAMING)).toBeGreaterThanOrEqual(5);
      expect(bubbleRenders.get(ctx.messages.at(-1)!.id)).toBeGreaterThanOrEqual(5);
    } finally {
      for (const request of requests) request.close();
      vi.unstubAllGlobals();
    }
  });

  it('default bubble with custom MessageParts, MentionChip and Markdown: none of them renders for a finished message', async () => {
    const components: ChatComponents = { MessageParts: CountingParts, MentionChip: CountingChip, Markdown: CountingMarkdown };
    const { chat } = await mount({ ...baseConfig(), components });
    const streamingId = await startAnswer(chat);
    reset();
    await streamChunks(chat, 10);
    expect(byId(bubbleRenders, finishedIds())).toEqual({});
    expect(byId(counts.parts, finishedIds())).toEqual({});
    expect(byId(counts.markdown, finishedIds())).toEqual({});
    expect([...counts.chip.keys()].filter((label) => !label.startsWith('Live'))).toEqual([]);
    expect(counts.parts.get(streamingId)).toBeGreaterThanOrEqual(10);
  });
});


/** Replaces one message of the transport with a new object (as the AI SDK does), the others kept. */
async function replace(chat: StreamingChat, id: string, change: (message: ChatMessage) => ChatMessage) {
  await act(async () => {
    chat.messages = chat.messages.map((message) => (message.id === id ? change(message) : message));
    track(chat.messages);
    chat.setMessages(chat.messages);
  });
}

const visibleIds = () => [...document.querySelectorAll('[data-component="message-bubble"]')].length;
const bubbleText = (index: number) => document.querySelectorAll('[data-component="message-bubble"]')[index]?.textContent ?? '';
const others = (except: ReadonlyArray<string>) => finishedIds().filter((id) => !except.includes(id));
/**
 * The answers with a decided approval. With `approvalDisplay` showing approvals at their part they read the
 * conversation (the names of the approval's records come from all messages), so they render once when a
 * message that is not streaming changes.
 */
const WITH_APPROVAL = Array.from({ length: TURNS }, (_, turn) => turn).filter((turn) => turn % 3 === 0).map((turn) => `r${turn}`);
function expectOnlyChanged(changed: ReadonlyArray<string>, options: { approvals: boolean }) {
  for (const id of changed) expect(bubbleRenders.get(id), id).toBe(1);
  const readers = options.approvals ? WITH_APPROVAL.filter((id) => !changed.includes(id)) : [];
  for (const id of readers) expect(bubbleRenders.get(id), id).toBe(1);
  expect(byId(bubbleRenders, others([...changed, ...readers]))).toEqual({});
}

describe('a finished message renders again when something it shows changes', () => {
  it('new matchers: every bubble once, and the finished answers show the new matches', async () => {
    const { chat, view } = await mount(baseConfig());
    expect(document.querySelectorAll('[data-component="mention-chip"][data-mention-type="task"]').length).toBe(TURNS);
    reset();
    const next = [{ type: 'task', pattern: /MAR-\d+/, resolve: (key: string) => ({ id: key, label: `Task ${key}` }) }];
    const config = { ...baseConfig(), entityLinks: { ...LINKS, matchers: next } };
    view.rerender(<Host chat={chat} config={config} />);
    for (const id of finishedIds()) expect(bubbleRenders.get(id), id).toBe(1);
    // The matcher chips start over with the new `resolve`, without another chunk or render of the chat.
    await waitFor(() => expect(document.querySelector('[data-mention-type="task"] [aria-label]')?.getAttribute('aria-label')).toContain('Task MAR-'));
    const labels = [...document.querySelectorAll('[data-mention-type="task"] [data-action="open"]')].map((chip) => chip.getAttribute('aria-label'));
    expect(labels.length).toBe(TURNS);
    expect(labels.every((label) => label?.includes('Task MAR-'))).toBe(true);
  });

  it('another locale: every bubble once, with the new texts', async () => {
    const { chat, view } = await mount(baseConfig());
    reset();
    view.rerender(<Host chat={chat} config={{ ...baseConfig(), locale: { copyMessageLabel: 'Kopieren', activityDoneOneLabel: 'Ein Schritt' } }} />);
    for (const id of finishedIds()) expect(bubbleRenders.get(id), id).toBe(1);
    const copies = [...document.querySelectorAll('[data-action="copy"]')].map((button) => button.textContent);
    expect(copies.length).toBe(TURNS);
    expect(new Set(copies)).toEqual(new Set(['Kopieren']));
    const summaries = [...document.querySelectorAll('[data-component="activity-log"] [data-element="activity-summary"]')].map((summary) => summary.textContent);
    expect(summaries.filter((summary) => summary?.includes('Ein Schritt')).length).toBe(TURNS - Math.ceil(TURNS / 3));
  });

  it('another theme: no bubble renders (the theme is CSS variables on the panel)', async () => {
    const { chat, view } = await mount(baseConfig());
    const before = document.querySelector('[data-component="message-list"]')!.innerHTML;
    reset();
    view.rerender(<Host chat={chat} config={{ ...baseConfig(), theme: { colors: { primary: '#10b981' } } }} />);
    expect(byId(bubbleRenders, finishedIds())).toEqual({});
    expect((document.querySelector('[data-component="ai-chat-panel"]') as HTMLElement).getAttribute('style')).toContain('#10b981');
    expect(document.querySelector('[data-component="message-list"]')!.innerHTML).toBe(before);
  });

  it('new components: every bubble once, with the new component', async () => {
    const { chat, view } = await mount(baseConfig());
    reset();
    view.rerender(<Host chat={chat} config={{ ...baseConfig(), components: { MentionChip: CountingChip } }} />);
    for (const id of finishedIds()) expect(bubbleRenders.get(id), id).toBe(1);
    expect(document.querySelectorAll('[data-chip]').length).toBeGreaterThanOrEqual(TURNS * 5);
  });

  it('a tool state of an earlier answer changes (approval answered, then its result): only that answer renders, once each', async () => {
    const { chat } = await mount(baseConfig());
    // r4 asked for an approval; the call is answered later (the AI SDK writes a new message object).
    await replace(chat, 'r4', (message) => ({
      ...message,
      parts: [...message.parts, { type: 'tool-channel_archive', toolCallId: 'x4', state: 'approval-requested', input: { key: 'c4_6' }, approval: { id: 'apx4' } }],
    } as ChatMessage));
    const entries = () => [...document.querySelectorAll('[data-component="message-bubble"]')[9]!.querySelectorAll('[data-component="approval-entry"]')];
    expect(entries()).toEqual([]);
    reset();
    await replace(chat, 'r4', (message) => ({
      ...message,
      parts: message.parts.map((part) => ((part as { toolCallId?: string }).toolCallId === 'x4'
        ? { ...part, state: 'approval-responded', approval: { id: 'apx4', approved: true } }
        : part)),
    } as ChatMessage));
    expectOnlyChanged(['r4'], { approvals: true });
    expect(entries().map((entry) => entry.getAttribute('data-decision'))).toEqual(['approved']);
    reset();
    // The UI outcome / result of the call arrives on the earlier answer.
    await replace(chat, 'r4', (message) => ({
      ...message,
      parts: message.parts.map((part) => ((part as { toolCallId?: string }).toolCallId === 'x4'
        ? { ...part, state: 'output-available', output: { message: 'archived x4' } }
        : part)),
    } as ChatMessage));
    expectOnlyChanged(['r4'], { approvals: true });
    expect(entries().map((entry) => entry.getAttribute('data-outcome'))).toEqual(['done']);
  });

  it('a running call of an earlier answer gets its UI outcome: only that answer renders, and its log shows it', async () => {
    const { chat } = await mount(baseConfig());
    await replace(chat, 'r5', (message) => ({
      ...message,
      parts: [{ type: 'tool-open_channel', toolCallId: 'o5', state: 'input-available', input: { key: 'c5_1' } }, ...message.parts],
    } as ChatMessage));
    const steps = () => [...document.querySelectorAll('[data-component="message-bubble"]')[11]!.querySelectorAll('[data-element="activity-step"]')].map((step) => step.getAttribute('data-status'));
    expect(steps()).toContain('aborted');
    reset();
    await replace(chat, 'r5', (message) => ({
      ...message,
      parts: message.parts.map((part) => ((part as { toolCallId?: string }).toolCallId === 'o5'
        ? { ...part, state: 'output-available', output: { ok: true } }
        : part)),
    } as ChatMessage));
    expectOnlyChanged(['r5'], { approvals: true });
    expect(steps()).not.toContain('aborted');
  });

  it.each([
    ['approvals shown at their part', true],
    ['approvals in the panel (default)', false],
  ])('a message replaced by a new object (edit, regenerate), %s: only it renders, once, with its new text', async (_, approvals) => {
    const { chat } = await mount(approvals ? baseConfig() : { ...baseConfig(), approvalDisplay: undefined });
    reset();
    // The marker stays, so the known names and seen ids stay the same (else every bubble renders once for them).
    await replace(chat, 'q6', (message) => ({ ...message, parts: [{ type: 'text', text: 'ref-q6 edited question {{mention:channel:c6_0:Channel 6 zero}}' }] }));
    expectOnlyChanged(['q6'], { approvals });
    expect(bubbleText(12)).toContain('edited question');
  });

  it('another conversation with the same message ids (session switch): every bubble shows the new one', async () => {
    const { chat } = await mount(baseConfig());
    const other = conversation(TURNS).map((message) => ({
      ...message,
      parts: message.parts.map((part) => (part.type === 'text' ? { ...part, text: `${(part as { text: string }).text} (other chat)` } : part)),
    } as ChatMessage));
    await act(async () => { chat.messages = other; track(other); chat.setMessages(other); });
    await settle();
    expect(visibleIds()).toBe(TURNS * 2);
    for (let index = 0; index < TURNS * 2; index += 1) expect(bubbleText(index), String(index)).toContain('(other chat)');
    await act(async () => { ctx.clear(); });
    await settle();
    expect(visibleIds()).toBe(0);
  });

  it('the streamed answer ends: it gets its footer and follow-ups, the finished messages do not render', async () => {
    const { chat } = await mount({ ...baseConfig(), suggestions: { placement: 'message' } });
    const streamingId = await startAnswer(chat);
    await streamChunks(chat, 3);
    expect(document.querySelectorAll('[data-action="follow-up"]').length).toBe(0);
    reset();
    await act(async () => {
      chat.finish([
        { type: 'text', text: streamingText(3) },
        { type: 'tool-suggest_followups', toolCallId: 'f1', state: 'output-available', input: {}, output: { followups: ['Next one?', 'Another?'] } },
      ]);
    });
    track(chat.messages);
    await settle();
    expect(bubbleRenders.get(streamingId)).toBeGreaterThanOrEqual(1);
    // The answer is no longer streaming: the answers with an approval read it now (once).
    expectOnlyChanged([], { approvals: true });
    const last = [...document.querySelectorAll('[data-component="message-bubble"]')].at(-1)!;
    expect([...last.querySelectorAll('[data-action="follow-up"]')].map((button) => button.textContent)).toEqual(['Next one?', 'Another?']);
    expect(last.querySelector('[data-action="copy"]')).not.toBeNull();

    // A new question: the answer before it is no longer the latest (its follow-ups go), the rest does not render.
    reset();
    await act(async () => { void chat.sendMessage({ text: 'ref-again one more' }); });
    track(chat.messages);
    expect(bubbleRenders.get(streamingId)).toBe(1);
    // The new question is the latest message while its turn runs: the conversation the answers read is unchanged.
    expectOnlyChanged([], { approvals: false });
    expect(document.querySelectorAll('[data-action="follow-up"]').length).toBe(0);
  });

  it('the latest answer asks for an approval and the user approves: only the latest answer renders', async () => {
    const { chat } = await mount(baseConfig());
    await replace(chat, 'r12', (message) => ({
      ...message,
      parts: [...message.parts, { type: 'tool-channel_archive', toolCallId: 'z', state: 'approval-requested', input: { key: 'c12_2' }, approval: { id: 'apz' } }],
    } as ChatMessage));
    const latest = () => [...document.querySelectorAll('[data-component="message-bubble"]')].at(-1)!;
    await waitFor(() => expect(latest().querySelector('[data-component="approval-card"]')).not.toBeNull());
    expect(ctx.pendingApprovals.map((approval) => approval.id)).toEqual(['apz']);
    reset();
    await act(async () => { ctx.approve('apz'); });
    await settle();
    expect(ctx.pendingApprovals).toEqual([]);
    expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({ id: 'apz', approved: true });
    expect(bubbleRenders.get('r12')).toBeGreaterThanOrEqual(1);
    expect(byId(bubbleRenders, others(['r12']))).toEqual({});
  });

  it('a clarification of an earlier answer: answered once its answer is in the conversation, open again when the answer goes', async () => {
    const { chat } = await mount(baseConfig());
    await replace(chat, 'r12', (message) => ({
      ...message,
      parts: [...message.parts, {
        type: 'tool-ask_clarification', toolCallId: 'k12', state: 'output-available',
        input: { question: 'Which channel?', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }, output: {},
      }],
    } as ChatMessage));
    const card = () => document.querySelector('[data-component="clarification-card"]')!.getAttribute('data-state');
    expect(card()).toBe('open');
    await act(async () => {
      void chat.sendMessage({ text: clarificationAnswerMessage({ toolCallId: 'k12', answer: 'Alpha', optionId: 'a' }) });
    });
    await act(async () => { chat.stop(); });
    expect(card()).toBe('answered');
    reset();
    // The answer goes again (the app removes it): the question is the latest message, open once more.
    await act(async () => { chat.messages = chat.messages.slice(0, -1); chat.setMessages(chat.messages); });
    expect(card()).toBe('open');
    expectOnlyChanged(['r12'], { approvals: true });
  });

  it('a streamed tool result names a record a finished answer mentions: the finished answer links it', async () => {
    const { chat } = await mount(baseConfig());
    await replace(chat, 'r2', (message) => ({
      ...message,
      parts: [...message.parts, { type: 'text', text: 'ref-r2 later Gamma Desk was mentioned.' }],
    } as ChatMessage));
    const gamma = () => [...document.querySelectorAll('[data-component="mention-chip"]')].filter((chip) => chip.textContent?.includes('Gamma Desk')).length;
    expect(gamma()).toBe(0);
    await startAnswer(chat);
    reset();
    await act(async () => {
      chat.stream([
        { type: 'tool-channels_list', toolCallId: 'tg', state: 'output-available', input: {}, output: { channels: [{ key: 'gamma', title: 'Gamma Desk' }] } },
        { type: 'text', text: streamingText(1) },
      ]);
    });
    track(chat.messages);
    expect(gamma()).toBe(1);
    // The known names changed: each bubble once.
    for (const id of finishedIds()) expect(bubbleRenders.get(id) ?? 0, id).toBeLessThanOrEqual(1);
  });
});
