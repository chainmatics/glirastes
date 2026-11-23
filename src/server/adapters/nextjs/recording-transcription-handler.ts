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
  /** Default 5 MiB. Checked against `content-length` and while reading, before the whole body is held. */
  maxBytes?: number;
  /** Longest recording, from the WAV header. Default 60 seconds. */
  maxDurationSeconds?: number;
  /** Default 45 seconds, including the wait for a free slot. */
  timeoutMs?: number;
  /** Transcriptions running at once. Default 2. */
  maxConcurrent?: number;
  /** Requests waiting for a slot; more answer 429. Default 8. */
  maxQueued?: number;
  /**
   * Protected profile: refuse a service URL that is not a private address
   * (loopback, RFC 1918/ULA, a single-label service name such as `stt`, or
   * `.internal`/`.local`/`.svc`/`.cluster.local`). There is never a cloud
   * fallback. Default false.
   */
  localOnly?: boolean;
  /**
   * The speech part of the effective privacy policy, read per request:
   * `() => glirastes.speechPolicy()` on the managed path. A protected policy
   * forces `localOnly` and caps the duration at the shorter of both limits.
   * Only an explicit `'off'` means no protected policy applies, and the
   * options above apply. `null`, `undefined`, anything malformed or a throw
   * (managed runtime without a verified, unrevoked policy) answer 503:
   * there is no fallback to local or cloud defaults. Leave `policy` unset
   * only for a route outside any privacy integration.
   */
  policy?: () => SpeechPrivacyPolicy | 'off' | null | undefined;
  /** Receives a content-free failure for the server log; the browser only learns that it failed. */
  onError?: (error: unknown) => void;
  fetch?: typeof globalThis.fetch;
  /** Only in `LocalRecordingTranscriptionHandlerConfig`. */
  transcribe?: never;
}

/** The handler config that transcribes in the app's own server instead of calling a service. */
export interface LocalRecordingTranscriptionHandlerConfig {
  maxDurationSeconds?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  localOnly?: boolean;
  policy?: () => SpeechPrivacyPolicy | 'off' | null | undefined;
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

/** The speech limits of a protected privacy policy (`EffectivePrivacyPolicy['speech']`). */
export interface SpeechPrivacyPolicy {
  localOnly: true;
  maxDurationSeconds: number;
}

const failed = (status: number, error: string, headers?: Record<string, string>) =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store', ...headers } });

class TranscriptionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TranscriptionFailure';
  }
}

/**
 * The policy for one request: `null` without a resolver or for an explicit
 * `'off'`; throws `policy_unavailable` for anything else that is not a
 * protected policy, `null` and `undefined` included.
 */
function speechPolicy(read: (() => SpeechPrivacyPolicy | 'off' | null | undefined) | undefined): SpeechPrivacyPolicy | null {
  if (!read) return null;
  let policy: unknown;
  try {
    policy = read();
  } catch {
    throw new TranscriptionFailure('policy_unavailable');
  }
  if (policy === 'off') return null;
  if (policy === null || policy === undefined) throw new TranscriptionFailure('policy_unavailable');
  const candidate = policy as Partial<SpeechPrivacyPolicy>;
  if (
    typeof policy !== 'object'
    || candidate.localOnly !== true
    || !Number.isSafeInteger(candidate.maxDurationSeconds)
    || candidate.maxDurationSeconds! <= 0
  ) {
    throw new TranscriptionFailure('policy_unavailable');
  }
  return { localOnly: true, maxDurationSeconds: candidate.maxDurationSeconds! };
}

/** True for an address that stays inside the consumer's own network. */
export function isPrivateServiceUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host)) return true; // compose/k8s service name
  if (/\.(internal|local|svc|cluster\.local|lan)$/.test(host)) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^f[cd][0-9a-f]{2}:/.test(host);
}

