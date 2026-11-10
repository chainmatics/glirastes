import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHAT_STYLES } from '../chat-styles.generated.js';

describe('inlined shadow-root styles', () => {
  it('match src/react/styles.css byte for byte', () => {
    const css = readFileSync(new URL('../../react/styles.css', import.meta.url), 'utf8');
    expect(CHAT_STYLES).toBe(css);
  });
});
