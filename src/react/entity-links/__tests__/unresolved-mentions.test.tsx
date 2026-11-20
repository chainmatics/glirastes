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

function Chat({ messages, entityLinks, search, declarations = DECLARED }: {
  messages: ChatMessage[];
  entityLinks: ChatEntityLinksConfig;
  search?: Search;
  declarations?: EntityDeclarationsByTool;
}) {
  const interactions = search
    ? { entities: [defineChatEntity({ type: 'playlist', label: 'Playlist', search: (query: string) => search(query) })] }
    : undefined;
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
