// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useDragResizePanel,
  type UseDragResizePanelOptions,
} from '../use-drag-resize-panel.js';

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
  beforeEach(() => {
    sessionStorage.clear();
    document.body.style.userSelect = '';
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
  });

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

  it('cancels dragging when disabled without waiting for pointer release', () => {
    const options = createOptions();
    document.body.style.userSelect = 'text';
    const { result, rerender } = renderHook(
      ({ enabled }) => useDragResizePanel({ ...options, draggable: enabled }),
      { initialProps: { enabled: true } },
    );
    act(() => {
      result.current.handlers.onDragStart(mouseDown(500, 140));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 550, clientY: 180 }));
    });
    expect(result.current.isDragging).toBe(true);
    rerender({ enabled: false });
    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.userSelect).toBe('text');
    const position = result.current.position;
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 600, clientY: 200 })));
    expect(result.current.position).toEqual(position);
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

  it('restores persisted dimensions instead of overwriting them on mount', () => {
    sessionStorage.setItem('ai-panel-width', '720');
    sessionStorage.setItem('ai-panel-height', '760');

    const { result } = renderHook(() => useDragResizePanel({
      ...createOptions(),
      persistDimensions: 'ai-panel',
    }));

    expect(result.current.size).toEqual({ width: 720, height: 760 });
  });

  it('sanitizes corrupted persisted dimensions', () => {
    sessionStorage.setItem('ai-panel-width', '-50');
    sessionStorage.setItem('ai-panel-height', 'not-a-number');

    const { result } = renderHook(() => useDragResizePanel({
      ...createOptions(),
      persistDimensions: 'ai-panel',
    }));

    expect(result.current.size).toEqual({ width: 320, height: 500 });
  });

  it('still follows dimension prop changes after restoring a session size', () => {
    sessionStorage.setItem('ai-panel-width', '720');
    sessionStorage.setItem('ai-panel-height', '760');

    const { result, rerender } = renderHook(
      ({ width, height }) => useDragResizePanel({
        ...createOptions(),
        width,
        height,
        persistDimensions: 'ai-panel',
      }),
      { initialProps: { width: 400, height: 500 } },
    );

    expect(result.current.size).toEqual({ width: 720, height: 760 });

    rerender({ width: 600, height: 650 });

    expect(result.current.size).toEqual({ width: 600, height: 650 });
  });

  it('snaps a dragged panel back to its centered anchor on release', () => {
    const { result } = renderHook(() => useDragResizePanel(createOptions()));

    act(() => {
      result.current.handlers.onDragStart(mouseDown(500, 140));
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 520,
        clientY: 304,
      }));
    });

    expect(result.current.isDragging).toBe(true);
    expect(result.current.isNearSnapZone).toBe(true);
    expect(result.current.position).toEqual({ x: 520, y: 284 });

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', {
        clientX: 520,
        clientY: 304,
      }));
    });

    expect(result.current.isDragging).toBe(false);
    expect(result.current.isNearSnapZone).toBe(false);
    expect(result.current.position).toBeNull();
    expect(document.body.style.userSelect).toBe('');
  });

  it('clamps edge resize to the configured dimensions', () => {
    const { result } = renderHook(() => useDragResizePanel(createOptions()));

    act(() => {
      result.current.handlers.onEdgeResizeStart('right')(
        mouseDown(700, 300),
      );
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 1_500,
        clientY: 300,
      }));
    });

    expect(result.current.size.width).toBe(800);

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', {
        clientX: 1_500,
        clientY: 300,
      }));
    });

    expect(result.current.isResizing).toBe(false);
    expect(result.current.activeEdge).toBeNull();
  });
});
