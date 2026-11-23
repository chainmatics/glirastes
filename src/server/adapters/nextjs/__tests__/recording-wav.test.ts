import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../../../react/stt/recorded.js';
import { decodeRecordingWav } from '../recording-wav.js';

interface Chunk { id: string; body: Uint8Array; size?: number }

/** Builds a RIFF/WAVE file from raw chunks, padding odd-sized chunks like a conforming writer. */
function riff(chunks: readonly Chunk[], form = 'WAVE', magic = 'RIFF'): ArrayBuffer {
  const parts: number[] = [];
  const ascii = (value: string) => { for (const c of value) parts.push(c.charCodeAt(0)); };
  const u32 = (value: number) => { parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff); };
  ascii(form);
  for (const chunk of chunks) {
    ascii(chunk.id);
    u32(chunk.size ?? chunk.body.length);
    parts.push(...chunk.body);
    if (chunk.size === undefined && chunk.body.length % 2 === 1) parts.push(0);
  }
  const out = new Uint8Array(8 + parts.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) out[i] = magic.charCodeAt(i);
  view.setUint32(4, parts.length, true);
  out.set(parts, 8);
  return out.buffer;
}

function fmt(options: { format?: number; channels?: number; rate?: number; bits?: number } = {}): Chunk {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  const channels = options.channels ?? 1;
  const rate = options.rate ?? 16000;
  const bits = options.bits ?? 16;
  view.setUint16(0, options.format ?? 1, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, rate, true);
  view.setUint32(8, rate * channels * (bits / 8), true);
  view.setUint16(12, channels * (bits / 8), true);
  view.setUint16(14, bits, true);
  return { id: 'fmt ', body };
}

const pcm = (...values: number[]) => {
  const body = new Uint8Array(values.length * 2);
  const view = new DataView(body.buffer);
  values.forEach((value, i) => view.setInt16(i * 2, value, true));
  return body;
};

describe('decodeRecordingWav', () => {
  it("decodes the browser's 44-byte PCM16 mono 16 kHz file", () => {
    const samples = decodeRecordingWav(encodeWav([Int16Array.of(0, 16384, -32768)], 16000));
    expect(samples).toBeInstanceOf(Float32Array);
    expect(Array.from(samples!)).toEqual([0, 0.5, -1]);
  });

  it('skips unknown chunks before data (LIST, FLLR) and honours odd-size padding', () => {
    const file = riff([
      { id: 'LIST', body: Uint8Array.of(1, 2, 3) },
      fmt(),
      { id: 'FLLR', body: new Uint8Array(6) },
      { id: 'data', body: pcm(16384, -16384) },
    ]);
    expect(Array.from(decodeRecordingWav(file)!)).toEqual([0.5, -0.5]);
  });

  it('refuses stereo, 44.1 kHz, 24-bit, float and non-RIFF input', () => {
    const data = { id: 'data', body: pcm(1, 2, 3, 4, 5, 6) };
    expect(decodeRecordingWav(riff([fmt({ channels: 2 }), data]))).toBeUndefined();
    expect(decodeRecordingWav(riff([fmt({ rate: 44100 }), data]))).toBeUndefined();
    expect(decodeRecordingWav(riff([fmt({ bits: 24 }), data]))).toBeUndefined();
    expect(decodeRecordingWav(riff([fmt({ format: 3, bits: 32 }), data]))).toBeUndefined();
    expect(decodeRecordingWav(riff([fmt(), data], 'WAVE', 'RIFX'))).toBeUndefined();
    expect(decodeRecordingWav(riff([fmt(), data], 'AVI '))).toBeUndefined();
    expect(decodeRecordingWav(new Uint8Array(8).fill(1).buffer)).toBeUndefined();
    expect(decodeRecordingWav(new ArrayBuffer(0))).toBeUndefined();
  });

  it('reads to the end of the buffer when the data size lies', () => {
    const file = riff([fmt(), { id: 'data', body: Uint8Array.of(0, 64, 0, 192, 7), size: 0xffffffff }]);
    expect(Array.from(decodeRecordingWav(file)!)).toEqual([0.5, -0.5]);
  });

  it('drops a trailing odd byte of a data chunk', () => {
    const file = riff([fmt(), { id: 'data', body: Uint8Array.of(0, 64, 9) }]);
    expect(Array.from(decodeRecordingWav(file)!)).toEqual([0.5]);
  });

  it('refuses a data chunk before any fmt chunk', () => {
    expect(decodeRecordingWav(riff([{ id: 'data', body: pcm(1, 2) }, fmt()]))).toBeUndefined();
  });

  it('refuses a file without a data chunk or with a truncated chunk header', () => {
    expect(decodeRecordingWav(riff([fmt()]))).toBeUndefined();
    const truncated = riff([fmt(), { id: 'data', body: pcm(1) }]).slice(0, 40);
    expect(() => decodeRecordingWav(truncated)).not.toThrow();
  });
});
