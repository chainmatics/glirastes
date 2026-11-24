import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { markdownWithMentionMarkers } from '../entity-links-react.js';
import { parseMentionSegments } from '../../utils/mention-markup.js';

// #27: a mention label in `mentionMarkers: 'markdown'` text must stay one
// plain text: no emphasis, code, link, autolink, HTML, entity or table cell
// break. Only characters that can start such a construct inside the label
// are escaped (CommonMark inline syntax plus GFM strikethrough and tables).
// GFM autolink literals (www., https://, e-mail) are not covered: remark-gfm
// finds them in the parsed text, after escapes are gone, so no escape helps.

const INVISIBLE = /[\u2060\u2063\u200B\u200C]/g;

describe('escaping of mention labels for Markdown', () => {
  const html = (label: string) => {
    const { content } = markdownWithMentionMarkers(parseMentionSegments(`| A | B |\n|---|---|\n| x {{mention:task:t_1:${label}}} | z |\n\nline {{mention:task:t_1:${label}}} end`));
    return renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>).replace(INVISIBLE, '');
  };

  it('escapes only characters that start inline Markdown in the label', () => {
    const label = (text: string) => markdownWithMentionMarkers(parseMentionSegments(`{{mention:task:t_1:${text}}}`)).content.replace(INVISIBLE, '');
    expect(label('Abstimmung - Wochenaktion (KW 3)! #1 +2 >')).toBe('Abstimmung - Wochenaktion (KW 3)! #1 +2 >');
    expect(label('a*b_c`d[e]f<g&h|i~j\\k.l:m@n')).toBe('a\\*b\\_c\\`d\\[e\\]f\\<g\\&h\\|i\\~j\\\\k.l:m@n');
  });

  it.each([
    ['emphasis', '**bold** _em_', /<(?:strong|em)>/],
    ['code', '`code`', /<code>/],
    ['link', '[l](target)', /<a /],
    ['image', '![i](i.png)', /<img /],
    ['autolink', '<tel:123>', /<a /],
    ['html', '<b>x</b>', /<b>/],
    ['strikethrough', '~~gone~~', /<del>/],
    ['entity', 'AT&amp;T', /AT&amp;T(?!amp)/],
  ])('a label never becomes %s', (_name, label, pattern) => {
    expect(html(label)).not.toMatch(pattern);
  });

  it('a | in a label stays in its table cell', () => {
    expect(html('c|d')).toMatch(/<td>x c\|d<\/td><td>z<\/td>/);
  });
});
