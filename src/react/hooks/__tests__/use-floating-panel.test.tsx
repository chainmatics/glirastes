// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFloatingPanel, type UseFloatingPanelOptions } from '../use-floating-panel.js';

const renders = { count: 0 };

function Panel(props: Partial<UseFloatingPanelOptions>) {
  renders.count += 1;
  const panel = useFloatingPanel({
    defaultRect: { x: 100, y: 100, width: 400, height: 300 },
    minWidth: 200,
    minHeight: 150,
    ...props,
  });
  return (
    <div ref={panel.ref} data-testid="panel" style={panel.style}>
      <header data-testid="header" {...panel.dragHandleProps}>
        <button>close</button>
      </header>
      <div data-testid="se" {...panel.getResizeHandleProps('se')} />
      <div data-testid="w" {...panel.getResizeHandleProps('w')} />
      <output data-testid="rect">{panel.rect ? JSON.stringify(panel.rect) : 'none'}</output>
      <button onClick={panel.reset}>reset</button>
    </div>
  );
}

const rect = () => JSON.parse(screen.getByTestId('rect').textContent!);
const frame = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

beforeEach(() => {
  renders.count = 0;
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('useFloatingPanel', () => {
  it('places the panel at its default rect', async () => {
    render(<Panel />);
    await frame();
    expect(rect()).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(screen.getByTestId('panel').style.left).toBe('100px');
    expect(screen.getByTestId('panel').style.width).toBe('400px');
  });

  it('moves with the pointer without rendering, and commits once on release', async () => {
    render(<Panel />);
    await frame();
    const header = screen.getByTestId('header');
    const panel = screen.getByTestId('panel');
    const before = renders.count;

    fireEvent.pointerDown(header, { button: 0, clientX: 150, clientY: 110, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 250, clientY: 160, pointerId: 1 });
    await frame();
    fireEvent.pointerMove(header, { clientX: 350, clientY: 210, pointerId: 1 });
    await frame();

    expect(panel.style.transform).toBe('translate3d(200px, 100px, 0)');
    // One render for the interaction flag at most; none per pointer move.
    expect(renders.count - before).toBeLessThanOrEqual(1);

    fireEvent.pointerUp(header, { clientX: 350, clientY: 210, pointerId: 1 });
    expect(panel.style.transform).toBe('');
    expect(rect()).toEqual({ x: 300, y: 200, width: 400, height: 300 });
  });

  it('keeps the panel inside the viewport', async () => {
    render(<Panel />);
    await frame();
    const header = screen.getByTestId('header');
    fireEvent.pointerDown(header, { button: 0, clientX: 150, clientY: 110, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 5000, clientY: -5000, pointerId: 1 });
    fireEvent.pointerUp(header, { pointerId: 1 });
    expect(rect()).toEqual({ x: 592, y: 8, width: 400, height: 300 });
  });

  it('does not start a move from a control inside the handle', async () => {
    render(<Panel />);
    await frame();
    fireEvent.pointerDown(screen.getByText('close'), { button: 0, clientX: 150, clientY: 110, pointerId: 1 });
    fireEvent.pointerMove(screen.getByTestId('header'), { clientX: 400, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('header'), { pointerId: 1 });
    expect(rect().x).toBe(100);
  });

  it('resizes from a corner and from the opposite edge within its limits', async () => {
    render(<Panel maxWidth={600} />);
    await frame();
    const se = screen.getByTestId('se');
    fireEvent.pointerDown(se, { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(se, { clientX: 560, clientY: 450, pointerId: 1 });
    fireEvent.pointerUp(se, { pointerId: 1 });
    expect(rect()).toEqual({ x: 100, y: 100, width: 460, height: 350 });

    // Dragging the left edge right shrinks to the minimum and keeps the right edge in place.
    const w = screen.getByTestId('w');
    fireEvent.pointerDown(w, { button: 0, clientX: 100, clientY: 200, pointerId: 2 });
    fireEvent.pointerMove(w, { clientX: 900, clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(w, { pointerId: 2 });
    expect(rect()).toEqual({ x: 360, y: 100, width: 200, height: 350 });

    // And left again grows to the maximum.
    fireEvent.pointerDown(w, { button: 0, clientX: 360, clientY: 200, pointerId: 3 });
    fireEvent.pointerMove(w, { clientX: -900, clientY: 200, pointerId: 3 });
    fireEvent.pointerUp(w, { pointerId: 3 });
    expect(rect().width).toBe(552);
    expect(rect().x).toBe(8);
  });

  it('moves and resizes from the keyboard', async () => {
    render(<Panel />);
    await frame();
    const header = screen.getByTestId('header');
    fireEvent.keyDown(header, { key: 'ArrowRight' });
    fireEvent.keyDown(header, { key: 'ArrowDown', shiftKey: true });
    expect(rect()).toEqual({ x: 116, y: 164, width: 400, height: 300 });
    fireEvent.keyDown(header, { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(header, { key: 'ArrowUp', altKey: true });
    expect(rect()).toEqual({ x: 116, y: 164, width: 416, height: 284 });
  });

  it('remembers its rect, fits it into a smaller window and resets to the default', async () => {
    const first = render(<Panel storageKey="chat-window" />);
    await frame();
    const header = screen.getByTestId('header');
    fireEvent.pointerDown(header, { button: 0, clientX: 150, clientY: 110, pointerId: 1 });
    fireEvent.pointerMove(header, { clientX: 650, clientY: 510, pointerId: 1 });
    fireEvent.pointerUp(header, { pointerId: 1 });
    expect(rect().x).toBe(592);
    first.unmount();

    render(<Panel storageKey="chat-window" />);
    await frame();
    expect(rect()).toEqual({ x: 592, y: 492, width: 400, height: 300 });

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(rect()).toEqual({ x: 92, y: 492, width: 400, height: 300 });

    fireEvent.click(screen.getByText('reset'));
    expect(rect()).toEqual({ x: 92, y: 100, width: 400, height: 300 });
  });

  it('stays out of the way while disabled', async () => {
    render(<Panel enabled={false} />);
    await frame();
    expect(screen.getByTestId('rect').textContent).toBe('none');
    expect(screen.getByTestId('panel').style.left).toBe('');
  });
});
