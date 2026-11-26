// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import type { PendingApproval } from '../../types.js';
import { BulkApprovalCard } from '../bulk-approval-card.js';

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => ({ classNames: {}, toolLabels: {}, locale: DEFAULT_LOCALE }),
}));
afterEach(cleanup);

function remember(id: string, details: string[]): PendingApproval {
  return { id, toolName: 'memory_remember', args: {}, messageId: 'm', description: 'Remember note', details };
}

function renderCard(approvals: PendingApproval[]) {
  const { container } = render(
    <BulkApprovalCard toolName="memory_remember" approvals={approvals} onApproveAll={vi.fn()} onRejectAll={vi.fn()} />,
  );
  const values = [...container.querySelectorAll('[data-element="detail-value"]')].map((el) => el.textContent);
  const shared = [...container.querySelectorAll('[data-element="shared-detail"]')].map((el) => el.textContent);
  return { values, shared };
}

describe('BulkApprovalCard: one distinct line per item', () => {
  it('shows the line that differs per item and the common one once', () => {
    const { values, shared } = renderCard([
      remember('a1', ['Scope: Everyone', 'Note: Teams are deleted after the trash is emptied']),
      remember('a2', ['Scope: Everyone', 'Note: Weekly report goes out on Mondays']),
    ]);
    expect(values).toEqual(['Teams are deleted after the trash is emptied', 'Weekly report goes out on Mondays']);
    expect(shared).toEqual(['Scope: Everyone']);
  });

  it('keeps the first line when nothing tells the items apart', () => {
    const { values, shared } = renderCard([remember('a1', ['Title: Same']), remember('a2', ['Title: Same'])]);
    expect(values).toEqual(['Same', 'Same']);
    expect(shared).toEqual([]);
  });

  it('keeps the first line when it already differs', () => {
    const { values, shared } = renderCard([
      remember('a1', ['Title: One', 'Priority: High']),
      remember('a2', ['Title: Two', 'Priority: High']),
    ]);
    expect(values).toEqual(['One', 'Two']);
    expect(shared).toEqual(['Priority: High']);
  });
});
