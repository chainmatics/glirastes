// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichMentionInput } from '../rich-mention-input.js';

const png = () => new File([Uint8Array.from([0x89, 0x50])], 'shot.png', { type: 'image/png' });
const search = async () => [];

function focusEnd(editor: HTMLElement) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function paste(editor: HTMLElement, files: File[], text = '') {
  const event = createEvent.paste(editor, { clipboardData: { files, getData: (type: string) => (type === 'text/plain' ? text : '') } });
  fireEvent(editor, event);
  return event;
}

afterEach(cleanup);

describe.each([
  ['mention mode', { onSearch: search }],
  ['plain mode', {}],
])('RichMentionInput files (%s)', (_mode, extra) => {
  it('routes pasted files to onFiles without inserting them', () => {
    const onFiles = vi.fn();
    render(<RichMentionInput {...extra} onFiles={onFiles} />);
    const editor = screen.getByRole('textbox');
    focusEnd(editor);
    const event = paste(editor, [png()]);
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'shot.png' })]);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe('');
  });

  it('keeps the text of a mixed paste', () => {
    const onFiles = vi.fn();
    const onChange = vi.fn();
    render(<RichMentionInput {...extra} onFiles={onFiles} onChange={onChange} />);
    const editor = screen.getByRole('textbox');
    focusEnd(editor);
    paste(editor, [png()], 'caption');
    expect(onFiles).toHaveBeenCalledOnce();
    expect(editor.textContent).toBe('caption');
  });

  it('marks a file drag and hands dropped files to onFiles', () => {
    const onFiles = vi.fn();
    const { container } = render(<RichMentionInput {...extra} onFiles={onFiles} />);
    const root = container.querySelector('[data-component="rich-mention-input"]')!;
    const editor = screen.getByRole('textbox');
    const dataTransfer = { types: ['Files'], files: [png()], dropEffect: 'none' };
    const over = createEvent.dragOver(editor, { dataTransfer });
    fireEvent(editor, over);
    expect(over.defaultPrevented).toBe(true);
    expect(root.getAttribute('data-drag-over')).toBe('true');
    const drop = createEvent.drop(editor, { dataTransfer });
    fireEvent(editor, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'shot.png' })]);
    expect(root.hasAttribute('data-drag-over')).toBe(false);
  });

  it('calls onBackspaceEmpty only in an empty editor', () => {
    const onBackspaceEmpty = vi.fn();
    render(<RichMentionInput {...extra} onBackspaceEmpty={onBackspaceEmpty} />);
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(onBackspaceEmpty).toHaveBeenCalledOnce();
    editor.textContent = 'x';
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Backspace' });
    expect(onBackspaceEmpty).toHaveBeenCalledOnce();
  });

  it('submits an empty editor only with allowEmptySubmit', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<RichMentionInput {...extra} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(<RichMentionInput {...extra} onSubmit={onSubmit} allowEmptySubmit />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('', []);
  });
});

describe('RichMentionInput without onFiles', () => {
  it('leaves file drags alone', () => {
    render(<RichMentionInput onSearch={search} />);
    const editor = screen.getByRole('textbox');
    const over = createEvent.dragOver(editor, { dataTransfer: { types: ['Files'], files: [png()] } });
    fireEvent(editor, over);
    expect(over.defaultPrevented).toBe(false);
  });

  it('keeps the plain text paste of mention mode', () => {
    const onChange = vi.fn();
    render(<RichMentionInput onSearch={search} onChange={onChange} />);
    const editor = screen.getByRole('textbox');
    focusEnd(editor);
    paste(editor, [], 'hello');
    expect(editor.textContent).toBe('hello');
    expect(onChange).toHaveBeenCalled();
  });
});
