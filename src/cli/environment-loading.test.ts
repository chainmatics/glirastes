import { describe, expect, it } from 'vitest';
import { shouldLoadImplicitEnvironment } from './environment-loading.js';

describe('shouldLoadImplicitEnvironment', () => {
  it.each([
    ['sync'],
    ['connect'],
    ['doctor'],
    ['init'],
    ['setup', 'inspect'],
    ['setup', 'sync'],
    ['setup', '--managed'],
  ])('keeps %s credentials out of unverified implicit env files', (...args) => {
    expect(shouldLoadImplicitEnvironment(args)).toBe(false);
  });

  it('preserves implicit environment loading for transitional commands', () => {
    expect(shouldLoadImplicitEnvironment(['setup', 'status'])).toBe(true);
    expect(shouldLoadImplicitEnvironment(['scan', '--sync'])).toBe(true);
  });
});
