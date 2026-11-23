import { describe, expect, it } from 'vitest';
import {
  INLINE_SYNTAX_LINE_LIMIT,
  markdownPlaceholderShape,
  markdownToPlainBlocks,
  markdownToPlainText,
} from './markdown-plain-text.js';

describe('markdownToPlainText', () => {
  it('removes block and inline syntax and escapes, keeps literal escaped characters', () => {
    const source = [
      '# Title #',
      '> quoted **bold**',
      '1. first',
      '* [x] done_item',
      '',
      'Use \\*stars\\* and snake_case_name, ~~old~~ [link](https://x.y) ![alt](i.png) <https://a.b>',
      '***',
      '| a \\| b | c |',
      '|:---|---:|',
    ].join('\n');
    expect(markdownToPlainText(source)).toBe([
      'Title',
      'quoted bold',
      '1. first',
      '• done_item',
      '',
      'Use *stars* and snake_case_name, old link alt https://a.b',
      'a | b · c',
    ].join('\n'));
  });

  it('keeps fenced code lines as they are, indentation included, and drops the fences', () => {
    expect(markdownToPlainText('```ts\n  const **x** = 1;\n\tif (a) \\n\n```\nafter')).toBe('  const **x** = 1;\n\tif (a) \\n\n\nafter');
  });

  it('turns a mention marker into its label', () => {
    expect(markdownToPlainText('**\u2060\u200C\u2063Live \\+ v2\u2060** ok')).toBe('Live + v2 ok');
  });

  it('leaves Private Use Area characters of the text as they are (icon fonts)', () => {
    const icons = '\uE02A \uE000 \uE05C \uFDD0 \uFDE1';
    expect(markdownToPlainText(`${icons} \\* **b**`)).toBe(`${icons} * b`);
  });

  it('keeps backslashes inside code spans', () => {
    expect(markdownToPlainText('Run `C:\\path\\*` and \\`not code\\`')).toBe('Run C:\\path\\* and `not code`');
  });

  it('keeps lines that are only - or --, drops the backslash of a hard line break', () => {
    expect(markdownToPlainText('a\n-\n--\nend\\\nnext')).toBe('a\n-\n--\nend\nnext');
  });

  it('keeps indented code as a code block', () => {
    expect(markdownToPlainBlocks('Text:\n\n    a  =  1\n      b\n\nafter')).toEqual([
      { kind: 'text', text: 'Text:' },
      { kind: 'code', text: 'a  =  1\n  b' },
      { kind: 'text', text: 'after' },
    ]);
    expect(markdownToPlainBlocks('```\n  x\n\n  y\n```')).toEqual([{ kind: 'code', text: '  x\n\n  y' }]);
  });

  it('copes with hostile inputs: unmatched delimiters stay text and the work is linear', () => {
    const n = 8_400; // under INLINE_SYNTAX_LINE_LIMIT: the syntax is removed
    expect(markdownToPlainText(' *a'.repeat(n / 3))).toBe(' a'.repeat(n / 3));
    expect(markdownToPlainText('**a '.repeat(n / 4))).toBe('a '.repeat(n / 4));
    expect(markdownToPlainText('['.repeat(n))).toBe('['.repeat(n));
    expect(markdownToPlainText('<https:'.repeat(n / 7))).toBe('<https:'.repeat(n / 7));
    expect(markdownToPlainText('`a'.repeat(n / 2))).toBe('a'.repeat(n / 2));
    expect(markdownToPlainText('`a``'.repeat(n / 4))).toContain('a');
    // A 30 KB line is past the limit: returned as it is, without running the inline passes.
    const huge = ' *a'.repeat(10_000);
    expect(markdownToPlainText(huge)).toBe(huge);
  });

  it('beyond the line limit, inline syntax is left as it is', () => {
    const long = `**b** ${'x'.repeat(INLINE_SYNTAX_LINE_LIMIT)}`;
    expect(markdownToPlainText(long)).toBe(long);
    expect(INLINE_SYNTAX_LINE_LIMIT).toBeLessThanOrEqual(20_000);
  });
});

describe('markdownPlaceholderShape', () => {
  it('derives lines and width from the text, bounded', () => {
    expect(markdownPlaceholderShape('Hi.')).toEqual({ lines: 1, chars: 3 });
    expect(markdownPlaceholderShape('')).toEqual({ lines: 1, chars: 1 });
    expect(markdownPlaceholderShape('- a\n- b\n- c')).toEqual({ lines: 3, chars: 3 });
    expect(markdownPlaceholderShape('x'.repeat(130))).toEqual({ lines: 3, chars: 60 });
    expect(markdownPlaceholderShape(Array.from({ length: 40 }, () => 'line').join('\n')).lines).toBe(8);
  });
});
