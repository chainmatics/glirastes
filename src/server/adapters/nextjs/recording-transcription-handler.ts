import { trimTrailingSlashes } from '../../../contracts/url.js';
import { decodeRecordingWav } from './recording-wav.js';
/** The languages a recording may be transcribed in, unless the app sets its own list. */
export const DEFAULT_RECORDING_LANGUAGES = ['de', 'en', 'de-DE', 'en-US', 'en-GB', 'fr', 'es', 'it', 'nl', 'pt'] as const;

/** A decoded recording: mono samples in [-1, 1) at 16 kHz. */
export interface RecordingAudio {
  samples: Float32Array;
  sampleRate: 16000;
}

/**
 * Transcribes a decoded recording inside the app's own server, for example
 * `createLocalTranscriber().transcribe` from `glirastes/server/stt-local`.
 * `language` is the two-letter code; `signal` aborts on client disconnect or timeout.
 */
export type RecordingTranscriber = (
  audio: RecordingAudio,
  options: { language: string; signal: AbortSignal },
) => Promise<{ text: string }>;

/** Thrown by a `RecordingTranscriber` that cannot take another job now; the handler answers 503. */
export class TranscriptionUnavailableError extends Error {
  constructor(message = 'Transcription unavailable') {
    super(message);
    this.name = 'TranscriptionUnavailableError';
  }
}

export interface RecordingTranscriptionHandlerConfig {
  /** The app's own session check; `false` answers 401 before the audio is read. */
  authorize(request: Request): boolean | Promise<boolean>;
  /** Base URL of a service with the common `POST /v1/audio/transcriptions` API (Parakeet, Whisper, …); unset answers 503. */
  url: string | undefined;
  /** Sent as `Bearer` token when set. */
  apiKey?: string;
  /** Default `parakeet-tdt-0.6b-v3`. */
  model?: string;
  /** Allowed `?language=` values; the first two letters go to the service. Default `DEFAULT_RECORDING_LANGUAGES`. */
  languages?: readonly string[];
  /** Used when the request names no language. Default `de`. */
  defaultLanguage?: string;
  /** Default 5 MB, more than two minutes of 16 kHz mono 16-bit audio. */
  maxBytes?: number;
  /** Default 45 seconds. */
  timeoutMs?: number;
  /** Receives the failure for the server log; the browser only learns that it failed. */
  onError?: (error: unknown) => void;
  fetch?: typeof globalThis.fetch;
  /** Only in `LocalRecordingTranscriptionHandlerConfig`. */
  transcribe?: never;
}

/** The handler config that transcribes in the app's own server instead of calling a service. */
export interface LocalRecordingTranscriptionHandlerConfig {
  /** The app's own session check; `false` answers 401 before the audio is read. */
  authorize(request: Request): boolean | Promise<boolean>;
  /** Allowed `?language=` values; the first two letters go to `transcribe`. Default `DEFAULT_RECORDING_LANGUAGES`. */
  languages?: readonly string[];
  /** Used when the request names no language. Default `de`. */
  defaultLanguage?: string;
  /** Default 5 MB, more than two minutes of 16 kHz mono 16-bit audio. */
  maxBytes?: number;
  /** Default 120 seconds. */
  timeoutMs?: number;
  /** Receives the failure for the server log; the browser only learns that it failed. */
  onError?: (error: unknown) => void;
  /** Receives PCM16 mono 16 kHz recordings as samples; any other WAV answers 415. A `TranscriptionUnavailableError` answers 503. */
  transcribe: RecordingTranscriber;
  url?: never;
  apiKey?: never;
  model?: never;
  fetch?: never;
}

const failed = (status: number, error: string) => Response.json({ error }, { status });

/** Duck-typed so a CommonJS and an ESM copy of the class agree. */
const isUnavailable = (error: unknown) => error instanceof Error && error.name === 'TranscriptionUnavailableError';

/**
 * A Next.js route handler for the `recording` speech input
 * (`RecordedSttAdapter`, which posts `audio/wav` to `/api/ai/speech-recognize`).
 * It checks the app's session, the format, language and size, and either
 * forwards the recording to the app's own transcription service (`url`), whose
 * address, key and model stay on the server, or decodes it and hands the
 * samples to a local `transcribe` function.
 */
export function createRecordingTranscriptionHandler(
  config: RecordingTranscriptionHandlerConfig | LocalRecordingTranscriptionHandlerConfig,
) {
  const transcribe = 'transcribe' in config && config.transcribe ? config.transcribe : undefined;
  const languages = config.languages ?? DEFAULT_RECORDING_LANGUAGES;
  const maxBytes = config.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = config.timeoutMs ?? (transcribe ? 120_000 : 45_000);
  const onError = config.onError
    ?? ((error: unknown) => console.error('[speech] Recording transcription failed:', error instanceof Error ? error.message : 'unknown error'));

  return async function POST(request: Request): Promise<Response> {
    if (!(await config.authorize(request))) return failed(401, 'Authentication required');
    if (!transcribe && !config.url) return failed(503, 'Speech service not configured');
    if (!request.headers.get('content-type')?.startsWith('audio/wav')) return failed(415, 'Unsupported audio format');
    const language = new URL(request.url).searchParams.get('language') || config.defaultLanguage || 'de';
    if (!languages.includes(language)) return failed(400, 'Unsupported language');

    const audio = await request.arrayBuffer();
    if (audio.byteLength === 0) return failed(400, 'Empty recording');
    if (audio.byteLength > maxBytes) return failed(413, 'Recording too long');

    if (transcribe) {
      const samples = decodeRecordingWav(audio);
      if (!samples) return failed(415, 'Unsupported audio format');
      // A cleared timer instead of AbortSignal.timeout, so a finished job leaves no timer behind.
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new DOMException('Transcription timed out', 'TimeoutError')), timeoutMs);
      try {
        const signal = AbortSignal.any([request.signal, timeout.signal]);
        const result = await transcribe({ samples, sampleRate: 16000 }, { language: language.slice(0, 2), signal });
        return Response.json({ text: typeof result?.text === 'string' ? result.text.trim() : '' });
      } catch (error) {
        if (isUnavailable(error)) return failed(503, 'Speech service busy');
        // The client left: nobody reads this answer, and it is not a server error.
        if (request.signal.aborted) return failed(499, 'Client closed request');
        onError(error);
        if (timeout.signal.aborted) return failed(504, 'Transcription timed out');
        return failed(502, 'Transcription failed');
      } finally {
        clearTimeout(timer);
      }
    }

    const form = new FormData();
    form.set('file', new File([audio], 'recording.wav', { type: 'audio/wav' }));
    form.set('model', config.model || 'parakeet-tdt-0.6b-v3');
    form.set('language', language.slice(0, 2));

    try {
      const response = await (config.fetch ?? globalThis.fetch)(`${trimTrailingSlashes(config.url!)}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`transcription service answered ${response.status}`);
      const result = (await response.json()) as { text?: unknown };
      return Response.json({ text: typeof result.text === 'string' ? result.text.trim() : '' });
    } catch (error) {
      onError(error);
      return failed(502, 'Transcription failed');
    }
  };
}
