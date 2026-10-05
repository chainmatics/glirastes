import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('shipped styles for the new chat surfaces', () => {
  it('lays the provider composer form out as one row so the editor keeps its width', () => {
    // The wrapper is flex, but the editor, mic and Send live inside a bare
    // <form> that classNames.input leaves unstyled; without this rule the form
    // shrink-wraps (about 111px at 375px wide) and the editor and its list
    // inherit that width.
    const form = rule(
      '[data-component="ai-chat-panel"] [data-component="mention-input"][data-mode="providers"] > form',
    );
    expect(form).toContain('display: flex');
    expect(form).toContain('flex: 1');
    expect(form).toContain('min-width: 0');
    expect(form).toContain('align-items: flex-end');
  });

  it('gives the inline recording bar a row of its own so the live words have room', () => {
    // RecordingBar sets `width: 100%` inline; only a non-auto flex-basis on the
    // row item beats it. Sharing the row left the bar ~100px at 375px wide,
    // too little for the interim transcript, so the form wraps and the bar
    // takes the full width behind Send (real layout: recording-bar-browser).
    const form = rule(
      '[data-component="ai-chat-panel"] [data-component="mention-input"][data-mode="providers"] > form',
    );
    expect(form).toContain('flex-wrap: wrap');
    const bar = rule(
      '[data-component="ai-chat-panel"] [data-component="mention-input"][data-mode="providers"] > form > [data-component="recording-bar"]',
    );
    expect(bar).toContain('flex: 1 1 100%;');
    expect(bar).toContain('order: 1;');
  });

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
