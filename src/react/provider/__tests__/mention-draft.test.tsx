// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RichMentionInput } from '../../components/rich-mention-input.js';
import type { MentionData, RichMentionInputHandle } from '../../types.js';
import { mentionDataFromResult, serializeMentionsForSend } from '../../utils/mention-markup.js';

describe('structured mention draft restoration', () => {
  afterEach(cleanup);
  it('restores text and ordered mention identities without markup injection or duplicate tokens', () => {
    const ref = createRef<RichMentionInputHandle>();
    const { container } = render(<RichMentionInput ref={ref} onSearch={async () => []} />);
    const mentions: MentionData[] = [
      { id: 'alice', type: 'user', label: 'Alice', prefix: '@', slug: 'alice' },
      { id: 'task-42', type: 'task', label: '<b>Task</b>', prefix: '/', slug: 'task-42' },
    ];
    act(() => ref.current!.setValue('Bitte @alice für /task-42 vormerken', mentions));
    expect(ref.current!.getValue()).toBe('Bitte @alice für /task-42 vormerken');
    expect(ref.current!.getMentions().map((entry) => entry.id)).toEqual(['alice', 'task-42']);
    expect(container.querySelectorAll('[data-mention-id][data-mention-type]')).toHaveLength(2);
    expect(container.querySelector('b')).toBeNull();
  });

  it('uses distinct saved identities for repeated identical visible tokens', () => {
    const ref = createRef<RichMentionInputHandle>();
    render(<RichMentionInput ref={ref} onSearch={async () => []} />);
    act(() => ref.current!.setValue('@alex fragt @alex', [
      { id: 'first', type: 'user', label: 'Alex', prefix: '@', slug: 'alex' },
      { id: 'second', type: 'user', label: 'Alex', prefix: '@', slug: 'alex' },
    ]));
    expect(ref.current!.getMentions().map((entry) => entry.id)).toEqual(['first', 'second']);
    expect(ref.current!.getValue()).toBe('@alex fragt @alex');
    act(() => ref.current!.setValue('plain text'));
    expect(ref.current!.getMentions()).toEqual([]);
  });
});

