// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../react/stt/controller.js';
import type { ChatMessage, ChatTransport } from '../../react/types.js';
import { registerNavigationBridge } from '../../browser/navigation.js';
import { CHAT_STYLES } from '../chat-styles.generated.js';
import {
  EMBED_CSS_VARIABLES,
  GlirastesChatElement,
  defineGlirastesChatElement,
  embedThemeCss,
} from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function transport(messages: ChatMessage[] = []): ChatTransport {
  return {
    messages,
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

/** A complete AI SDK UI message stream (SSE) that answers with `text`. */
function sseResponse(text: string): Response {
  const chunks = [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

/** A UI message stream with one executed tool call and its output. */
function toolStreamResponse(toolName: string, output: unknown): Response {
  const chunks = [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'tool-input-available', toolCallId: 'call-1', toolName, input: {} },
    { type: 'tool-output-available', toolCallId: 'call-1', output },
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

async function mount(
  configure: (element: GlirastesChatElement) => void = () => {},
  tag = 'glirastes-chat',
) {
  defineGlirastesChatElement(tag);
  const element = document.createElement(tag) as GlirastesChatElement;
  configure(element);
  const events: Array<{ type: string; detail: unknown }> = [];
  for (const type of ['ready', 'status', 'tool-result', 'ui-action', 'error']) {
    document.addEventListener(`glirastes-chat:${type}`, (event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
    });
  }
  await act(async () => { document.body.append(element); });
  return { element, events };
}

afterEach(async () => {
  await act(async () => { document.body.replaceChildren(); });
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('<glirastes-chat>', () => {
  it('renders the React chat inside an open shadow root with the shared CSS', async () => {
    const chat = transport();
    const { element, events } = await mount((node) => {
      node.setAttribute('placeholder', 'Frag deine App');
      node.transport = chat;
    });
    const shadow = element.shadowRoot!;
    expect(shadow.querySelector('[data-component="ai-chat-panel"]')).toBeTruthy();
    expect(shadow.querySelector('style')?.textContent).toContain(CHAT_STYLES);
    expect(shadow.querySelector('textarea')?.getAttribute('placeholder')).toBe('Frag deine App');
    expect(document.body.querySelector('[data-component="ai-chat-panel"]')).toBeNull();
    expect(events.map((event) => event.type)).toEqual([
      'glirastes-chat:ready',
      'glirastes-chat:status',
    ]);
  });

  it('speaks the nearest lang of the element, not only the one of the page', async () => {
    document.documentElement.setAttribute('lang', 'de');
    defineGlirastesChatElement('glirastes-chat');
    const region = document.createElement('div');
    region.setAttribute('lang', 'pl-PL');
    const element = document.createElement('glirastes-chat') as GlirastesChatElement;
    element.transport = transport();
    element.config = { locales: { pl: { placeholder: 'Napisz wiadomość' } } };
    region.append(element);
    await act(async () => { document.body.append(region); });
    expect(element.shadowRoot!.querySelector('textarea')?.getAttribute('placeholder')).toBe('Napisz wiadomość');
    document.documentElement.removeAttribute('lang');
  });

  it('follows a lang the page sets after the element mounted, with English for the keys a partial table lacks', async () => {
    document.documentElement.setAttribute('lang', 'de');
    const { element } = await mount((node) => {
      node.transport = transport();
      node.config = { locales: { pl: { placeholder: 'Napisz wiadomość' } } };
    });
    const textarea = () => element.shadowRoot!.querySelector('textarea')!;
    const send = () => element.shadowRoot!.querySelector('button[data-action="send"]')!;
    expect(textarea().getAttribute('placeholder')).toBe('Nachricht eingeben…');
    await act(async () => { document.documentElement.setAttribute('lang', 'pl'); });
    await waitFor(() => expect(textarea().getAttribute('placeholder')).toBe('Napisz wiadomość'));
    expect(send().textContent).toBe('Send');
    document.documentElement.removeAttribute('lang');
  });

  it("keeps the server's tool wording first with languageSource: 'server'", async () => {
    document.documentElement.setAttribute('lang', 'en');
    const handlers = new Set<(part: { type: string; data: unknown }) => void>();
    const { element } = await mount((node) => {
      node.transport = {
        ...transport(),
        subscribeToData: (handler) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      };
      node.config = { languageSource: 'server' };
    });
    await act(async () => {
      handlers.forEach((handler) => handler({
        type: 'data-tool-presentation',
        data: { locale: 'de-DE', tools: { tasks_list: { label: 'Aufgaben lesen' } } },
      }));
    });
    expect(element.shadowRoot!.querySelector('textarea')?.getAttribute('placeholder')).toBe('Nachricht eingeben…');
    element.config = {};
    await act(async () => {});
    expect(element.shadowRoot!.querySelector('textarea')?.getAttribute('placeholder')).not.toBe('Nachricht eingeben…');
    document.documentElement.removeAttribute('lang');
  });

  it('lets host CSS variables theme the panel instead of inline variables', async () => {
    const { element } = await mount((node) => {
      node.setAttribute('theme', 'professional-dark');
      node.transport = transport();
    });
    const panel = element.shadowRoot!.querySelector<HTMLElement>('[data-component="ai-chat-panel"]')!;
    expect(panel.getAttribute('style') ?? '').not.toContain('--cm-primary');
    const css = element.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).toContain(embedThemeCss('professional-dark'));
    expect(css).toMatch(/--cm-primary: var\(--glirastes-chat-primary, [^)]+\);/);
    expect(EMBED_CSS_VARIABLES).toContain('--glirastes-chat-primary');
  });

  it('keeps the preset effect (glass blur) while colours stay on CSS variables', async () => {
    const { element } = await mount((node) => {
      node.setAttribute('theme', 'liquid-glass');
      node.transport = transport();
    });
    const panel = () =>
      element.shadowRoot!.querySelector<HTMLElement>('[data-component="ai-chat-panel"]')!;
    expect(panel().getAttribute('data-theme-effect')).toBe('glass');
    expect(panel().getAttribute('style') ?? '').not.toContain('--cm-');

    await act(async () => { element.setAttribute('theme', 'professional-dark'); });
    expect(panel().hasAttribute('data-theme-effect')).toBe(false);
  });

  it('sends from the keyboard and through the element API', async () => {
    const chat = transport();
    const { element } = await mount((node) => { node.transport = chat; });
    const textarea = element.shadowRoot!.querySelector('textarea')!;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Zeige meine Aufgaben' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Zeige meine Aufgaben' }));
    await act(async () => { expect(element.send('Und morgen?')).toBe(true); });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Und morgen?' }));
  });

  it('emits tool results of the running request for host-side UI actions', async () => {
    const output = { success: true, uiAction: { type: 'navigate', path: '/tasks' } };
    vi.stubGlobal('fetch', vi.fn(async () => toolStreamResponse('ui_navigate', output)));
    const { element, events } = await mount((node) => { node.setAttribute('endpoint', '/api/chat'); });
    await act(async () => { expect(element.send('Öffne die Aufgaben')).toBe(true); });
    await waitFor(() => expect(events).toContainEqual({
      type: 'glirastes-chat:tool-result',
      detail: { toolName: 'ui_navigate', result: output },
    }));
    // A host-side action has no generated UI action, so no outcome event.
    expect(events.map((event) => event.type)).not.toContain('glirastes-chat:ui-action');
  });

  it('does not emit tool results of messages a custom transport starts with', async () => {
    const chat = transport([{
      id: 'a1',
      role: 'assistant',
      parts: [{
        type: 'tool-ui_navigate', toolCallId: 'c1', state: 'output-available',
        output: { success: true, uiAction: { type: 'navigate', path: '/tasks' } },
      }],
    } as unknown as ChatMessage]);
    const { events } = await mount((node) => { node.transport = chat; });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(events.map((event) => event.type)).not.toContain('glirastes-chat:tool-result');
  });

  it('emits the outcome of a generated UI action without its payload', async () => {
    const output = {
      success: true,
      message: 'Handed to the app.',
      uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/tasks?q=secret' } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => toolStreamResponse('ui_navigate', output)));
    const push = vi.fn();
    const stopBridge = registerNavigationBridge({ push });
    // A throwing host callback does not stop the DOM event.
    const onUiActionOutcome = vi.fn(() => { throw new Error('host callback'); });
    try {
      const { element, events } = await mount((node) => {
        node.setAttribute('endpoint', '/api/chat');
        node.config = { onUiActionOutcome };
      });
      await act(async () => { expect(element.send('Zeige erledigte Aufgaben')).toBe(true); });
      await waitFor(() => expect(events).toContainEqual({
        type: 'glirastes-chat:ui-action',
        detail: { toolName: 'ui_navigate', toolCallId: 'call-1', code: 'ok', actionIds: ['glirastes.navigate'] },
      }));
      expect(push).toHaveBeenCalledWith('/tasks?q=secret');
      expect(onUiActionOutcome).toHaveBeenCalledWith(expect.objectContaining({ code: 'ok', toolCallId: 'call-1' }));
      expect(JSON.stringify(events.filter((event) => event.type === 'glirastes-chat:ui-action'))).not.toContain('secret');
    } finally {
      stopBridge();
    }
  });

  it('posts to the endpoint attribute with the config headers and bodyExtras', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => sseResponse('Hallo zurück'));
    vi.stubGlobal('fetch', fetchMock);
    const { element, events } = await mount((node) => {
      node.setAttribute('endpoint', '/api/chat');
      node.config = {
        headers: () => ({ 'x-tenant': 't1' }),
        bodyExtras: { locale: 'de' },
      };
    });
    expect(element.shadowRoot!.querySelector('[data-component="ai-chat-panel"]')).toBeTruthy();
    expect(events.map((event) => event.type)).not.toContain('glirastes-chat:error');

    await act(async () => { expect(element.send('Hallo')).toBe(true); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/chat');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-tenant')).toBe('t1');
    const body = JSON.parse(String(init?.body)) as {
      locale: string;
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    };
    expect(body.locale).toBe('de');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'Hallo' }],
    });

    await waitFor(() => expect(element.shadowRoot!.textContent).toContain('Hallo zurück'));
    await waitFor(() => expect(events.filter((event) => event.type === 'glirastes-chat:status').pop())
      .toMatchObject({ detail: { state: 'idle' } }));
  });

  it('maps the voice and voice-language attributes onto the composer microphone', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
    const connect = vi.fn<SttProviderAdapter['connect']>(async () => ({
      finalize: async () => {},
      cancel: async () => {},
      close: async () => {},
    }));
    const adapter: SttProviderAdapter = { connect };
    const micOf = (element: GlirastesChatElement) =>
      element.shadowRoot!.querySelector<HTMLButtonElement>('[data-component="voice-input-addon"]');

    const silent = await mount((node) => { node.transport = transport(); });
    expect(micOf(silent.element)).toBeNull();
    await act(async () => { silent.element.remove(); });

    const english = await mount((node) => {
      node.setAttribute('voice', '');
      node.setAttribute('voice-language', 'en');
      node.transport = transport();
      node.config = { voice: { adapter } };
    });
    expect(micOf(english.element)).toBeTruthy();
    await act(async () => { fireEvent.click(micOf(english.element)!); });
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect.mock.calls[0]![0].language).toBe('en');
    await act(async () => { english.element.remove(); });

    const defaulted = await mount((node) => {
      node.setAttribute('voice', '');
      node.transport = transport();
      node.config = { voice: { adapter } };
    });
    await act(async () => { fireEvent.click(micOf(defaulted.element)!); });
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(connect.mock.calls[1]![0].language).toBe('de');
  });

  it('reports a missing endpoint instead of rendering a broken chat', async () => {
    const { element, events } = await mount();
    expect(element.shadowRoot!.querySelector('[data-component="ai-chat-panel"]')).toBeNull();
    expect(events).toContainEqual({
      type: 'glirastes-chat:error',
      detail: { message: 'Missing endpoint attribute' },
    });
  });

  it('unmounts cleanly on removal but survives a move', async () => {
    const { element } = await mount((node) => { node.transport = transport(); });
    const other = document.createElement('section');
    document.body.append(other);
    await act(async () => { other.append(element); });
    expect(element.shadowRoot!.querySelector('[data-component="ai-chat-panel"]')).toBeTruthy();

    await act(async () => { element.remove(); });
    await act(async () => { await Promise.resolve(); });
    expect(element.shadowRoot!.childNodes).toHaveLength(0);
    expect(element.send('late')).toBe(false);
  });

  it('defines each tag once and refuses foreign definitions', () => {
    const first = defineGlirastesChatElement('glirastes-chat-twice');
    expect(defineGlirastesChatElement('glirastes-chat-twice')).toBe(first);
    customElements.define('foreign-chat', class extends HTMLElement {});
    expect(() => defineGlirastesChatElement('foreign-chat')).toThrow(/already defined/);
  });
});
