// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionDropdownItemProps, MentionResult } from '../../types.js';
import { RichMentionInput } from '../rich-mention-input.js';

const RESULTS: MentionResult[] = [
  { id: 'a', type: 'user', label: 'Anna' },
  { id: 'b', type: 'user', label: 'Bert' },
  { id: 'c', type: 'user', label: 'Cleo' },
  { id: 'd', type: 'user', label: 'Dora', actions: [{ id: 'open', label: 'Open' }, { id: 'mail', label: 'Mail' }] },
];

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

/** A real move: jsdom has no layout, so movement is read from the event coordinates. */
function move(target: Element, x: number, y: number) {
  fireEvent.pointerMove(target, { clientX: x, clientY: y, pointerType: 'mouse' });
  fireEvent.mouseMove(target, { clientX: x, clientY: y });
}

const option = (label: string) => screen.getByRole('option', { name: label });
const editorOf = () => screen.getByRole('textbox', { name: 'Edit' });
const activeId = () => editorOf().getAttribute('aria-activedescendant');
const selectedLabels = () => screen.getAllByRole('option')
  .filter((node) => node.getAttribute('aria-selected') === 'true')
  .map((node) => node.textContent);

async function open(props: Partial<React.ComponentProps<typeof RichMentionInput>> = {}) {
  const onSearch = vi.fn((query: string) => RESULTS.filter((result) => result.label.toLowerCase().includes(query)));
  const onEntityAction = vi.fn();
  render(<RichMentionInput onSearch={onSearch} onEntityAction={onEntityAction} placeholder="Edit" {...props} />);
  const editor = editorOf();
  typeInto(editor, '@');
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  return { editor, onSearch, onEntityAction };
}

