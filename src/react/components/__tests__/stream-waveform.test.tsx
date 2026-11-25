// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamWaveform } from '../stream-waveform.js';

function fakeContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    fillStyle: '',
    globalAlpha: 1,
  };
}

describe('StreamWaveform', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('draws on a canvas inside the waveform element', () => {
    render(<StreamWaveform stream={null} />);
    const waveform = document.querySelector('[data-element="waveform"]');
    expect(waveform?.querySelector('canvas')).toBeTruthy();
    expect(waveform?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a dotted baseline across the width before any sound', () => {
    const context = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 24 } as DOMRect);
    render(<StreamWaveform stream={null} />);
    // 100px / 5px per bar, plus one entering from the right edge.
    expect(context.roundRect.mock.calls.length).toBeGreaterThanOrEqual(20);
    for (const [, , , barHeight] of context.roundRect.mock.calls) expect(barHeight).toBe(2);
  });

  it('renders without a 2D context (no canvas support)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => render(<StreamWaveform stream={null} />)).not.toThrow();
  });
});
