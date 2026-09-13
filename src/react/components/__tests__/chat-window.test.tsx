// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatWindow } from '../chat-window';

afterEach(cleanup);

function Draft() {
  const [text, setText] = useState('');
  return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />;
}

function pointer(target: Element | Document, type: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(target, event);
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

describe('ChatWindow shared layouts', () => {
  it('continues dragging when the app persists each sidebar width update in state', () => {
    function App() {
      const [width, setWidth] = useState(420);
      return <ChatWindow mode="sidebar" sidebarWidth={width} onSidebarWidthChange={setWidth}><Draft /></ChatWindow>;
    }
    render(<App />);
    const panel = screen.getByRole('textbox').closest('section')!;
    pointer(screen.getByRole('separator'), 'pointerdown', 600);
    pointer(document, 'pointermove', 590);
    expect(panel.style.width).toBe('430px');
    expect(document.body.style.userSelect).toBe('none');
    pointer(document, 'pointermove', 580);
    expect(panel.style.width).toBe('440px');
    pointer(document, 'pointerup', 580);
    expect(document.body.style.userSelect).not.toBe('none');
  });

  it('does not reset floating position when the sidebar header is double-clicked', () => {
    render(<ChatWindow layoutControls initialPosition={{ x: 500, y: 150 }} snapToCenter><Draft /></ChatWindow>);
    const panel = screen.getByRole('textbox').closest('section')!;
    fireEvent.click(screen.getByRole('button', { name: 'Dock chat' }));
    fireEvent.doubleClick(panel.querySelector('[data-component="chat-window-header"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Float chat' }));
    expect(panel.style.left).toBe('500px');
    expect(panel.style.top).toBe('150px');
  });

  it('moves focus out of collapsed content and back to the composer on expand', () => {
    const { rerender } = render(<ChatWindow mode="sidebar" collapsed={false}><Draft /></ChatWindow>);
    const input = screen.getByRole('textbox');
    input.focus();
    rerender(<ChatWindow mode="sidebar" collapsed><Draft /></ChatWindow>);
    const expand = screen.getByRole('button', { name: 'Expand chat' });
    expect(document.activeElement).toBe(expand);
    rerender(<ChatWindow mode="sidebar" collapsed={false}><Draft /></ChatWindow>);
    expect(document.activeElement).toBe(input);
  });

  it('does not steal external focus on a controlled collapse', () => {
    const { rerender } = render(<><button>External</button><ChatWindow mode="sidebar"><Draft /></ChatWindow></>);
    const external = screen.getByRole('button', { name: 'External' });
    external.focus();
    rerender(<><button>External</button><ChatWindow mode="sidebar" collapsed><Draft /></ChatWindow></>);
    expect(document.activeElement).toBe(external);
  });

  it('keeps sidebar persistence isolated when its namespace changes', () => {
    window.sessionStorage.setItem('layout-a-sidebar-width', '480');
    window.sessionStorage.setItem('layout-b-sidebar-width', '550');
    const { rerender } = render(<ChatWindow mode="sidebar" persistDimensions="layout-a"><Draft /></ChatWindow>);
    const panel = screen.getByRole('textbox').closest('section')!;
    expect(panel.style.width).toBe('480px');
    rerender(<ChatWindow mode="sidebar" persistDimensions="layout-b"><Draft /></ChatWindow>);
    expect(panel.style.width).toBe('550px');
    expect(window.sessionStorage.getItem('layout-a-sidebar-width')).toBe('480');
    expect(window.sessionStorage.getItem('layout-b-sidebar-width')).toBe('550');
    window.sessionStorage.removeItem('layout-a-sidebar-width');
    window.sessionStorage.removeItem('layout-b-sidebar-width');
  });

  it('can resize when optional session storage is denied', () => {
    const read = vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage denied'); });
    const write = vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage denied'); });
    try {
      render(<ChatWindow mode="sidebar" persistDimensions="blocked"><Draft /></ChatWindow>);
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
      expect(screen.getByRole('textbox').closest('section')!.style.width).toBe('440px');
    } finally { read.mockRestore(); write.mockRestore(); }
  });

  it('resizes the sidebar by keyboard within bounds without changing floating size', () => {
    const widths: number[] = [];
    render(<ChatWindow portal={false} layoutControls defaultMode="sidebar" width={672}
      sidebarWidth={420} minSidebarWidth={400} maxSidebarWidth={600} onSidebarWidthChange={width => widths.push(width)}><Draft /></ChatWindow>);
    const separator = screen.getByRole('separator', { name: 'Resize chat sidebar' });
    const panel = screen.getByRole('textbox').closest('section')!;
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(panel.style.width).toBe('440px');
    expect(separator.getAttribute('aria-valuenow')).toBe('440');
    expect(widths.at(-1)).toBe(440);
    fireEvent.keyDown(separator, { key: 'End' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(panel.style.width).toBe('600px');
    fireEvent.keyDown(separator, { key: 'Home' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(panel.style.width).toBe('400px');
    fireEvent.doubleClick(separator);
    expect(panel.style.width).toBe('420px');
    fireEvent.click(screen.getByRole('button', { name: 'Float chat' }));
    expect(panel.style.width).toBe('672px');
    fireEvent.click(screen.getByRole('button', { name: 'Dock chat' }));
    expect(panel.style.width).toBe('420px');
  });

  it('isolates pointer IDs and releases sidebar resize on cancellation', () => {
    render(<ChatWindow defaultMode="sidebar"><Draft /></ChatWindow>);
    const separator = screen.getByRole('separator');
    const panel = screen.getByRole('textbox').closest('section')!;
    document.body.style.userSelect = 'text';
    pointer(separator, 'pointerdown', 600);
    expect(document.body.style.userSelect).toBe('none');
    pointer(document, 'pointermove', 500, 2);
    expect(panel.style.width).toBe('420px');
    pointer(document, 'pointermove', 500);
    expect(panel.style.width).toBe('520px');
    pointer(document, 'pointercancel', 500);
    expect(document.body.style.userSelect).toBe('text');
    pointer(document, 'pointermove', 400);
    expect(panel.style.width).toBe('520px');
    document.body.style.userSelect = '';
  });

  it.each(['collapse', 'float', 'close', 'unmount', 'blur'])('releases a sidebar gesture on %s', (action) => {
    const { unmount } = render(<ChatWindow keepMounted layoutControls defaultMode="sidebar"><Draft /></ChatWindow>);
    const panel = screen.getByRole('textbox').closest('section')!;
    pointer(screen.getByRole('separator'), 'pointerdown', 600);
    expect(document.body.style.userSelect).toBe('none');
    if (action === 'unmount') unmount();
    else if (action === 'blur') fireEvent.blur(window);
    else fireEvent.click(screen.getByRole('button', { name: ({ collapse: 'Collapse chat', float: 'Float chat', close: 'Close chat' })[action] }));
    expect(document.body.style.userSelect).not.toBe('none');
    const width = panel.style.width;
    pointer(document, 'pointermove', 300);
    expect(panel.style.width).toBe(width);
  });

  it('restores sidebar width independently from namespaced floating dimensions', () => {
    const prefix = 'layout-test';
    window.sessionStorage.setItem(`${prefix}-sidebar-width`, '510');
    const { unmount } = render(<ChatWindow defaultMode="sidebar" persistDimensions={prefix}><Draft /></ChatWindow>);
    const panel = screen.getByRole('textbox').closest('section')!;
    expect(panel.style.width).toBe('510px');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(window.sessionStorage.getItem(`${prefix}-sidebar-width`)).toBe('530');
    unmount();
    window.sessionStorage.removeItem(`${prefix}-sidebar-width`);
  });

  it('docks the same draft inline and restores floating geometry when undocked', () => {
    render(<ChatWindow portal={false} layoutControls width={672} height={540}><Draft /></ChatWindow>);
    const input = screen.getByRole('textbox');
    const panel = input.closest('section')!;
    fireEvent.change(input, { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dock chat' }));
    expect(panel.style.position).toBe('relative');
    expect(panel.style.width).toBe('420px');
    expect(panel.style.height).toBe('100%');
    expect(panel.style.transform).toBe('none');
    expect(screen.getByRole('textbox')).toBe(input);
    fireEvent.click(screen.getByRole('button', { name: 'Float chat' }));
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.width).toBe('672px');
    expect(panel.style.height).toBe('540px');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Keep my draft');
  });

  it('keeps a collapsed draft mounted and inert until expanded', () => {
    render(<ChatWindow portal={false} layoutControls defaultMode="sidebar"><Draft /></ChatWindow>);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Not sent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }));
    expect(input.isConnected).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(input.closest('[data-component="chat-window-body"]')!.hasAttribute('inert')).toBe(true);
    expect(input.closest('section')!.style.width).toBe('44px');
    fireEvent.click(screen.getByRole('button', { name: 'Expand chat' }));
    expect(screen.getByRole('textbox')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('Not sent');
  });

  it('requests a controlled mode change without overriding the parent', () => {
    const changes: string[] = [];
    const { rerender } = render(<ChatWindow mode="floating" layoutControls onModeChange={mode => changes.push(mode)}><Draft /></ChatWindow>);
    fireEvent.click(screen.getByRole('button', { name: 'Dock chat' }));
    expect(changes).toEqual(['sidebar']);
    expect(screen.getByRole('textbox').closest('section')!.dataset.mode).toBe('floating');
    rerender(<ChatWindow mode="sidebar" layoutControls><Draft /></ChatWindow>);
    expect(screen.getByRole('textbox').closest('section')!.dataset.mode).toBe('sidebar');
  });

  it('cancels an active floating resize on docking', () => {
    const { rerender } = render(<ChatWindow mode="floating"><Draft /></ChatWindow>);
    const panel = screen.getByRole('textbox').closest('section')!;
    fireEvent.mouseDown(panel.querySelector('[data-edge="right"]')!, { button: 0, clientX: 420 });
    expect(document.body.style.userSelect).toBe('none');
    rerender(<ChatWindow mode="sidebar"><Draft /></ChatWindow>);
    expect(document.body.style.userSelect).not.toBe('none');
    fireEvent.mouseMove(document, { clientX: 750 });
    expect(panel.style.width).toBe('420px');
  });
});
