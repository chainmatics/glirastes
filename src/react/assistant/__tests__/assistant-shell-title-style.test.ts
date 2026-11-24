// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UNSTYLED_GUARD } from '../../unstyled.js';

// #16: the shell's title rule (one line, ellipsis, flex: 1) styles the header
// title only, not the `title` elements of parts rendered inside the shell
// (command arguments form, chat queue, plan checklist, session switcher,
// pipeline timeline).

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../styles.css'), 'utf8').replaceAll(UNSTYLED_GUARD, '');

/** Every selector of a rule that starts in the shell and ends on a `title` element. */
function shellTitleSelectors(): string[] {
  const selectors: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((part) => part.trim())) {
      if (selector.startsWith('[data-component="assistant-shell"]') && selector.endsWith('[data-element="title"]')) {
        selectors.push(selector);
      }
    }
  }
  return selectors;
}

function shell(): HTMLElement {
  document.body.innerHTML = `
    <div data-component="assistant-shell">
      <div data-element="frame">
        <header data-element="header"><span data-element="icon"></span><span data-element="title" id="header-title">Assistant</span></header>
        <div data-element="body">
          <div data-component="ai-chat-panel">
            <div data-component="command-arguments"><p data-element="title">/deploy</p></div>
            <div data-component="chat-queue"><p data-element="title">Queue</p></div>
            <div data-component="plan-checklist"><strong data-element="title">Plan</strong></div>
            <div data-component="pipeline-timeline"><span data-element="title">1</span></div>
          </div>
        </div>
      </div>
    </div>`;
  return document.body;
}

describe('assistant shell title rule', () => {
  it('exists and styles the header title', () => {
    const selectors = shellTitleSelectors();
    expect(selectors.length).toBeGreaterThan(0);
    const root = shell();
    const title = root.querySelector('#header-title')!;
    expect(selectors.some((selector) => title.matches(selector))).toBe(true);
  });

  it('does not reach title elements of parts inside the shell', () => {
    const root = shell();
    const nested = [...root.querySelectorAll('[data-element="title"]:not(#header-title)')];
    expect(nested).toHaveLength(4);
    for (const selector of shellTitleSelectors()) {
      for (const element of nested) {
        expect(element.matches(selector), `${selector} matches ${element.parentElement!.dataset.component}`).toBe(false);
      }
    }
  });
});
