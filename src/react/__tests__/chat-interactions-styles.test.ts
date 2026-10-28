import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNSTYLED_GUARD } from '../unstyled.js';
import { CHAT_STYLES } from '../../embed/chat-styles.generated.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

// Rules carry the unstyled guard on their first compound; look them up without it.
const plain = css.replaceAll(UNSTYLED_GUARD, '');

function rule(selector: string): string {
  const start = plain.indexOf(`${selector} {`);
  expect(start, `missing rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return plain.slice(start, plain.indexOf('}', start));
}

describe('shipped styles for chat interactions', () => {
  it('puts entity actions beside their result and marks the active one', () => {
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-dropdown"] [data-element="result-row"]'))
      .toContain('display: flex');
    expect(rule('[data-component="ai-chat-panel"] [data-element="result-row"] > [data-component="mention-dropdown-item"]'))
      .toContain('min-width: 0');
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-action"][data-selected="true"]'))
      .toContain('background: var(--cm-primary-tint)');
  });

  it('keeps the chips on one line beside the result and drops them below it only when the row is too narrow', () => {
    // The item keeps `width: 100%` from its own rule, so it needs a small flex basis: with the full
    // row as basis the shrink is shared by basis and squeezes the chips below their own width.
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-dropdown"] [data-element="result-row"]'))
      .toContain('flex-wrap: wrap');
    const item = rule('[data-component="ai-chat-panel"] [data-element="result-row"] > [data-component="mention-dropdown-item"]');
    expect(item).toContain('flex: 1 1 8rem');
    expect(item).toContain('min-width: 0');
    expect(rule('[data-component="ai-chat-panel"] [data-element="entity-actions"]')).toContain('flex: 0 0 auto');
  });

  it('wraps the argument form on narrow panels and opens entity lists upwards', () => {
    const form = rule('[data-component="ai-chat-panel"] [data-component="command-arguments"]');
    expect(form).toContain('flex-wrap: wrap');
    expect(form).toContain('max-width: 100%');
    expect(rule('[data-component="command-arguments"] [data-element="field"]')).toContain('min-width: 0');
    expect(rule('[data-component="command-arguments"] [data-element="options"]')).toContain('bottom: calc(100% + 0.25rem)');
  });

  it('puts the description of an argument option under its label', () => {
    // Nothing else styles this span: the dropdown rule for descriptions is scoped to the mention items,
    // so without it the option reads `Alice Examplealice@example.com`.
    const description = rule('[data-component="command-arguments"] [data-element="options"] [data-element="description"]');
    expect(description).toContain('display: block');
    expect(description).toContain('font-size: 12px');
    expect(description).toContain('color: var(--cm-text-muted)');
  });

  it('gives the argument form a row of its own above the composer', () => {
    // The provider composer rule `[data-mode="providers"] > form { flex: 1 }` (0,3,1) outranks the
    // form's own rule (0,2,0): without these two rules the form sits beside the editor.
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-input"][data-mode="providers"]'))
      .toContain('flex-wrap: wrap');
    const row = rule('[data-component="ai-chat-panel"] [data-component="mention-input"][data-mode="providers"] > form[data-component="command-arguments"]');
    expect(row).toContain('flex: 1 1 100%');
    expect(row).toContain('margin: 0');
  });

  it('ships the same rules inside <glirastes-chat>', () => {
    expect(CHAT_STYLES).toBe(css);
    expect(CHAT_STYLES).toContain('[data-component="command-arguments"]');
  });
});
