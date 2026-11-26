/**
 * Cross-layer conformance for an app's table-like (item-scope) component:
 * defineChatComponent → manifest → validate → resolve → text.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatViewSpec } from '../../contracts/chat-view.js';
import {
  chatElementId,
  chatViewToText,
  defineChatComponent,
  mergeChatManifests,
  refOnly,
  resolveChatView,
  starterChatComponentManifest,
  toChatComponentManifest,
  validateChatViewSpec,
} from '../index.js';

const orderGrid = defineChatComponent({
  id: 'OrderGrid',
  schemaVersion: 1,
  description: 'Orders with one column per field',
  props: z.object({
    orders: refOnly(z.array(z.record(z.string(), z.unknown()))),
    fields: z.array(z.object({ title: z.string(), element: chatElementId() })).max(4),
  }),
  itemScope: { rowsProp: 'orders', cellsProp: 'fields' },
  text: { rows: 'orders', columns: 'fields' },
});

const manifest = mergeChatManifests(starterChatComponentManifest, toChatComponentManifest([orderGrid]));

const spec: ChatViewSpec = {
  root: 'grid',
  elements: {
    grid: {
      type: 'OrderGrid',
      props: { orders: { $ref: 'call_1', path: 'data[]' }, fields: [{ title: 'Order', element: 'no' }, { title: 'State', element: 'state' }] },
    },
    no: { type: 'StatusBadge', props: { label: { $item: 'number' }, tone: 'neutral' } },
    state: { type: 'StatusBadge', props: { label: { $item: 'state' }, tone: 'success' } },
  },
};

const orders = [{ number: 'A-1', state: 'shipped' }, { number: 'A-2', state: 'open' }];

describe('app item-scope component', () => {
  it('defineChatComponent requires a chatElementId() field in the cells prop', () => {
    expect(() => defineChatComponent({
      id: 'BadGrid',
      schemaVersion: 1,
      description: 'Grid',
      props: z.object({
        orders: refOnly(z.array(z.record(z.string(), z.unknown()))),
        fields: z.array(z.object({ title: z.string(), element: z.string() })),
      }),
      itemScope: { rowsProp: 'orders', cellsProp: 'fields' },
      text: { rows: 'orders' },
    })).toThrow('chat component BadGrid: itemScope.cellsProp "fields" must be a list of objects with a chatElementId() field naming the cell element');
  });

  it('validates, resolves and renders as a table in the text fallback', async () => {
    const validated = validateChatViewSpec(spec, manifest);
    expect(validated).toMatchObject({ ok: true });
    if (!validated.ok) return;
    const resolved = await resolveChatView(validated.spec, manifest, async () => ({
      toolName: 'orders_list', value: { data: orders }, truncated: false,
    }));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(chatViewToText(resolved.view, manifest)).toBe([
      '| Order | State |',
      '| --- | --- |',
      '| A-1 | shipped |',
      '| A-2 | open |',
    ].join('\n'));
    // A client without the app's component: nothing of its own (no children), no error.
    expect(chatViewToText(resolved.view, starterChatComponentManifest)).toBe('');
  });
});
