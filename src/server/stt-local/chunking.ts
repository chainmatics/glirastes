export const SAMPLE_RATE = 16000;
/** Parakeet degrades on long input: every decoded chunk is at most 20 s. */
export const MAX_CHUNK_SAMPLES = 20 * SAMPLE_RATE;
const MIN_CHUNK_SAMPLES = 2 * SAMPLE_RATE;
const PAD_SAMPLES = 4800; // 0.3 s
const FALLBACK_WINDOW = 8 * SAMPLE_RATE;
const FRAME = 480; // 30 ms
const HOP = 240;

/** Sample indices, end exclusive. */
export type Span = readonly [start: number, end: number];

/** Audio longer than one chunk goes through the VAD; shorter audio is decoded whole. */
export function needsVad(sampleCount: number): boolean {
  return sampleCount > MAX_CHUNK_SAMPLES;
}

/** The centre of the 30 ms frame with the least energy in [from, to). */
function quietestFrame(samples: Float32Array, from: number, to: number): number {
  let best = from;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let frame = Math.max(0, from); frame + FRAME <= to; frame += HOP) {
    let energy = 0;
    for (let i = frame; i < frame + FRAME; i += 1) energy += samples[i]! * samples[i]!;
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = frame;
    }
  }
  return best + HOP;
}

/**
 * Plans the chunks to decode from the **original** samples: the VAD speech
 * spans only locate silences. Cuts fall on midpoints between consecutive
 * spans, filled greedily up to 20 s with every chunk at least 2 s; when no
 * midpoint fits, the cut falls on the quietest 30 ms frame in the last 8 s of
 * the window. 0.3 s padding before the first and after the last span.
 */
export function planChunks(samples: Float32Array, speech: readonly Span[]): Span[] {
  if (speech.length === 0) return [];
  const n = samples.length;
  const cuts: number[] = [];
  for (let i = 1; i < speech.length; i += 1) cuts.push(Math.floor((speech[i - 1]![1] + speech[i]![0]) / 2));
  let start = Math.max(0, speech[0]![0] - PAD_SAMPLES);
  const end = Math.min(n, speech.at(-1)![1] + PAD_SAMPLES);
  const chunks: Span[] = [];
  while (end - start > MAX_CHUNK_SAMPLES) {
    const limit = start + MAX_CHUNK_SAMPLES;
    const fit = cuts.filter((c) => c > start + MIN_CHUNK_SAMPLES && c <= limit);
    const cut = fit.length > 0 ? fit.at(-1)! : quietestFrame(samples, limit - FALLBACK_WINDOW, limit);
    chunks.push([start, cut]);
    start = cut;
  }
  chunks.push([start, end]);
  return chunks;
}
