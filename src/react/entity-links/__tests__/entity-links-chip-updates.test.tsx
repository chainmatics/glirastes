// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { StrictMode, Suspense, startTransition, use, useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport, MentionChipProps } from '../../types.js';
import { WithoutEntityLinks, useChatEntityLinks } from '../entity-links-react.js';
import type { ChatEntityLinksConfig } from '../entity-links.js';

/**
 * A chip follows its text: when a streamed chunk or new matchers change what
 * a chip stands for, it shows (and opens) the new record, never the one before.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function transport(messages: ChatMessage[]): ChatTransport {
  return {
    messages, status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const mounts = new Map<string, number>();
function CountingChip({ mention, onOpen, openLabel }: MentionChipProps) {
  useEffect(() => { mounts.set(mention.id, (mounts.get(mention.id) ?? 0) + 1); }, []);
  return <button type="button" aria-label={openLabel} onClick={onOpen} data-chip={`${mention.type}:${mention.id}`}>{mention.displayName}</button>;
}
const COMPONENTS = { MentionChip: CountingChip };

const bus = new UiActionBus();
function Chat({ messages, entityLinks, strict = false, entityDeclarations, children }: {
  messages: ChatMessage[]; entityLinks: ChatEntityLinksConfig; strict?: boolean; entityDeclarations?: EntityDeclarationsByTool; children?: ReactNode;
}) {
  const chat = (
    <AiChatProvider transport={transport(messages)} entityLinks={entityLinks} entityDeclarations={entityDeclarations} uiActionBus={bus} components={COMPONENTS}>
      {children}
      <AiChatPanel />
    </AiChatProvider>
  );
  return strict ? <StrictMode>{chat}</StrictMode> : chat;
}

const answer = (text: string): ChatMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Which task?' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] },
];

const chips = () => [...document.querySelectorAll('[data-chip]')].map((chip) => `${chip.getAttribute('data-chip')}=${chip.textContent}`);

/** Renders `first`, waits for `firstChips`, streams `then` (each a new message object with the same id) and returns the chips. */
async function streamed(entityLinks: ChatEntityLinksConfig, first: string, firstChips: string[], then: string[], options: { strict?: boolean } = {}) {
  const view = render(<Chat messages={answer(first)} entityLinks={entityLinks} strict={options.strict} />);
  await waitFor(() => expect(chips()).toEqual(firstChips));
  for (const text of then) {
    await act(async () => { view.rerender(<Chat messages={answer(text)} entityLinks={entityLinks} strict={options.strict} />); });
  }
  // Let every resolve settle.
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
  return view;
}

const TASK = /MAR-\d+/;

