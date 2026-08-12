import { describe, expect, it } from 'vitest';
import { resolveRuntimeMode } from '../runtime-mode.js';

describe('resolveRuntimeMode', () => {
  it('resolves standalone when no control plane is configured', () => {
    expect(resolveRuntimeMode({})).toBe('standalone');
    expect(resolveRuntimeMode({ GLIRASTES_CONTROL_PLANE_URL: '' })).toBe('standalone');
    expect(resolveRuntimeMode({ GLIRASTES_CONTROL_PLANE_URL: '   ' })).toBe('standalone');
  });

  it('resolves managed when the control plane URL is set', () => {
    expect(resolveRuntimeMode({
      GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101',
      GLIRASTES_API_KEY: 'k',
    })).toBe('managed');
  });

  it('fails closed on a half-configured managed mode', () => {
    expect(() => resolveRuntimeMode({
      GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101',
    })).toThrow(/GLIRASTES_API_KEY/);
    expect(() => resolveRuntimeMode({
      GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101',
      GLIRASTES_API_KEY: '   ',
    })).toThrow(/GLIRASTES_API_KEY/);
  });
});
