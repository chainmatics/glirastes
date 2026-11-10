import type {
  SttProviderAdapter,
  SttProviderConnection,
} from './controller.js';
import { createPcmPipeline } from './deepgram.js';

const SAMPLE_RATE = 16_000;

export interface RecordedSttAdapterOptions {
  /** Endpoint that takes the WAV and answers `{ text }`. Default: `/api/ai/speech-recognize`. */
  url?: string;
  /** Extra request headers, read when the recording is sent. */
  getHeaders?: () => Record<string, string> | undefined;
  /** Longest recording kept, in seconds; later audio is dropped. Default: 120. */
  maxSeconds?: number;
  /** For tests and non-browser hosts. */
  fetch?: typeof fetch;
  /** Audio capture as 16 kHz mono PCM chunks; returns its stop function. */
  capture?: (
    stream: MediaStream,
    onAudio: (audio: ArrayBuffer) => void,
  ) => Promise<() => Promise<void>>;
}

/** 16-bit mono PCM chunks as one WAV file. */
export function encodeWav(chunks: ReadonlyArray<Int16Array>, sampleRate: number): ArrayBuffer {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1, offset += 2) view.setInt16(offset, chunk[i], true);
  }
  return buffer;
}

/**
 * Speech input for a transcription model that takes a finished recording
 * instead of a live stream (Parakeet, Whisper and the like): the audio is
 * kept in the browser while the user speaks and sent once when they stop.
 * There is no interim text; the transcript arrives as one final segment.
 *
 * The endpoint is the app's own route. It receives `audio/wav` (16 kHz, mono,
 * 16 bit) with the language as a query parameter and answers `{ "text": … }`.
 */
export class RecordedSttAdapter implements SttProviderAdapter {
  constructor(private readonly options: RecordedSttAdapterOptions = {}) {}

  async connect(input: Parameters<SttProviderAdapter['connect']>[0]): Promise<SttProviderConnection> {
    const maxSamples = (this.options.maxSeconds ?? 120) * SAMPLE_RATE;
    const chunks: Int16Array[] = [];
    let kept = 0;
    let discarded = false;
    let sent: Promise<void> | null = null;
    const request = new AbortController();

    let stopCapture: (() => Promise<void>) | null = await (this.options.capture ?? createPcmPipeline)(
      input.stream,
      (audio) => {
        if (discarded || kept >= maxSamples) return;
        const chunk = new Int16Array(audio).slice(0, maxSamples - kept);
        chunks.push(chunk);
        kept += chunk.length;
      },
    );
    const endCapture = async () => {
      const stop = stopCapture;
      stopCapture = null;
      await stop?.();
    };
    const discard = async () => {
      discarded = true;
      chunks.length = 0;
      request.abort();
      await endCapture();
    };
    input.signal.addEventListener('abort', () => { void discard(); }, { once: true });

    const send = async () => {
      await endCapture();
      if (discarded || kept === 0) return;
      const base = typeof window === 'undefined' ? undefined : window.location.href;
      const url = new URL(this.options.url ?? '/api/ai/speech-recognize', base);
      url.searchParams.set('language', input.language);
      try {
        const response = await (this.options.fetch ?? fetch)(url.toString(), {
          method: 'POST',
          headers: { ...this.options.getHeaders?.(), 'content-type': 'audio/wav' },
          body: encodeWav(chunks, SAMPLE_RATE),
          credentials: 'same-origin',
          signal: request.signal,
        });
        if (!response.ok) throw new Error('Transcription failed');
        const result = await response.json() as { text?: unknown };
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        if (text && !discarded) {
          input.events.onSegment({ id: 'recording', sequence: 0, text, isFinal: true });
        }
      } catch {
        // The server's own words stay out of the UI.
        if (!discarded) input.events.onError(new Error('Transcription failed'));
      } finally {
        chunks.length = 0;
      }
    };

    return {
      finalize: () => (sent ??= send()),
      cancel: discard,
      close: discard,
    };
  }
}