describe('tool references of commands across draft restores', () => {
  afterEach(cleanup);

  const token = { prefix: '/', slug: 'administration-offnen' };
  // What picking a tool-backed command from the `/` list leaves in the composer state.
  const picked = (): MentionData => mentionDataFromResult({
    id: 'ui.navigate.admin',
    type: 'command',
    label: 'Administration öffnen',
    definitionId: 'ui.navigate',
    args: { destination: 'admin' },
  }, token);
  const REFERENCE = 'tool: ui.navigate, args: {"destination":"admin"}';

  function mount() {
    const ref = createRef<RichMentionInputHandle>();
    const view = render(<RichMentionInput ref={ref} onSearch={async () => []} />);
    return { ref, container: view.container };
  }

  it('keeps the definition id and arguments in the chip read back from the editor', () => {
    const { ref } = mount();
    act(() => ref.current!.setValue('Bitte /administration-offnen jetzt', [picked()]));
    expect(ref.current!.getMentions()).toEqual([
      expect.objectContaining({
        id: 'ui.navigate.admin',
        type: 'command',
        slug: 'administration-offnen',
        definitionId: 'ui.navigate',
        args: { destination: 'admin' },
      }),
    ]);
  });

  it('adds no tool reference to chips that never had one', () => {
    const { ref, container } = mount();
    act(() => ref.current!.setValue('@alice', [
      { id: 'alice', type: 'user', label: 'Alice', prefix: '@', slug: 'alice' },
    ]));
    const [entry] = ref.current!.getMentions();
    expect(entry).toBeDefined();
    expect('definitionId' in entry!).toBe(false);
    expect('args' in entry!).toBe(false);
    const chip = container.querySelector<HTMLElement>('[data-component="mention-chip"]')!;
    expect(chip.dataset.mentionDefinitionId).toBeUndefined();
    expect(chip.dataset.mentionArgs).toBeUndefined();
  });

  it('keeps a definition id without arguments', () => {
    const { ref } = mount();
    act(() => ref.current!.setValue('/administration-offnen', [
      { ...picked(), args: undefined },
    ]));
    const [entry] = ref.current!.getMentions();
    expect(entry).toMatchObject({ definitionId: 'ui.navigate' });
    expect('args' in entry!).toBe(false);
  });

  it('keeps the reference over two dictations of the same draft', () => {
    const { ref } = mount();
    const state = picked();
    // First dictation: the composer hands the picked command back as the only draft entry.
    act(() => ref.current!.setValue('/administration-offnen und dann', [state]));
    // Second dictation: the composer now reads the chip from the DOM and the state entry.
    const second = [...ref.current!.getMentions(), state];
    expect(second).toHaveLength(2);
    act(() => ref.current!.setValue('/administration-offnen und dann noch mehr', second));
    // Third: whichever of the two entries was restored has to carry the reference too.
    const third = [...ref.current!.getMentions(), state];
    act(() => ref.current!.setValue('/administration-offnen und dann noch mehr Text', third));

    const sent = serializeMentionsForSend(ref.current!.getValue(), ref.current!.getMentions());
    expect(sent).toContain(REFERENCE);
    expect(sent).toContain('{{mention:command:ui.navigate.admin:Administration öffnen}}');
  });

  it('keeps the reference when the entry read from the editor comes first and the state entry second', () => {
    const { ref } = mount();
    const state = picked();
    act(() => ref.current!.setValue('/administration-offnen', [state]));
    const chipEntry = ref.current!.getMentions()[0]!;
    act(() => ref.current!.setValue('/administration-offnen weiter', [chipEntry, state]));
    expect(ref.current!.getMentions()).toEqual([
      expect.objectContaining({ definitionId: 'ui.navigate', args: { destination: 'admin' } }),
    ]);
  });

  it('ignores a tool reference in the chip that cannot be sent to the model', () => {
    const { ref, container } = mount();
    act(() => ref.current!.setValue('/administration-offnen', [picked()]));
    const chip = container.querySelector<HTMLElement>('[data-component="mention-chip"]')!;
    const tamper = (definitionId: string, args?: string) => {
      chip.dataset.mentionDefinitionId = definitionId;
      if (args === undefined) delete chip.dataset.mentionArgs;
      else chip.dataset.mentionArgs = args;
      const [entry] = ref.current!.getMentions();
      return entry!;
    };
    // A reference that can be sent is read back as it is written.
    expect(tamper('ui.navigate', '{"destination":"other"}')).toMatchObject({
      definitionId: 'ui.navigate',
      args: { destination: 'other' },
    });
    for (const [definitionId, args] of [
      ['ui.navigate', '{not json'],
      ['ui.navigate', '["admin"]'],
      ['ui.navigate', 'null'],
      ['ui.navigate', '"admin"'],
      ['ui navigate', '{"destination":"admin"}'],
      ['', undefined],
    ] as const) {
      const entry = tamper(definitionId, args);
      expect(entry.id).toBe('ui.navigate.admin');
      expect('definitionId' in entry).toBe(false);
      expect('args' in entry).toBe(false);
    }
  });

  it('does not put a reference into the chip that the model could not be given', () => {
    const { ref, container } = mount();
    act(() => ref.current!.setValue('/administration-offnen', [
      { ...picked(), args: ['admin'] },
    ]));
    const chip = container.querySelector<HTMLElement>('[data-component="mention-chip"]')!;
    expect(chip.dataset.mentionDefinitionId).toBeUndefined();
    expect(chip.dataset.mentionArgs).toBeUndefined();
    const [entry] = ref.current!.getMentions();
    expect('definitionId' in entry!).toBe(false);
  });
});
