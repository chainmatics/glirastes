// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { AiChatPanel } from '../ai-chat-panel.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type {
  AiChatProviderConfig as AiChatProviderProps,
  ChatMessage,
  ChatTransport,
  MessagePartEntry,
  MessagePartsProps,
  ToolPartApproval,
} from '../../types.js';

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
  playlists_delete: { input: [{ type: 'playlist', args: ['playlistId'], role: 'target' }] },
};

const listed = {
  type: 'tool-playlists_list', toolCallId: 'c1', state: 'output-available', input: {},
  output: { playlists: [{ id: 'pl_7', name: 'Lobby Loop' }] },
};

function deletion(state: string, approval: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'tool-playlists_delete', toolCallId: 'c2', state, input: { playlistId: 'pl_7' }, approval, ...extra };
}

function conversation(...assistantParts: unknown[]): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Delete the lobby playlist' }] },
    { id: 'a1', role: 'assistant', parts: [listed, ...assistantParts] } as unknown as ChatMessage,
  ];
}

function Chat({ messages, ...props }: { messages: ChatMessage[] } & Partial<AiChatProviderProps>) {
  return (
    <AiChatProvider transport={transport(messages)} uiActionBus={new UiActionBus()} entityDeclarations={DECLARED} {...props}>
      <AiChatPanel />
    </AiChatProvider>
  );
}

function bubble(): Element {
  return document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')[0]!;
}

describe('MessageParts.parts (W2)', () => {
  it('gives every part in message order with a stable key and its default node', async () => {
    const seen: MessagePartEntry[][] = [];
    function Arrange({ parts, children }: MessagePartsProps) {
      if (parts.some((part) => part.kind === 'text')) seen.push(parts);
      return <>{children}</>;
    }
    const messages = conversation(
      { type: 'text', text: 'I will delete it.' },
      deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }),
      { type: 'text', text: 'Done.' },
    );
    render(<Chat messages={messages} toolResults={{ mode: 'default' }} components={{ MessageParts: Arrange }} />);
    await screen.findByText('Done.');
    const parts = seen.at(-1)!;
    expect(parts.map((part) => [part.key, part.kind, part.toolName ?? null])).toEqual([
      ['tool:c1', 'tool', 'playlists_list'],
      ['text:1', 'text', null],
      ['tool:c2', 'tool', 'playlists_delete'],
      ['text:3', 'text', null],
    ]);
    expect(parts[1]!.node).not.toBeNull();
    // A custom layout places its own content at the tool part and keeps the default nodes elsewhere.
    cleanup();
    function Ordered({ parts: entries }: MessagePartsProps) {
      return <>{entries.map((entry) => (entry.key === 'tool:c2' ? <i key={entry.key} data-testid="mine">mine</i> : <React.Fragment key={entry.key}>{entry.node}</React.Fragment>))}</>;
    }
    render(<Chat messages={messages} toolResults={{ mode: 'hidden' }} components={{ MessageParts: Ordered }} />);
    await screen.findByText('Done.');
    const order = Array.from(bubble().querySelectorAll('[data-testid="mine"], [data-component="markdown"]')).map((node) => node.textContent);
    expect(order).toEqual(['I will delete it.', 'mine', 'Done.']);
  });

  it('keeps the default DOM without any new option', async () => {
    const messages = conversation(
      { type: 'text', text: 'Deleted.' },
      deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }),
    );
    render(<Chat messages={messages} />);
    await screen.findByText('Deleted.');
    expect(document.querySelector('[data-component="approval-entry"]')).toBeNull();
    expect(bubble().children[0]!.getAttribute('data-component')).toBe('activity-log');
  });
});

