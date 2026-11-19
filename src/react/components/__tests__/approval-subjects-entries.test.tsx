// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import type { EntityDeclarationsByTool } from '../../../contracts/entity-declaration.js';
import { AiChatPanel } from '../ai-chat-panel.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type {
  AiChatProviderConfig as AiChatProviderProps,
  ChatMessage,
  ChatTransport,
  MessagePartsProps,
  ToolPartApproval,
} from '../../types.js';

/**
 * The server's approval subjects (`data-approval-subjects`, persistent in the
 * history) on the approval entries and the inline card of #112: open and
 * decided approvals, also after a reload (the transport starts with the stored
 * messages).
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

const DECLARED: EntityDeclarationsByTool = {
  playlists_list: { output: [{ type: 'playlist', id: 'id', name: 'name', path: 'playlists[]' }] },
  playlists_delete: { input: [{ type: 'playlist', args: ['playlistId'], role: 'target' }] },
};

const listed = {
  type: 'tool-playlists_list', toolCallId: 'c1', state: 'output-available', input: {},
  output: { playlists: [{ id: 'pl_7', name: 'Old history name' }] },
};

function subjectsPart(subject: Record<string, unknown>, preview?: Record<string, unknown>) {
  return {
    type: 'data-approval-subjects', id: 'c2',
    data: {
      v: 1, toolCallId: 'c2',
      subjects: [{
        type: 'playlist', role: 'target', id: 'pl_7', ids: { id: 'pl_7' }, path: 'playlistId', idKind: 'opaque', ...subject,
      }],
      ...(preview ? { preview } : {}),
    },
  };
}

const found = { status: 'named', check: 'found', name: 'Backend Name' };
const preview = { check: 'found', fields: [{ key: 'devices', label: { en: 'Devices', de: 'Geräte' }, value: 3, format: 'count' }] };

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

function approvalsOf(messages: ChatMessage[], props: Partial<AiChatProviderProps> = {}) {
  const seen: Array<ToolPartApproval | undefined> = [];
  function Arrange({ parts, children }: MessagePartsProps) {
    for (const part of parts) if (part.toolName === 'playlists_delete') seen.push(part.approval);
    return <>{children}</>;
  }
  render(<Chat messages={messages} components={{ MessageParts: Arrange }} {...props} />);
  return seen;
}

describe('server approval subjects on approval entries and the inline card', () => {
  it('gives a decided approval (after a reload) the server subjects and preview, not the history name', async () => {
    const seen = approvalsOf(conversation(
      subjectsPart(found, preview),
      deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }),
    ));
    await waitFor(() => expect(seen.at(-1)).toBeDefined());
    expect(seen.at(-1)).toMatchObject({
      state: 'decided', outcome: 'done',
      subjects: [expect.objectContaining({ source: 'server', check: 'found', status: 'named', name: 'Backend Name' })],
      preview: [expect.objectContaining({ key: 'devices', label: 'Devices', value: 3 })],
      previewCheck: 'found',
    });
  });

  it('renders the server name, the not-checkable warning and the preview in the lasting entry', async () => {
    render(
      <Chat
        messages={conversation(
          subjectsPart(found, preview),
          deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } }),
          { type: 'text', text: 'Deleted.' },
        )}
        approvalDisplay={{ decided: 'entry' }}
      />,
    );
    await screen.findByText('Deleted.');
    const entry = document.querySelector('[data-component="approval-entry"]')!;
    expect(entry.textContent).toContain('Backend Name');
    expect(entry.textContent).not.toContain('Old history name');
    expect(entry.querySelector('[data-preview=""]')!.textContent).toContain('3');
    cleanup();

    render(
      <Chat
        messages={conversation(
          subjectsPart({ status: 'unknown', check: 'unchecked', reason: 'timeout' }, { check: 'unchecked', reason: 'timeout', fields: [] }),
          deletion('output-denied', { id: 'ap1', approved: false }),
          { type: 'text', text: 'Declined.' },
        )}
        approvalDisplay={{ decided: 'entry' }}
        locale={{ approvalSubjectUncheckedWarning: 'NOT CHECKED {id}', approvalPreviewUncheckedNote: 'NO PREVIEW' }}
      />,
    );
    await screen.findByText('Declined.');
    const declined = document.querySelector('[data-component="approval-entry"]')!;
    expect(declined.querySelector('[data-check="unchecked"]')!.textContent).toBe('NOT CHECKED pl_7');
    expect(declined.textContent).toContain('NO PREVIEW');
  });

  it('shows a looked-up id with replacement patterns literally in the not-checkable texts of entry and card', async () => {
    const hostile = { id: "k$&{label}$'", ids: { id: "k$&{label}$'" }, status: 'unknown', check: 'unchecked', reason: 'timeout' };
    render(
      <Chat
        messages={conversation(subjectsPart(hostile), deletion('output-denied', { id: 'ap1', approved: false }), { type: 'text', text: 'Declined.' })}
        approvalDisplay={{ decided: 'entry' }}
        locale={{ approvalSubjectUncheckedWarning: '{label}: {id} not checked' }}
      />,
    );
    await screen.findByText('Declined.');
    expect(document.querySelector('[data-component="approval-entry"] [data-check="unchecked"]')!.textContent)
      .toBe("Playlist: k$&{label}$' not checked");
    cleanup();
    render(
      <Chat
        messages={conversation(subjectsPart(hostile), deletion('approval-requested', { id: 'ap9' }))}
        locale={{ approvalSubjectUncheckedWarning: '{label}: {id} not checked' }}
      />,
    );
    await waitFor(() => expect(document.querySelector('[data-component="approval-card"] [data-check="unchecked"]')).toBeTruthy());
    expect(document.querySelector('[data-component="approval-card"] [data-check="unchecked"]')!.textContent)
      .toBe("Playlist: k$&{label}$' not checked");
  });

  it('draws an open approval inline with the server subjects after a reload', async () => {
    const seen = approvalsOf(conversation(subjectsPart(found, preview), deletion('approval-requested', { id: 'ap9' })), {
      approvalDisplay: { open: 'inline' },
    });
    await waitFor(() => expect(bubble()?.querySelector('[data-component="approval-card"]')).toBeTruthy());
    const card = bubble()!.querySelector('[data-component="approval-card"]')!;
    expect(card.textContent).toContain('Backend Name');
    expect(card.textContent).not.toContain('Old history name');
    expect(card.querySelector('[data-preview=""]')!.textContent).toContain('Devices');
    await waitFor(() => expect(seen.at(-1)?.state).toBe('open'));
    expect(seen.at(-1)!.subjects).toEqual([expect.objectContaining({ source: 'server', name: 'Backend Name' })]);
  });

  it('keeps the history guess without a server part (an app without a declaration)', async () => {
    const seen = approvalsOf(conversation(deletion('output-available', { id: 'ap1', approved: true }, { output: { success: true } })));
    await waitFor(() => expect(seen.at(-1)).toBeDefined());
    expect(seen.at(-1)!.subjects).toEqual([expect.objectContaining({ name: 'Old history name' })]);
    expect(seen.at(-1)!.subjects![0]!.source).toBeUndefined();
    expect(seen.at(-1)!.preview).toBeUndefined();
  });
});

function bubble(): Element | undefined {
  return document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')[0];
}
