// @vitest-environment jsdom

import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusIcon } from '../status-icon.js';
import { CHAT_STYLES } from '../../../embed/chat-styles.generated.js';

function mockReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StatusIcon motion', () => {
  it('spins without a stylesheet when the user does not ask for less motion', () => {
    mockReducedMotion(false);
    const { container } = render(<StatusIcon icon="spinner" />);
    expect(container.querySelector('animateTransform')).not.toBeNull();
    expect(container.querySelector('svg')!.hasAttribute('data-motion')).toBe(false);
  });

  it('spins where matchMedia is missing (server, old test DOMs)', () => {
    const { container } = render(<StatusIcon icon="spinner" />);
    expect(container.querySelector('animateTransform')).not.toBeNull();
  });

  it('stands still under prefers-reduced-motion and stays distinguishable from pending', () => {
    mockReducedMotion(true);
    const { container } = render(
      <>
        <StatusIcon icon="spinner" />
        <StatusIcon icon="pending" />
      </>,
    );
    const [spinner, pending] = Array.from(container.querySelectorAll('svg'));
    expect(spinner!.querySelector('animateTransform')).toBeNull();
    expect(spinner!.getAttribute('data-icon')).toBe('spinner');
    expect(spinner!.getAttribute('data-motion')).toBe('reduced');
    // An open arc, not the faint full circle of `pending`.
    expect(spinner!.querySelector('path')).not.toBeNull();
    expect(pending!.querySelector('circle')).not.toBeNull();
  });
});

describe('stylesheet motion', () => {
  const css = readFileSync(join(process.cwd(), 'src/react/styles.css'), 'utf8');

  function reducedBlock(source: string): string {
    const start = source.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n}\n', start));
  }

  it('stops the typing dots and dialog animations under prefers-reduced-motion', () => {
    const block = reducedBlock(css);
    expect(block).toContain('[data-component="typing-indicator"] [data-element="dot"]');
    expect(block).toContain('animation: none');
    expect(block).toContain('[data-component="confirm-dialog"]');
  });

  it('ships the same rule in the shadow-root styles of the embed', () => {
    expect(reducedBlock(CHAT_STYLES)).toBe(reducedBlock(css));
  });
});