describe('approvals at their tool part (W3)', () => {
  function approvalsOf(messages: ChatMessage[], props: Partial<AiChatProviderProps> = {}) {
    const seen: Array<ToolPartApproval | undefined> = [];
    function Arrange({ parts, children }: MessagePartsProps) {
      for (const part of parts) if (part.toolName === 'playlists_delete') seen.push(part.approval);
      return <>{children}</>;
    }
    render(<Chat messages={messages} components={{ MessageParts: Arrange }} {...props} />);
    return seen;
  }

  it.each([
    ['done', deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }), 'approved', 'done'],
    ['failed', deletion('output-available', { id: 'ap1', approved: true }, { output: { success: false, error: 'Locked', status: 500 } }), 'approved', 'failed'],
    ['declined', deletion('output-denied', { id: 'ap1', approved: false, reason: 'Rejected by user.' }), 'declined', 'declined'],
    ['not run', deletion('output-denied', { id: 'ap1', approved: true }), 'approved', 'not-run'],
    ['running', deletion('approval-responded', { id: 'ap1', approved: true }), 'approved', 'running'],
  ])('describes a decided approval after a reload: %s', async (_label, part, decision, outcome) => {
    const seen = approvalsOf(conversation(part));
    await waitFor(() => expect(seen.at(-1)).toBeDefined());
    expect(seen.at(-1)).toMatchObject({
      approvalId: 'ap1', toolCallId: 'c2', toolName: 'playlists_delete', state: 'decided', decision, outcome,
      subjects: [expect.objectContaining({ id: 'pl_7', status: 'named', name: 'Lobby Loop' })],
    });
    expect(typeof seen.at(-1)!.label).toBe('string');
  });

  it('leaves subjects out with approvalSubjects off', async () => {
    const seen = approvalsOf(conversation(deletion('output-denied', { id: 'ap1', approved: false })), { approvalSubjects: false });
    await waitFor(() => expect(seen.at(-1)).toBeDefined());
    expect(seen.at(-1)!.subjects).toBeUndefined();
  });

  it("decided: 'entry' renders a lasting entry at the tool part with its outcome", async () => {
    render(
      <Chat
        messages={conversation(deletion('output-denied', { id: 'ap1', approved: true }), { type: 'text', text: 'It expired.' })}
        approvalDisplay={{ decided: 'entry' }}
        locale={{ approvalEntryNotRunLabel: 'Not run' }}
      />,
    );
    await screen.findByText('It expired.');
    const entry = document.querySelector('[data-component="approval-entry"]')!;
    expect(entry.getAttribute('data-decision')).toBe('approved');
    expect(entry.getAttribute('data-outcome')).toBe('not-run');
    expect(entry.querySelector('[data-element="outcome"]')!.textContent).toBe('Not run');
    expect(entry.textContent).toContain('Lobby Loop');
  });

  it('places the entry and the inline card between the texts around their tool part', async () => {
    const order = () => Array.from(bubble().querySelectorAll(
      '[data-component="markdown"], [data-component="approval-entry"], [data-component="approval-card"]',
    )).map((node) => node.getAttribute('data-component') === 'markdown' ? node.textContent : node.getAttribute('data-component'));
    render(
      <Chat
        messages={conversation(
          { type: 'text', text: 'Text A' },
          deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }),
          { type: 'text', text: 'Text B' },
        )}
        approvalDisplay={{ decided: 'entry' }}
      />,
    );
    await screen.findByText('Text B');
    expect(order()).toEqual(['Text A', 'approval-entry', 'Text B']);
    cleanup();
    render(
      <Chat
        messages={conversation({ type: 'text', text: 'Text A' }, deletion('approval-requested', { id: 'ap9' }), { type: 'text', text: 'Text B' })}
        approvalDisplay={{ open: 'inline' }}
      />,
    );
    await waitFor(() => expect(order()).toEqual(['Text A', 'approval-card', 'Text B']));
  });

  it("keeps each log of activityLog.grouping: 'sections' at its place when approvals render in message order", async () => {
    const order = () => Array.from(bubble().querySelectorAll(
      '[data-component="markdown"], [data-component="approval-entry"], [data-component="activity-log"]',
    )).map((node) => node.getAttribute('data-component') === 'markdown' ? node.textContent : node.getAttribute('data-component'));
    render(
      <Chat
        messages={conversation(
          { type: 'text', text: 'Text A' },
          deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }),
          { type: 'text', text: 'Text B' },
        )}
        approvalDisplay={{ decided: 'entry' }}
        activityLog={{ grouping: 'sections' }}
      />,
    );
    await screen.findByText('Text B');
    // The first log (the list call) comes before Text A, the second (the deletion) before its entry.
    expect(order()).toEqual(['activity-log', 'Text A', 'activity-log', 'approval-entry', 'Text B']);
  });

  it("open: 'inline' draws the open card at its tool part instead of below the messages", async () => {
    const messages = conversation({ type: 'text', text: 'Please confirm.' }, deletion('approval-requested', { id: 'ap9' }));
    const { unmount } = render(<Chat messages={messages} />);
    await waitFor(() => expect(document.querySelector('[data-component="approval-card"]')).not.toBeNull());
    expect(bubble().querySelector('[data-component="approval-card"]')).toBeNull();
    unmount();

    const addToolApprovalResponse = vi.fn(async () => {});
    render(
      <AiChatProvider
        transport={{ ...transport(messages), addToolApprovalResponse }}
        uiActionBus={new UiActionBus()}
        entityDeclarations={DECLARED}
        approvalDisplay={{ open: 'inline' }}
      >
        <AiChatPanel />
      </AiChatProvider>,
    );
    await waitFor(() => expect(bubble().querySelector('[data-component="approval-card"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-component="approval-card"]')).toHaveLength(1);
    fireEvent.click(bubble().querySelector('[data-action="approve"]')!);
    await waitFor(() => expect(addToolApprovalResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 'ap9', approved: true })));
  });
});

