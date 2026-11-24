import { afterEach, describe, expect, it, vi } from 'vitest';

// #26: without react-markdown the chat warns once; the hint names the package, not one installer.
describe('react-markdown missing', () => {
  afterEach(() => {
    vi.doUnmock('react-markdown');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('warns once with a package-manager neutral hint', async () => {
    vi.resetModules();
    vi.doMock('react-markdown', () => { throw new Error("Cannot find package 'react-markdown'"); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadMarkdownModule } = await import('../markdown-module.js');
    await loadMarkdownModule();
    await loadMarkdownModule();
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain('react-markdown');
    expect(text).not.toMatch(/\b(?:npm|yarn|pnpm|bun) (?:install|add|i)\b/);
  });
});
