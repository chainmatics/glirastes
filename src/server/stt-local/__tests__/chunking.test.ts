import { describe, expect, it } from 'vitest';
import { MAX_CHUNK_SAMPLES, needsVad, planChunks, SAMPLE_RATE, type Span } from '../chunking.js';

const s = (seconds: number) => Math.round(seconds * SAMPLE_RATE);

/** Deterministic noise in [-0.5, 0.5). */
function noise(length: number): Float32Array {
  const out = new Float32Array(length);
  let seed = 42;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = seed / 0x7fffffff - 0.5;
  }
  return out;
}

function expectContiguous(chunks: Span[]) {
  for (let i = 1; i < chunks.length; i += 1) expect(chunks[i]![0]).toBe(chunks[i - 1]![1]);
  for (const [a, b] of chunks) {
    expect(b - a).toBeLessThanOrEqual(MAX_CHUNK_SAMPLES);
    expect(b).toBeGreaterThan(a);
  }
}

describe('needsVad', () => {
  it('needsVad is false at exactly 20 s and true one sample later', () => {
    expect(MAX_CHUNK_SAMPLES).toBe(320_000);
    expect(needsVad(320_000)).toBe(false);
    expect(needsVad(320_001)).toBe(true);
  });
});

describe('planChunks', () => {
  it('cuts at silence midpoints and keeps every chunk at most 20 s', () => {
    const samples = noise(s(80));
    const speech: Span[] = [0, 1, 2, 3, 4].map((i) => [s(1 + 15 * i), s(15 + 15 * i)] as const);
    const midpoints = speech.slice(1).map((span, i) => Math.floor((speech[i]![1] + span[0]) / 2));
    const chunks = planChunks(samples, speech);
    expectContiguous(chunks);
    expect(chunks[0]![0]).toBe(speech[0]![0] - 4800);
    expect(chunks.at(-1)![1]).toBe(speech.at(-1)![1] + 4800);
    for (const [, end] of chunks.slice(0, -1)) expect(midpoints).toContain(end);
    expect(chunks).toHaveLength(5);
  });

  it('clamps the padding to the audio', () => {
    const chunks = planChunks(noise(s(25)), [[100, s(10)], [s(12), s(25)]]);
    expect(chunks[0]![0]).toBe(0);
    expect(chunks.at(-1)![1]).toBe(s(25));
  });

  it('falls back to the quietest frame when no silence fits', () => {
    const samples = noise(s(60));
    samples.fill(0, s(15), s(15) + 480);
    const chunks = planChunks(samples, [[s(1), s(58)]]);
    expectContiguous(chunks);
    expect(Math.abs(chunks[0]![1] - (s(15) + 240))).toBeLessThanOrEqual(240);
  });

  it('never makes a chunk shorter than 2 s from a midpoint', () => {
    const samples = noise(s(30));
    const chunks = planChunks(samples, [[4800, s(0.8)], [s(1.2), s(29)]]);
    expectContiguous(chunks);
    expect(chunks[0]![0]).toBe(0);
    expect(chunks[0]![1]).not.toBe(s(1));
    expect(chunks[0]![1] - chunks[0]![0]).toBeGreaterThan(s(2));
  });

  it('returns no chunks when the VAD found no speech', () => {
    expect(planChunks(noise(s(30)), [])).toEqual([]);
  });

  it('returns one chunk when the padded speech fits in 20 s', () => {
    expect(planChunks(noise(s(40)), [[s(5), s(10)], [s(12), s(20)]])).toEqual([[s(5) - 4800, s(20) + 4800]]);
  });
});
