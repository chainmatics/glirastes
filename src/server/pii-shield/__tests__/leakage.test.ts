import { describe, it, expect } from 'vitest';
import { detectLeakage } from '../leakage.js';

describe('detectLeakage', () => {
  it('detects known original in text', () => {
    const originals = ['Max Müller', 'max@test.com'];
    const text = 'The user Max Müller sent a request.';
    const leaked = detectLeakage(text, originals);
    expect(leaked).toEqual(['Max Müller']);
  });

  it('returns empty when no leakage', () => {
    const originals = ['Max Müller'];
    const text = 'Sabine Hofmann sent a request.';
    const leaked = detectLeakage(text, originals);
    expect(leaked).toEqual([]);
  });

  it('detects multiple leaked originals', () => {
    const originals = ['Max Müller', 'max@test.com'];
    const text = 'Max Müller (max@test.com) signed in.';
    const leaked = detectLeakage(text, originals);
    expect(leaked).toContain('Max Müller');
    expect(leaked).toContain('max@test.com');
  });

  it('is case-sensitive', () => {
    const originals = ['Max Müller'];
    const text = 'max müller sent a request.';
    const leaked = detectLeakage(text, originals);
    expect(leaked).toEqual([]);
  });

  it('ignores short originals (< 3 chars)', () => {
    const originals = ['ab', 'Max Müller'];
    const text = 'ab and Max Müller are here.';
    const leaked = detectLeakage(text, originals);
    expect(leaked).toEqual(['Max Müller']);
  });
});
