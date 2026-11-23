// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalEntry } from '../approval-entry.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import type { ToolPartApproval } from '../../types.js';

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => ({ locale: DEFAULT_LOCALE, language: 'en' }),
}));

afterEach(() => {
  cleanup();
});

const decided = (extra: Partial<ToolPartApproval> = {}): ToolPartApproval => ({
  approvalId: 'ap-1',
  toolCallId: 'c1',
  toolName: 'tasks_update',
  state: 'decided',
  decision: 'approved',
  outcome: 'done',
  label: 'Update task',
  ...extra,
});

const lines = () => Array.from(document.querySelectorAll('[data-component="approval-entry"] [data-element="detail-line"]'))
  .map((line) => Array.from(line.children).map((child) => child.textContent).join(' | ') || line.textContent);

describe('ApprovalEntry field details', () => {
  it('shows the field details the approval card showed, label and value apart', () => {
    render(<ApprovalEntry approval={decided({ details: ['Title: Weekly sync', 'Due: 2026-11-20', 'Moves the task'] })} />);
    expect(lines()).toEqual(['Title | Weekly sync', 'Due | 2026-11-20', 'Moves the task']);
  });

  it('keeps a subject name the details do not show and does not repeat one they show', () => {
    render(
      <ApprovalEntry
        approval={decided({
          details: ['Title: Weekly sync'],
          subjects: [
            { path: 'taskId', id: 't1', label: 'Task', status: 'named', name: 'Weekly sync' },
            { path: 'ownerId', id: 'o1', label: 'Owner', status: 'named', name: 'Ada' },
          ],
        })}
      />,
    );
    expect(lines()).toEqual(['Owner | Ada', 'Title | Weekly sync']);
  });

  it('renders no detail line without details or subjects', () => {
    render(<ApprovalEntry approval={decided()} />);
    expect(lines()).toEqual([]);
  });
});