describe('a matcher chip follows its text while the answer streams', () => {
  it('"See MAR-5" becomes "See MAR-51" (no resolve): the chip is MAR-51', async () => {
    const open = vi.fn();
    await streamed({ matchers: [{ type: 'task', pattern: TASK }], open }, 'See MAR-5', ['task:MAR-5=MAR-5'], ['See MAR-51']);
    expect(chips()).toEqual(['task:MAR-51=MAR-51']);
    fireEvent.click(document.querySelector('[data-chip]')!);
    expect(open).toHaveBeenCalledWith({ type: 'task', id: 'MAR-51', label: 'MAR-51' });
  });

  it('"Fix MAR-1" becomes "Fix MAR-12 now" (with resolve): the chip is MAR-12', async () => {
    const resolve = (key: string) => ({ id: `id-${key}`, label: `Task ${key}` });
    await streamed({ matchers: [{ type: 'task', pattern: TASK, resolve }], open: vi.fn() }, 'Fix MAR-1', ['task:id-MAR-1=MAR-1'], ['Fix MAR-12 now']);
    expect(chips()).toEqual(['task:id-MAR-12=MAR-12']);
  });

  it('"Open ABC-1" becomes "Open XYZ-9" in the same message: the chip is XYZ-9', async () => {
    await streamed({ matchers: [{ type: 'ticket', pattern: /[A-Z]{3}-\d+/ }], open: vi.fn() }, 'Open ABC-1', ['ticket:ABC-1=ABC-1'], ['Open XYZ-9']);
    expect(chips()).toEqual(['ticket:XYZ-9=XYZ-9']);
  });

  it('mentionMarkers markdown: "**MAR-5**" becomes "**MAR-51**": the chip is MAR-51', async () => {
    await streamed({ mentionMarkers: 'markdown', matchers: [{ type: 'task', pattern: TASK }], open: vi.fn() }, 'Look: **MAR-5**', ['task:MAR-5=MAR-5'], ['Look: **MAR-51**']);
    expect(chips()).toEqual(['task:MAR-51=MAR-51']);
  });

  it('EntityText (a text part with a marker, mentionMarkers plain): "MAR-5" becomes "MAR-51": the chip is MAR-51', async () => {
    const marker = '{{mention:channel:c1:Lobby}}';
    await streamed(
      { matchers: [{ type: 'task', pattern: TASK }], open: vi.fn() },
      `${marker} needs MAR-5`, ['channel:c1=Lobby', 'task:MAR-5=MAR-5'], [`${marker} needs MAR-51`],
    );
    expect(chips()).toEqual(['channel:c1=Lobby', 'task:MAR-51=MAR-51']);
  });

  it('new matchers whose resolve denies the hit: the chip goes, also over later chunks', async () => {
    const allow = { matchers: [{ type: 'task', pattern: TASK, resolve: (key: string) => ({ id: key, label: key }) }], open: vi.fn() };
    const deny: ChatEntityLinksConfig = { matchers: [{ type: 'task', pattern: TASK, resolve: () => undefined }], open: allow.open };
    const view = render(<Chat messages={answer('See MAR-5')} entityLinks={allow} />);
    await waitFor(() => expect(chips()).toEqual(['task:MAR-5=MAR-5']));
    await act(async () => { view.rerender(<Chat messages={answer('See MAR-5')} entityLinks={deny} />); });
    for (const text of ['See MAR-5 and', 'See MAR-5 and more']) {
      await act(async () => { view.rerender(<Chat messages={answer(text)} entityLinks={deny} />); });
    }
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(chips()).toEqual([]);
    expect(document.body.textContent).toContain('See MAR-5 and more');
  });

  it('while the new hit resolves, the chip never shows the record of the old one', async () => {
    // MAR-51 never resolves: its text stays plain, it never borrows MAR-5's chip.
    const resolve = (key: string) => (key === 'MAR-5' ? { id: key, label: key } : new Promise<undefined>(() => {}));
    await streamed({ matchers: [{ type: 'task', pattern: TASK, resolve }], open: vi.fn() }, 'See MAR-5', ['task:MAR-5=MAR-5'], ['See MAR-51']);
    expect(chips()).toEqual([]);
    expect(document.body.textContent).toContain('See MAR-51');
  });

  it('a chip whose text did not change is not mounted again while the answer streams', async () => {
    mounts.clear();
    const resolve = (key: string) => ({ id: key, label: key });
    await streamed(
      { mentionMarkers: 'markdown', matchers: [{ type: 'task', pattern: TASK, resolve }], open: vi.fn() },
      'Done: **MAR-5**.', ['task:MAR-5=MAR-5'], ['Done: **MAR-5**. Next', 'Done: **MAR-5**. Next up', 'Done: **MAR-5**. Next up soon'],
    );
    expect(chips()).toEqual(['task:MAR-5=MAR-5']);
    expect(mounts.get('MAR-5')).toBe(1);
  });

  it('a hit already resolved is a chip in the same commit when it appears again (no plain text in between)', async () => {
    const resolve = vi.fn((key: string) => ({ id: key, label: key }));
    const entityLinks: ChatEntityLinksConfig = { matchers: [{ type: 'task', pattern: TASK, resolve }], open: vi.fn() };
    const view = await streamed(entityLinks, 'See MAR-5', ['task:MAR-5=MAR-5'], []);
    act(() => { view.rerender(<Chat messages={answer('See MAR-5, again MAR-5')} entityLinks={entityLinks} />); });
    expect(chips()).toEqual(['task:MAR-5=MAR-5', 'task:MAR-5=MAR-5']);
  });
});

