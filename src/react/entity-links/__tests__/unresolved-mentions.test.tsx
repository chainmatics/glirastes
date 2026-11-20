// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { defineChatEntity, type ChatEntityItem } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport } from '../../types.js';
import type { ChatEntityLinksConfig } from '../entity-links.js';
import { useChatEntityLinks } from '../entity-links-react.js';
import { Host, StreamingChat, ctx } from '../../__tests__/streaming-chat.js';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';
import { useChatInteractionsData } from '../../interactions/use-chat-interactions-data.js';

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

const DECLARED: EntityDeclarationsByTool = {
  playlists_list: { output: [{ type: 'playlist', id: 'id', name: 'name', path: 'playlists[]' }] },
};

const listed = {
  type: 'tool-playlists_list', toolCallId: 'c1', state: 'output-available', input: {},
  output: { playlists: [{ id: 'pl_7', name: 'Lobby Loop' }] },
};

function answer(text: string, user = 'Which playlist?'): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: user }] },
    { id: 'a1', role: 'assistant', parts: [listed, { type: 'text', text }] },
  ] as unknown as ChatMessage[];
}

type Search = (query: string) => ReadonlyArray<ChatEntityItem> | Promise<ReadonlyArray<ChatEntityItem>>;

const interactionsBySearch = new WeakMap<Search, { entities: ReturnType<typeof defineChatEntity>[] }>();
/** One `chatInteractions` object per search function, as an app with `useMemo` passes it. */
function stableInteractions(search: Search) {
  let found = interactionsBySearch.get(search);
  if (!found) {
    found = { entities: [defineChatEntity({ type: 'playlist', label: 'Playlist', search: (query: string) => search(query) })] };
    interactionsBySearch.set(search, found);
  }
  return found;
}

function Chat({ messages, entityLinks, search, declarations = DECLARED }: {
  messages: ChatMessage[];
  entityLinks: ChatEntityLinksConfig;
  search?: Search;
  declarations?: EntityDeclarationsByTool;
}) {
  const interactions = search ? stableInteractions(search) : undefined;
  return (
    <AiChatProvider
      transport={transport(messages)}
      uiActionBus={new UiActionBus()}
      entityDeclarations={declarations}
      entityLinks={entityLinks}
      {...(interactions ? { chatInteractions: interactions } : {})}
    >
      <AiChatPanel />
    </AiChatProvider>
  );
}

function bubble(): Element {
  return document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')[0]!;
}

function chips(): Element[] {
  return [...bubble().querySelectorAll('[data-component="mention-chip"]')];
}

async function textShown(text: string): Promise<void> {
  await waitFor(() => expect(bubble()?.textContent ?? '').toContain(text));
}

const WRONG = 'Found {{mention:playlist:pl_8:Lobby Loop}} for you.';

