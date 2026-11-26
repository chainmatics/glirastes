// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResolvedChatView } from '../../../contracts/chat-view.js';
import { defineChatComponent, refOnly } from '../../../chat-views/define.js';
import { chatElementId } from '../../../chat-views/element-id.js';
import { starterChatComponents } from '../../../chat-views/starter-catalog.js';
import { UiActionBus } from '../../../browser/ui-action-bus.js';
import { readChatViewCapabilities } from '../../../server/adapters/nextjs/render-view.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { useChatContext } from '../../provider/chat-context.js';
import { MessageList } from '../../components/message-list.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';
import { useVercelAiChatTransport } from '../../transports/vercel.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport } from '../../types.js';
import {
  bindChatComponent,
  ChatView,
  createChatViewRegistry,
  mergeChatComponentBindings,
  starterChatBindings,
  type ChatComponentBinding,
} from '../../index.js';

afterEach(cleanup);

function viewMessage(view: unknown, output?: unknown): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    parts: [{
      type: 'tool-render_view',
      toolCallId: 'call-view',
      state: 'output-available',
      input: {},
      output: output ?? { shown: true, elements: Object.keys((view as ResolvedChatView).elements).length, view },
    }],
  } as unknown as ChatMessage;
}

function transport(messages: ChatMessage[]): ChatTransport {
  return {
    messages, status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function renderChat(view: unknown, props: Partial<AiChatProviderConfig> = {}, chat = transport([viewMessage(view)])) {
  render(
    <AiChatProvider transport={chat} {...props}>
      <MessageList />
    </AiChatProvider>,
  );
  return chat;
}

const invoices: ResolvedChatView = {
  v: 1,
  root: 'g',
  caption: 'Offene Rechnungen',
  elements: {
    g: { type: 'Group', schemaVersion: 1, props: {}, children: ['t', 'total'] },
    t: {
      type: 'Table',
      schemaVersion: 1,
      props: {
        columns: [
          { header: 'Kunde', cell: 'name' },
          { header: 'Status', cell: 'state' },
          { header: 'Betrag', cell: 'amount' },
        ],
        truncatedRows: 3,
      },
      rows: [
        { name: { text: 'Acme' }, state: { label: 'offen', tone: 'warning' }, amount: { amount: 1234.5, currency: 'EUR' } },
        { name: { text: 'Globex' }, state: { label: 'bezahlt', tone: 'success' }, amount: { amount: 99, currency: 'EUR' } },
      ],
    },
    name: { type: 'Text', schemaVersion: 1, props: {} },
    state: { type: 'StatusBadge', schemaVersion: 1, props: {} },
    amount: { type: 'Money', schemaVersion: 1, props: {} },
    total: { type: 'Stat', schemaVersion: 1, props: { label: 'Summe', value: 'ca. 12.400 €' }, said: true },
  },
};

describe('chat views in the message list', () => {
  it('renders a starter view: table rows, badge, money in de', () => {
    renderChat(invoices, { chatViews: {}, language: 'de' });
    const root = document.querySelector('[data-component="chat-view"]')!;
    expect(root).not.toBeNull();
    expect(root.querySelector('[data-element="caption"]')?.textContent).toBe('Offene Rechnungen');
    expect([...root.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Kunde', 'Status', 'Betrag']);
    const rows = [...root.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('[data-element="text"]')?.textContent).toBe('Acme');
    const badge = rows[0]!.querySelector('[data-element="status-badge"]')!;
    expect(badge.textContent).toBe('offen');
    expect(badge.getAttribute('data-tone')).toBe('warning');
    expect(rows[0]!.querySelector('[data-element="money"]')?.textContent).toMatch(/^1\.234,50\s€$/);
    expect(root.querySelector('[data-note="more"]')?.textContent).toBe('+3 weitere');
    expect(root.querySelector('[data-element="stat-value"]')?.textContent).toBe('ca. 12.400 €');
    // Not the raw tool output, not a step of the activity log.
    expect(document.querySelector('[data-component="tool-result"]')).toBeNull();
  });

  it('renders old version via text fallback', () => {
    const noteV2 = defineChatComponent({
      id: 'Note',
      schemaVersion: 2,
      description: 'A note',
      props: z.object({ body: z.string(), author: z.string() }),
      text: { value: 'body' },
    });
    const Note = vi.fn(() => <em data-element="note" />);
    const view: ResolvedChatView = {
      v: 1,
      root: 'g',
      elements: {
        g: { type: 'Group', schemaVersion: 1, props: {}, children: ['old', 'hint'] },
        old: { type: 'Note', schemaVersion: 1, props: { body: 'Stored before the upgrade' } },
        hint: { type: 'Text', schemaVersion: 1, props: { text: 'Still rendered' } },
      },
    };
    renderChat(view, { chatViews: { components: [bindChatComponent(noteV2, Note)] } });
    expect(Note).not.toHaveBeenCalled();
    expect(document.querySelector('[data-element="text-fallback"]')?.textContent).toBe('Stored before the upgrade');
    expect(document.querySelector('[data-element="text"]')?.textContent).toBe('Still rendered');
  });

  it('renders an unknown component or invalid props as text while the siblings still render', () => {
    const view: ResolvedChatView = {
      v: 1,
      root: 'g',
      elements: {
        g: { type: 'Group', schemaVersion: 1, props: {}, children: ['chart', 'bad', 'ok'] },
        chart: { type: 'Chart', schemaVersion: 1, props: { series: [] } },
        bad: { type: 'StatusBadge', schemaVersion: 1, props: { label: 'blocked', tone: 'purple' } },
        ok: { type: 'StatusBadge', schemaVersion: 1, props: { label: 'done', tone: 'success' } },
      },
    };
    renderChat(view, { chatViews: {} });
    const fallbacks = [...document.querySelectorAll('[data-element="text-fallback"]')].map((node) => node.textContent);
    // The unknown Chart has no text and no children: nothing at all, not an empty span.
    expect(fallbacks).toEqual(['blocked']);
    expect(document.querySelector('[data-element="status-badge"]')?.textContent).toBe('done');
  });

  it('renders the whole view as text when the root cannot render', () => {
    const view: ResolvedChatView = {
      v: 1,
      root: 'card',
      elements: {
        card: { type: 'Card', schemaVersion: 1, props: { title: 42 }, children: ['x'] },
        x: { type: 'Text', schemaVersion: 1, props: { text: 'Inside' } },
      },
    };
    renderChat(view, { chatViews: {} });
    const root = document.querySelector('[data-component="chat-view"]')!;
    expect(root.getAttribute('data-fallback')).toBe('text');
    expect(root.textContent).toContain('Inside');
  });

  it('renders an element whose component throws as its text', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const textDefinition = starterChatComponents.find((definition) => definition.id === 'Text')!;
      const broken = bindChatComponent(textDefinition, () => { throw new Error('render bug'); });
      const view: ResolvedChatView = {
        v: 1,
        root: 'g',
        elements: {
          g: { type: 'Group', schemaVersion: 1, props: {}, children: ['x'] },
          x: { type: 'Text', schemaVersion: 1, props: { text: 'Fallback text' } },
        },
      };
      renderChat(view, { chatViews: { components: [broken] } });
      expect(document.querySelector('[data-element="text-fallback"]')?.textContent).toBe('Fallback text');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('always shows the said marker, also with unstyled and an app Stat', () => {
    const statDefinition = starterChatComponents.find((definition) => definition.id === 'Stat')!;
    const appStat = bindChatComponent(statDefinition, ({ props }) => <b data-element="app-stat">{String(props.value)}</b>);
    renderChat(invoices, { chatViews: { components: [appStat] }, unstyled: true, language: 'de' });
    expect(document.querySelector('[data-element="app-stat"]')?.textContent).toBe('ca. 12.400 €');
    expect(document.querySelector('[data-element="said-marker"]')?.textContent).toBe('vom Assistenten berechnet');
  });

  it('sends an action prompt as the next message', async () => {
    const view: ResolvedChatView = {
      v: 1,
      root: 'go',
      elements: { go: { type: 'Action', schemaVersion: 1, props: { label: 'Only overdue', prompt: 'Show only the overdue invoices' } } },
    };
    const chat = renderChat(view, { chatViews: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Only overdue' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Show only the overdue invoices' }),
    ));
  });

  it('runs an action uiAction through the bus and reports its outcome', async () => {
    const bus = new UiActionBus();
    const handler = vi.fn();
    bus.subscribeById('invoices.remind', handler);
    const onUiActionOutcome = vi.fn();
    const view: ResolvedChatView = {
      v: 1,
      root: 'go',
      elements: {
        go: { type: 'Action', schemaVersion: 1, props: { label: 'Remind', uiAction: { id: 'invoices.remind', args: { invoiceId: 'R-7' } } } },
      },
    };
    renderChat(view, { chatViews: {}, uiActionBus: bus, onUiActionOutcome });
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(onUiActionOutcome).toHaveBeenCalled());
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'glirastes.action', actionId: 'invoices.remind', payload: { invoiceId: 'R-7' },
    }));
    expect(onUiActionOutcome.mock.calls[0]![0]).toMatchObject({
      toolName: 'render_view', toolCallId: 'call-view', code: 'ok', reported: false,
    });
  });

  it('renders a view as text without the chatViews option', () => {
    renderChat(invoices, { language: 'de' });
    const root = document.querySelector('[data-component="chat-view"]')!;
    expect(root.getAttribute('data-fallback')).toBe('text');
    // Plain text, synchronously: no Markdown renderer is involved.
    expect(root.textContent).toContain('Acme');
    expect(root.textContent).toContain('vom Assistenten berechnet');
  });

  describe('values never become markup in a text fallback', () => {
    const LINK = '[x](https://evil.example)';
    const IMAGE = '![](https://evil.example/p.png)';
    const HTML = '<img src=x>';
    const BARE = 'https://evil.example and mail@evil.example';
    const hostile = (rootProps: Record<string, unknown> = {}): ResolvedChatView => ({
      v: 1,
      root: 'card',
      caption: LINK,
      elements: {
        card: { type: 'Card', schemaVersion: 1, props: { title: IMAGE, ...rootProps }, children: ['facts', 'note', 'table', 'chart'] },
        facts: { type: 'KeyValue', schemaVersion: 1, props: { items: [{ label: HTML, value: LINK }] } },
        note: { type: 'Text', schemaVersion: 1, props: { text: BARE } },
        table: {
          type: 'Table',
          schemaVersion: 1,
          props: { columns: [{ header: IMAGE, cell: 'who' }] },
          rows: [{ who: { label: LINK, tone: 'neutral' } }, { who: { label: HTML, tone: 'purple' } }],
        },
        who: { type: 'StatusBadge', schemaVersion: 1, props: {} },
        // Unknown type: its per-element fallback is the text of its children.
        chart: { type: 'Chart', schemaVersion: 1, props: {}, children: ['inner'] },
        inner: { type: 'Text', schemaVersion: 1, props: { text: IMAGE } },
      },
    });
    const expectInert = () => {
      const root = document.querySelector('[data-component="chat-view"]')!;
      expect(root.querySelector('a, img, script')).toBeNull();
      return root;
    };

    it('in the whole-view fallback without the option', () => {
      renderChat(hostile());
      const root = expectInert();
      expect(root.getAttribute('data-fallback')).toBe('text');
      for (const value of [LINK, IMAGE, HTML, BARE]) expect(root.textContent).toContain(value);
    });

    it('in the whole-view fallback when the root fails', () => {
      renderChat(hostile({ title: 42 }), { chatViews: {} });
      const root = expectInert();
      expect(root.getAttribute('data-fallback')).toBe('text');
      expect(root.textContent).toContain(LINK);
    });

    it('in the per-element and per-cell fallbacks', () => {
      renderChat(hostile(), { chatViews: {} });
      const root = expectInert();
      expect(root.getAttribute('data-fallback')).toBeNull();
      const fallbacks = [...root.querySelectorAll('[data-element="text-fallback"]')].map((node) => node.textContent);
      // The invalid badge cell (tone `purple`) and the unknown Chart.
      expect(fallbacks).toEqual([HTML, IMAGE]);
    });

    it('through the escaped Markdown text form, also when a consumer renders it as Markdown', async () => {
      const { chatViewToText } = await import('../../../chat-views/text.js');
      const { starterChatComponentManifest } = await import('../../../chat-views/starter-catalog.js');
      const { default: Markdown } = await import('react-markdown');
      const { default: remarkGfm } = await import('remark-gfm');
      const markdown = chatViewToText(hostile(), starterChatComponentManifest);
      const { container } = render(<Markdown remarkPlugins={[remarkGfm]}>{markdown}</Markdown>);
      expect(container.querySelector('img, script')).toBeNull();
      // GFM autolinks a bare address after unescaping; that link shows exactly
      // its target. No value yields a link with hidden or different text.
      const links = [...container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
      expect(links.length).toBeGreaterThan(0);
      for (const [text, href] of links) expect([text, `mailto:${text}`]).toContain(href);
      expect(links.map(([text]) => text)).not.toContain('x');
      expect(container.querySelector('table')).not.toBeNull();
      for (const value of [LINK, IMAGE, HTML, BARE]) expect(container.textContent).toContain(value);
    });
  });

  it('renders nothing for a failed or running render_view call', () => {
    renderChat(invoices, { chatViews: {} }, transport([viewMessage(invoices, { success: false, error: 'unknown component', retryable: false })]));
    expect(document.querySelector('[data-component="chat-view"]')).toBeNull();
    expect(document.querySelector('[data-component="tool-result"]')).toBeNull();
  });
});

