import { describe, expect, it } from 'vitest';

describe('glirastes/embed module', () => {
  it('can be imported where no DOM exists (SSR) and fails clearly on define', async () => {
    expect(typeof globalThis.HTMLElement).toBe('undefined');
    const embed = await import('../index.js');
    expect(embed.GLIRASTES_CHAT_TAG).toBe('glirastes-chat');
    expect(() => embed.defineGlirastesChatElement()).toThrow(/Custom Elements/);
  });
});
