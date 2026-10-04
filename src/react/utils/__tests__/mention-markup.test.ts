import { describe, expect, it } from 'vitest';
import type { MentionData, MentionResult } from '../../types.js';
import {
  describeToolReference,
  mentionDataFromResult,
  serializeMentionsForSend,
  stripContextBlocks,
} from '../mention-markup.js';

const MARKER = '{{mention:command:ui.navigate.admin:Administration öffnen}}';

function command(extra: Record<string, unknown> = {}): MentionData {
  return {
    id: 'ui.navigate.admin',
    type: 'command',
    label: 'Administration öffnen',
    slug: 'administration-offnen',
    prefix: '/',
    ...extra,
  };
}

describe('describeToolReference', () => {
  it('names the definition and its fixed arguments', () => {
    expect(describeToolReference('ui.navigate')).toBe('tool: ui.navigate');
    expect(describeToolReference('ui.navigate', { destination: 'admin' }))
      .toBe('tool: ui.navigate, args: {"destination":"admin"}');
  });

  it('keeps arguments from closing the surrounding context comment', () => {
    const text = describeToolReference('ui.filter', { q: '--> <script>' });
    expect(text).toBe('tool: ui.filter, args: {"q":"--\\u003e \\u003cscript\\u003e"}');
    expect(text).not.toMatch(/[<>]/);
  });

  it.each([
    ['a definition id with spaces', 'ui navigate', undefined],
    ['a non-string definition id', 42, undefined],
    ['an over-long definition id', 'x'.repeat(201), undefined],
    ['array arguments', 'ui.navigate', ['admin']],
    ['null arguments', 'ui.navigate', null],
    ['arguments JSON cannot represent', 'ui.navigate', { big: 1n }],
    ['arguments over 2000 characters', 'ui.navigate', { text: 'x'.repeat(2_001) }],
  ])('refuses %s', (_name, definitionId, args) => {
    expect(describeToolReference(definitionId, args)).toBeUndefined();
  });
});

describe('serializeMentionsForSend with tool-backed commands', () => {
  it('tells the model which definition a command runs even without a context block option', () => {
    const sent = serializeMentionsForSend(
      '/administration-offnen',
      [command({ definitionId: 'ui.navigate', args: { destination: 'admin' } })],
    );
    expect(sent).toBe(
      '<!--context:[Referenced entities: Administration öffnen '
      + '(ID: ui.navigate.admin, tool: ui.navigate, args: {"destination":"admin"})]--> '
      + MARKER,
    );
    expect(stripContextBlocks(sent)).toBe(MARKER);
  });

  it('strips the block completely even when arguments contain a comment terminator', () => {
    const sent = serializeMentionsForSend(
      '/administration-offnen',
      [command({ definitionId: 'ui.filter', args: { q: '-->' } })],
    );
    expect(stripContextBlocks(sent)).toBe(MARKER);
  });

  it('leaves a command whose id is the definition id as the bare marker', () => {
    expect(serializeMentionsForSend('/administration-offnen', [command()])).toBe(MARKER);
  });

  it('ignores a definition reference the model cannot be given', () => {
    expect(serializeMentionsForSend(
      '/administration-offnen',
      [command({ definitionId: 'ui navigate', args: { destination: 'admin' } })],
    )).toBe(MARKER);
    expect(serializeMentionsForSend(
      '/administration-offnen',
      [command({ definitionId: 'ui.navigate', args: ['admin'] })],
    )).toBe(MARKER);
  });

  it('lists only tool-backed mentions unless the context block option is on', () => {
    const user: MentionData = {
      id: '42', type: 'user', label: 'Alice Doe', slug: 'alice-doe', prefix: '@',
    };
    const text = 'Frag @alice-doe dann /administration-offnen';
    const tool = command({ definitionId: 'ui.navigate', args: { destination: 'admin' } });
    const toolHint = '(ID: ui.navigate.admin, tool: ui.navigate, args: {"destination":"admin"})';

    expect(serializeMentionsForSend(text, [user, tool])).toBe(
      `<!--context:[Referenced entities: Administration öffnen ${toolHint}]--> `
      + `Frag {{mention:user:42:Alice Doe}} dann ${MARKER}`,
    );
    expect(serializeMentionsForSend(text, [user, tool], { includeContextBlock: true })).toBe(
      `<!--context:[Referenced entities: Alice Doe (ID: 42), Administration öffnen ${toolHint}]--> `
      + `Frag {{mention:user:42:Alice Doe}} dann ${MARKER}`,
    );
  });

  it('sends no definition reference when serialization is disabled', () => {
    expect(serializeMentionsForSend(
      '/administration-offnen',
      [command({ definitionId: 'ui.navigate', args: { destination: 'admin' } })],
      { enabled: false },
    )).toBe('/administration-offnen');
  });
});

describe('serializeMentionsForSend with two entries for one command', () => {
  // A command that was dictated into after it was picked comes back twice:
  // as a chip rebuilt from the editor DOM (dataset only: no definition id, no
  // arguments) and as the state entry that still carries them.
  const chip = command();
  const entry = command({ definitionId: 'ui.navigate', args: { destination: 'admin' } });
  const expected = '<!--context:[Referenced entities: Administration öffnen '
    + '(ID: ui.navigate.admin, tool: ui.navigate, args: {"destination":"admin"})]--> '
    + MARKER;

  it.each([
    ['the chip first', [chip, entry]],
    ['the state entry first', [entry, chip]],
  ])('keeps the tool reference when %s', (_name, mentions) => {
    expect(serializeMentionsForSend('/administration-offnen', mentions)).toBe(expected);
  });

  it('lists the command once with the option on', () => {
    expect(serializeMentionsForSend(
      '/administration-offnen',
      [chip, entry],
      { includeContextBlock: true },
    )).toBe(expected);
  });

  it('does not lend the reference to a different mention', () => {
    const other = command({ id: 'ui.filter.done', label: 'Erledigte filtern', slug: 'erledigte-filtern' });
    expect(serializeMentionsForSend('/erledigte-filtern', [other, entry]))
      .toBe('{{mention:command:ui.filter.done:Erledigte filtern}}');
  });
});

describe('mentionDataFromResult', () => {
  const picked: MentionResult = {
    id: 'ui.navigate.admin',
    key: 'ui-tools:command:ui.navigate.admin',
    type: 'command',
    label: 'Administration öffnen',
    description: 'Seite wechseln',
    definitionId: 'ui.navigate',
    args: { destination: 'admin' },
  };
  const token = { prefix: '/', slug: 'administration-offnen' };

  it('keeps the definition and arguments of a tool-backed command', () => {
    expect(mentionDataFromResult(picked, token)).toEqual({
      id: 'ui.navigate.admin',
      type: 'command',
      label: 'Administration öffnen',
      displayName: 'Administration öffnen',
      slug: 'administration-offnen',
      prefix: '/',
      definitionId: 'ui.navigate',
      args: { destination: 'admin' },
    });
  });

  it('adds no keys for a result without a tool reference', () => {
    const { definitionId: _definitionId, args: _args, ...plain } = picked;
    expect(Object.keys(mentionDataFromResult(plain, token)).sort()).toEqual(
      ['displayName', 'id', 'label', 'prefix', 'slug', 'type'],
    );
  });

  it('reaches the model through the serializer', () => {
    expect(serializeMentionsForSend('/administration-offnen', [mentionDataFromResult(picked, token)]))
      .toBe(
        '<!--context:[Referenced entities: Administration öffnen '
        + '(ID: ui.navigate.admin, tool: ui.navigate, args: {"destination":"admin"})]--> '
        + MARKER,
      );
  });
});
