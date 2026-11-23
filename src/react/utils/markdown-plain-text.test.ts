import { describe, expect, it } from 'vitest';
import { markdownPlaceholderShape, markdownToPlainText } from './markdown-plain-text.js';

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

  it('keeps fenced code lines as they are and drops the fences', () => {
    expect(markdownToPlainText('```ts\nconst **x** = 1;\n```\nafter')).toBe('const **x** = 1;\nafter');
  });

  it('turns a mention marker into its label', () => {
    expect(markdownToPlainText('**\u2060\u200C\u2063Live \\+ v2\u2060** ok')).toBe('Live + v2 ok');
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
