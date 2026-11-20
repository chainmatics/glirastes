// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { defineChatEntity, type ChatEntityItem } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport } from '../../types.js';
import { pickExactNameMatch, type ChatEntityLinksConfig } from '../entity-links.js';
import { useChatEntityLinks } from '../entity-links-react.js';
import { Host, StreamingChat, ctx } from '../../__tests__/streaming-chat.js';
import type { ChatInteractionsData } from '../../../contracts/chat-interactions.js';

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

describe('pickExactNameMatch', () => {
  it('matches one exact name: case-sensitive, whitespace trimmed and collapsed, no prefix', () => {
    const items = [{ id: '1', label: 'Lobby Loop 2' }, { id: '2', label: ' Lobby   Loop ' }, { id: '3', label: 'lobby loop' }];
    expect(pickExactNameMatch('Lobby Loop', items)).toEqual({ id: '2', label: ' Lobby   Loop ' });
    expect(pickExactNameMatch('Lobby', items)).toBeUndefined();
    expect(pickExactNameMatch('LOBBY LOOP', items)).toBeUndefined();
  });

  it('gives nothing on ambiguity, but one record listed twice is one match', () => {
    expect(pickExactNameMatch('Lobby Loop', [{ id: '1', label: 'Lobby Loop' }, { id: '2', label: 'Lobby Loop' }])).toBeUndefined();
    expect(pickExactNameMatch('Lobby Loop', [{ id: '1', label: 'Lobby Loop' }, { id: '1', label: 'Lobby Loop' }])).toEqual({ id: '1', label: 'Lobby Loop' });
  });

  it('compares canonically equivalent Unicode as equal', () => {
    expect(pickExactNameMatch('Café', [{ id: '1', label: 'Café' }])).toEqual({ id: '1', label: 'Café' });
  });
});

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

  it("'keep' is the explicit off switch and never searches", async () => {
    const search = vi.fn(() => [{ id: 'pl_7', label: 'Lobby Loop' }]);
    const open = vi.fn();
    render(<Chat messages={answer(WRONG)} search={search} entityLinks={{ open, unresolvedMentions: 'keep' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Lobby Loop' }));
    expect(open).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_8', label: 'Lobby Loop' });
    expect(search).not.toHaveBeenCalled();
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

describe("unresolvedMentions: 'search'", () => {
  for (const mentionMarkers of ['plain', 'markdown'] as const) {
    it(`${mentionMarkers}: one exact match by name becomes a chip with the found id`, async () => {
      const search = vi.fn(() => [{ id: 'pl_7b', label: 'Lobby Loop' }, { id: 'pl_9', label: 'Lobby Loop 2' }]);
      const open = vi.fn();
      render(<Chat messages={answer(WRONG)} search={search} entityLinks={{ open, mentionMarkers, unresolvedMentions: 'search', known: false }} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open Lobby Loop' }));
      expect(open).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_7b', label: 'Lobby Loop' });
      expect(search).toHaveBeenCalledWith('Lobby Loop');
    });
  }

  it('shows the name as text while the search runs, then the chip', async () => {
    let finish: (items: ChatEntityItem[]) => void = () => {};
    const search = vi.fn(() => new Promise<ChatEntityItem[]>((resolve) => { finish = resolve; }));
    render(<Chat messages={answer(WRONG)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
    await act(async () => { finish([{ id: 'pl_7b', label: 'Lobby Loop' }]); });
    expect(await screen.findByRole('button', { name: 'Open Lobby Loop' })).not.toBeNull();
  });

  const textCases: Array<[string, ChatEntityItem[]]> = [
    ['two records with the name', [{ id: 'pl_1', label: 'Lobby Loop' }, { id: 'pl_2', label: 'Lobby Loop' }]],
    ['no hit', []],
    ['a prefix hit only', [{ id: 'pl_1', label: 'Lobby Loop Extended' }]],
    ['another case only', [{ id: 'pl_1', label: 'lobby loop' }]],
  ];
  for (const [name, items] of textCases) {
    it(`falls back to the name as text on ${name}`, async () => {
      const search = vi.fn(() => items);
      render(<Chat messages={answer(WRONG)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
      await waitFor(() => expect(search).toHaveBeenCalled());
      await textShown('Found Lobby Loop for you.');
      await act(async () => { await Promise.resolve(); });
      expect(chips()).toHaveLength(0);
    });
  }

  it('falls back to the name as text when the search fails', async () => {
    const search = vi.fn(async () => { throw new Error('offline'); });
    render(<Chat messages={answer(WRONG)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
    await waitFor(() => expect(search).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(chips()).toHaveLength(0);
    expect(bubble().textContent).toContain('Found Lobby Loop for you.');
  });

  it('falls back to the name as text for a type declared by outputEntities but without a search', async () => {
    render(<Chat messages={answer(WRONG)} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
  });

  it('does not search for a shown id', async () => {
    const search = vi.fn(() => []);
    render(<Chat messages={answer('Found {{mention:playlist:pl_7:Lobby Loop}}.')} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
    await screen.findByRole('button', { name: 'Open Lobby Loop' });
    expect(search).not.toHaveBeenCalled();
  });

  it('searches one type and name once, for every marker and render', async () => {
    const search = vi.fn(() => [{ id: 'pl_7b', label: 'Lobby Loop' }]);
    const text = '{{mention:playlist:pl_8:Lobby Loop}} and {{mention:playlist:pl_9:Lobby  Loop}}';
    const view = render(<Chat messages={answer(text)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Open Lobby/ })).toHaveLength(2));
    view.rerender(<Chat messages={answer(text)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('works with integer ids and a name with the marker delimiter', async () => {
    const numeric: EntityDeclarationsByTool = {
      tickets_list: { output: [{ type: 'playlist', id: 'id', name: 'name', path: 'tickets[]' }] },
    };
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Which?' }] },
      {
        id: 'a1', role: 'assistant', parts: [
          { type: 'tool-tickets_list', toolCallId: 'c1', state: 'output-available', input: {}, output: { tickets: [{ id: 42, name: 'Ops: Lobby' }] } },
          { type: 'text', text: 'See {{mention:playlist:42:Ops: Lobby}} and {{mention:playlist:43:Ops: Lobby}}.' },
        ],
      },
    ] as unknown as ChatMessage[];
    const search = vi.fn(() => [{ id: 42 as unknown as string, label: 'Ops: Lobby' }]);
    const open = vi.fn();
    render(<Chat messages={messages} declarations={numeric} search={search} entityLinks={{ open, unresolvedMentions: 'search', known: false }} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Open Ops: Lobby' })).toHaveLength(2));
    for (const chip of screen.getAllByRole('button', { name: 'Open Ops: Lobby' })) fireEvent.click(chip);
    expect(open.mock.calls.map(([reference]) => reference.id)).toEqual(['42', '42']);
    expect(search).toHaveBeenCalledTimes(1);
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

/** A chat whose host re-renders with new inline objects of equal value, as an app without `useMemo` does. */
function InlineChat({ messages, entityLinks, search, roles = ['editor'], panel = 'one' }: {
  messages: ChatMessage[];
  entityLinks: ChatEntityLinksConfig;
  search: Search;
  roles?: string[];
  /** A new value remounts the panel (and every marker) inside the same provider. */
  panel?: string;
}) {
  return (
    <AiChatProvider
      transport={transport(messages)}
      uiActionBus={new UiActionBus()}
      entityDeclarations={{ ...DECLARED }}
      entityLinks={{ ...entityLinks }}
      completionContext={{ roles: [...roles] }}
      chatInteractions={{ entities: [defineChatEntity({ type: 'playlist', label: 'Playlist', search: (query: string) => search(query) })] }}
    >
      <AiChatPanel key={panel} />
    </AiChatProvider>
  );
}

describe('search cache (review 1, 6, 7)', () => {
  for (const mentionMarkers of ['plain', 'markdown'] as const) {
    it(`${mentionMarkers}: new inline objects of equal value neither search again nor drop the chip`, async () => {
      let finish: (items: ChatEntityItem[]) => void = () => {};
      const search = vi.fn(() => new Promise<ChatEntityItem[]>((resolve) => { finish = resolve; }));
      const links: ChatEntityLinksConfig = { open: vi.fn(), mentionMarkers, unresolvedMentions: 'search', known: false };
      const view = render(<InlineChat messages={answer(WRONG)} search={search} entityLinks={links} />);
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 3; i += 1) view.rerender(<InlineChat messages={answer(WRONG)} search={search} entityLinks={links} />);
      await act(async () => { finish([{ id: 'pl_7b', label: 'Lobby Loop' }]); });
      await waitFor(() => expect(chips()).toHaveLength(1));
      for (let i = 0; i < 3; i += 1) {
        view.rerender(<InlineChat messages={answer(WRONG)} search={search} entityLinks={links} />);
        expect(chips()).toHaveLength(1);
      }
      await act(async () => { await Promise.resolve(); });
      expect(chips()).toHaveLength(1);
      expect(search).toHaveBeenCalledTimes(1);
    });
  }

  it('searches again and drops the found id when the user context changes by value', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([{ id: 'pl_A', label: 'Lobby Loop' }])
      .mockResolvedValueOnce([{ id: 'pl_B', label: 'Lobby Loop' }]);
    const open = vi.fn();
    const links: ChatEntityLinksConfig = { open, unresolvedMentions: 'search', known: false };
    const view = render(<InlineChat messages={answer(WRONG)} search={search} entityLinks={links} roles={['a']} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Lobby Loop' }));
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pl_A' }));
    view.rerender(<InlineChat messages={answer(WRONG)} search={search} entityLinks={links} roles={['b']} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Lobby Loop' }));
      expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pl_B' }));
    });
  });

  it('does not keep a failed search: a later marker with the name searches again', async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([{ id: 'pl_7b', label: 'Lobby Loop' }]);
    const links: ChatEntityLinksConfig = { open: vi.fn(), unresolvedMentions: 'search', known: false };
    const view = render(<Chat messages={answer(WRONG)} search={search} entityLinks={links} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(chips()).toHaveLength(0);
    const more = [...answer(WRONG), { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Again {{mention:playlist:pl_9:Lobby Loop}}.' }] }] as unknown as ChatMessage[];
    view.rerender(<Chat messages={more} search={search} entityLinks={links} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByRole('button', { name: 'Open Lobby Loop' })).not.toHaveLength(0);
  });

  it('does not keep a refused derived search (HTTP 500) either', async () => {
    const data: ChatInteractionsData = {
      schemaVersion: 1, commands: [],
      entities: [{ type: 'playlist', label: 'Playlist', search: { tool: 'playlists.list', path: '/api/playlists', queryParam: 'q', itemsPath: ['items'], idField: 'id', labelField: 'name' } }],
    } as unknown as ChatInteractionsData;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('no', { status: 500 }))
      .mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 'pl_7b', name: 'Lobby Loop' }] }), { status: 200 }));
    const links: ChatEntityLinksConfig = { open: vi.fn(), unresolvedMentions: 'search', known: false };
    const derived = { data, fetch: fetcher };
    const Derived = ({ messages }: { messages: ChatMessage[] }) => (
      <AiChatProvider transport={transport(messages)} uiActionBus={new UiActionBus()} entityDeclarations={DECLARED} entityLinks={links} chatInteractions={derived}>
        <AiChatPanel />
      </AiChatProvider>
    );
    const view = render(<Derived messages={answer(WRONG)} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    const more = [...answer(WRONG), { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Again {{mention:playlist:pl_9:Lobby Loop}}.' }] }] as unknown as ChatMessage[];
    view.rerender(<Derived messages={more} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByRole('button', { name: 'Open Lobby Loop' })).not.toHaveLength(0);
  });

  it('a remount of the markers while the search runs does not search again', async () => {
    let finish: (items: ChatEntityItem[]) => void = () => {};
    const search = vi.fn(() => new Promise<ChatEntityItem[]>((resolve) => { finish = resolve; }));
    const links: ChatEntityLinksConfig = { open: vi.fn(), unresolvedMentions: 'search', known: false };
    const view = render(<InlineChat messages={answer(WRONG)} search={search} entityLinks={links} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    view.rerender(<InlineChat messages={answer(WRONG)} search={search} entityLinks={links} panel="two" />);
    expect(chips()).toHaveLength(0);
    await act(async () => { finish([{ id: 'pl_7b', label: 'Lobby Loop' }]); });
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('only messages whose turn had declarations (review 2)', () => {
  it('keeps stored markers after a reload; handles the wrong marker of a new live turn', async () => {
    const chat = new StreamingChat();
    chat.messages = answer('Old {{mention:playlist:pl_7:Lobby Loop}} and {{mention:playlist:pl_8:Lobby Loop}}.');
    const search = vi.fn(() => []);
    const config = {
      entityLinks: { open: vi.fn(), unresolvedMentions: 'search' as const, known: false },
      chatInteractions: { entities: [defineChatEntity({ type: 'playlist', label: 'Playlist', search })] },
    };
    render(<Host chat={chat} config={config} />);
    await waitFor(() => expect(document.querySelectorAll('[data-component="mention-chip"]')).toHaveLength(2));
    await act(async () => { void ctx.send('next'); });
    await act(async () => { chat.emit({ type: 'data-tool-entities', data: { tools: DECLARED } }); });
    await act(async () => { chat.stream([{ type: 'text', text: 'New {{mention:playlist:pl_9:Lobby Loop}} here.' }]); });
    await act(async () => { chat.finish([{ type: 'text', text: 'New {{mention:playlist:pl_9:Lobby Loop}} here.' }]); });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    const bubbles = document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]');
    expect(bubbles[0]!.querySelectorAll('[data-component="mention-chip"]')).toHaveLength(2);
    expect(bubbles[1]!.querySelectorAll('[data-component="mention-chip"]')).toHaveLength(0);
    expect(bubbles[1]!.textContent).toContain('New Lobby Loop here.');
  });

  it('keeps every marker of a reloaded history without declarations: no search on load', async () => {
    const search = vi.fn(() => []);
    render(<Chat messages={answer(WRONG)} declarations={{}} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search' }} />);
    await screen.findByRole('button', { name: 'Open Lobby Loop' });
    expect(search).not.toHaveBeenCalled();
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

  it('shows the name as text, never a chip, while derived data is still undefined', async () => {
    const view = render(<Loading chatInteractions={{ data: undefined }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
    view.rerender(<Loading chatInteractions={{ data: loaded(['playlist']) }} />);
    await textShown('Found Lobby Loop for you.');
    expect(chips()).toHaveLength(0);
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

describe('search edge cases (review 4, 5, 10)', () => {
  it('a name at the cut length of a hit label never matches, and is not searched', async () => {
    const long = 'x'.repeat(200);
    const search = vi.fn(() => [{ id: 'pl_1', label: 'x'.repeat(250) }]);
    render(<Chat messages={answer(`See {{mention:playlist:pl_8:${long}}}.`)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search', known: false }} />);
    await textShown(long);
    await act(async () => { await Promise.resolve(); });
    expect(chips()).toHaveLength(0);
    expect(search).not.toHaveBeenCalled();
  });

  it('a hit label at the cut length does not match a shorter name that equals its cut', async () => {
    const name = 'y'.repeat(199);
    const search = vi.fn(() => [{ id: 'pl_1', label: `${'y'.repeat(199)} tail` }]);
    render(<Chat messages={answer(`See {{mention:playlist:pl_8:${name}}}.`)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search', known: false }} />);
    await waitFor(() => expect(search).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(chips()).toHaveLength(0);
  });

  it('compares the marker type case-insensitively, as the seen check does, without a second search', async () => {
    const search = vi.fn(() => [{ id: 'pl_7b', label: 'Lobby Loop' }]);
    const text = '{{mention:Playlist:pl_8:Lobby Loop}} and {{mention:playlist:pl_9:Lobby Loop}}';
    render(<Chat messages={answer(text)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search', known: false }} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Open Lobby Loop' })).toHaveLength(2));
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('searches at most maxMentionSearches (default 5) distinct names per message; the rest stay text', async () => {
    const names = ['Aa1x', 'Bb2x', 'Cc3x', 'Dd4x', 'Ee5x', 'Ff6x', 'Gg7x'];
    const text = names.map((name, i) => `{{mention:playlist:x${i}:${name}}}`).join(' ');
    const search = vi.fn((query: string) => [{ id: `id-${query}`, label: query }]);
    render(<Chat messages={answer(text)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search', known: false }} />);
    await waitFor(() => expect(chips()).toHaveLength(5));
    expect(search.mock.calls.map(([query]) => query)).toEqual(names.slice(0, 5));
    cleanup();
    const once = vi.fn((query: string) => [{ id: `id-${query}`, label: query }]);
    render(<Chat messages={answer(text)} search={once} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search', maxMentionSearches: 1, known: false }} />);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('runs at most two searches at a time', async () => {
    let running = 0;
    let most = 0;
    const resolvers: Array<() => void> = [];
    const search = vi.fn((query: string) => new Promise<ChatEntityItem[]>((resolve) => {
      running += 1;
      most = Math.max(most, running);
      resolvers.push(() => { running -= 1; resolve([{ id: `id-${query}`, label: query }]); });
    }));
    const text = ['Aa1x', 'Bb2x', 'Cc3x', 'Dd4x'].map((name, i) => `{{mention:playlist:x${i}:${name}}}`).join(' ');
    render(<Chat messages={answer(text)} search={search} entityLinks={{ open: vi.fn(), unresolvedMentions: 'search', known: false }} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    while (resolvers.length > 0) await act(async () => { resolvers.shift()!(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(chips()).toHaveLength(4));
    expect(most).toBe(2);
  });
});
