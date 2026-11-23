/**
 * Copy content of a rendered answer (the message footer's copy button): rich
 * HTML with inline styles that pastes well into Word or Outlook, and plain
 * text. Only semantic content of the rendered Markdown is exported, never chat
 * chrome, event handlers, app classes or theme styles. Internal.
 */

const ALLOWED = new Set([
  'P', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'BR', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A',
]);
const DROPPED = new Set(['SVG', 'SCRIPT', 'STYLE', 'BUTTON', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'VIDEO', 'AUDIO']);
const STYLES: Record<string, string> = {
  P: 'margin:0 0 10px;',
  H1: 'font-size:20pt;font-weight:600;margin:16px 0 8px;',
  H2: 'font-size:16pt;font-weight:600;margin:14px 0 8px;',
  H3: 'font-size:13pt;font-weight:600;margin:12px 0 6px;',
  H4: 'font-size:11pt;font-weight:600;margin:12px 0 6px;',
  UL: 'margin:0 0 10px;padding-left:24px;',
  OL: 'margin:0 0 10px;padding-left:24px;',
  LI: 'margin:0 0 4px;',
  BLOCKQUOTE: 'margin:8px 0;padding-left:12px;border-left:3px solid #cccccc;',
  PRE: 'margin:8px 0;padding:10px;background-color:#f3f4f6;color:#111111;white-space:pre-wrap;font-family:Consolas,monospace;font-size:10pt;',
  CODE: 'font-family:Consolas,monospace;font-size:10pt;',
  TABLE: 'border-collapse:collapse;margin:10px 0;font-size:11pt;',
  TH: 'border:1px solid #cccccc;padding:6px 10px;text-align:left;background-color:#f3f4f6;color:#111111;font-weight:600;',
  TD: 'border:1px solid #cccccc;padding:6px 10px;text-align:left;',
  A: 'color:#1f6feb;text-decoration:underline;',
};
const ROOT_STYLE = "font-family:'Segoe UI',Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;";
const LINK_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'UL', 'OL']);
/** The rendered text blocks of an answer: Markdown, and text with mention chips outside Markdown. */
const BLOCKS = '[data-component="markdown"], [data-component="message-rich-text"]';

function exportNode(node: Node, target: HTMLElement, doc: Document): void {
  if (node.nodeType === 3) {
    target.append(doc.createTextNode(node.textContent ?? ''));
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  // A mention chip is a button here: its visible name is kept as text.
  if (element.getAttribute('data-component') === 'mention-chip') {
    const name = element.querySelector('[data-element="display-name"]') ?? element;
    target.append(doc.createTextNode(name.textContent ?? ''));
    return;
  }
  if (DROPPED.has(tag)) return;
  // Markdown still loading: its source text, as the bubble showed before the skeleton.
  if (element.getAttribute('data-element') === 'markdown-skeleton') {
    target.append(doc.createTextNode(element.getAttribute('data-markdown-source') ?? ''));
    return;
  }
  if (tag === 'INPUT') {
    if (element.getAttribute('type') === 'checkbox') {
      target.append(doc.createTextNode((element as HTMLInputElement).checked ? '☑ ' : '☐ '));
    }
    return;
  }
  if (!ALLOWED.has(tag)) {
    element.childNodes.forEach((child) => exportNode(child, target, doc));
    return;
  }
  const copy = doc.createElement(tag.toLowerCase());
  const style = STYLES[tag];
  if (style) copy.setAttribute('style', style);
  if (tag === 'A') {
    try {
      const href = new URL(element.getAttribute('href') ?? '', doc.baseURI);
      if (LINK_PROTOCOLS.has(href.protocol)) copy.setAttribute('href', href.href);
    } catch {
      // The visible label stays when a link cannot be exported.
    }
  }
  if (tag === 'OL' && /^\d+$/.test(element.getAttribute('start') ?? '')) {
    copy.setAttribute('start', element.getAttribute('start')!);
  }
  if (tag === 'TD' || tag === 'TH') {
    for (const attribute of ['colspan', 'rowspan']) {
      const value = element.getAttribute(attribute);
      if (value && /^\d+$/.test(value)) copy.setAttribute(attribute, value);
    }
  }
  element.childNodes.forEach((child) => exportNode(child, copy, doc));
  target.append(copy);
}

function plainText(node: Node, depth = 0): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  const list = tag === 'UL' || tag === 'OL';
  const contents = [...element.childNodes].map((child) => plainText(child, depth + (list ? 1 : 0))).join('');
  if (tag === 'BR') return '\n';
  if (tag === 'HR') return '\n\n';
  if (list && element.parentElement?.tagName.toUpperCase() === 'LI') return `\n${contents.trimEnd()}\n`;
  if (tag === 'LI') {
    const parent = element.parentElement;
    const number = parent?.tagName.toUpperCase() === 'OL'
      ? Number(parent.getAttribute('start') ?? 1) + [...parent.children].indexOf(element)
      : null;
    return `${'  '.repeat(Math.max(0, depth - 1))}${number === null ? '•' : `${number}.`} ${contents.trim()}\n`;
  }
  if (tag === 'TD' || tag === 'TH') return `${contents.trim()}\t`;
  if (tag === 'TR') return `${contents.trimEnd()}\n`;
  if (BLOCK_TAGS.has(tag)) return `${contents.trimEnd()}\n\n`;
  return contents;
}

/**
 * Rich HTML (allowlisted tags, inline styles) and plain text of the rendered
 * Markdown blocks inside `root`; `fallback` when none renders text.
 */
export function messageClipboardContent(root: Element | null, fallback: string): { html: string; text: string } {
  const doc = root?.ownerDocument ?? (typeof document === 'undefined' ? null : document);
  if (!doc) return { html: '', text: fallback };
  const output = doc.createElement('div');
  output.setAttribute('style', ROOT_STYLE);
  for (const block of root ? root.querySelectorAll(BLOCKS) : []) {
    // One block per rendered text, so two texts never run together.
    const holder = doc.createElement('div');
    block.childNodes.forEach((child) => exportNode(child, holder, doc));
    output.append(holder);
  }
  if (!output.textContent?.trim()) output.textContent = fallback;
  return {
    html: output.outerHTML,
    text: plainText(output).replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * Writes both flavors (`ClipboardItem`), else plain text (`writeText`).
 * Rejects when neither works; never logs.
 */
export async function copyMessageToClipboard(root: Element | null, fallback: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) throw new Error('Clipboard unavailable');
  const content = messageClipboardContent(root, fallback);
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (content.html && typeof Item === 'function' && typeof clipboard.write === 'function') {
    try {
      await clipboard.write([new Item({
        'text/html': new Blob([content.html], { type: 'text/html' }),
        'text/plain': new Blob([content.text], { type: 'text/plain' }),
      })]);
      return;
    } catch {
      // Some browsers allow text-only clipboard access.
    }
  }
  if (typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
  await clipboard.writeText(content.text);
}