describe('unresolvedMentions: default keeps today', () => {
  it("plain markers (default): a wrong id is still a chip that opens the wrong id", async () => {
    const open = vi.fn();
    render(<Chat messages={answer(WRONG)} entityLinks={{ open }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Lobby Loop' }));
    expect(open).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_8', label: 'Lobby Loop' });
  });

  it("markdown markers (default verifyMentions): a wrong id stays its label", async () => {
    render(<Chat messages={answer(WRONG)} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', known: false }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
  });

  it("'keep' is the explicit off switch", async () => {
    const open = vi.fn();
    render(<Chat messages={answer(WRONG)} entityLinks={{ open, unresolvedMentions: 'keep' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Lobby Loop' }));
    expect(open).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_8', label: 'Lobby Loop' });
  });
});

describe("unresolvedMentions: 'text'", () => {
  for (const mentionMarkers of ['plain', 'markdown'] as const) {
    it(`${mentionMarkers}: a marker with an id the conversation never showed renders as its name, no chip`, async () => {
      render(<Chat messages={answer(WRONG)} entityLinks={{ open: vi.fn(), mentionMarkers, unresolvedMentions: 'text', known: false }} />);
      await textShown('Found Lobby Loop for you.');
      expect(chips()).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Open Lobby Loop' })).toBeNull();
    });

    it(`${mentionMarkers}: a shown id stays a chip`, async () => {
      const open = vi.fn();
      render(<Chat messages={answer('Found {{mention:playlist:pl_7:Lobby Loop}}.')} entityLinks={{ open, mentionMarkers, unresolvedMentions: 'text', known: false }} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open Lobby Loop' }));
      expect(open).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_7', label: 'Lobby Loop' });
    });
  }

  it('leaves markers of an undeclared type and commands as they were', async () => {
    const open = vi.fn();
    render(<Chat messages={answer('Ask {{mention:robot:r9:Robo Arm}} now.')} entityLinks={{ open, unresolvedMentions: 'text' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Robo Arm' }));
    expect(open).toHaveBeenCalledWith({ type: 'robot', id: 'r9', label: 'Robo Arm' });
  });

  it("leaves a user's own marker a chip", async () => {
    const messages = answer('Done.', 'About {{mention:playlist:pl_42:Old Loop}}');
    render(<Chat messages={messages} entityLinks={{ open: vi.fn(), unresolvedMentions: 'text' }} />);
    await textShown('Done.');
    const user = document.querySelector('[data-component="message-bubble"][data-role="user"]')!;
    expect(user.querySelectorAll('[data-component="mention-chip"]')).toHaveLength(1);
  });

  it('never applies to a marker of a user message, whatever its id (role check)', async () => {
    const decided: Record<string, string | undefined> = {};
    function Probe() {
      const links = useChatEntityLinks();
      const mention = { type: 'playlist', id: 'pl_404', displayName: 'Lobby Loop', prefix: '@' };
      decided.user = links.unresolvedMention?.(mention, { id: 'u1', role: 'user' });
      decided.assistant = links.unresolvedMention?.(mention, { id: 'a1', role: 'assistant' });
      return null;
    }
    render(
      <AiChatProvider transport={transport(answer('Done.'))} uiActionBus={new UiActionBus()} entityDeclarations={DECLARED} entityLinks={{ unresolvedMentions: 'text' }}>
        <Probe />
      </AiChatProvider>,
    );
    expect(decided).toEqual({ user: 'keep', assistant: 'text' });
  });

  it("markdown with verifyMentions: false: 'text' still applies", async () => {
    render(<Chat messages={answer(WRONG)} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', verifyMentions: false, unresolvedMentions: 'text', known: false }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
  });
});

describe('unresolvedMention hook', () => {
  it('decides per marker; undefined or a throw falls back to unresolvedMentions', async () => {
    const decide = vi.fn((marker: { id: string }) => {
      if (marker.id === 'pl_8') return 'keep' as const;
      if (marker.id === 'pl_9') throw new Error('boom');
      return undefined;
    });
    const text = 'A {{mention:playlist:pl_8:Lobby Loop}} B {{mention:playlist:pl_9:Other}} C {{mention:playlist:pl_10:Third}}.';
    render(<Chat messages={answer(text)} entityLinks={{ open: vi.fn(), unresolvedMentions: 'text', unresolvedMention: decide, known: false }} />);
    await screen.findByRole('button', { name: 'Open Lobby Loop' });
    expect(chips()).toHaveLength(1);
    expect(bubble().textContent).toContain('B Other C Third.');
    expect(decide).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_8', label: 'Lobby Loop' });
    expect(decide).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'pl_7' }));
  });

  it('works without unresolvedMentions', async () => {
    render(<Chat messages={answer(WRONG)} entityLinks={{ open: vi.fn(), unresolvedMention: () => 'text' }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
  });
});

describe('interactions still loading (review 3)', () => {
  const CHANNELS: EntityDeclarationsByTool = { channels_list: { output: [{ type: 'channel', id: 'key', name: 'title' }] } };
  const loaded = (types: string[]) => ({
    schemaVersion: 1, commands: [],
    entities: types.map((type) => ({ type, label: type })),
  }) as unknown as ChatInteractionsData;
  const Loading = ({ chatInteractions }: { chatInteractions: Record<string, unknown> }) => (
    <AiChatProvider transport={transport(answer(WRONG))} uiActionBus={new UiActionBus()} entityDeclarations={CHANNELS} entityLinks={{ open: vi.fn(), unresolvedMentions: 'text' }} chatInteractions={chatInteractions}>
      <AiChatPanel />
    </AiChatProvider>
  );

  it('shows the name as text, never a chip, while derived data is still loading', async () => {
    const view = render(<Loading chatInteractions={{ data: undefined, loading: true }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
    view.rerender(<Loading chatInteractions={{ data: loaded(['playlist']) }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
  });

  it('data given as undefined without a pending load is judged with what is known: a chip', async () => {
    render(<Loading chatInteractions={{ data: undefined }} />);
    expect(await screen.findByRole('button', { name: 'Open Lobby Loop' })).not.toBeNull();
  });

  it('honours an explicit loading flag', async () => {
    render(<Loading chatInteractions={{ entities: [], loading: true }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
  });

  it('keeps a loaded but undeclared type a chip', async () => {
    render(<Loading chatInteractions={{ data: loaded(['person']) }} />);
    expect(await screen.findByRole('button', { name: 'Open Lobby Loop' })).not.toBeNull();
  });
});


const NOOP_SEARCH = () => [];
const playlistInteractions = { entities: [defineChatEntity({ type: 'playlist', label: 'Playlist', search: NOOP_SEARCH })] };
const CHANNELS_ONLY: EntityDeclarationsByTool = { channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] } };
const TURN_ONE = [listed, { type: 'text', text: 'Found {{mention:playlist:pl_7:Lobby Loop}} not {{mention:playlist:pl_8:Lobby Loop}}.' }];

function assistantBubbles(): Element[] {
  return [...document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')];
}

/** Chips and text of one assistant bubble: each chip's open target, and its text. */
function bubbleState(index: number, open: ReturnType<typeof vi.fn>): { ids: string[]; text: string } {
  const bubble = assistantBubbles()[index]!;
  open.mockClear();
  for (const button of bubble.querySelectorAll('[data-component="mention-chip"] button')) fireEvent.click(button);
  return { ids: open.mock.calls.map(([reference]) => (reference as { id: string }).id), text: bubble.textContent ?? '' };
}

/** One live turn: the user message, the server's declarations, the streamed answer. */
async function liveTurn(chat: StreamingChat, declarations: EntityDeclarationsByTool | undefined, parts: unknown[]) {
  await act(async () => { void ctx.send('next'); });
  if (declarations) await act(async () => { chat.emit({ type: 'data-tool-entities', data: { tools: declarations } }); });
  await act(async () => { chat.stream(parts); });
  await act(async () => { chat.finish(parts); });
}

function liveHost(chat: StreamingChat, mentionMarkers: 'plain' | 'markdown') {
  const open = vi.fn();
  const config = {
    entityLinks: { open, mentionMarkers, verifyMentions: false, unresolvedMentions: 'text' as const, known: false },
    chatInteractions: playlistInteractions,
  };
  render(<Host chat={chat} config={config} />);
  return open;
}

describe('a message keeps the declarations of its own turn (review 2: finding 1)', () => {
  for (const mentionMarkers of ['plain', 'markdown'] as const) {
    it(`${mentionMarkers}: a later turn with other declarations does not change an earlier decision`, async () => {
      const chat = new StreamingChat();
      const open = liveHost(chat, mentionMarkers);
      await liveTurn(chat, DECLARED, TURN_ONE);
      await waitFor(() => expect(bubbleState(0, open).ids).toEqual(['pl_7']));
      await liveTurn(chat, CHANNELS_ONLY, [{ type: 'text', text: 'Other answer.' }]);
      await waitFor(() => expect(assistantBubbles()).toHaveLength(2));
      const first = bubbleState(0, open);
      expect(first.ids).toEqual(['pl_7']);
      expect(first.text).toContain('not Lobby Loop.');
    });
  }

  it('a session switch drops the turn declarations: back in the first chat its markers are not judged any more', async () => {
    const chat = new StreamingChat();
    const open = liveHost(chat, 'plain');
    await liveTurn(chat, DECLARED, TURN_ONE);
    await waitFor(() => expect(bubbleState(0, open).ids).toEqual(['pl_7']));
    const first = chat.messages;
    await act(async () => { chat.setMessages([]); });
    await liveTurn(chat, CHANNELS_ONLY, [{ type: 'text', text: 'Elsewhere.' }]);
    await act(async () => { chat.setMessages(first); });
    await waitFor(() => expect(assistantBubbles()).toHaveLength(1));
    // Not judged: as without the option, both markers are chips.
    await waitFor(() => expect(bubbleState(0, open).ids).toEqual(['pl_7', 'pl_8']));
  });

  it('with the app\'s own entityDeclarations a chat switched back to is judged by them', async () => {
    const chat = new StreamingChat();
    const open = vi.fn();
    const config = {
      entityLinks: { open, unresolvedMentions: 'text' as const, known: false },
      chatInteractions: playlistInteractions,
      entityDeclarations: DECLARED,
    };
    render(<Host chat={chat} config={config} />);
    await liveTurn(chat, CHANNELS_ONLY, TURN_ONE);
    const first = chat.messages;
    await act(async () => { chat.setMessages([]); });
    await act(async () => { chat.setMessages(first); });
    await waitFor(() => expect(assistantBubbles()).toHaveLength(1));
    expect(bubbleState(0, open).ids).toEqual(['pl_7']);
  });

  it('a history with the same message ids in another chat is not judged by the left chat\'s declarations', async () => {
    const chat = new StreamingChat();
    const open = liveHost(chat, 'plain');
    await liveTurn(chat, DECLARED, TURN_ONE);
    await waitFor(() => expect(bubbleState(0, open).ids).toEqual(['pl_7']));
    // Another chat whose store numbers its messages alike: same ids, other objects, no tool result.
    const other = chat.messages.map((message) => (message.role === 'assistant'
      ? { ...message, parts: [{ type: 'text', text: 'Elsewhere {{mention:playlist:pl_8:Lobby Loop}}.' }] }
      : { ...message, parts: [...message.parts] })) as ChatMessage[];
    await act(async () => { chat.setMessages(other); });
    await waitFor(() => expect(assistantBubbles()[0]!.textContent).toContain('Elsewhere'));
    expect(bubbleState(0, open).ids).toEqual(['pl_8']);
  });

  it('turn 2 shows the id turn 1 got wrong: turn 1 stays text (only what came before a message counts)', async () => {
    const chat = new StreamingChat();
    const open = liveHost(chat, 'plain');
    await liveTurn(chat, DECLARED, TURN_ONE);
    await liveTurn(chat, DECLARED, [
      { ...listed, toolCallId: 'c9', output: { playlists: [{ id: 'pl_8', name: 'Lobby Loop' }] } },
      { type: 'text', text: 'Listed again.' },
    ]);
    await waitFor(() => expect(assistantBubbles()).toHaveLength(2));
    const first = bubbleState(0, open);
    expect(first.ids).toEqual(['pl_7']);
    expect(first.text).toContain('not Lobby Loop.');
  });

  it('a retried turn: the new answer is judged by its own declarations', async () => {
    const chat = new StreamingChat();
    const open = liveHost(chat, 'plain');
    await liveTurn(chat, DECLARED, TURN_ONE);
    await act(async () => { chat.retry(); });
    await act(async () => { chat.emit({ type: 'data-tool-entities', data: { tools: DECLARED } }); });
    const again = [listed, { type: 'text', text: 'Again {{mention:playlist:pl_7:Lobby Loop}} not {{mention:playlist:pl_9:Lobby Loop}}.' }];
    await act(async () => { chat.finish(again); });
    await waitFor(() => expect(assistantBubbles()).toHaveLength(1));
    const state = bubbleState(0, open);
    expect(state.ids).toEqual(['pl_7']);
    expect(state.text).toContain('not Lobby Loop.');
  });

  it('an approval continuation of the same message keeps the declarations of its first request', async () => {
    const chat = new StreamingChat();
    const open = liveHost(chat, 'plain');
    await liveTurn(chat, DECLARED, TURN_ONE);
    await waitFor(() => expect(bubbleState(0, open).ids).toEqual(['pl_7']));
    // The continuation streams into the same assistant message; its request declares other tools.
    const last = chat.messages.at(-1)!;
    const continued = { ...last, parts: [...last.parts, { type: 'text', text: ' Also {{mention:playlist:pl_10:Lobby Loop}}.' }] } as ChatMessage;
    chat.status = 'streaming';
    await act(async () => { chat.emit({ type: 'data-tool-entities', data: { tools: CHANNELS_ONLY } }); });
    await act(async () => { chat.setMessages([...chat.messages.slice(0, -1), continued]); });
    chat.status = 'ready';
    await act(async () => { chat.setMessages([...chat.messages]); });
    await waitFor(() => expect(assistantBubbles()[0]!.textContent).toContain('Also Lobby Loop.'));
    expect(bubbleState(0, open).ids).toEqual(['pl_7']);
  });

  it('a turn without declarations from the server is not judged', async () => {
    const chat = new StreamingChat();
    const open = liveHost(chat, 'plain');
    await liveTurn(chat, undefined, TURN_ONE);
    await waitFor(() => expect(bubbleState(0, open).ids).toEqual(['pl_7', 'pl_8']));
  });
});

describe('reloaded history (coverage)', () => {
  it('keeps stored markers after a reload; judges the wrong marker of a new live turn', async () => {
    const chat = new StreamingChat();
    chat.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Which playlist?' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Old {{mention:playlist:pl_7:Lobby Loop}} and {{mention:playlist:pl_8:Lobby Loop}}.' }] },
    ] as unknown as ChatMessage[];
    const open = liveHost(chat, 'plain');
    await waitFor(() => expect(bubbleState(0, open).ids).toEqual(['pl_7', 'pl_8']));
    await liveTurn(chat, DECLARED, [{ type: 'text', text: 'New {{mention:playlist:pl_9:Lobby Loop}} here.' }]);
    await waitFor(() => expect(assistantBubbles()).toHaveLength(2));
    expect(bubbleState(0, open).ids).toEqual(['pl_7', 'pl_8']);
    const fresh = bubbleState(1, open);
    expect(fresh.ids).toEqual([]);
    expect(fresh.text).toContain('New Lobby Loop here.');
  });

  it('a live turn after a stored tool result it cannot read is not judged', async () => {
    const chat = new StreamingChat();
    chat.messages = answer('Stored answer.');
    const open = liveHost(chat, 'plain');
    await liveTurn(chat, DECLARED, [{ type: 'text', text: 'New {{mention:playlist:pl_7:Lobby Loop}} and {{mention:playlist:pl_99:Lobby Loop}}.' }]);
    await waitFor(() => expect(assistantBubbles()).toHaveLength(2));
    expect(bubbleState(1, open).ids).toEqual(['pl_7', 'pl_99']);
  });

  it('keeps every marker of a reloaded history without the app\'s declarations', async () => {
    render(<Chat messages={answer(WRONG)} declarations={{}} entityLinks={{ open: vi.fn(), unresolvedMentions: 'text' }} />);
    expect(await screen.findByRole('button', { name: 'Open Lobby Loop' })).not.toBeNull();
  });
});

describe('outputEntities while chatInteractions data loads (review 2: c)', () => {
  const loaded = { schemaVersion: 1, commands: [], entities: [{ type: 'person', label: 'Person' }] } as unknown as ChatInteractionsData;
  const text = 'A {{mention:playlist:pl_7:Lobby Loop}} B {{mention:playlist:pl_8:Lobby Loop}} C {{mention:robot:r1:Robo Arm}}.';
  const View = ({ data }: { data: ChatInteractionsData | undefined }) => (
    <AiChatProvider transport={transport(answer(text))} uiActionBus={new UiActionBus()} entityDeclarations={DECLARED} entityLinks={{ open: vi.fn(), unresolvedMentions: 'text', known: false }} chatInteractions={{ data, loading: data === undefined }}>
      <AiChatPanel />
    </AiChatProvider>
  );

  it('a declared, shown id stays a chip; a declared wrong id is text; an unknown type waits as text and is not frozen', async () => {
    const view = render(<View data={undefined} />);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Open Lobby Loop' })).not.toBeNull();
    expect(bubble().textContent).toContain('B Lobby Loop C Robo Arm.');
    view.rerender(<View data={loaded} />);
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Open Robo Arm' })).not.toBeNull();
    expect(bubble().textContent).toContain('B Lobby Loop C');
  });
});

describe('each tool result read with its own turn\'s declarations (review 3: 1)', () => {
  for (const mentionMarkers of ['plain', 'markdown'] as const) {
    it(`${mentionMarkers}: a marker of turn 2 names a record turn 1's tools showed`, async () => {
      const chat = new StreamingChat();
      const open = liveHost(chat, mentionMarkers);
      await liveTurn(chat, DECLARED, [listed, { type: 'text', text: 'Listed.' }]);
      await liveTurn(chat, CHANNELS_ONLY, [{ type: 'text', text: 'It is {{mention:playlist:pl_7:Lobby Loop}}, not {{mention:playlist:pl_8:Lobby Loop}}.' }]);
      await waitFor(() => expect(assistantBubbles()).toHaveLength(2));
      const second = bubbleState(1, open);
      expect(second.ids).toEqual(['pl_7']);
      expect(second.text).toContain('not Lobby Loop.');
    });
  }
});

describe('loading by default only while a load is pending (review 3: 4)', () => {
  const robot = 'Ask {{mention:robot:r9:Robo Arm}} now.';
  function HookChat({ endpoint, fetcher }: { endpoint: string | undefined; fetcher: typeof fetch }) {
    const data = useChatInteractionsData(endpoint, { fetch: fetcher });
    return (
      <AiChatProvider transport={transport(answer(robot))} uiActionBus={new UiActionBus()} entityDeclarations={DECLARED} entityLinks={{ open: vi.fn(), unresolvedMentions: 'text' }} chatInteractions={{ data }}>
        <AiChatPanel />
      </AiChatProvider>
    );
  }

  it('text while the GET is pending, a chip once it failed', async () => {
    let refuse: () => void = () => {};
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { refuse = () => resolve(new Response('no', { status: 500 })); }));
    render(<HookChat endpoint="/chat" fetcher={fetcher as unknown as typeof fetch} />);
    await textShown('Ask Robo Arm now.');
    expect(chips()).toHaveLength(0);
    await act(async () => { refuse(); });
    expect(await screen.findByRole('button', { name: 'Open Robo Arm' })).not.toBeNull();
  });

  it('a chip when the endpoint is off', async () => {
    render(<HookChat endpoint={undefined} fetcher={vi.fn() as unknown as typeof fetch} />);
    expect(await screen.findByRole('button', { name: 'Open Robo Arm' })).not.toBeNull();
  });
});