/**
 * Duration of a PCM WAV recording, measured from the `fmt ` fields (sample
 * rate, channels, bits per sample) and the bytes that follow the `data`
 * header. The header's own `byteRate` is never trusted: it must agree with
 * those fields, as must `blockAlign`. Returns `undefined` for anything else
 * (not RIFF/WAVE, non-PCM, inconsistent or zero fields, no `data`), so the
 * handler fails closed.
 */
export function wavDurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let bytesPerSecond: number | undefined;
  let dataBytes: number | undefined;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && bytesPerSecond === undefined) {
      if (size < 16 || offset + 8 + 16 > bytes.byteLength) return undefined;
      const body = offset + 8;
      let format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe) {
        if (size < 40 || body + 26 > bytes.byteLength) return undefined;
        format = view.getUint16(body + 24, true);
      }
      if (format !== 1) return undefined; // only integer PCM can be measured
      if (channels < 1 || sampleRate < 1 || bits < 8 || bits % 8 !== 0 || bits > 32) return undefined;
      if (blockAlign !== channels * (bits / 8)) return undefined;
      if (byteRate !== sampleRate * blockAlign) return undefined;
      bytesPerSecond = byteRate;
    }
    if (id === 'data') {
      // Everything after the data header counts, whatever the chunk size claims:
      // the whole file is what gets transcribed.
      dataBytes = bytes.byteLength - offset - 8;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!bytesPerSecond || dataBytes === undefined) return undefined;
  return dataBytes / bytesPerSecond;
}

/**
 * Reads at most `limit` bytes. `undefined` when the body is longer; throws
 * `upload_timeout` / `aborted` when the signal fires first, cancelling the
 * stream so a slow upload is cut off.
 */
async function readCapped(request: Request, limit: number, signal: AbortSignal, timedOut: () => boolean): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const stop = new Promise<never>((_resolve, reject) => {
    const fire = () => reject(new TranscriptionFailure(timedOut() ? 'upload_timeout' : 'aborted'));
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });
  stop.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stop]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A counting gate: `maxConcurrent` slots, `maxQueued` waiting. */