describe('the first render resolves as 0.29.0 did (the cache is cleared once after mounting)', () => {
  const MARKER = '{{mention:channel:c1:Lobby}}';
  for (const [path, text] of [['EntityText', `${MARKER} see MAR-5`], ['Markdown', 'See MAR-5']] as const) {
    it(`${path}: a hit still waiting is asked again: a resolve that answers differently each time ends on the second answer`, async () => {
      let count = 0;
      const entityLinks: ChatEntityLinksConfig = { matchers: [{ type: 'task', pattern: TASK, resolve: (key) => ({ id: `${key}#${++count}`, label: key }) }] };
      render(<Chat messages={answer(text)} entityLinks={entityLinks} />);
      await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
      expect(chips().filter((chip) => chip.startsWith('task:'))).toEqual(['task:MAR-5#2=MAR-5']);
    });

    it(`${path}: a resolve that throws once at mount still ends as a chip`, async () => {
      let count = 0;
      const entityLinks: ChatEntityLinksConfig = {
        matchers: [{ type: 'task', pattern: TASK, resolve: (key) => { count += 1; if (count === 1) throw new Error('offline'); return { id: key, label: key }; } }],
      };
      render(<Chat messages={answer(text)} entityLinks={entityLinks} />);
      await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
      expect(chips().filter((chip) => chip.startsWith('task:'))).toEqual(['task:MAR-5=MAR-5']);
    });
  }
});

describe('new matchers start every chip over, as in 0.29.0', () => {
  it('a finished chip of the old matchers shows in the render that passes them, then starts over (0.29.0: [A-MAR-5], [], [], [])', async () => {
    const conversation = (later: string): ChatMessage[] => [
      ...answer('See MAR-5'),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'And now?' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: later }] },
    ];
    const a: ChatEntityLinksConfig = { matchers: [{ type: 'task', pattern: TASK, resolve: (key) => ({ id: `A-${key}`, label: key }) }], open: vi.fn() };
    const b: ChatEntityLinksConfig = {
      matchers: [{ type: 'customer', pattern: TASK, resolve: () => new Promise<undefined>((done) => setTimeout(() => done(undefined), 60)) }],
      open: a.open,
    };
    const view = render(<Chat messages={conversation('Working')} entityLinks={a} />);
    await waitFor(() => expect(chips()).toEqual(['task:A-MAR-5=MAR-5']));
    const seen: string[][] = [];
    await act(async () => { view.rerender(<Chat messages={conversation('Working')} entityLinks={b} />); });
    seen.push(chips());
    for (const later of ['Working on', 'Working on it']) {
      await act(async () => { view.rerender(<Chat messages={conversation(later)} entityLinks={b} />); });
      seen.push(chips());
    }
    await act(async () => { await new Promise((done) => setTimeout(done, 100)); });
    seen.push(chips());
    expect(seen).toEqual([['task:A-MAR-5=MAR-5'], [], [], []]);
  });
});

