// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatWindow } from '../chat-window';

afterEach(cleanup);

function Draft() {
  const [text, setText] = useState('');
  return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />;
}

describe('ChatWindow visibility lifecycle', () => {
  it('preserves the same composer while keeping closed content hidden and inert', () => {
    const { rerender } = render(<ChatWindow open keepMounted><Draft /></ChatWindow>);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Unsent draft' } });
    rerender(<ChatWindow open={false} keepMounted><Draft /></ChatWindow>);
    expect(input.isConnected).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
    const panel = input.closest('section')!;
    expect(panel.hidden).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.style.display).toBe('none');
    rerender(<ChatWindow open keepMounted><Draft /></ChatWindow>);
    expect(screen.getByRole('textbox')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('Unsent draft');
    expect(panel.hasAttribute('inert')).toBe(false);
  });

  it('retains the existing unmount-on-close default', () => {
    const { rerender } = render(<ChatWindow open><Draft /></ChatWindow>);
    const input = screen.getByRole('textbox');
    rerender(<ChatWindow open={false}><Draft /></ChatWindow>);
    expect(input.isConnected).toBe(false);
  });

  it('releases an active resize when hidden, even if the window stays mounted', () => {
    document.body.style.userSelect = 'text';
    const { rerender } = render(<ChatWindow open keepMounted><Draft /></ChatWindow>);
    const panel = screen.getByRole('textbox').closest('section')!;
    fireEvent.mouseDown(panel.querySelector('[data-edge="right"]')!, { button: 0, clientX: 420 });
    expect(document.body.style.userSelect).toBe('none');
    rerender(<ChatWindow open={false} keepMounted><Draft /></ChatWindow>);
    expect(document.body.style.userSelect).toBe('text');
    const width = panel.style.width;
    fireEvent.mouseMove(document, { clientX: 750 });
    expect(panel.style.width).toBe(width);
    document.body.style.userSelect = '';
  });
});