describe('createChatViewRegistry', () => {
  it('reports the bound components and prefers an app binding of the same id@schemaVersion', () => {
    const registry = createChatViewRegistry(starterChatBindings);
    expect(registry.capabilities()).toContainEqual({ id: 'Table', schemaVersion: 1 });
    expect(registry.capabilities()).toHaveLength(starterChatBindings.length);
    expect(registry.resolve('Money', 1, { amount: 1, currency: 'EUR' })?.binding.definition.id).toBe('Money');
    expect(registry.resolve('Money', 1, { amount: '1', currency: 'EUR' })).toBeUndefined();
  });

  it('picks the highest version up to the element version whose schema accepts the props', () => {
    const v1 = defineChatComponent({ id: 'Note', schemaVersion: 1, description: 'n', props: z.object({ body: z.string() }), text: {} });
    const v2 = defineChatComponent({ id: 'Note', schemaVersion: 2, description: 'n', props: z.object({ text: z.string() }), text: {} });
    const bindings: ChatComponentBinding[] = [bindChatComponent(v1, () => null), bindChatComponent(v2, () => null)];
    const registry = createChatViewRegistry(bindings);
    expect(registry.resolve('Note', 2, { text: 'x' })?.entry.schemaVersion).toBe(2);
    expect(registry.resolve('Note', 3, { body: 'x' })?.entry.schemaVersion).toBe(1);
    expect(registry.resolve('Note', 1, { text: 'x' })).toBeUndefined();
  });
});

