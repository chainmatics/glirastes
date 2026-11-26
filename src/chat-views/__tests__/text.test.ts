import { describe, expect, it } from 'vitest';
import type { ResolvedChatView } from '../../contracts/chat-view.js';
import {
  chatElementToText,
  chatViewToText,
  defineChatComponent,
  starterChatComponentManifest,
  starterChatComponents,
  toChatComponentManifest,
} from '../index.js';
import { z } from 'zod';

const manifest = starterChatComponentManifest;
const v = (type: string, props: Record<string, unknown>, extra: object = {}) => ({
  type,
  schemaVersion: 1,
  props,
  ...extra,
});

const starterView: ResolvedChatView = {
  v: 1,
  root: 'card',
  caption: 'Open invoices',
  elements: {
    card: v('Card', { title: 'Invoices' }, { children: ['facts', 'table', 'stat', 'act'] }),
    facts: v('KeyValue', { items: [{ label: 'Customer', value: 'ACME' }, { label: 'Open', value: 2 }] }),
    table: v(
      'Table',
      {
        columns: [
          { header: 'Customer', cell: 'customer' },
          { header: 'Total', cell: 'total' },
          { header: 'Due', cell: 'due' },
        ],
        truncatedRows: 3,
        partial: true,
      },
      {
        rows: [
          { customer: { label: 'ACME | Co', tone: 'neutral' }, total: { amount: 1234.5, currency: 'EUR' }, due: { value: '2026-03-04', mode: 'date' } },
          { customer: { label: 'Beta', tone: 'success' }, total: { amount: 10, currency: 'EUR' }, due: { value: '2026-03-05T10:30:00Z', mode: 'datetime' } },
        ],
      },
    ),
    customer: v('StatusBadge', {}),
    total: v('Money', {}),
    due: v('DateTime', {}),
    stat: v('Stat', { label: 'Total', value: 1244.5 }, { said: true }),
    act: v('Action', { label: 'Send reminder', prompt: 'remind' }),
  },
};

describe('chatViewToText', () => {
  it('renders the starter view as exact Markdown', () => {
    expect(chatViewToText(starterView, manifest)).toBe(
      [
        'Open invoices',
        '**Invoices**',
        'Customer: ACME\nOpen: 2',
        [
          '| Customer | Total | Due |',
          '| --- | --- | --- |',
          '| ACME \\| Co | €1,234.50 | Mar 4, 2026 |',
          '| Beta | €10.00 | Mar 5, 2026, 10:30 AM |',
          '(+3 more)',
          '(excerpt — not all entries shown)',
        ].join('\n'),
        'Total: 1244.5 (computed by the assistant)',
      ].join('\n\n'),
    );
  });

  it('uses German phrases and formats in the locale', () => {
    const text = chatViewToText(starterView, manifest, { locale: 'de' });
    expect(text).toContain('Total: 1244.5 (vom Assistenten berechnet)');
    expect(text).toContain('(+3 weitere)');
    expect(text).toContain('(Auszug – nicht alle Einträge)');
    expect(text).toContain('1.234,50');
    expect(text).toContain('04.03.2026');
  });

  it('omits the said marker when the stat is not computed by the assistant', () => {
    const view = { ...starterView, elements: { ...starterView.elements, stat: v('Stat', { label: 'Total', value: 5 }) } };
    expect(chatViewToText(view, manifest)).toMatch(/Total: 5$/);
    expect(chatViewToText(view, manifest)).not.toContain('computed');
  });

  it('renders an app component through its text rule', () => {
    const custom = toChatComponentManifest([
      ...starterChatComponents,
      defineChatComponent({
        id: 'OrderChip',
        schemaVersion: 1,
        description: 'Order',
        props: z.object({ name: z.string(), state: z.string() }),
        text: { label: 'name', value: 'state' },
      }),
    ]);
    const view: ResolvedChatView = {
      v: 1,
      root: 'chip',
      elements: { chip: v('OrderChip', { name: 'Order 7', state: 'shipped' }) },
    };
    expect(chatViewToText(view, custom)).toBe('Order 7: shipped');
  });

  it('degrades an unknown type to the text of its children', () => {
    const view: ResolvedChatView = {
      v: 1,
      root: 'x',
      elements: {
        x: v('FutureThing', { a: 1 }, { children: ['t'] }),
        t: v('Text', { text: 'still readable' }),
      },
    };
    expect(chatViewToText(view, manifest)).toBe('still readable');
  });

  it('renders one element for the per-element fallback', () => {
    expect(chatElementToText(starterView, 'facts', manifest)).toBe('Customer: ACME\nOpen: 2');
    expect(chatElementToText(starterView, 'missing', manifest)).toBe('');
  });
});
