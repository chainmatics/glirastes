import { describe, expect, it } from 'vitest';
import { fillTemplate } from '../fill-template.js';

describe('fillTemplate', () => {
  it('inserts untrusted values literally: no replacement patterns, no second fill', () => {
    expect(fillTemplate('{label} {id} could not be checked.', { label: 'Playlist', id: "$& $' $` $$ {label}" }))
      .toBe("Playlist $& $' $` $$ {label} could not be checked.");
    expect(fillTemplate('Open {name}', { name: '$1{name}' })).toBe('Open $1{name}');
  });

  it('leaves an unknown placeholder as written and fills every occurrence', () => {
    expect(fillTemplate('{a} {b} {a}', { a: 'x' })).toBe('x {b} x');
  });
});
