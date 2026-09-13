// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RichMentionInput } from '../../components/rich-mention-input.js';
import type { MentionData, RichMentionInputHandle } from '../../types.js';

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
