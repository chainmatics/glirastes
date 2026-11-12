// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deChatLocale } from '../../locale-de.js';
import type { PendingApproval } from '../../types.js';
import { createApprovalDescriptionGenerator } from '../../utils/create-approval-description.js';
import { ApprovalCard } from '../approval-card.js';

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => ({ classNames: {}, locale: deChatLocale }),
}));

const tasks = ['Routineaufgabe Montag', 'Routineaufgabe Dienstag', 'Routineaufgabe Mittwoch', 'Routineaufgabe Donnerstag', 'Routineaufgabe Freitag'];

function approval(partial: Partial<PendingApproval>): PendingApproval {
  return { id: 'a1', toolName: 'delete_tasks', args: {}, messageId: 'm', description: 'Aufgaben löschen', ...partial };
}

function renderCard(a: PendingApproval) {
  return render(<ApprovalCard approval={a} onApprove={vi.fn()} onReject={vi.fn()} />);
}

afterEach(cleanup);

describe('ApprovalCard detail values', () => {
  it('leaves short values untouched', () => {
    renderCard(approval({ details: ['Titel: Bericht'] }));
    expect(screen.getByText('Bericht')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /anzeigen/ })).toBeNull();
  });

  it('does not offer a toggle for a short list', () => {
    renderCard(approval({ details: ['Aufgaben: A, B'], detailItems: [['A', 'B']] }));
    expect(screen.queryByRole('button', { name: /anzeigen/ })).toBeNull();
  });

  it('collapses an array with a count and expands to one item per line', () => {
    const { container } = renderCard(approval({ details: [`Aufgaben: ${tasks.join(', ')}`], detailItems: [tasks] }));
    expect(container.textContent).toContain('Routineaufgabe Montag, Routineaufgabe Dienstag +3 weitere');
    const toggle = screen.getByRole('button', { name: 'Alle 5 anzeigen' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('li').length).toBe(0);

    fireEvent.click(toggle);
    expect(container.querySelectorAll('li').length).toBe(5);
    const less = screen.getByRole('button', { name: 'Weniger anzeigen' });
    expect(less.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(less);
    expect(container.querySelectorAll('li').length).toBe(0);
  });

  it('does not split a comma-joined string that is not an array', () => {
    const { container } = renderCard(approval({ details: [`Aufgaben: ${tasks.join(', ')}`] }));
    expect(container.querySelectorAll('li').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Mehr anzeigen' }));
    expect(container.querySelectorAll('li').length).toBe(0);
    expect(container.textContent).toContain(tasks.join(', '));
  });

  it('wraps long text fully when expanded', () => {
    const long = 'x'.repeat(150);
    const { container } = renderCard(approval({ details: [`Notiz: ${long}`] }));
    expect(container.querySelector('[data-collapsed]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mehr anzeigen' }));
    expect(container.querySelector('[data-collapsed]')).toBeNull();
    expect(container.textContent).toContain(long);
  });
});

describe('createApprovalDescriptionGenerator detailItems', () => {
  it('carries real array values as items, by detail index', () => {
    const gen = createApprovalDescriptionGenerator({ fieldLabels: { titles: 'Aufgaben' } });
    const result = gen('delete_tasks', 'a', { name: 'x', titles: ['a', 'b', 'c'] });
    expect(result.details).toEqual(['name: X', 'Aufgaben: A, B, C']);
    expect(result.detailItems).toEqual([undefined, ['A', 'B', 'C']]);
  });

  it('omits detailItems without arrays', () => {
    const result = createApprovalDescriptionGenerator()('t', 'a', { name: 'x' });
    expect(result.detailItems).toBeUndefined();
  });
});
