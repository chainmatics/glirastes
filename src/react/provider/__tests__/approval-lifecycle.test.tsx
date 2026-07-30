// @vitest-environment jsdom

import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatTransport } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';

function ApprovalProbe() {
  const {
    pendingApprovals,
    approve,
    isProcessingApproval,
    error,
    pipelineState,
  } = useChatContext();

  return (
    <div>
      <span data-testid="approval-count">{pendingApprovals.length}</span>
      <span data-testid="approval-state">
        {isProcessingApproval ? 'processing' : 'idle'}
      </span>
      <span data-testid="approval-error">{error ? 'error' : 'ok'}</span>
      <span data-testid="pipeline-message">{pipelineState?.message ?? ''}</span>
      {pendingApprovals.map(({ id }) => (
        <button
          key={id}
          disabled={isProcessingApproval}
          onClick={() => {
            void Promise.resolve(approve(id)).catch(() => {});
          }}
        >
          approve-{id}
        </button>
      ))}
      {pendingApprovals.length > 1 && (
        <button
          onClick={() => {
            for (const { id } of pendingApprovals) {
              void Promise.resolve(approve(id)).catch(() => {});
            }
          }}
        >
          approve-all
        </button>
      )}
    </div>
  );
}

function createTransport(
  addToolApprovalResponse: ChatTransport['addToolApprovalResponse'],
  approvalIds = ['approval-1'],
  error: Error | null = null,
): ChatTransport {
  return {
    messages: [{
      id: 'assistant-1',
      role: 'assistant',
      parts: approvalIds.map((id, index) => ({
        type: 'tool-tasks.update',
        toolCallId: `call-${index + 1}`,
        state: 'approval-requested',
        input: { taskId: `task-${index + 1}` },
        approval: { id },
      } as never)),
    }],
    status: 'ready',
    error,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse,
  };
}

describe('AiChatProvider approval lifecycle', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps a pending approval recoverable when the transport response fails', async () => {
    let rejectResponse: ((reason?: unknown) => void) | undefined;
    const response = new Promise<void>((_resolve, reject) => {
      rejectResponse = reject;
    });
    const addToolApprovalResponse = vi.fn(() => response);

    render(
      <AiChatProvider transport={createTransport(addToolApprovalResponse)}>
        <ApprovalProbe />
      </AiChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('approval-count').textContent).toBe('1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'approve-approval-1' }));

    expect(screen.getByTestId('approval-count').textContent).toBe('1');
    expect(screen.getByTestId('approval-state').textContent).toBe('processing');
    expect(screen.getByRole('button', { name: 'approve-approval-1' }).hasAttribute('disabled'))
      .toBe(true);

    await act(async () => {
      rejectResponse?.(new Error('raw transport payload'));
      await response.catch(() => {});
    });

    await waitFor(() => {
      expect(screen.getByTestId('approval-count').textContent).toBe('1');
      expect(screen.getByTestId('approval-state').textContent).toBe('idle');
      expect(screen.getByTestId('approval-error').textContent).toBe('error');
    });
    expect(screen.queryByText('raw transport payload')).toBeNull();
  });

  it('removes an approval only after the transport confirms it', async () => {
    let resolveResponse: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });

    render(
      <AiChatProvider transport={createTransport(() => response)}>
        <ApprovalProbe />
      </AiChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('approval-count').textContent).toBe('1');
    });
    fireEvent.click(screen.getByRole('button', { name: 'approve-approval-1' }));
    expect(screen.getByTestId('approval-count').textContent).toBe('1');

    await act(async () => {
      resolveResponse?.();
      await response;
    });

    await waitFor(() => {
      expect(screen.getByTestId('approval-count').textContent).toBe('0');
      expect(screen.getByTestId('approval-state').textContent).toBe('idle');
      expect(screen.getByTestId('approval-error').textContent).toBe('ok');
    });
  });

  it('keeps bulk processing active until every response settles', async () => {
    const resolvers = new Map<string, {
      resolve: () => void;
      reject: (reason?: unknown) => void;
    }>();
    const addToolApprovalResponse = vi.fn(({ id }: { id: string }) => (
      new Promise<void>((resolve, reject) => {
        resolvers.set(id, { resolve, reject });
      })
    ));

    render(
      <AiChatProvider
        transport={createTransport(
          addToolApprovalResponse,
          ['approval-1', 'approval-2'],
        )}
      >
        <ApprovalProbe />
      </AiChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('approval-count').textContent).toBe('2');
    });
    fireEvent.click(screen.getByRole('button', { name: 'approve-all' }));
    expect(screen.getByTestId('approval-state').textContent).toBe('processing');

    await act(async () => {
      resolvers.get('approval-1')?.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('approval-count').textContent).toBe('1');
      expect(screen.getByTestId('approval-state').textContent).toBe('processing');
    });

    await act(async () => {
      resolvers.get('approval-2')?.reject(new Error('raw second response'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('approval-count').textContent).toBe('1');
      expect(screen.getByTestId('approval-state').textContent).toBe('idle');
      expect(screen.getByTestId('approval-error').textContent).toBe('error');
    });
  });

  it('does not copy raw transport failures into the pipeline state', async () => {
    render(
      <AiChatProvider
        transport={createTransport(
          vi.fn(),
          [],
          new Error('raw provider response body'),
        )}
      >
        <ApprovalProbe />
      </AiChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pipeline-message').textContent)
        .toBe('Pipeline failed.');
    });
    expect(screen.queryByText('raw provider response body')).toBeNull();
  });
});
