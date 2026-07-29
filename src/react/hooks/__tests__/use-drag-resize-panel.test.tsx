// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useDragResizePanel,
  type UseDragResizePanelOptions,
} from '../use-drag-resize-panel';

function createOptions(): UseDragResizePanelOptions {
  const panel = document.createElement('section');
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
    x: 300,
    y: 120,
    left: 300,
    top: 120,
    right: 700,
    bottom: 620,
    width: 400,
    height: 500,
    toJSON: () => ({}),
  });

  return {
    panelRef: { current: panel },
    width: 400,
    height: 500,
    minWidth: 320,
    minHeight: 300,
    maxWidth: 800,
    maxHeight: 900,
    snapToCenter: true,
    draggable: true,
    resizable: true,
  };
}

function mouseDown(
  clientX: number,
  clientY: number,
): React.MouseEvent<HTMLElement> {
  return {
    button: 0,
    clientX,
    clientY,
    target: document.createElement('div'),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

describe('useDragResizePanel drag lifecycle', () => {
  it('does not enter a stuck drag state after an immediate click release', () => {
    const { result } = renderHook(() => useDragResizePanel(createOptions()));

    act(() => {
      result.current.handlers.onDragStart(mouseDown(500, 140));
      document.dispatchEvent(new MouseEvent('mouseup', {
        clientX: 500,
        clientY: 140,
      }));
    });

    expect(result.current.isDragging).toBe(false);
    expect(result.current.position).toBeNull();
    expect(document.body.style.userSelect).toBe('');
  });

  it('starts dragging only after the pointer crosses a movement threshold', () => {
    const { result } = renderHook(() => useDragResizePanel(createOptions()));

    act(() => {
      result.current.handlers.onDragStart(mouseDown(500, 140));
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 502,
        clientY: 142,
      }));
    });

    expect(result.current.isDragging).toBe(false);
    expect(result.current.position).toBeNull();

    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 520,
        clientY: 160,
      }));
    });

    expect(result.current.isDragging).toBe(true);
    expect(result.current.position).toEqual({ x: 520, y: 140 });

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', {
        clientX: 520,
        clientY: 160,
      }));
    });

    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.userSelect).toBe('');
  });

  it('keeps a dragged panel inside the viewport', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
    const options = {
      ...createOptions(),
      constrainToViewport: true,
    };
    const { result } = renderHook(() => useDragResizePanel(options));

    act(() => {
      result.current.handlers.onDragStart(mouseDown(500, 140));
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 0,
        clientY: 0,
      }));
    });

    expect(result.current.position).toEqual({ x: 208, y: 8 });

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', {
        clientX: 0,
        clientY: 0,
      }));
    });
  });

  it('does not leave resize active after an immediate release', () => {
    const { result } = renderHook(() => useDragResizePanel(createOptions()));

    act(() => {
      result.current.handlers.onEdgeResizeStart('left')(mouseDown(300, 300));
      document.dispatchEvent(new MouseEvent('mouseup', {
        clientX: 300,
        clientY: 300,
      }));
    });

    expect(result.current.isResizing).toBe(false);
    expect(result.current.activeEdge).toBeNull();
    expect(document.body.style.userSelect).toBe('');
  });
});