describe("one provider's markdownComponents rendered elsewhere link with that provider's links, as in 0.29.0", () => {
  const ABC = /ABC-\d+/;
  function Foreign({ children }: { children: ReactNode }) {
    return <AiChatProvider transport={transport([])} entityLinks={{ matchers: [{ type: 'other', pattern: ABC }] }} uiActionBus={bus} components={COMPONENTS}>{children}</AiChatProvider>;
  }
  /** Renders the outer provider's `p` component inside `wrap`. */
  function Grab({ wrap }: { wrap: (node: ReactNode) => ReactNode }) {
    const P = useChatEntityLinks().markdownComponents.p!;
    return <>{wrap(<div data-testid="grabbed"><P>{'See MAR-3 and ABC-4'}</P></div>)}</>;
  }
  const grabbed = () => [...document.querySelectorAll('[data-testid="grabbed"] [data-chip]')].map((chip) => chip.getAttribute('data-chip'));

  it('under a foreign provider, from the first render, and after the outer matchers change', async () => {
    const outer = (pattern: RegExp, type: string): ChatEntityLinksConfig => ({ matchers: [{ type, pattern }], open: vi.fn() });
    const tree = (links: ChatEntityLinksConfig) => (
      <Chat messages={[]} entityLinks={links}><Grab wrap={(node) => <Foreign>{node}</Foreign>} /></Chat>
    );
    const view = render(tree(outer(TASK, 'task')));
    await waitFor(() => expect(grabbed()).toEqual(['task:MAR-3']));
    await act(async () => { view.rerender(tree(outer(ABC, 'abc'))); });
    await waitFor(() => expect(grabbed()).toEqual(['abc:ABC-4']));
  });

  it('under WithoutEntityLinks: a known name is still a chip (a matcher hit is resolved by the links around it, none there)', async () => {
    const named: ChatMessage[] = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What about {{mention:task:t7:Release prüfen}}?' }] }];
    function GrabName({ wrap }: { wrap: (node: ReactNode) => ReactNode }) {
      const P = useChatEntityLinks().markdownComponents.p!;
      return <>{wrap(<div data-testid="grabbed"><P>{'Release prüfen and MAR-3'}</P></div>)}</>;
    }
    render(<Chat messages={named} entityLinks={{ matchers: [{ type: 'task', pattern: TASK }], open: vi.fn() }}>
      <GrabName wrap={(node) => <WithoutEntityLinks>{node}</WithoutEntityLinks>} />
    </Chat>);
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(grabbed()).toEqual(['task:t7']);
  });

  it('a render React sets aside (a transition that suspends) does not leak into what the committed tree shows', async () => {
    let setLinks: (links: ChatEntityLinksConfig) => void = () => {};
    let setHold: (hold: boolean) => void = () => {};
    let bump: () => void = () => {};
    const never = new Promise<never>(() => {});
    function Hold({ hold }: { hold: boolean }) {
      if (hold) use(never);
      return null;
    }
    function Probe() {
      const [count, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      const P = useChatEntityLinks().markdownComponents.p!;
      return <div data-testid="grabbed" data-count={count}><P>{'See MAR-3 and ABC-4'}</P></div>;
    }
    function App() {
      const [links, set] = useState<ChatEntityLinksConfig>({ matchers: [{ type: 'task', pattern: TASK }], open: () => {} });
      const [hold, setHoldState] = useState(false);
      setLinks = set;
      setHold = setHoldState;
      return (
        <Chat messages={[]} entityLinks={links}>
          <Suspense fallback={null}><Hold hold={hold} /></Suspense>
          <Probe />
        </Chat>
      );
    }
    render(<App />);
    await waitFor(() => expect(grabbed()).toEqual(['task:MAR-3']));
    // New matchers in a transition that suspends: React renders them and sets that render aside.
    await act(async () => {
      startTransition(() => {
        setLinks({ matchers: [{ type: 'abc', pattern: ABC }], open: () => {} });
        setHold(true);
      });
    });
    // An urgent update below the provider renders with the committed links.
    await act(async () => { bump(); });
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(document.querySelector('[data-testid="grabbed"]')?.getAttribute('data-count')).toBe('1');
    expect(grabbed()).toEqual(['task:MAR-3']);
  });
});

const DECLARED: EntityDeclarationsByTool = {
  channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
};

describe('StrictMode', () => {
  const paragraphs = new Set<unknown>();
  function ParagraphIdentity() {
    paragraphs.add(useChatEntityLinks().markdownComponents.p);
    return null;
  }
  const history = (more: string): ChatMessage[] => [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Is {{mention:channel:c1:Lobby screens}} live?' }] },
    {
      id: 'a1', role: 'assistant', parts: [
        { type: 'tool-channels_list', toolCallId: 't1', state: 'output-available', input: {}, output: { channels: [{ key: 'c2', title: 'Main hall' }, { key: 'c3', title: 'Back office' }] } },
        { type: 'text', text: `**Yes**: {{mention:channel:c2:Main hall}} and Back office run, MAR-7.${more}` },
      ],
    } as unknown as ChatMessage,
  ];
  const links: ChatEntityLinksConfig = { mentionMarkers: 'markdown', matchers: [{ type: 'task', pattern: TASK, resolve: (key) => ({ id: key, label: key }) }], open: () => {} };

  async function run(strict: boolean): Promise<string[]> {
    paragraphs.clear();
    mounts.clear();
    const view = render(
      <Chat messages={history('')} entityLinks={links} strict={strict} entityDeclarations={DECLARED}><ParagraphIdentity /></Chat>,
    );
    await waitFor(() => expect(document.querySelector('[data-chip="task:MAR-7"]')).not.toBeNull());
    for (const more of [' More', ' More and', ' More and Main hall']) {
      await act(async () => {
        view.rerender(<Chat messages={history(more)} entityLinks={links} strict={strict} entityDeclarations={DECLARED}><ParagraphIdentity /></Chat>);
      });
    }
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    const shown = chips();
    cleanup();
    return shown;
  }

  it('streams to the same chips as without StrictMode, with one markdownComponents identity', async () => {
    const plain = await run(false);
    expect(paragraphs.size).toBe(1);
    const strict = await run(true);
    expect(strict).toEqual(plain);
    expect(paragraphs.size).toBe(1);
    expect(plain).toEqual(['channel:c1=Lobby screens', 'channel:c2=Main hall', 'channel:c3=Back office', 'task:MAR-7=MAR-7', 'channel:c2=Main hall']);
  });
});
