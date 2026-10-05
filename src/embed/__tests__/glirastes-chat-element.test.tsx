// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
