// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Work the entity links do per streamed chunk. Counted, never timed: calls of the
 * collectors' per-part work made from `entity-links.ts`, regexes compiled, chip
 * mounts in finished messages and the identity of `markdownComponents`.
 */
const work = { parse: 0, declared: 0 };
/** Whether the caller two frames up (the wrapped function's caller) is `entity-links.ts`. */
const calledFromEntityLinks = () => (new Error().stack ?? '').split('\n').slice(2, 4)
  .some((line) => /entity-links[\\/]entity-links\.ts/.test(line));

vi.mock('../../utils/mention-markup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/mention-markup.js')>();
  return {
    ...actual,
    parseMentionSegments: (...args: Parameters<typeof actual.parseMentionSegments>) => {
      if (calledFromEntityLinks()) work.parse += 1;
      return actual.parseMentionSegments(...args);
    },
  };
});
vi.mock('../../../contracts/entity-declaration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contracts/entity-declaration.js')>();
  return {
    ...actual,
    declaredRecordsOf: (...args: Parameters<typeof actual.declaredRecordsOf>) => {
      if (calledFromEntityLinks()) work.declared += 1;
      return actual.declaredRecordsOf(...args);
    },
  };
});

import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport, MentionChipProps } from '../../types.js';
import { useChatEntityLinks } from '../entity-links-react.js';
import type { ChatEntityLinksConfig } from '../entity-links.js';

const NativeRegExp = RegExp;
afterEach(() => {
  globalThis.RegExp = NativeRegExp;
  cleanup();
  vi.restoreAllMocks();
});

function transport(messages: ChatMessage[]): ChatTransport {
  return {
    messages, status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const DECLARED: EntityDeclarationsByTool = {
  channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
};

/** `turns` user/assistant pairs; each answer lists 20 declared channels and names some of them. */
function conversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ id: `u${turn}`, role: 'user', parts: [{ type: 'text', text: `Is {{mention:channel:c${turn}_0:Channel ${turn} zero}} live?` }] });
    messages.push({
      id: `a${turn}`, role: 'assistant', parts: [
        {
          type: 'tool-channels_list', toolCallId: `t${turn}`, state: 'output-available', input: {},
          output: { channels: Array.from({ length: 20 }, (_, record) => ({ key: `c${turn}_${record}`, title: `Channel ${turn} n${record}` })) },
        },
        { type: 'text', text: `**Yes**: {{mention:channel:c${turn}_1:Channel ${turn} n1}} and Channel ${turn} n2 run.\n\n- {{mention:channel:c${turn}_3:Channel ${turn} n3}}\n- MAR-${turn}` },
      ],
    } as unknown as ChatMessage);
  }
  return messages;
}

/** The next chunk of the last message, as the AI SDK delivers it: a new clone, the settled messages unchanged. */
function nextChunk(messages: ChatMessage[], chunk: number): ChatMessage[] {
  const last = structuredClone(messages[messages.length - 1]!) as unknown as { parts: Array<{ type: string; text?: string }> };
  const text = last.parts.find((part) => part.type === 'text')!;
  text.text += ` more ${chunk}`;
  return [...messages.slice(0, -1), last as unknown as ChatMessage];
}

const mounts = { finished: 0, streaming: 0 };
let streamingPrefix = '';
function CountingChip({ mention, onOpen, openLabel }: MentionChipProps) {
  useEffect(() => {
    if (mention.id.startsWith(streamingPrefix)) mounts.streaming += 1;
    else mounts.finished += 1;
  }, []);
  return <button type="button" aria-label={openLabel} onClick={onOpen} data-chip={mention.id}>{mention.displayName}</button>;
}
const COMPONENTS = { MentionChip: CountingChip };

const seenParagraphs = new Set<unknown>();
const seenLinks = new Set<unknown>();
function ParagraphIdentity() {
  const links = useChatEntityLinks();
  seenParagraphs.add(links.markdownComponents.p);
  seenLinks.add(links);
  return null;
}

const bus = new UiActionBus();
function Chat({ messages, entityLinks }: { messages: ChatMessage[]; entityLinks: ChatEntityLinksConfig }) {
  return (
    <AiChatProvider transport={transport(messages)} entityLinks={entityLinks} entityDeclarations={DECLARED} uiActionBus={bus} components={COMPONENTS}>
      <ParagraphIdentity />
      <AiChatPanel />
    </AiChatProvider>
  );
}

const resolveKey = (key: string) => ({ id: key, label: key });
const CONFIGS: Array<[string, ChatEntityLinksConfig]> = [
  ['known on, verifyMentions on', { mentionMarkers: 'markdown', matchers: [{ type: 'task', pattern: /MAR-\d+/, resolve: resolveKey }], open: () => {} }],
  ['known on, verifyMentions off', { mentionMarkers: 'markdown', verifyMentions: false, matchers: [{ type: 'task', pattern: /MAR-\d+/, resolve: resolveKey }], open: () => {} }],
  ['known off, verifyMentions on', { known: false, mentionMarkers: 'markdown', matchers: [{ type: 'task', pattern: /MAR-\d+/, resolve: resolveKey }], open: () => {} }],
  ['known off, verifyMentions off', { known: false, verifyMentions: false, mentionMarkers: 'markdown', matchers: [], open: () => {} }],
];

const CHUNKS = 4;

