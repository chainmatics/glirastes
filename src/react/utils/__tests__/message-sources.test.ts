import { describe, expect, it } from 'vitest';
import { readMessageSources } from '../message-sources.js';

const text = (value: string) => ({ type: 'text', text: value });

describe('readMessageSources', () => {
  it('inline and reference links in order', () => {
    expect(readMessageSources([text('See [Docs](https://example.com/a) and [b][1].\n\n[1]: https://www.example.org/b')])).toEqual([
      { href: 'https://example.com/a', label: 'Docs', domain: 'example.com' },
      { href: 'https://www.example.org/b', label: 'b', domain: 'example.org' },
    ]);
  });

  it('a collapsed reference and a link title', () => {
    expect(readMessageSources([text('[Guide][] and [x](https://e.com/x "The X")\n\n[guide]: <https://g.com/p> "G"')])).toEqual([
      { href: 'https://g.com/p', label: 'Guide', domain: 'g.com' },
      { href: 'https://e.com/x', label: 'x', domain: 'e.com' },
    ]);
  });

  it('unsafe links are dropped', () => {
    const links = ['javascript:alert(1)', 'data:text/html,x', 'http://example.com', 'https://u:p@example.com', '/relative', 'mailto:a@b.c', 'https://u@example.com']
      .map((url, i) => `[l${i}](${url})`).join(' ');
    expect(readMessageSources([text(links)])).toEqual([]);
  });

  it('links in code are ignored', () => {
    expect(readMessageSources([text('```\n[x](https://e.com/a)\n```\n\n`[y](https://e.com/b)` and\n~~~\n[z](https://e.com/c)\n~~~')])).toEqual([]);
  });

  it('a multi-line code block hides every line and the link after it counts', () => {
    const answer = 'Intro\n```md\nline one\n[x](https://evil.example/a)\n[y](https://evil.example/b)\n```\n[After](https://ok.example/c)';
    expect(readMessageSources([text(answer)])).toEqual([
      { href: 'https://ok.example/c', label: 'After', domain: 'ok.example' },
    ]);
  });

  it('an unclosed code block runs to the end of the text', () => {
    expect(readMessageSources([text('[Before](https://ok.example/a)\n~~~\ncode\n[x](https://evil.example/a)')])).toEqual([
      { href: 'https://ok.example/a', label: 'Before', domain: 'ok.example' },
    ]);
  });

  it('duplicates collapse and at most 20', () => {
    const links = Array.from({ length: 25 }, (_, i) => `[l${i}](https://e${i}.com/)`);
    links.splice(3, 0, '[again](https://e0.com/)');
    const sources = readMessageSources([text(links.join(' '))]);
    expect(sources).toHaveLength(20);
    expect(sources[0]).toEqual({ href: 'https://e0.com/', label: 'l0', domain: 'e0.com' });
    expect(sources.map((source) => source.label)).not.toContain('again');
    expect(sources.at(-1)?.label).toBe('l19');
  });

  it('source-url parts', () => {
    expect(readMessageSources([
      { type: 'source-url', sourceId: 's1', url: 'https://news.example.com/x', title: 'News' },
      { type: 'source-url', sourceId: 's2', url: 'https://plain.example.com/' },
      { type: 'source-url', sourceId: 's3', url: 'javascript:alert(1)' },
    ])).toEqual([
      { href: 'https://news.example.com/x', label: 'News', domain: 'news.example.com' },
      { href: 'https://plain.example.com/', label: 'plain.example.com', domain: 'plain.example.com' },
    ]);
  });

  it('tool output sources and citations', () => {
    expect(readMessageSources([
      { type: 'tool-search', toolCallId: 'c1', state: 'output-available', output: { data: { citations: ['https://a.com/x', { href: 'https://b.com', title: 'B' }] } } },
      { type: 'tool-result', toolCallId: 'c2', toolName: 'web', result: { sources: [{ url: 'https://c.com/y' }, 42, { url: 'http://d.com' }] } },
    ])).toEqual([
      { href: 'https://a.com/x', label: 'a.com', domain: 'a.com' },
      { href: 'https://b.com/', label: 'B', domain: 'b.com' },
      { href: 'https://c.com/y', label: 'c.com', domain: 'c.com' },
    ]);
  });

  it('label is capped at 160 characters', () => {
    const [source] = readMessageSources([text(`[${'a'.repeat(300)}](https://e.com)`)]);
    expect(source!.label).toHaveLength(160);
  });

  it('nothing for non-text, non-tool parts', () => {
    expect(readMessageSources([{ type: 'reasoning', text: '[x](https://e.com)' }, null, 'x'])).toEqual([]);
  });
});
