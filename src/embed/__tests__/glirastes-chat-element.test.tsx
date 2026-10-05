// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../react/stt/controller.js';
import type { ChatMessage, ChatTransport } from '../../react/types.js';
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

async function mount(
  configure: (element: GlirastesChatElement) => void = () => {},
  tag = 'glirastes-chat',
) {
  defineGlirastesChatElement(tag);
  const element = document.createElement(tag) as GlirastesChatElement;
  configure(element);
  const events: Array<{ type: string; detail: unknown }> = [];
  for (const type of ['ready', 'status', 'tool-result', 'error']) {
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

  it('emits tool results for host-side UI actions', async () => {
    const chat = transport([{
      id: 'a1',
      role: 'assistant',
      parts: [{
        type: 'tool-ui_navigate', toolCallId: 'c1', state: 'output-available',
        output: { success: true, uiAction: { type: 'navigate', path: '/tasks' } },
      }],
    } as unknown as ChatMessage]);
    const { events } = await mount((node) => { node.transport = chat; });
    expect(events).toContainEqual({
      type: 'glirastes-chat:tool-result',
      detail: {
        toolName: 'ui_navigate',
        result: { success: true, uiAction: { type: 'navigate', path: '/tasks' } },
      },
    });
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
