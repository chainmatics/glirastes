import { describe, expect, it, vi } from 'vitest';
import { planChunks, type Span } from '../chunking.js';
import { createSherpaEngine, recognizerConfig, vadConfig } from '../engine.js';
import type { SherpaModule, SherpaOfflineStream } from '../sherpa-types.js';

const s = (seconds: number) => Math.round(seconds * 16000);

interface FakeOptions { texts?: string[]; spans?: Span[] }

function fakeSherpa(options: FakeOptions = {}) {
  const texts = [...(options.texts ?? [])];
  const decoded: number[] = [];
  const windows: number[] = [];
  const calls = { created: 0, createdAsync: 0, decode: 0, decodeAsync: 0, vads: [] as Array<{ config: object; bufferSeconds: number }> };
  class Stream implements SherpaOfflineStream {
    length = 0;
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }) {
      expect(input.sampleRate).toBe(16000);
      this.length = input.samples.length;
      decoded.push(input.samples.length);
    }
  }
  const recognizer = {
    createStream: () => new Stream(),
    decode: vi.fn(() => { calls.decode += 1; }),
    decodeAsync: vi.fn(async () => { calls.decodeAsync += 1; return { text: texts.shift() ?? '' }; }),
    getResult: vi.fn(() => ({ text: texts.shift() ?? '' })),
  };
  class OfflineRecognizer {
    static config: object | undefined;
    constructor(config: object) {
      calls.created += 1;
      OfflineRecognizer.config = config;
      return recognizer as unknown as OfflineRecognizer;
    }
    static async createAsync(config: object) {
      calls.createdAsync += 1;
      OfflineRecognizer.config = config;
      return recognizer;
    }
  }
  class Vad {
    queue: Array<{ start: number; samples: Float32Array }> = [];
    constructor(config: object, bufferSeconds: number) {
      calls.vads.push({ config, bufferSeconds });
    }
    acceptWaveform(samples: Float32Array) { windows.push(samples.length); }
    isEmpty() { return this.queue.length === 0; }
    front() { return this.queue[0]!; }
    pop() { this.queue.shift(); }
    flush() {
      this.queue = (options.spans ?? []).map(([a, b]) => ({ start: a, samples: new Float32Array(b - a) }));
    }
  }
  const sherpa = { OfflineRecognizer, Vad } as unknown as SherpaModule;
  return { sherpa, decoded, windows, calls, texts, OfflineRecognizer };
}

const loud = (length: number) => new Float32Array(length).fill(0.5);
const never = () => false;

describe('engine config', () => {
  it('passes the pinned recognizer and VAD config', () => {
    expect(recognizerConfig({ modelDir: '/m', numThreads: 2 })).toEqual({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: '/m/parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx',
          decoder: '/m/parakeet-tdt-0.6b-v3-int8/decoder.int8.onnx',
          joiner: '/m/parakeet-tdt-0.6b-v3-int8/joiner.int8.onnx',
        },
        tokens: '/m/parakeet-tdt-0.6b-v3-int8/tokens.txt',
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
        modelType: 'nemo_transducer',
      },
    });
    expect(vadConfig('/m')).toEqual({
      sileroVad: {
        model: '/m/silero-vad/silero_vad.onnx',
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.5,
        maxSpeechDuration: 19,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    });
  });
});

describe('createSherpaEngine', () => {
  it('warms up with one second of silence after loading', async () => {
    const fake = fakeSherpa();
    await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 3 }, 'sync');
    expect(fake.calls.created).toBe(1);
    expect(fake.decoded).toEqual([16000]);
    expect((fake.OfflineRecognizer.config as { modelConfig: { numThreads: number } }).modelConfig.numThreads).toBe(3);
  });

  it('decodes audio of 20 s or less whole without creating a VAD', async () => {
    const fake = fakeSherpa({ texts: ['', ' Hallo Welt '] });
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'sync');
    expect(await engine.transcribe(loud(s(20)), never)).toBe('Hallo Welt');
    expect(fake.decoded).toEqual([16000, s(20)]);
    expect(fake.calls.vads).toEqual([]);
  });

  it('returns an empty string for empty audio without decoding', async () => {
    const fake = fakeSherpa();
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'sync');
    expect(await engine.transcribe(new Float32Array(0), never)).toBe('');
    expect(fake.decoded).toEqual([16000]);
  });

  it('decodes original-audio chunks, not VAD segments, and joins texts with single spaces', async () => {
    const spans: Span[] = [[s(1), s(18)], [s(19), s(36)], [s(37), s(55)]];
    const fake = fakeSherpa({ texts: ['', ' a ', '', 'b'], spans });
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'sync');
    const samples = loud(s(60));
    expect(await engine.transcribe(samples, never)).toBe('a b');
    const plan = planChunks(samples, spans);
    expect(plan).toHaveLength(3);
    expect(fake.decoded.slice(1)).toEqual(plan.map(([a, b]) => b - a));
    expect(fake.calls.vads).toHaveLength(1);
    expect(fake.calls.vads[0]!.bufferSeconds).toBe(65);
    expect(fake.calls.vads[0]!.config).toEqual(vadConfig('/m'));
    expect(fake.windows.slice(0, -1).every((length) => length === 512)).toBe(true);
    expect(fake.windows.reduce((a, b) => a + b, 0)).toBe(s(60));
  });

  it('returns an empty string when the VAD finds no speech', async () => {
    const fake = fakeSherpa({ spans: [] });
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'sync');
    expect(await engine.transcribe(loud(s(30)), never)).toBe('');
    expect(fake.decoded).toEqual([16000]);
  });

  it('lifts quiet audio before decoding', async () => {
    const fake = fakeSherpa();
    let seen: Float32Array | undefined;
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'sync');
    const stream = { acceptWaveform: (input: { samples: Float32Array }) => { seen = input.samples; } };
    // The fake constructor returns one shared recognizer object.
    const recognizer = new fake.sherpa.OfflineRecognizer({});
    recognizer.createStream = () => stream as never;
    await engine.transcribe(new Float32Array(10).fill(0.01), never);
    expect(seen![0]).toBeCloseTo(0.2, 6);
  });

  it('stops between chunks when asked', async () => {
    const spans: Span[] = [[s(1), s(18)], [s(19), s(36)], [s(37), s(55)]];
    const fake = fakeSherpa({ texts: ['', 'a', 'b', 'c'], spans });
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'sync');
    const error = await engine.transcribe(loud(s(60)), () => fake.decoded.length - 1 >= 1).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(fake.decoded.length - 1).toBe(1);
  });

  it('checks for a stop before the first chunk', async () => {
    const fake = fakeSherpa();
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'sync');
    const error = await engine.transcribe(loud(s(5)), () => true).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(fake.decoded).toEqual([16000]);
  });

  it('uses decodeAsync and createAsync in async mode', async () => {
    const fake = fakeSherpa({ texts: ['', 'hallo'] });
    const engine = await createSherpaEngine(fake.sherpa, { modelDir: '/m', numThreads: 2 }, 'async');
    expect(await engine.transcribe(loud(s(3)), never)).toBe('hallo');
    expect(fake.calls.createdAsync).toBe(1);
    expect(fake.calls.created).toBe(0);
    expect(fake.calls.decodeAsync).toBe(2);
    expect(fake.calls.decode).toBe(0);
  });
});