describe('completion list: the active entry follows real pointer movement', () => {
  let scroll: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll as unknown as Element['scrollIntoView'];
  });
  afterEach(cleanup);

  it('makes the row under the moving pointer the active one; Enter picks it', async () => {
    const { editor } = await open();
    move(option('Anna'), 10, 10); // first event after opening only records the position
    move(option('Cleo'), 10, 60);
    expect(selectedLabels()).toEqual(['Cleo']);
    expect(activeId()).toBe(option('Cleo').id);
    expect(option('Cleo').getAttribute('data-selected')).toBe('true');
    expect(option('Anna').getAttribute('data-selected')).toBe('false');
    expect(screen.getByRole('listbox').getAttribute('data-active-source')).toBe('pointer');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="c"]')).toBeTruthy());
  });

  it('Tab picks the pointer row as well', async () => {
    const { editor } = await open();
    move(option('Anna'), 1, 1);
    move(option('Bert'), 1, 30);
    fireEvent.keyDown(editor, { key: 'Tab' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="b"]')).toBeTruthy());
  });

  it('keeps the keyboard row when the list opens under a resting pointer', async () => {
    await open();
    // Browsers fire enter/over and sometimes a move event without movement when a list appears.
    fireEvent.pointerOver(option('Cleo'), { clientX: 5, clientY: 5 });
    fireEvent.mouseEnter(option('Cleo'), { clientX: 5, clientY: 5 });
    move(option('Cleo'), 5, 5);
    expect(selectedLabels()).toEqual(['Anna']);
    expect(screen.getByRole('listbox').getAttribute('data-active-source')).toBe('keyboard');
  });

  it('keeps the keyboard row when the list scrolls or re-renders under a resting pointer', async () => {
    const { editor } = await open();
    move(option('Anna'), 3, 3);
    move(option('Bert'), 3, 30);
    expect(selectedLabels()).toEqual(['Bert']);
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(selectedLabels()).toEqual(['Dora']);
    expect(screen.getByRole('listbox').getAttribute('data-active-source')).toBe('keyboard');
    // The list scrolled under the resting pointer: now another row is below it, the coordinates are the same.
    fireEvent.mouseOver(option('Cleo'), { clientX: 3, clientY: 30 });
    move(option('Cleo'), 3, 30);
    expect(selectedLabels()).toEqual(['Dora']);
  });

  it('only records the position with the first event after the results change', async () => {
    const { editor } = await open();
    move(option('Anna'), 3, 3);
    move(option('Bert'), 3, 30);
    expect(selectedLabels()).toEqual(['Bert']);
    typeInto(editor, '@e'); // Bert, Cleo
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(selectedLabels()).toEqual(['Bert']);
    move(option('Cleo'), 7, 40);
    expect(selectedLabels()).toEqual(['Bert']);
    move(option('Cleo'), 7, 42);
    expect(selectedLabels()).toEqual(['Cleo']);
  });

  it('hands the list back to the keyboard when it scrolls under a resting pointer', async () => {
    const { editor } = await open();
    const list = () => screen.getByRole('listbox');
    move(option('Anna'), 4, 4);
    move(option('Bert'), 4, 30);
    expect(list().getAttribute('data-active-source')).toBe('pointer');
    // Wheel or trackpad scroll: another row is under the pointer now.
    fireEvent.scroll(list());
    expect(list().getAttribute('data-active-source')).toBe('keyboard');
    expect(selectedLabels()).toEqual(['Bert']);
    // Same coordinates: the pointer rests, nothing changes.
    move(option('Cleo'), 4, 30);
    expect(selectedLabels()).toEqual(['Bert']);
    expect(list().getAttribute('data-active-source')).toBe('keyboard');
    // Real movement activates the row under the pointer again.
    move(option('Cleo'), 4, 33);
    expect(selectedLabels()).toEqual(['Cleo']);
    expect(list().getAttribute('data-active-source')).toBe('pointer');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="c"]')).toBeTruthy());
  });

  it('hands the list back to the keyboard when its results change under the pointer', async () => {
    const { editor } = await open();
    move(option('Anna'), 4, 4);
    move(option('Bert'), 4, 30);
    expect(screen.getByRole('listbox').getAttribute('data-active-source')).toBe('pointer');
    typeInto(editor, '@e');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getByRole('listbox').getAttribute('data-active-source')).toBe('keyboard');
  });

  it('counts a pointer event and its integer mouse event as one position right after opening', async () => {
    await open();
    fireEvent.pointerMove(option('Cleo'), { clientX: 10.5, clientY: 30.5, pointerType: 'mouse' });
    fireEvent.mouseMove(option('Cleo'), { clientX: 10, clientY: 30 });
    expect(selectedLabels()).toEqual(['Anna']);
    expect(screen.getByRole('listbox').getAttribute('data-active-source')).toBe('keyboard');
  });

  it('keeps the keyboard row for the same pair over a resting pointer after the arrow keys', async () => {
    const { editor } = await open();
    fireEvent.pointerMove(option('Anna'), { clientX: 10.5, clientY: 2.5, pointerType: 'mouse' });
    fireEvent.mouseMove(option('Anna'), { clientX: 10, clientY: 2 });
    fireEvent.pointerMove(option('Bert'), { clientX: 10.5, clientY: 30.5, pointerType: 'mouse' });
    fireEvent.mouseMove(option('Bert'), { clientX: 10, clientY: 30 });
    expect(selectedLabels()).toEqual(['Bert']);
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(selectedLabels()).toEqual(['Dora']);
    fireEvent.pointerMove(option('Cleo'), { clientX: 10.5, clientY: 30.5, pointerType: 'mouse' });
    fireEvent.mouseMove(option('Cleo'), { clientX: 10, clientY: 30 });
    expect(selectedLabels()).toEqual(['Dora']);
  });

  it('activates once sub-pixel steps add up to a full pixel', async () => {
    await open();
    const step = (y: number) => fireEvent.pointerMove(option('Bert'), { clientX: 10, clientY: y, pointerType: 'mouse' });
    step(30);
    step(30.4);
    step(30.8);
    expect(selectedLabels()).toEqual(['Anna']);
    step(31.2);
    expect(selectedLabels()).toEqual(['Bert']);
  });

  it('still works with mouse events only (no pointer events)', async () => {
    const { editor } = await open();
    fireEvent.mouseMove(option('Anna'), { clientX: 10, clientY: 2 });
    fireEvent.mouseMove(option('Cleo'), { clientX: 10, clientY: 60 });
    expect(selectedLabels()).toEqual(['Cleo']);
    fireEvent.mouseMove(option('Cleo'), { clientX: 10.5, clientY: 60.5 });
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    fireEvent.mouseMove(option('Cleo'), { clientX: 10, clientY: 60 });
    expect(selectedLabels()).toEqual(['Bert']);
  });

  it('continues arrow-key navigation from the pointer row', async () => {
    const { editor } = await open();
    move(option('Anna'), 1, 1);
    move(option('Bert'), 1, 30);
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(selectedLabels()).toEqual(['Cleo']);
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    expect(selectedLabels()).toEqual(['Anna']);
  });

  it('does not scroll the list for a pointer activation, but does for the keyboard', async () => {
    const { editor } = await open();
    scroll.mockClear();
    move(option('Anna'), 1, 1);
    move(option('Cleo'), 1, 60);
    expect(selectedLabels()).toEqual(['Cleo']);
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    expect(scroll).toHaveBeenCalled();
  });

  it('ignores touch pointer movement (a finger scrolling the list)', async () => {
    await open();
    fireEvent.pointerMove(option('Anna'), { clientX: 1, clientY: 1, pointerType: 'touch' });
    fireEvent.pointerMove(option('Cleo'), { clientX: 1, clientY: 60, pointerType: 'touch' });
    expect(selectedLabels()).toEqual(['Anna']);
  });

  it('activates an entity action button under the moving pointer', async () => {
    const { editor, onEntityAction } = await open();
    const mail = screen.getByRole('option', { name: 'Mail: Dora' });
    move(option('Anna'), 1, 1);
    move(mail, 200, 90);
    expect(activeId()).toBe(mail.id);
    expect(mail.getAttribute('aria-selected')).toBe('true');
    expect(mail.getAttribute('data-selected')).toBe('true');
    expect(option('Dora').getAttribute('data-selected')).toBe('false');
    // Back to the result itself.
    move(option('Dora'), 50, 90);
    expect(activeId()).toBe(option('Dora').id);
    move(mail, 200, 91);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onEntityAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'd' }), 'mail');
  });

  it('arrow keys left/right continue from a pointer-activated action', async () => {
    const { editor } = await open();
    const open_ = screen.getByRole('option', { name: 'Open: Dora' });
    move(option('Anna'), 1, 1);
    move(open_, 150, 90);
    fireEvent.keyDown(editor, { key: 'ArrowRight' });
    expect(activeId()).toBe(screen.getByRole('option', { name: 'Mail: Dora' }).id);
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    expect(activeId()).toBe(option('Dora').id);
  });

  it('works for a custom DropdownItem that only spreads optionProps', async () => {
    function Item({ result, isSelected, onClick, optionProps }: MentionDropdownItemProps) {
      return (
        <div {...optionProps} onClick={onClick} data-mine={isSelected ? 'on' : 'off'}>
          <strong>{result.label}</strong>
        </div>
      );
    }
    const { editor } = await open({ components: { DropdownItem: Item } });
    move(option('Anna').querySelector('strong')!, 1, 1);
    move(option('Cleo').querySelector('strong')!, 1, 60);
    expect(option('Cleo').getAttribute('data-mine')).toBe('on');
    expect(activeId()).toBe(option('Cleo').id);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="c"]')).toBeTruthy());
  });

  it('works for a custom DropdownItem that does not spread optionProps (one element per row)', async () => {
    function Item({ result, isSelected, onClick }: MentionDropdownItemProps) {
      return <button type="button" onClick={onClick} data-mine={isSelected ? 'on' : 'off'}>{result.label}</button>;
    }
    const { editor } = await open({ components: { DropdownItem: Item }, onEntityAction: undefined });
    const row = (label: string) => screen.getByText(label);
    move(row('Anna'), 1, 1);
    move(row('Bert'), 1, 30);
    expect(row('Bert').getAttribute('data-mine')).toBe('on');
    expect(row('Anna').getAttribute('data-mine')).toBe('off');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="b"]')).toBeTruthy());
  });

  it('lets a custom DropdownItem activate its row through onActivate', async () => {
    function Item({ result, isSelected, onClick, optionProps, onActivate }: MentionDropdownItemProps) {
      return (
        <div {...optionProps} onClick={onClick} data-mine={isSelected ? 'on' : 'off'}>
          <span data-testid={`activate-${result.id}`} onFocus={() => onActivate?.()} tabIndex={-1}>{result.label}</span>
        </div>
      );
    }
    const { editor } = await open({ components: { DropdownItem: Item } });
    fireEvent.focus(screen.getByTestId('activate-c'));
    expect(option('Cleo').getAttribute('data-mine')).toBe('on');
    expect(activeId()).toBe(option('Cleo').id);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(editor.querySelector('[data-mention-id="c"]')).toBeTruthy());
  });
});
