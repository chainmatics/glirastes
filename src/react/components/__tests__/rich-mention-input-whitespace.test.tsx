// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RichMentionInput } from '../rich-mention-input.js';

// A command pick leaves `/slug ` in the editor and a chip pick leaves a text
// node starting with a space. Under the default `white-space: normal` Chrome
// collapses that trailing separator, so the next typed word merges into the
// token and the structured id is lost. jsdom does not lay out text, so these
// tests pin the rule that prevents it; the real-Chrome flow is verified in
// the Task 13 fix report.
describe('editor whitespace', () => {
  afterEach(cleanup);

  it('keeps whitespace literal in the mention editor without relying on styles.css', () => {
    render(<RichMentionInput onSearch={async () => []} />);
    const editor = screen.getByRole('textbox');
    expect(editor.getAttribute('data-element')).toBe('editor');
    expect(editor.style.whiteSpace).toBe('pre-wrap');
    expect(window.getComputedStyle(editor).whiteSpace).toBe('pre-wrap');
  });

  it('leaves the plain editor DOM without an inline style', () => {
    render(<RichMentionInput />);
    expect(screen.getByRole('textbox').hasAttribute('style')).toBe(false);
  });
});
