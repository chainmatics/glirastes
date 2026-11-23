import { join } from 'node:path';
import { needsVad, planChunks, SAMPLE_RATE, type Span } from './chunking.js';
import { normalizeGain } from './gain.js';
import { PARAKEET_DIR, SILERO_VAD_PATH } from './models.js';
import type { SherpaModule, SherpaOfflineRecognizer } from './sherpa-types.js';

export interface EngineOptions {
  modelDir: string;
  numThreads: number;
}

export interface SttEngine {
  /** Throws an AbortError-named Error when shouldStop() is true between chunks. */
  transcribe(samples: Float32Array, shouldStop: () => boolean): Promise<string>;
}

const VAD_WINDOW = 512;

export function recognizerConfig(o: EngineOptions) {
  const dir = join(o.modelDir, PARAKEET_DIR);
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(dir, 'encoder.int8.onnx'),
        decoder: join(dir, 'decoder.int8.onnx'),
        joiner: join(dir, 'joiner.int8.onnx'),
      },
      tokens: join(dir, 'tokens.txt'),
      numThreads: o.numThreads,
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
  };
}

export function vadConfig(modelDir: string) {
  return {
    sileroVad: {
      model: join(modelDir, SILERO_VAD_PATH),
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      maxSpeechDuration: 19,
      windowSize: VAD_WINDOW,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  };
}

export function abortError(): Error {
  const error = new Error('Transcription aborted');
  error.name = 'AbortError';
  return error;
}

/** Speech spans the Silero VAD finds; used only to place cuts. */
function speechSpans(sherpa: SherpaModule, modelDir: string, samples: Float32Array): Span[] {
  const vad = new sherpa.Vad(vadConfig(modelDir), Math.ceil(samples.length / SAMPLE_RATE) + 5);
  const spans: Span[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      spans.push([segment.start, segment.start + segment.samples.length]);
      vad.pop();
    }
  };
  for (let i = 0; i < samples.length; i += VAD_WINDOW) {
    vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW));
    drain();
  }
  vad.flush();
  drain();
  return spans;
}

/**
 * Loads the Parakeet recognizer (sync in a worker, async on the libuv
 * threadpool for `mode: 'inline'`), warms it up with one second of silence,
 * and transcribes by gain → VAD silences → ≤ 20 s chunks of the original
 * audio, checking `shouldStop` before each chunk.
 */
export async function createSherpaEngine(sherpa: SherpaModule, o: EngineOptions, decode: 'sync' | 'async'): Promise<SttEngine> {
  const config = recognizerConfig(o);
  const recognizer: SherpaOfflineRecognizer = decode === 'async'
    ? await sherpa.OfflineRecognizer.createAsync(config)
    : new sherpa.OfflineRecognizer(config);

  const decodeChunk = async (samples: Float32Array): Promise<string> => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    if (decode === 'async') return (await recognizer.decodeAsync(stream)).text;
    recognizer.decode(stream);
    return recognizer.getResult(stream).text;
  };

  await decodeChunk(new Float32Array(SAMPLE_RATE));

  return {
    async transcribe(input, shouldStop) {
      if (input.length === 0) return '';
      const samples = normalizeGain(input);
      const chunks: Span[] = needsVad(samples.length)
        ? planChunks(samples, speechSpans(sherpa, o.modelDir, samples))
        : [[0, samples.length]];
      const texts: string[] = [];
      for (const [start, end] of chunks) {
        if (shouldStop()) throw abortError();
        const text = (await decodeChunk(samples.subarray(start, end))).trim();
        if (text) texts.push(text);
      }
      return texts.join(' ');
    },
  };
}