describe('mention markers inside Markdown (W6)', () => {
  const answer = (marker: string) => [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Which playlist?' }] },
    {
      id: 'a1', role: 'assistant', parts: [
        listed,
        { type: 'text', text: `**Found:** ${marker} is *live*.\n\n- second line` },
      ],
    },
  ] as unknown as ChatMessage[];

  it('keeps a text part with a marker as plain rich text by default', async () => {
    render(<Chat messages={answer('{{mention:playlist:pl_7:Lobby Loop}}')} entityLinks={{ open: vi.fn() }} />);
    await screen.findByRole('button', { name: 'Open Lobby Loop' });
    expect(bubble().querySelector('[data-component="message-rich-text"]')).not.toBeNull();
    expect(bubble().querySelector('strong')).toBeNull();
  });

  it("mentionMarkers: 'markdown' keeps the Markdown and puts the chip inside it", async () => {
    const open = vi.fn();
    render(<Chat messages={answer('{{mention:playlist:pl_7:Lobby Loop}}')} entityLinks={{ open, mentionMarkers: 'markdown', known: false }} />);
    const chip = await screen.findByRole('button', { name: 'Open Lobby Loop' });
    const markdown = bubble().querySelector('[data-component="markdown"]')!;
    expect(markdown.contains(chip)).toBe(true);
    expect(markdown.querySelector('strong')!.textContent).toBe('Found:');
    expect(markdown.querySelector('em')!.textContent).toBe('live');
    expect(markdown.querySelector('li')!.textContent).toBe('second line');
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_7', label: 'Lobby Loop' });
  });

  it('leaves a marker the conversation never showed as its label, and the check can be turned off', async () => {
    const forged = answer('{{mention:playlist:pl_999:Lobby*Loop}}');
    render(<Chat messages={forged} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', known: false }} />);
    await waitFor(() => expect(bubble().querySelector('[data-component="markdown"] strong')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /Open Lobby/ })).toBeNull();
    expect(bubble().querySelector('[data-component="markdown"] p')!.textContent).toContain('Lobby*Loop is live.');
    cleanup();
    render(<Chat messages={forged} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', verifyMentions: false, known: false }} />);
    expect(await screen.findByRole('button', { name: 'Open Lobby*Loop' })).not.toBeNull();
  });

  it('keeps two markers with one label apart by their ids', async () => {
    const twins = answer('{{mention:playlist:pl_7:Lobby Loop}} and {{mention:playlist:pl_8:Lobby Loop}}');
    render(<Chat messages={twins} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', known: false }} />);
    // Only pl_7 was shown by a declared result: one chip, the other stays text.
    expect(await screen.findAllByRole('button', { name: 'Open Lobby Loop' })).toHaveLength(1);
    expect(bubble().querySelector('[data-component="markdown"] p')!.textContent).toContain('and Lobby Loop is live.');
    cleanup();
    const open = vi.fn();
    render(<Chat messages={twins} entityLinks={{ open, mentionMarkers: 'markdown', verifyMentions: false, known: false }} />);
    const chips = await screen.findAllByRole('button', { name: 'Open Lobby Loop' });
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]!);
    expect(open).toHaveBeenCalledWith({ type: 'playlist', id: 'pl_8', label: 'Lobby Loop' });
  });

  it("follows ambiguousNames: 'text' and resolveAmbiguous for a name two records share", async () => {
    const twinsListed = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Which playlist?' }] },
      {
        id: 'a1', role: 'assistant', parts: [
          { ...listed, output: { playlists: [{ id: 'pl_7', name: 'Lobby Loop' }, { id: 'pl_8', name: 'Lobby Loop' }] } },
          { type: 'text', text: '**Found:** {{mention:playlist:pl_7:Lobby Loop}}' },
        ],
      },
    ] as unknown as ChatMessage[];
    const strong = () => bubble().querySelector('[data-component="markdown"] strong');
    render(<Chat messages={twinsListed} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown' }} />);
    expect(await screen.findAllByRole('button', { name: 'Open Lobby Loop' })).toHaveLength(1);
    cleanup();
    render(<Chat messages={twinsListed} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', ambiguousNames: 'text' }} />);
    await waitFor(() => expect(strong()).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Open Lobby Loop' })).toBeNull();
    cleanup();
    const pick = (id: string) => (_label: string, candidates: ReadonlyArray<{ id: string }>) => candidates.find((c) => c.id === id) as never;
    render(<Chat messages={twinsListed} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', resolveAmbiguous: pick('pl_7') }} />);
    expect(await screen.findAllByRole('button', { name: 'Open Lobby Loop' })).toHaveLength(1);
    cleanup();
    render(<Chat messages={twinsListed} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', resolveAmbiguous: pick('pl_8'), known: false }} />);
    await waitFor(() => expect(strong()).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Open Lobby Loop' })).toBeNull();
  });

  it("does not let an invented marker make a shown record's name ambiguous", async () => {
    const mixed = answer('{{mention:playlist:pl_7:Lobby Loop}} or {{mention:playlist:pl_999:Lobby Loop}}');
    render(<Chat messages={mixed} entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', ambiguousNames: 'text', known: false }} />);
    expect(await screen.findAllByRole('button', { name: 'Open Lobby Loop' })).toHaveLength(1);
  });

  it('never takes an id from a field-name guess for the check', async () => {
    render(
      <Chat
        messages={answer('{{mention:playlist:pl_7:Lobby Loop}}')}
        entityDeclarations={{}}
        entityLinks={{ open: vi.fn(), mentionMarkers: 'markdown', known: false }}
      />,
    );
    await waitFor(() => expect(bubble().querySelector('[data-component="markdown"] strong')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Open Lobby Loop' })).toBeNull();
  });
});
