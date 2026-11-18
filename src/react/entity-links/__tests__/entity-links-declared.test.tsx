// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport } from '../../types.js';
import type { ChatEntityLinksConfig } from '../entity-links.js';

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
  channels_list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'channels[]' }] },
};

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Is Lobby screens live?' }] },
  {
    id: 'a1', role: 'assistant', parts: [
      { type: 'tool-channels_list', toolCallId: 'c1', state: 'output-available', input: {}, output: { channels: [{ key: 'lobby', title: 'Lobby screens' }] } },
      { type: 'text', text: 'Lobby screens is live.' },
    ],
  } as unknown as ChatMessage,
];

function Chat({ entityLinks, entityDeclarations }: { entityLinks: ChatEntityLinksConfig; entityDeclarations?: EntityDeclarationsByTool }) {
  return (
    <AiChatProvider transport={transport(messages)} entityLinks={entityLinks} entityDeclarations={entityDeclarations} uiActionBus={new UiActionBus()}>
      <AiChatPanel />
    </AiChatProvider>
  );
}

describe('entity links from declarations', () => {
  it('D1: links the declared records of any tool result; D5 default links in user messages too', async () => {
    const open = vi.fn();
    render(<Chat entityLinks={{ open }} entityDeclarations={DECLARED} />);
    const chips = await screen.findAllByRole('button', { name: 'Open Lobby screens' });
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]!);
    expect(open).toHaveBeenCalledWith({ type: 'channel', id: 'lobby', label: 'Lobby screens' });
  });

  it('D1: an app without declarations links nothing from that result (as before)', async () => {
    render(<Chat entityLinks={{ open: vi.fn() }} />);
    await screen.findByText('Lobby screens is live.');
    expect(screen.queryByRole('button', { name: 'Open Lobby screens' })).toBeNull();
  });

  it('D5: scope assistant leaves the user message as text', async () => {
    render(<Chat entityLinks={{ open: vi.fn(), scope: 'assistant' }} entityDeclarations={DECLARED} />);
    expect(await screen.findAllByRole('button', { name: 'Open Lobby screens' })).toHaveLength(1);
  });

  it('D3 and D4: knownEntities reads the messages and its data reaches open', async () => {
    const open = vi.fn();
    const knownEntities = vi.fn(({ messages: seen }: { messages: ReadonlyArray<unknown> }) => (seen.length > 0
      ? [{ type: 'channel', id: 'lobby', label: 'Lobby screens', data: { floor: 2 } }]
      : []));
    render(<Chat entityLinks={{ open, knownEntities }} />);
    const chips = await screen.findAllByRole('button', { name: 'Open Lobby screens' });
    fireEvent.click(chips.at(-1)!);
    expect(knownEntities).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith({ type: 'channel', id: 'lobby', label: 'Lobby screens', data: { floor: 2 } });
  });

  it('takes the declarations the server streams as data-tool-entities', async () => {
    let push: ((part: { type: string; data: unknown }) => void) | undefined;
    const streaming: ChatTransport = {
      ...transport(messages),
      subscribeToData: (handler: (part: { type: string; data: unknown }) => void) => {
        push = handler;
        return () => {};
      },
    } as ChatTransport;
    render(
      <AiChatProvider transport={streaming} entityLinks={{ open: vi.fn() }} uiActionBus={new UiActionBus()}>
        <AiChatPanel />
      </AiChatProvider>,
    );
    await screen.findByText('Lobby screens is live.');
    expect(screen.queryByRole('button', { name: 'Open Lobby screens' })).toBeNull();
    act(() => push?.({ type: 'data-tool-entities', data: { tools: DECLARED } }));
    expect(await screen.findAllByRole('button', { name: 'Open Lobby screens' })).toHaveLength(2);
  });
});
