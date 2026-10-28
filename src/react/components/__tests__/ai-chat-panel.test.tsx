// @vitest-environment jsdom

import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApprovalCardProps,
  BulkApprovalCardProps,
  SuggestionChipProps,
} from '../../types.js';
import { AiChatPanel } from '../ai-chat-panel.js';

const panelSpies = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  selectSuggestion: vi.fn(),
  stop: vi.fn(),
}));

const chatContext = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

vi.mock('../message-list.js', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

function TestApprovalCard({
  approval,
  onApprove,
  onReject,
}: ApprovalCardProps) {
  return (
    <div data-testid={`single-${approval.id}`}>
      <button onClick={() => onApprove(approval.id)}>approve single</button>
      <button onClick={() => onReject(approval.id)}>reject single</button>
    </div>
  );
}

function TestBulkApprovalCard({
  toolName,
  approvals,
  onApproveAll,
  onRejectAll,
}: BulkApprovalCardProps) {
  return (
    <div data-testid={`bulk-${toolName}`} data-count={approvals.length}>
      <button onClick={onApproveAll}>approve all</button>
      <button onClick={onRejectAll}>reject all</button>
    </div>
  );
}

function TestSuggestionChip({ label, onClick }: SuggestionChipProps) {
  return <button onClick={onClick}>{label}</button>;
}

function resetContext() {
  chatContext.current = {
    classNames: {},
    components: {
      ApprovalCard: TestApprovalCard,
      BulkApprovalCard: TestBulkApprovalCard,
      ChatInput: () => <div data-testid="chat-input" />,
      PipelineTimeline: () => <div data-testid="pipeline" />,
      SuggestionChip: TestSuggestionChip,
    },
    hasMentions: false,
    locale: {
      emptyState: 'Noch keine Nachrichten',
      errorMessage: 'Die Anfrage ist fehlgeschlagen.',
      continueButton: 'Fortfahren',
      dismissButton: 'Schließen',
    },
    isLoading: false,
    stop: panelSpies.stop,
    error: null,
    messages: [],
    pipelineSteps: [],
    pipelineState: null,
    pendingApprovals: [
      {
        id: 'update-1',
        toolName: 'tasks.update',
        args: {},
      },
      {
        id: 'calendar-1',
        toolName: 'calendar.create',
        args: {},
      },
      {
        id: 'update-2',
        toolName: 'tasks.update',
        args: {},
      },
    ],
    approve: panelSpies.approve,
    reject: panelSpies.reject,
    isProcessingApproval: false,
    truncation: null,
    continueTruncation: vi.fn(),
    dismissTruncation: vi.fn(),
    themeVars: {},
    themeEffect: undefined,
    suggestionChips: ['Aufgaben prüfen'],
    selectSuggestion: panelSpies.selectSuggestion,
    suggestions: {},
  };
}

describe('AiChatPanel composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContext();
  });

  afterEach(() => {
    cleanup();
  });

  it('groups same-tool approvals while preserving independent approvals', () => {
    render(<AiChatPanel />);

    expect(screen.getByTestId('bulk-tasks.update').getAttribute('data-count'))
      .toBe('2');
    expect(screen.getByTestId('single-calendar-1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'approve all' }));
    expect(panelSpies.approve.mock.calls).toEqual([
      ['update-1'],
      ['update-2'],
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'reject single' }));
    expect(panelSpies.reject).toHaveBeenCalledWith('calendar-1');
  });

  it('renders contextual suggestions only while the panel is idle', () => {
    const { rerender } = render(<AiChatPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Aufgaben prüfen' }));
    expect(panelSpies.selectSuggestion).toHaveBeenCalledWith('Aufgaben prüfen');

    chatContext.current.isLoading = true;
    rerender(<AiChatPanel />);

    expect(screen.queryByRole('button', { name: 'Aufgaben prüfen' })).toBeNull();
    expect(document.querySelector('[data-component="typing-indicator"]'))
      .toBeTruthy();
  });

  it('renders only the bounded error copy, never the raw error message', () => {
    chatContext.current.error = new Error('raw provider payload');

    render(<AiChatPanel />);

    expect(screen.getByRole('alert').textContent)
      .toBe('Die Anfrage ist fehlgeschlagen.');
    expect(screen.queryByText('raw provider payload')).toBeNull();
  });

  it('leaves the pipeline bar out unless the app supplies one', () => {
    const { rerender } = render(<AiChatPanel />);
    expect(screen.getByTestId('pipeline')).toBeTruthy();

    const { PipelineTimeline: _custom, ...rest } = chatContext.current.components as Record<string, unknown>;
    chatContext.current.components = rest;
    chatContext.current.pipelineState = {
      status: 'running', totalSteps: 0, maxSteps: 5, stepLimitSource: 'module',
      updatedAt: '2026-10-28T10:00:00.000Z',
    };
    chatContext.current.pipelineSteps = [0, 1].map((stepNumber) => ({
      stepNumber, finishReason: 'tool-calls', toolCalls: ['tasks.update'], toolResults: 1,
      requiresApproval: false, pendingApprovals: 0, summary: '',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      createdAt: '2026-10-28T10:00:00.000Z',
    }));
    chatContext.current.toolLabels = {};
    rerender(<AiChatPanel />);
    expect(document.querySelector('[data-component="pipeline-timeline"]')).toBeNull();
  });

  it('drops the typing dots once the activity log shows a running tool', () => {
    chatContext.current.isLoading = true;
    chatContext.current.messages = [{
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'tool-tasks.update', toolCallId: 'c1', state: 'input-available' }],
    }];
    render(<AiChatPanel />);
    expect(document.querySelector('[data-component="typing-indicator"]')).toBeNull();
  });
});
