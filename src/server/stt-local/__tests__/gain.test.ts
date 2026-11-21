import { describe, expect, it } from 'vitest';
import { normalizeGain } from '../gain.js';

const peak = (samples: Float32Array) => samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

describe('normalizeGain', () => {
  it('gain lifts quiet input and leaves normal input alone', () => {
    expect(peak(normalizeGain(Float32Array.of(0, 0.01, -0.005)))).toBeCloseTo(0.2, 6);
    const lifted = normalizeGain(Float32Array.of(0.05, -0.025));
    expect(peak(lifted)).toBeCloseTo(0.5, 6);
    expect(lifted[1]).toBeCloseTo(-0.25, 6);
    const normal = Float32Array.of(0.3, -0.1);
    expect(normalizeGain(normal)).toBe(normal);
    const loudAtThreshold = Float32Array.of(0.1);
    expect(normalizeGain(loudAtThreshold)).toBe(loudAtThreshold);
    const silent = new Float32Array(4);
    expect(normalizeGain(silent)).toBe(silent);
  });

  it('does not change the input array', () => {
    const quiet = Float32Array.of(0.01);
    normalizeGain(quiet);
    expect(quiet[0]).toBeCloseTo(0.01, 6);
  });
});
