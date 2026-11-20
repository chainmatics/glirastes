import { describe, expect, it } from 'vitest';
import { resolveChatTriggers } from '../triggers.js';

describe('resolveChatTriggers', () => {
  it('keeps @ and / with today\'s defaults without any config', () => {
    expect(resolveChatTriggers(undefined, [])).toEqual([
      { char: '@', prefix: '@', select: 'chip' },
      { char: '/', prefix: '/', select: 'chip' },
    ]);
    expect(resolveChatTriggers(undefined, [{ trigger: '@' }, { trigger: '/' }])).toEqual([
      { char: '@', prefix: '@', select: 'chip' },
      { char: '/', prefix: '/', select: 'chip' },
    ]);
  });

  it('adds the char of a provider without a definition', () => {
    expect(resolveChatTriggers(undefined, [{ trigger: '#' }, { trigger: '#' }, { trigger: '@' }])).toEqual([
      { char: '@', prefix: '@', select: 'chip' },
      { char: '/', prefix: '/', select: 'chip' },
      { char: '#', prefix: '#', select: 'chip' },
    ]);
  });

  it('lets an explicit definition win over defaults and providers', () => {
    expect(resolveChatTriggers(
      [
        { char: '#', label: 'Tickets', prefix: 'T-', select: 'text' },
        { char: '@', label: 'Mention' },
      ],
      [{ trigger: '#' }],
    )).toEqual([
      { char: '@', prefix: '@', select: 'chip', label: 'Mention' },
      { char: '/', prefix: '/', select: 'chip' },
      { char: '#', prefix: 'T-', select: 'text', label: 'Tickets' },
    ]);
  });

  it('rejects a char that is not exactly one non-whitespace character', () => {
    expect(() => resolveChatTriggers([{ char: '##' }], [])).toThrow(
      'Invalid chat trigger "##": `char` must be exactly one character that is not whitespace',
    );
    expect(() => resolveChatTriggers([{ char: '' }], [])).toThrow(/Invalid chat trigger/);
    expect(() => resolveChatTriggers([{ char: ' ' }], [])).toThrow(/Invalid chat trigger/);
    expect(() => resolveChatTriggers(undefined, [{ trigger: 'ab' }])).toThrow(/Invalid chat trigger "ab"/);
  });

  it('rejects a duplicate definition, an empty prefix and an unknown select kind', () => {
    expect(() => resolveChatTriggers([{ char: '#' }, { char: '#', prefix: 'T-' }], [])).toThrow(
      'Duplicate chat trigger definition: "#"',
    );
    expect(() => resolveChatTriggers([{ char: '#', prefix: '' }], [])).toThrow(
      'Invalid chat trigger "#": `prefix` must be a non-empty string without whitespace',
    );
    expect(() => resolveChatTriggers([{ char: '#', select: 'open' as never }], [])).toThrow(
      'Invalid chat trigger "#": `select` must be one of chip, text, run, list',
    );
  });
});