function createGate(maxConcurrent: number, maxQueued: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return {
    async acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
      if (running < maxConcurrent) {
        running += 1;
      } else {
        if (waiting.length >= maxQueued) return undefined;
        await new Promise<void>((resolve, reject) => {
          const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
          const abort = () => {
            const index = waiting.indexOf(wake);
            if (index >= 0) waiting.splice(index, 1);
            reject(new TranscriptionFailure('aborted'));
          };
          waiting.push(wake);
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiting.shift();
        if (next) next(); // the slot passes on; `running` stays the same
        else running -= 1;
      };
    },
  };
}

function contentFreeError(error: unknown): string {
  if (error instanceof TranscriptionFailure) return error.code;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

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
  const configuredMaxDuration = config.maxDurationSeconds ?? Infinity;
  const timeoutMs = config.timeoutMs ?? (transcribe ? 120_000 : 45_000);
  const gate = createGate(Math.max(1, config.maxConcurrent ?? 2), Math.max(0, config.maxQueued ?? 8));
  const onError = config.onError
    ?? ((error: unknown) => console.error(`[speech] Recording transcription failed: ${contentFreeError(error)}`));

  return async function POST(request: Request): Promise<Response> {
    if (!(await config.authorize(request))) return failed(401, 'Authentication required');
    let policy: SpeechPrivacyPolicy | null;
    try {
      policy = speechPolicy(config.policy);
    } catch (error) {
      onError(error);
      return failed(503, 'Speech service not available');
    }
    const localOnly = policy ? true : config.localOnly;
    const maxDuration = Math.min(configuredMaxDuration, policy?.maxDurationSeconds ?? Infinity);
    if (!transcribe && !config.url) return failed(503, 'Speech service not configured');
    if (!transcribe && localOnly && !isPrivateServiceUrl(config.url!)) {
      onError(new TranscriptionFailure('service_not_local'));
      return failed(503, 'Speech service not configured');
    }
    if (!request.headers.get('content-type')?.startsWith('audio/wav')) return failed(415, 'Unsupported audio format');
    const language = new URL(request.url).searchParams.get('language') || config.defaultLanguage || 'de';
    if (!languages.includes(language)) return failed(400, 'Unsupported language');
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return failed(413, 'Recording too long');

    // Ordinary local transcription retains upstream concurrency and starts its
    // timer only after upload. Privacy or explicit limits opt into the bounded gate.
    const constrained = policy !== null || config.maxConcurrent !== undefined || config.maxQueued !== undefined
      || config.maxDurationSeconds !== undefined;
    // Protected calls have one deadline for queue, upload and transcription.
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startDeadline = () => { timer = setTimeout(() => deadline.abort(new DOMException('Transcription timed out', 'TimeoutError')), timeoutMs); };
    if (constrained || !transcribe) startDeadline();
    const timeout = deadline.signal;
    const signal = AbortSignal.any([request.signal, timeout]);
    let release: (() => void) | undefined;
    try {
      if (constrained) {
        release = await gate.acquire(signal);
        if (!release) return failed(429, 'Speech service busy', { 'retry-after': '5' });
      }

      // Only a request that holds a slot has its body read, and the read is
      // bounded by size and by the deadline.
      const audio = await readCapped(request, maxBytes, signal, () => timeout.aborted);
      if (!audio) return failed(413, 'Recording too long');
      if (audio.byteLength === 0) return failed(400, 'Empty recording');
      // Policy may change while queued or uploading: never dispatch under the old decision.
      const dispatchPolicy = speechPolicy(config.policy);
      if (JSON.stringify(dispatchPolicy) !== JSON.stringify(policy)) return failed(503, 'Speech policy changed');
      if (constrained) {
        const duration = wavDurationSeconds(audio);
        if (duration === undefined) return failed(415, 'Unsupported audio format');
        if (duration > maxDuration) return failed(413, 'Recording too long');
      }

      if (transcribe) {
        const samples = decodeRecordingWav(new Uint8Array(audio).buffer);
        if (!samples) return failed(415, 'Unsupported audio format');
        if (!constrained) startDeadline();
        const result = await transcribe({ samples, sampleRate: 16000 }, { language: language.slice(0, 2), signal });
        return Response.json({ text: typeof result?.text === 'string' ? result.text.trim() : '' });
      }
      const form = new FormData();
      form.set('file', new File([audio as BlobPart], 'recording.wav', { type: 'audio/wav' }));
      form.set('model', config.model || 'parakeet-tdt-0.6b-v3');
      form.set('language', language.slice(0, 2));

      const response = await (config.fetch ?? globalThis.fetch)(`${trimTrailingSlashes(config.url!)}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
        body: form,
        // A redirect could lead the audio elsewhere: never follow one.
        redirect: 'manual',
        signal,
      });
      if (!response.ok) throw new TranscriptionFailure(`service_status_${response.status}`);
      const result = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined;
      if (!result || typeof result.text !== 'string') throw new TranscriptionFailure('invalid_result');
      return Response.json({ text: result.text.trim() }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (transcribe && isUnavailable(error)) return failed(503, 'Speech service busy');
      if (transcribe && timeout.aborted) {
        onError(new TranscriptionFailure('transcription_timeout'));
        return failed(504, 'Transcription timed out');
      }
      if (request.signal.aborted) return failed(499, transcribe ? 'Client closed request' : 'Recording cancelled');
      if (error instanceof TranscriptionFailure && error.code === 'upload_timeout') {
        onError(error);
        return failed(408, 'Upload timed out');
      }
      onError(error instanceof TranscriptionFailure ? error : new TranscriptionFailure(contentFreeError(error)));
      return failed(502, 'Transcription failed');
    } finally {
      clearTimeout(timer);
      release?.();
    }
  };
}
