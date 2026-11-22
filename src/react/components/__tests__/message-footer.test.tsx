// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiChatProviderConfig, MessagePartsProps } from '../../types.js';
import { formatDuration } from '../message-footer.js';
import { ctx, Host, StreamingChat } from '../../__tests__/streaming-chat.js';

const START = new Date('2026-11-22T10:00:00.000Z').getTime();
const LINKS = 'Read [Docs](https://example.com/a) and [Spec](https://www.example.org/b).';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

class FakeClipboardItem {
  constructor(public items: Record<string, Blob>) {}
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  consoleSpies = (['log', 'warn', 'error'] as const).map((name) => vi.spyOn(console, name));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalItem;
});

function elapse(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

const text = (value: string) => ({ type: 'text' as const, text: value });

/** One finished question and answer; the clock ran `ms` while it streamed. */
async function answered(config: Partial<AiChatProviderConfig>, answer = LINKS, ms = 3240) {
  const chat = new StreamingChat();
  const view = render(<Host chat={chat} config={config} />);
  await act(async () => { ctx.send('question'); });
  act(() => chat.stream([text('…')]));
  elapse(ms);
  act(() => chat.finish([text(answer)]));
  await waitFor(() => expect(document.querySelector('[data-component="markdown"] p')).not.toBeNull());
  return { chat, view };
}

const footer = () => document.querySelector('[data-component="message-footer"]');
const button = (action: string) => document.querySelector<HTMLButtonElement>(`[data-component="message-footer"] [data-action="${action}"]`);

describe('formatDuration', () => {
  it('tenths under a minute, whole seconds above', () => {
    expect(formatDuration(3240, 'en')).toBe('3.2 s');
    expect(formatDuration(3240, 'de')).toBe('3,2 s');
    expect(formatDuration(0)).toBe('< 0.1 s');
    expect(formatDuration(99, 'en')).toBe('< 0.1 s');
    expect(formatDuration(99, 'de')).toBe('< 0,1 s');
    expect(formatDuration(100, 'en')).toBe('0.1 s');
    expect(formatDuration(59_999, 'en')).toBe('59.9 s');
    expect(formatDuration(65_400, 'en')).toBe('1 min 5 s');
    expect(formatDuration(3240, 'not a language!')).toBe('3.2 s');
  });
});

describe('message footer', () => {
  it('zero config: no footer', async () => {
    await answered({});
    expect(footer()).toBeNull();
    const plain = document.querySelector('[data-component="message-list"]')!.innerHTML;
    cleanup();
    await answered({ messageFooter: false });
    expect(document.querySelector('[data-component="message-list"]')!.innerHTML).toBe(plain);
  });

  it('copy writes the answer and announces it', async () => {
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: vi.fn() }, configurable: true });
    await answered({ messageFooter: true }, '**Hi** [Docs](https://example.com/a)');
    const copy = button('copy')!;
    expect(copy.textContent).toBe('Copy');
    expect(copy.querySelector('[aria-live="polite"]')).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await act(async () => { fireEvent.click(copy); });
    expect(write).toHaveBeenCalledTimes(1);
    const [[item]] = write.mock.calls[0] as unknown as [[FakeClipboardItem]];
    expect(await item.items['text/plain']!.text()).toBe('Hi Docs');
    expect(await item.items['text/html']!.text()).toContain('href="https://example.com/a"');
    expect(copy.textContent).toBe('Copied');
    expect(copy.getAttribute('data-state')).toBe('copied');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(copy.textContent).toBe('Copy');
  });

  it('copy failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await answered({ messageFooter: true });
    const copy = button('copy')!;
    await act(async () => { fireEvent.click(copy); });
    await waitFor(() => expect(copy.textContent).toBe('Copy failed'));
    expect(copy.getAttribute('data-state')).toBe('failed');
  });

  it('sources toggle', async () => {
    await answered({ messageFooter: true });
    const toggle = button('sources')!;
    expect(toggle.textContent).toBe('2 sources');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(list.getAttribute('data-element')).toBe('sources');
    expect(list.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    const links = [...list.querySelectorAll('a')];
    expect(links.map((link) => [link.getAttribute('href'), link.target, link.rel])).toEqual([
      ['https://example.com/a', '_blank', 'noopener noreferrer'],
      ['https://www.example.org/b', '_blank', 'noopener noreferrer'],
    ]);
    expect(links.map((link) => link.querySelector('[data-element="source-domain"]')!.textContent)).toEqual(['example.com', 'example.org']);
  });

  it('one source, and none for unsafe links', async () => {
    await answered({ messageFooter: true }, 'See [Docs](https://example.com/a).');
    expect(button('sources')!.textContent).toBe('1 source');
    cleanup();
    await answered({ messageFooter: true }, 'See [x](javascript:alert(1)) and [y](http://example.com).');
    expect(button('sources')).toBeNull();
    expect(document.querySelector('[data-component="message-footer"] a[href^="javascript"], [data-component="message-footer"] a[href^="http:"]')).toBeNull();
  });

  it('duration on the last answer of a completed turn', async () => {
    await answered({ messageFooter: true });
    expect(document.querySelector('[data-element="duration"]')!.textContent).toBe('Done in 3.2 s');
    cleanup();
    await answered({ messageFooter: true, language: 'de' });
    expect(document.querySelector('[data-element="duration"]')!.textContent).toBe('Fertig in 3,2 s');
  });

  it('no duration for a stopped turn or an outcome without durationMs', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ messageFooter: true }} />);
    await act(async () => { ctx.send('question'); });
    act(() => chat.stream([text('Partial answer')]));
    elapse(1000);
    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(footer()?.getAttribute('data-state')).toBe('done'));
    expect(document.querySelector('[data-element="duration"]')).toBeNull();
    cleanup();
    const stored = new StreamingChat();
    stored.messages = [
      { id: 'u1', role: 'user', parts: [text('q')] },
      { id: 'a1', role: 'assistant', parts: [text('answer')] },
    ] as typeof stored.messages;
    render(<Host chat={stored} config={{ messageFooter: true }} />);
    await waitFor(() => expect(footer()).not.toBeNull());
    expect(document.querySelector('[data-element="duration"]')).toBeNull();
  });

  it('only the last answer of a turn shows the duration', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ messageFooter: true }} />);
    await act(async () => { ctx.send('question'); });
    elapse(500);
    act(() => chat.finish([text('first')]));
    // A second assistant message in the same turn (held apart, e.g. by a hidden part between them).
    chat.messages = [...chat.messages, { id: 'a-late', role: 'assistant', parts: [text('second')] }];
    await act(async () => { chat.setMessages(chat.messages); });
    const bubbles = [...document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')];
    const durations = bubbles.map((bubble) => bubble.querySelector('[data-element="duration"]')?.textContent ?? null);
    expect(durations.at(-1)).toBe('Done in 0.5 s');
    expect(durations.slice(0, -1).every((value) => value === null)).toBe(true);
  });

  it('running answer shows elapsed and stop', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ messageFooter: true }} />);
    await act(async () => { ctx.send('question'); });
    act(() => chat.stream([text('Hel')]));
    expect(footer()?.getAttribute('data-state')).toBe('running');
    elapse(1500);
    await waitFor(() => expect(document.querySelector('[data-element="elapsed"]')!.textContent).toBe('1.5 s'));
    expect(document.querySelector('[data-element="elapsed"]')!.getAttribute('aria-hidden')).toBe('true');
    expect(button('copy')).toBeNull();
    const stopButton = button('stop')!;
    expect(stopButton.textContent).toBe('Stop');
    expect(stopButton.type).toBe('button');
    await act(async () => { fireEvent.click(stopButton); });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(footer()?.getAttribute('data-state')).toBe('done'));
    expect(document.querySelector('[data-element="elapsed"]')).toBeNull();
  });

  it('the running footer becomes the done footer after finish', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ messageFooter: true }} />);
    await act(async () => { ctx.send('question'); });
    act(() => chat.stream([text('Hel')]));
    expect(footer()?.getAttribute('data-state')).toBe('running');
    act(() => chat.finish([text('Hello')]));
    expect(footer()?.getAttribute('data-state')).toBe('done');
    expect(document.querySelectorAll('[data-component="message-footer"]')).toHaveLength(1);
  });

  it('parts can be switched off', async () => {
    await answered({ messageFooter: { copy: false, stop: false } });
    expect(button('copy')).toBeNull();
    expect(button('sources')).not.toBeNull();
    expect(document.querySelector('[data-element="duration"]')).not.toBeNull();
    cleanup();
    await answered({ messageFooter: { copy: false, sources: false, duration: false, stop: false } });
    expect(footer()).toBeNull();
  });

  it('user messages never get a footer', async () => {
    await answered({ messageFooter: true });
    expect(document.querySelector('[data-role="user"] [data-component="message-footer"]')).toBeNull();
    expect(document.querySelectorAll('[data-component="message-footer"]')).toHaveLength(1);
  });

  it('MessageParts receives footer', async () => {
    const seen: MessagePartsProps[] = [];
    function WithChildren(props: MessagePartsProps) {
      seen.push(props);
      return <section data-testid="arranged">{props.children}</section>;
    }
    await answered({ messageFooter: true, components: { MessageParts: WithChildren } });
    expect(document.querySelector('[data-testid="arranged"] [data-component="message-footer"]')).not.toBeNull();
    cleanup();
    seen.length = 0;
    function TextOnly(props: MessagePartsProps) {
      seen.push(props);
      return <section data-testid="text-only">{props.text}</section>;
    }
    await answered({ messageFooter: true, components: { MessageParts: TextOnly } });
    expect(footer()).toBeNull();
    const assistant = seen.filter((props) => props.message.role === 'assistant').at(-1)!;
    expect(assistant.footer).not.toBeNull();
    expect(assistant.footer).toBeDefined();
  });

  it('German texts', async () => {
    await answered({ messageFooter: true, language: 'de' });
    expect(screen.getByRole('button', { name: 'Kopieren' })).toBeTruthy();
    expect(button('sources')!.textContent).toBe('2 Quellen');
  });
});
