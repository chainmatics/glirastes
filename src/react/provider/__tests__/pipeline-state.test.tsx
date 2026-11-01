// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatTransport, ChatTransportDataHandler } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';

function StateProbe() {
  const { pipelineState } = useChatContext();
  return (
    <span data-testid="pipeline-state">
      {pipelineState ? `${pipelineState.status}/${pipelineState.stepLimitSource}` : 'none'}
    </span>
  );
}

function createTransport(handlers: Set<ChatTransportDataHandler>): ChatTransport {
  return {
    messages: [],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
    subscribeToData: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

describe('AiChatProvider pipeline state', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps a stop at the runtime budget so the chat can say why the turn ended', () => {
    const handlers = new Set<ChatTransportDataHandler>();
    render(
      <AiChatProvider transport={createTransport(handlers)}>
        <StateProbe />
      </AiChatProvider>,
    );

    act(() => {
      handlers.forEach((handler) => handler({
        type: 'data-pipeline-state',
        data: {
          status: 'safety-stop',
          totalSteps: 3,
          finishReason: 'tool-calls',
          maxSteps: 12,
          stepLimitSource: 'runtime-budget',
          message: 'Stopped at runtime budget: maxInputTokens.',
          updatedAt: '2026-11-01T13:15:45.414Z',
        },
      }));
    });

    expect(screen.getByTestId('pipeline-state').textContent).toBe('safety-stop/runtime-budget');
  });
});