/** Renders `turns` turns, waits for the chips, then streams `CHUNKS` chunks into the last answer. */
async function stream(turns: number, entityLinks: ChatEntityLinksConfig, perChunk?: () => ChatEntityLinksConfig) {
  streamingPrefix = `c${turns - 1}_`;
  let messages = conversation(turns);
  const view = render(<Chat messages={messages} entityLinks={entityLinks} />);
  await waitFor(() => expect(document.querySelector(`[data-chip="c${turns - 1}_3"]`)).not.toBeNull(), { timeout: 5000 });
  // Let the matcher hits resolve before counting.
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  Object.assign(work, { parse: 0, declared: 0 });
  Object.assign(mounts, { finished: 0, streaming: 0 });
  const compiled = { all: 0, labels: 0 };
  globalThis.RegExp = new Proxy(NativeRegExp, {
    construct(target, args, newTarget) {
      compiled.all += 1;
      if (String(args[0]).includes('Channel')) compiled.labels += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
    messages = nextChunk(messages, chunk);
    const config = perChunk ? perChunk() : entityLinks;
    await act(async () => { view.rerender(<Chat messages={messages} entityLinks={config} />); });
  }
  globalThis.RegExp = NativeRegExp;
  return { work: { ...work }, mounts: { ...mounts }, compiled };
}

describe('entity links while an answer streams', () => {
  for (const [name, entityLinks] of CONFIGS) {
    it(`${name}: markdownComponents keep their identity while the messages change`, async () => {
      seenParagraphs.clear();
      await stream(3, entityLinks);
      // Rendered with the initial messages and after each of the chunks: one identity.
      expect(seenParagraphs.size).toBe(1);
    });

    it(`${name}: the links keep their identity over chunks that change no known name or seen id`, async () => {
      const turns = 3;
      streamingPrefix = `c${turns - 1}_`;
      let messages = conversation(turns);
      const view = render(<Chat messages={messages} entityLinks={entityLinks} />);
      await waitFor(() => expect(document.querySelector(`[data-chip="c${turns - 1}_3"]`)).not.toBeNull(), { timeout: 5000 });
      seenLinks.clear();
      for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
        messages = nextChunk(messages, chunk);
        await act(async () => { view.rerender(<Chat messages={messages} entityLinks={entityLinks} />); });
      }
      expect(seenLinks.size).toBe(1);
    });

    it(`${name}: no chip of a finished message mounts again while a later message streams`, async () => {
      const { mounts: counted } = await stream(5, entityLinks);
      expect(counted.finished).toBe(0);
    });

    it(`${name}: the collectors' work per chunk does not grow with the settled history`, async () => {
      const short = await stream(5, entityLinks);
      cleanup();
      const long = await stream(15, entityLinks);
      expect(long.work).toEqual(short.work);
      // Only the streaming message is read again: one text part and one tool result per collector.
      expect(long.work.parse).toBeLessThanOrEqual(CHUNKS);
      expect(long.work.declared).toBeLessThanOrEqual(2 * CHUNKS);
    });

    it(`${name}: no regex is compiled again while the known names stay the same`, async () => {
      const { compiled } = await stream(5, entityLinks);
      expect(compiled.labels).toBe(0);
      expect(compiled.all).toBe(0);
    });
  }

  it('a knownEntities hook that returns new objects with the same content keeps the links identity', async () => {
    const turns = 3;
    streamingPrefix = `c${turns - 1}_`;
    const knownEntities = vi.fn(() => [{ type: 'room', id: 'r1', label: 'Back office', data: { floor: 2 } }]);
    const entityLinks: ChatEntityLinksConfig = { mentionMarkers: 'markdown', knownEntities, open: () => {} };
    let messages = conversation(turns);
    const view = render(<Chat messages={messages} entityLinks={entityLinks} />);
    await waitFor(() => expect(document.querySelector(`[data-chip="c${turns - 1}_3"]`)).not.toBeNull(), { timeout: 5000 });
    seenLinks.clear();
    const calls = knownEntities.mock.calls.length;
    for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
      messages = nextChunk(messages, chunk);
      await act(async () => { view.rerender(<Chat messages={messages} entityLinks={entityLinks} />); });
    }
    // Still asked on every change of the messages.
    expect(knownEntities.mock.calls.length).toBeGreaterThanOrEqual(calls + CHUNKS);
    expect(seenLinks.size).toBe(1);
  });

  it('an app that passes a new config object (same matchers) on every render keeps markdownComponents and the chips of finished messages', async () => {
    seenParagraphs.clear();
    const matchers = [{ type: 'task', pattern: /MAR-\d+/, resolve: resolveKey }];
    const fresh = (): ChatEntityLinksConfig => ({ mentionMarkers: 'markdown', matchers, open: () => {} });
    const { mounts: counted, compiled } = await stream(5, fresh(), fresh);
    expect(seenParagraphs.size).toBe(1);
    expect(counted.finished).toBe(0);
    expect(compiled.all).toBe(0);
  });

  it('new matchers (a new array with new regexes) on every render: markdownComponents stay, nothing is compiled again, chips start over as in 0.29.0', async () => {
    seenParagraphs.clear();
    const fresh = (): ChatEntityLinksConfig => ({
      mentionMarkers: 'markdown',
      matchers: [{ type: 'task', pattern: new RegExp('MAR-\\d+'), resolve: resolveKey }],
      open: () => {},
    });
    const { compiled } = await stream(5, fresh(), fresh);
    expect(seenParagraphs.size).toBe(1);
    // Only the app's own `new RegExp` per render; the label and matcher patterns are not compiled again.
    expect(compiled.labels).toBe(0);
    expect(compiled.all).toBe(CHUNKS);
  });
});