describe('mergeChatComponentBindings', () => {
  const note = (schemaVersion: number) => defineChatComponent({
    id: 'Note', schemaVersion, description: 'n', props: z.object({ body: z.string() }), text: {},
  });
  const bound = (schemaVersion: number) => bindChatComponent(note(schemaVersion), () => null);

  it('lets a later binding of the same id and schemaVersion replace an earlier one, keeping first-appearance order', () => {
    const early = bound(1);
    const other = bound(2);
    const late = bound(1);
    const merged = mergeChatComponentBindings([early, other], [late]);
    expect(merged).toEqual([late, other]);
    expect(merged[0]).toBe(late);
    expect(() => createChatViewRegistry(merged)).not.toThrow();
  });

  it('keeps createChatViewRegistry strict for duplicates inside one list', () => {
    expect(() => createChatViewRegistry([bound(1), bound(1)])).toThrow();
    expect(() => createChatViewRegistry([...starterChatBindings, ...starterChatBindings])).toThrow();
  });
});

describe('ChatView with an app table-like component', () => {
  const orderGrid = defineChatComponent({
    id: 'OrderGrid',
    schemaVersion: 1,
    description: 'Orders',
    props: z.object({
      orders: refOnly(z.array(z.record(z.string(), z.unknown()))),
      fields: z.array(z.object({ title: z.string(), element: chatElementId() })),
    }),
    itemScope: { rowsProp: 'orders', cellsProp: 'fields' },
    text: { rows: 'orders', columns: 'fields' },
  });
  const view: ResolvedChatView = {
    v: 1,
    root: 'grid',
    elements: {
      grid: { type: 'OrderGrid', schemaVersion: 1, props: { fields: [{ title: 'Order', element: 'no' }] }, rows: [{ no: { label: 'A-1', tone: 'neutral' } }] },
      no: { type: 'StatusBadge', schemaVersion: 1, props: {} },
    },
  };

  it('renders the app binding with its cells', () => {
    const Grid: ChatComponentBinding['component'] = ({ props, rows, renderCell }) => (
      <table data-element="order-grid">
        <tbody>
          {(rows ?? []).map((_row, index) => (
            <tr key={index}>{(props.fields as Array<{ element: string }>).map((field) => <td key={field.element}>{renderCell(index, field.element)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
    render(<ChatView view={view} registry={createChatViewRegistry([...starterChatBindings, bindChatComponent(orderGrid, Grid)])} />);
    expect(document.querySelector('[data-element="order-grid"] [data-element="status-badge"]')?.textContent).toBe('A-1');
  });

  it('renders the text table when the binding exists for the manifest but not the client', () => {
    // A client registry with the app's entry but no app binding falls back per element through the manifest.
    const registry = createChatViewRegistry([...starterChatBindings, bindChatComponent(orderGrid, () => { throw new Error('broken'); })]);
    render(<ChatView view={{ ...view, root: 'wrap', elements: { ...view.elements, wrap: { type: 'Group', schemaVersion: 1, props: {}, children: ['grid'] } } }} registry={registry} />);
    expect(document.querySelector('[data-element="text-fallback"]')?.textContent).toBe('| Order |\n| --- |\n| A-1 |');
  });
});

describe('ChatView on its own', () => {
  it('renders without a provider, entity links as their label', () => {
    const view: ResolvedChatView = {
      v: 1,
      root: 'link',
      elements: { link: { type: 'EntityLink', schemaVersion: 1, props: { entity: 'customer', record: 'c-1', label: 'Acme' } } },
    };
    render(<ChatView view={view} registry={createChatViewRegistry(starterChatBindings)} />);
    expect(document.querySelector('[data-element="entity-link"]')?.textContent).toBe('Acme');
  });
});

describe('chat view capabilities in the request body', () => {
  const bodies: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    bodies.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const chunks = [{ type: 'start' }, { type: 'finish' }];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  let send: ((text: string) => void) | undefined;
  function Send() {
    const { send: sendText } = useChatContext();
    send = (text) => { sendText(text); };
    return null;
  }
  function Chat(props: Partial<AiChatProviderConfig>) {
    const chatTransport = useVercelAiChatTransport({ endpoint: '/api/chat' });
    return (
      <AiChatProvider transport={chatTransport} {...props}>
        <Send />
        <AiChatPanel />
      </AiChatProvider>
    );
  }

  async function bodyOf(props: Partial<AiChatProviderConfig>) {
    render(<Chat {...props} />);
    await act(async () => { send!('Hello'); });
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    return bodies.at(-1)!;
  }

  it('sends no chatViews field without the option', async () => {
    expect(await bodyOf({})).not.toHaveProperty('chatViews');
  });

  it('sends the bound components and the surface with the option', async () => {
    const body = await bodyOf({ chatViews: { surface: 'narrow' } });
    const chatViews = body.chatViews as { components: Array<{ id: string; schemaVersion: number }>; surface: string };
    expect(chatViews.surface).toBe('narrow');
    expect(chatViews.components.map((component) => component.id)).toEqual(starterChatComponents.map((definition) => definition.id));
    // Round trip: the server's parser (Task 6) reads exactly this field and shape.
    expect(readChatViewCapabilities(body)).toEqual(chatViews);
  });

  it('lets an app binding override a starter component without throwing', async () => {
    const group = starterChatComponents.find((definition) => definition.id === 'Group')!;
    const mine = bindChatComponent(group, () => null);
    const body = await bodyOf({ chatViews: { components: [mine] } });
    const chatViews = body.chatViews as { components: Array<{ id: string; schemaVersion: number }> };
    expect(chatViews.components.filter((component) => component.id === 'Group')).toHaveLength(1);
    expect(chatViews.components).toHaveLength(starterChatBindings.length);
  });

  it('sends nothing the server would read as capabilities without the option', async () => {
    expect(readChatViewCapabilities(await bodyOf({}))).toBeUndefined();
  });
});
