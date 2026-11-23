// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { preloadMarkdown } from '../index.js';

const loads = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-markdown', async () => {
  loads.count += 1;
  return await vi.importActual<typeof import('react-markdown')>('react-markdown');
});

describe('preloadMarkdown on the server', () => {
  it('resolves without loading the renderer and without throwing', async () => {
    expect(typeof window).toBe('undefined');
    await expect(preloadMarkdown()).resolves.toBeUndefined();
    expect(loads.count).toBe(0);
  });
});
