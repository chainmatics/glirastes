/**
 * Lifts very quiet recordings before VAD and decode: when `0 < peak < 0.1`,
 * scales by `min(0.5 / peak, 20)` (Parakeet model card; sherpa-onnx#4024).
 * Returns the input itself when no scaling is needed.
 */
export function normalizeGain(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]!);
    if (value > peak) peak = value;
  }
  if (!(peak > 0 && peak < 0.1)) return samples;
  const gain = Math.min(0.5 / peak, 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i]! * gain;
  return out;
}
