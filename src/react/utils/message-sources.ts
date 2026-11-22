/** One external link an assistant message cites (the message footer's sources). */
export interface MessageSource {
  href: string;
  label: string;
  domain: string;
}

const MAX_SOURCES = 20;
const MAX_LABEL = 160;

// A fence runs to its closing fence, or to the end of the text when unclosed (`(?![\s\S])`: not `$`, which
// the `m` flag lets match at every line end).
const FENCED_CODE = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)??(?:\n[ \t]{0,3}\1[`~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
const DEFINITION = /^[ ]{0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/gm;
// `[label](url "title")` or `[label][id]` / `[label][]`; an image (`![…]`) is not a source.
const LINK = /(!?)\[([^\]\n]*)\](?:\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)|\[([^\]\n]*)\])/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The URL when it is https without credentials, else null. */
function safeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  return url;
}

function normalizeId(id: string): string {
  return id.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Markdown links of one text in text order, code removed first: `[label, url]`. */
function markdownLinks(text: string): Array<[string, string]> {
  const plain = text.replace(FENCED_CODE, '').replace(INLINE_CODE, '');
  const definitions = new Map<string, string>();
  const body = plain.replace(DEFINITION, (_match, id: string, url: string) => {
    const key = normalizeId(id);
    if (!definitions.has(key)) definitions.set(key, url);
    return '';
  });
  const links: Array<[string, string]> = [];
  for (const match of body.matchAll(LINK)) {
    const [, image, label = '', inlineUrl, refId] = match;
    if (image) continue;
    if (inlineUrl !== undefined) {
      links.push([label, inlineUrl]);
      continue;
    }
    const url = definitions.get(normalizeId(refId ? refId : label));
    if (url) links.push([label, url]);
  }
  return links;
}

/** `sources` / `citations` entries of a tool output (or its `data`): `[title, url]`. */
function toolSourceEntries(output: unknown): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const holder of [output, isRecord(output) ? output.data : undefined]) {
    if (!isRecord(holder)) continue;
    for (const key of ['sources', 'citations']) {
      const list = holder[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry === 'string') entries.push(['', entry]);
        else if (isRecord(entry)) {
          const url = typeof entry.url === 'string' ? entry.url : typeof entry.href === 'string' ? entry.href : null;
          if (url) entries.push([typeof entry.title === 'string' ? entry.title : '', url]);
        }
      }
    }
  }
  return entries;
}

function isToolPart(part: Record<string, unknown>): boolean {
  const type = typeof part.type === 'string' ? part.type : '';
  return type === 'dynamic-tool' || type.startsWith('tool-');
}

/**
 * Safe external links an assistant message cites, in first-seen order,
 * deduplicated by href, at most 20: its Markdown links (inline and
 * reference), AI SDK `source-url` parts, then the `sources` / `citations` of
 * its tool outputs. Only https links without credentials.
 */
export function readMessageSources(parts: ReadonlyArray<unknown>): MessageSource[] {
  const candidates: Array<[string, string]> = [];
  for (const part of parts) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') candidates.push(...markdownLinks(part.text));
  }
  for (const part of parts) {
    if (isRecord(part) && part.type === 'source-url' && typeof part.url === 'string') {
      candidates.push([typeof part.title === 'string' ? part.title : '', part.url]);
    }
  }
  for (const part of parts) {
    if (!isRecord(part) || !isToolPart(part)) continue;
    candidates.push(...toolSourceEntries(part.output ?? part.result));
  }
  const seen = new Set<string>();
  const sources: MessageSource[] = [];
  for (const [rawLabel, rawUrl] of candidates) {
    if (sources.length >= MAX_SOURCES) break;
    const url = safeUrl(rawUrl);
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    const domain = url.hostname.replace(/^www\./i, '');
    const label = rawLabel.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL) || domain;
    sources.push({ href: url.href, label, domain });
  }
  return sources;
}
