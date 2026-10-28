// @vitest-environment jsdom

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import { AiTriggerButton } from '../components/ai-trigger-button.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { UNSTYLED_GUARD } from '../unstyled.js';
import type { ChatTransport } from '../types.js';

afterEach(cleanup);

const css = readFileSync(resolve(process.cwd(), 'src/react/styles.css'), 'utf8');

/** Selector lists of every style rule, skipping keyframe steps. */
function ruleSelectors(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  const stack: Array<'keyframes' | 'group' | 'rule'> = [];
  let buffer = '';
  for (const char of text) {
    if (char === '{') {
      const head = buffer.trim();
      buffer = '';
      if (head.startsWith('@keyframes')) stack.push('keyframes');
      else if (head.startsWith('@')) stack.push('group');
      else {
        if (!stack.includes('keyframes')) selectors.push(head);
        stack.push('rule');
      }
    } else if (char === '}') {
      stack.pop();
      buffer = '';
    } else if (char === ';' && stack.at(-1) === 'rule') {
      buffer = '';
    } else {
      buffer += char;
    }
  }
  return selectors;
}

/** Splits a selector list on top-level commas. */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}

function transport(): ChatTransport {
  return {
    messages: [],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

describe('unstyled (BYOS) mode', () => {
  it('guards every shipped rule so it never matches inside an unstyled root', () => {
    const selectors = ruleSelectors(css).flatMap(splitList);
    expect(selectors.length).toBeGreaterThan(100);
    const unguarded = selectors.filter((selector) => !selector.includes(UNSTYLED_GUARD));
    expect(unguarded).toEqual([]);
  });

  it('puts the guard on the first compound, where the root or its ancestors match', () => {
    for (const selector of ruleSelectors(css).flatMap(splitList)) {
      const firstCompound = selector.split(/\s+(?![^(]*\))/)[0];
      expect(firstCompound, selector).toContain(UNSTYLED_GUARD);
    }
  });

  it('marks the panel and leaves the theme to the host stylesheet', () => {
    const view = render(
      <AiChatProvider transport={transport()} unstyled theme={{ preset: 'minimal-white' }}>
        <AiChatPanel />
      </AiChatProvider>,
    );
    const panel = view.container.querySelector('[data-component="ai-chat-panel"]') as HTMLElement;
    expect(panel.hasAttribute('data-unstyled')).toBe(true);
    expect(panel.getAttribute('style') ?? '').not.toContain('--cm-');
  });

  it('keeps the styled default when unstyled is not set', () => {
    const view = render(
      <AiChatProvider transport={transport()}>
        <AiChatPanel />
      </AiChatProvider>,
    );
    const panel = view.container.querySelector('[data-component="ai-chat-panel"]') as HTMLElement;
    expect(panel.hasAttribute('data-unstyled')).toBe(false);
  });

  it('marks roots that portal out of the panel', () => {
    render(
      <AiChatProvider transport={transport()} unstyled>
        <AiTriggerButton onClickChat={() => {}} />
        <ConfirmDialog open title="Delete?" onConfirm={() => {}} onCancel={() => {}} />
      </AiChatProvider>,
    );
    for (const name of ['ai-trigger-button', 'confirm-dialog-backdrop']) {
      const root = document.querySelector(`[data-component="${name}"]`);
      expect(root, name).not.toBeNull();
      expect(root!.hasAttribute('data-unstyled'), name).toBe(true);
    }
  });
});
