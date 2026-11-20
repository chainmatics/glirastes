import { describe, expect, it } from 'vitest';
import { createMentionPrefixLookup, normalizeTrigger, resolveChatTriggers } from '../triggers.js';

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
      'Invalid chat trigger "#": `select` must be one of chip, text, run',
    );
    expect(() => resolveChatTriggers([{ char: '#', select: 'list' as never }], [])).toThrow(/`select` must be one of/);
  });
});

describe('trigger types', () => {
  it('keeps the claimed types on the resolved trigger', () => {
    expect(resolveChatTriggers([{ char: '#', types: ['ticket', 'bug'] }], [])[2]).toEqual(
      { char: '#', prefix: '#', select: 'chip', types: ['ticket', 'bug'] },
    );
  });

  it('rejects a type claimed by two triggers and the command type', () => {
    expect(() => resolveChatTriggers([{ char: '#', types: ['ticket'] }, { char: '!', types: ['ticket'] }], [])).toThrow(
      'Duplicate chat trigger type: "ticket" is claimed by "#" and "!"',
    );
    expect(() => resolveChatTriggers([{ char: '#', types: ['command'] }], [])).toThrow(
      'Invalid chat trigger "#": `types` cannot contain `command`; commands always use `/`',
    );
    expect(() => resolveChatTriggers([{ char: '#', types: [''] }], [])).toThrow(/`types` must be a list/);
  });

  it('looks a sent mention\'s prefix up by type and falls back to @ and /', () => {
    const prefixOf = createMentionPrefixLookup([{ char: '#', types: ['ticket'] }, { char: '!', prefix: 'T-', types: ['issue'] }]);
    expect(['ticket', 'issue', 'user', 'command'].map(prefixOf)).toEqual(['#', 'T-', '@', '/']);
    expect(['ticket', 'command'].map(createMentionPrefixLookup(undefined))).toEqual(['@', '/']);
  });
});

describe('normalizeTrigger', () => {
  it('fills the defaults of a char or a definition and validates both', () => {
    expect(normalizeTrigger('#')).toEqual({ char: '#', prefix: '#', select: 'chip' });
    expect(normalizeTrigger({ char: '#', prefix: 'tag:', label: 'Tags' })).toEqual(
      { char: '#', prefix: 'tag:', select: 'chip', label: 'Tags' },
    );
    expect(() => normalizeTrigger('##')).toThrow(/Invalid chat trigger "##"/);
    expect(() => normalizeTrigger({ char: '#', prefix: '' })).toThrow(/`prefix` must be/);
  });
});
