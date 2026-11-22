// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyMessageToClipboard, messageClipboardContent } from '../copy-message.js';

function root(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}

const ANSWER = '<div data-component="markdown"><p>Hi <a href="https://e.com" onclick="x">E</a></p>'
  + '<ul><li>a</li><li>b</li></ul><table><tr><th>K</th><td>V</td></tr></table></div>';

describe('messageClipboardContent', () => {
  it('lists, tables and links become styled html and readable text', () => {
    const { html, text } = messageClipboardContent(root(ANSWER), 'fallback');
    expect(html).toContain('<a style="color:#1f6feb;text-decoration:underline;" href="https://e.com/">E</a>');
    expect(html).not.toContain('onclick');
    expect(html.startsWith('<div style="font-family:\'Segoe UI\',Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;">')).toBe(true);
    expect(text).toBe('Hi E\n\n• a\n• b\n\nK\tV');
  });

  it('ordered and nested lists keep their numbers and indent', () => {
    const { text, html } = messageClipboardContent(root(
      '<div data-component="markdown"><ol start="3"><li>x<ul><li>y</li></ul></li><li>z</li></ol></div>',
    ), '');
    expect(html).toContain('<ol style="margin:0 0 10px;padding-left:24px;" start="3">');
    expect(text).toBe('3. x\n  • y\n4. z');
  });

  it('javascript links keep only their label', () => {
    const { html, text } = messageClipboardContent(root(
      '<div data-component="markdown"><p><a href="javascript:alert(1)">Click</a></p></div>',
    ), '');
    expect(html).not.toContain('javascript');
    expect(html).toContain('>Click</a>');
    expect(text).toBe('Click');
  });

  it('a mention chip keeps its name', () => {
    const { text, html } = messageClipboardContent(root(
      '<div data-component="markdown"><p>See <span data-component="mention-chip"><span data-element="icon"></span>'
      + '<button type="button"><span data-element="display-name"><span data-element="prefix">@</span>Bug 7</span></button>'
      + '</span> now</p></div>',
    ), '');
    expect(text).toBe('See @Bug 7 now');
    expect(html).not.toContain('button');
  });

  it('mention text outside Markdown is copied too', () => {
    const { text } = messageClipboardContent(root(
      '<div data-component="message-rich-text"><span>Open </span><span data-component="mention-chip">'
      + '<span data-element="display-name"><span data-element="prefix">#</span>T-1</span></span></div>'
      + '<div data-component="markdown"><p>Second</p></div>',
    ), '');
    expect(text).toBe('Open #T-1\n\nSecond');
  });

  it('other buttons and svgs are dropped', () => {
    const { html, text } = messageClipboardContent(root(
      '<div data-component="markdown"><p>A<button>Copy</button><svg><text>x</text></svg><script>bad()</script><style>p{}</style></p>'
      + '<p><input type="checkbox" checked> done <input type="checkbox"> open</p></div>',
    ), '');
    expect(text).toBe('A\n\n☑  done ☐  open');
    expect(html).not.toMatch(/button|svg|script|style>|bad\(\)/);
  });

  it('fallback without markdown blocks', () => {
    const content = messageClipboardContent(root('<p>chrome</p>'), 'plain');
    expect(content.text).toBe('plain');
    expect(content.html).toContain('plain');
    expect(messageClipboardContent(null, 'only').text).toBe('only');
  });

  it('the fallback text is escaped in the html', () => {
    expect(messageClipboardContent(null, '<b>x</b>').html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('copyMessageToClipboard', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  class FakeClipboardItem {
    constructor(public items: Record<string, Blob>) {}
  }

  function stubClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  }

  beforeEach(() => {
    consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((name) => vi.spyOn(console, name));
  });
  afterEach(() => {
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalItem;
  });

  it('rich write first', async () => {
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    stubClipboard({ write, writeText });
    await copyMessageToClipboard(root(ANSWER), 'x');
    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0] as unknown as [FakeClipboardItem[]];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!.items).sort()).toEqual(['text/html', 'text/plain']);
    expect(await items[0]!.items['text/plain']!.text()).toBe('Hi E\n\n• a\n• b\n\nK\tV');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('then the text fallback when the rich write is refused', async () => {
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = FakeClipboardItem;
    const write = vi.fn(async () => { throw new Error('denied'); });
    const writeText = vi.fn(async () => {});
    stubClipboard({ write, writeText });
    await copyMessageToClipboard(root(ANSWER), 'x');
    expect(writeText).toHaveBeenCalledWith('Hi E\n\n• a\n• b\n\nK\tV');
  });

  it('text only without ClipboardItem', async () => {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    const write = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    stubClipboard({ write, writeText });
    await copyMessageToClipboard(null, 'plain answer');
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('plain answer');
  });

  it('rejects without a clipboard, and when the text write fails', async () => {
    stubClipboard(undefined);
    await expect(copyMessageToClipboard(root(ANSWER), 'x')).rejects.toBeInstanceOf(Error);
    stubClipboard({ writeText: vi.fn(async () => { throw new Error('denied'); }) });
    await expect(copyMessageToClipboard(root(ANSWER), 'x')).rejects.toBeInstanceOf(Error);
  });
});
