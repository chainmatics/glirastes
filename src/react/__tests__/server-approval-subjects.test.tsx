// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import { useChatContext } from '../provider/chat-context.js';
import type { ChatTransport, PendingApproval } from '../types.js';

afterEach(cleanup);

const P1 = '14f1e041-4609-4b24-a723-631b133115cc';

function transport(extraParts: unknown[], input: Record<string, unknown> = { playlist_id: P1 }): ChatTransport {
  return {
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Welche Playlists gibt es?' }] },
      {
        id: 'a0', role: 'assistant',
        parts: [{
          type: 'tool-playlists_list', toolCallId: 'list-1', state: 'output-available', input: {},
          output: { success: true, data: [{ id: P1, name: 'Abend-Promos' }] },
        } as never],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Lösch sie' }] },
      {
        id: 'a1', role: 'assistant',
        parts: [
          ...extraParts as never[],
          { type: 'tool-playlists_delete', toolCallId: 'call-1', state: 'approval-requested', input, approval: { id: 'approval-1' } } as never,
        ],
      },
    ],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function subjectsPart(toolCallId: string, subjects: unknown[], preview?: unknown) {
  return { type: 'data-approval-subjects', id: toolCallId, data: { v: 1, toolCallId, subjects, ...(preview ? { preview } : {}) } };
}

const serverSubject = {
  type: 'playlist', role: 'target', id: P1, ids: { playlist_id: P1 }, path: 'playlist_id',
  status: 'named', check: 'found', name: 'Abend-Promos (neu)', idKind: 'opaque',
};

let captured: PendingApproval[] = [];
function Capture() {
  captured = useChatContext().pendingApprovals;
  return null;
}

async function pendingOf(chat: ChatTransport): Promise<PendingApproval> {
  captured = [];
  render(<AiChatProvider transport={chat}><Capture /></AiChatProvider>);
  await waitFor(() => expect(captured.length).toBe(1));
  const pending = captured[0]!;
  cleanup();
  return pending;
}

describe('server approval subjects in the provider', () => {
  it('names the record from the server part of the call', async () => {
    render(<AiChatProvider transport={transport([subjectsPart('call-1', [serverSubject])])}><AiChatPanel /></AiChatProvider>);
    await waitFor(() => expect(document.querySelector('[data-component="approval-card"]')).not.toBeNull());
    const card = document.querySelector('[data-component="approval-card"]')!;
    expect(card.textContent).toContain('Abend-Promos (neu)');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns "could not be checked" for an unchecked subject with the server preview note', async () => {
    const chat = transport([subjectsPart('call-1', [{
      ...serverSubject, id: 'p-unseen', ids: { playlist_id: 'p-unseen' }, status: 'unknown', check: 'unchecked', reason: 'timeout', name: undefined,
    }], { check: 'unchecked', reason: 'timeout', fields: [] })], { playlist_id: 'p-unseen' });
    render(<AiChatProvider transport={chat}><AiChatPanel /></AiChatProvider>);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('p-unseen could not be checked right now.');
    expect(document.querySelector('[data-preview="unchecked"]')).not.toBeNull();
  });

  it('ignores a part of another call or one that does not parse', async () => {
    const plain = await pendingOf(transport([]));
    const other = await pendingOf(transport([
      subjectsPart('call-2', [serverSubject]),
      { type: 'data-approval-subjects', id: 'call-1', data: { v: 9, toolCallId: 'call-1', subjects: [serverSubject] } },
    ]));
    expect(other).toEqual(plain);
  });

  it('keeps the pending approval byte-identical for an app without a server part', async () => {
    const pending = await pendingOf(transport([]));
    expect(JSON.stringify(pending)).toBe(JSON.stringify({
      id: 'approval-1', toolName: 'playlists_delete', args: { playlist_id: P1 }, messageId: '',
      description: 'playlists_delete', details: [],
      subjects: [{ path: 'playlist_id', id: P1, status: 'named', name: 'Abend-Promos', label: 'Playlist' }],
    }));
  });

  it('puts the server subjects and preview on the pending approval', async () => {
    const pending = await pendingOf(transport([subjectsPart('call-1', [serverSubject], {
      check: 'found', fields: [{ key: 'impact.devices', label: { en: 'Devices', de: 'Geräte' }, value: 4, format: 'count' }],
    })]));
    expect(pending.subjects?.[0]).toMatchObject({ source: 'server', check: 'found', name: 'Abend-Promos (neu)' });
    expect(pending.preview).toEqual([{ key: 'impact.devices', label: 'Devices', value: 4, format: 'count' }]);
  });
});
