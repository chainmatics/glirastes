import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('shipped styles for the new chat surfaces', () => {
  it('anchors the / and @ list to the provider editor and keeps it on screen', () => {
    const dropdown = rule(
      '[data-component="ai-chat-panel"] [data-component="rich-mention-input"] [data-component="mention-dropdown"]',
    );
    expect(dropdown).toContain('position: absolute');
    expect(dropdown).toContain('max-height: min(40vh, 16rem)');
    expect(rule('[data-component="ai-chat-panel"] [data-component="mention-dropdown-item"][data-selected="true"]'))
      .toContain('background: var(--cm-primary-tint)');
  });

  it('wraps clarification options instead of overflowing narrow screens', () => {
    expect(rule('[data-component="clarification-card"] [data-element="options"]'))
      .toContain('flex-wrap: wrap');
    expect(rule('[data-component="clarification-card"] [data-element="free-text"] input'))
      .toContain('min-width: 0');
  });

  it('keeps push-to-talk holds from scrolling or opening touch menus', () => {
    const mic = rule('[data-component="ai-chat-panel"] [data-action="retry-recording"]');
    expect(mic).toContain('touch-action: none');
    expect(mic).toContain('-webkit-touch-callout: none');
    expect(rule('[data-component="ai-chat-panel"] [data-component="recording-bar"]'))
      .toContain('min-width: 0');
  });
});
