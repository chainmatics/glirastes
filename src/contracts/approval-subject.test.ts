import { describe, expect, it } from 'vitest';
import {
  assertApprovalSubjectDeclarations,
  entityLookupIssue,
  fieldArgsOf,
  lookupEffectAllowed,
  sanitizeSubjectText,
} from './approval-subject.js';

const cp = (...points: number[]) => String.fromCodePoint(...points);

describe('sanitizeSubjectText', () => {
  it('removes invisible and format characters: controls, bidi, zero-width, separators, tags, fillers, variation selectors', () => {
    for (const point of [0x0000, 0x001b, 0x009b, 0x061c, 0x200b, 0x200e, 0x2028, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069,
      0x00ad, 0x180e, 0xfe00, 0xfe0f, 0xfeff, 0xe0000, 0xe0041, 0xe007f, 0x115f, 0x3164]) {
      expect(sanitizeSubjectText(`a${cp(point)}b`), point.toString(16)).toBe('a b');
    }
  });

  it('keeps combining marks, which many languages need', () => {
    const composed = `Cafe${cp(0x0301)} ${cp(0x0915, 0x093f)}`;
    expect(sanitizeSubjectText(composed)).toBe(composed);
  });

  it('cuts at 200 characters and drops what is left empty', () => {
    expect(Array.from(sanitizeSubjectText('x'.repeat(500))!)).toHaveLength(200);
    expect(sanitizeSubjectText(cp(0x200b, 0xfeff))).toBeUndefined();
  });
});

describe('declaration checks', () => {
  it('refuses parameter names of the prototype machinery', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(entityLookupIssue({ type: 'playlist', params: { [name]: 'id' } })).toMatch(/not a name/);
      expect(entityLookupIssue(JSON.parse(`{"type":"playlist","params":{},"const":{"${name}":1}}`))).toMatch(/not a name/);
    }
    expect(entityLookupIssue({ type: 'playlist', params: { constructor_id: 'id' } })).toBeUndefined();
  });

  it('accepts idCase exact or ignore-case only', () => {
    expect(entityLookupIssue({ type: 'channel', params: {}, idCase: 'ignore-case' })).toBeUndefined();
    expect(entityLookupIssue({ type: 'channel', params: {}, idCase: 'lower' })).toMatch(/idCase/);
  });

  it('allows lookupEffect read on a POST (and GET, HEAD, no method), never on DELETE, PUT or PATCH', () => {
    for (const method of ['POST', 'GET', 'HEAD', undefined]) expect(lookupEffectAllowed(method)).toBe(true);
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      expect(lookupEffectAllowed(method)).toBe(false);
      expect(() => assertApprovalSubjectDeclarations({ lookupEffect: 'read', method }, 't')).toThrow(/only allowed on a POST/);
    }
  });

  it('maps composite arguments by name, in declared order without names, never in between', () => {
    expect(fieldArgsOf(['version_id', 'playlist_id'], ['playlist_id', 'version_id'])).toEqual(['playlist_id', 'version_id']);
    expect(fieldArgsOf(['a.version_id', 'b.playlist_id'], ['playlist_id', 'version_id'])).toEqual(['b.playlist_id', 'a.version_id']);
    expect(fieldArgsOf(['pid', 'vid'], ['playlist_id', 'version_id'])).toEqual(['pid', 'vid']);
    expect(fieldArgsOf(['version_id', 'pid'], ['playlist_id', 'version_id'])).toBeUndefined();
    expect(fieldArgsOf(['id'], ['playlist_id'])).toEqual(['id']);
  });
});
