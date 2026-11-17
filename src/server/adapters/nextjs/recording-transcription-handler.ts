import { trimTrailingSlashes } from '../../../contracts/url.js';
/** The languages a recording may be transcribed in, unless the app sets its own list. */
export const DEFAULT_RECORDING_LANGUAGES = ['de', 'en', 'de-DE', 'en-US', 'en-GB', 'fr', 'es', 'it', 'nl', 'pt'] as const;

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
  /** Receives a content-free failure for the server log; the browser only learns that it failed. */
  onError?: (error: unknown) => void;
  fetch?: typeof globalThis.fetch;
}

const failed = (status: number, error: string, headers?: Record<string, string>) =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store', ...headers } });

class TranscriptionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TranscriptionFailure';
  }
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
 * Duration of a PCM WAV recording from its `fmt ` and `data` chunks, or
 * `undefined` when the bytes are not a well-formed RIFF/WAVE file.
 */
export function wavDurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && size >= 16 && offset + 24 <= bytes.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') {
      dataBytes = Math.min(size, bytes.byteLength - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes === undefined) return undefined;
  return dataBytes / byteRate;
}

/** Reads at most `limit` bytes; `undefined` when the body is longer. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
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

/**
 * A Next.js route handler for the `recording` speech input
 * (`RecordedSttAdapter`, which posts `audio/wav` to `/api/ai/speech-recognize`).
 * It checks the app's session, the format, language, size and duration, and
 * forwards the recording to the app's own transcription service, whose
 * address, key and model stay on the server. Audio is held in memory for
 * the request only and never logged; the transcript goes back to the
 * browser for review and never triggers an action on its own.
 */
export function createRecordingTranscriptionHandler(config: RecordingTranscriptionHandlerConfig) {
  const languages = config.languages ?? DEFAULT_RECORDING_LANGUAGES;
  const maxBytes = config.maxBytes ?? 5 * 1024 * 1024;
  const maxDuration = config.maxDurationSeconds ?? 60;
  const timeoutMs = config.timeoutMs ?? 45_000;
  const gate = createGate(Math.max(1, config.maxConcurrent ?? 2), Math.max(0, config.maxQueued ?? 8));
  const onError = config.onError
    ?? ((error: unknown) => console.error(`[speech] Recording transcription failed: ${contentFreeError(error)}`));

  return async function POST(request: Request): Promise<Response> {
    if (!(await config.authorize(request))) return failed(401, 'Authentication required');
    if (!config.url) return failed(503, 'Speech service not configured');
    if (config.localOnly && !isPrivateServiceUrl(config.url)) {
      onError(new TranscriptionFailure('service_not_local'));
      return failed(503, 'Speech service not configured');
    }
    if (!request.headers.get('content-type')?.startsWith('audio/wav')) return failed(415, 'Unsupported audio format');
    const language = new URL(request.url).searchParams.get('language') || config.defaultLanguage || 'de';
    if (!languages.includes(language)) return failed(400, 'Unsupported language');
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return failed(413, 'Recording too long');

    const audio = await readCapped(request, maxBytes);
    if (!audio) return failed(413, 'Recording too long');
    if (audio.byteLength === 0) return failed(400, 'Empty recording');
    const duration = wavDurationSeconds(audio);
    if (duration === undefined) return failed(415, 'Unsupported audio format');
    if (duration > maxDuration) return failed(413, 'Recording too long');

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    let release: (() => void) | undefined;
    try {
      release = await gate.acquire(signal);
      if (!release) return failed(429, 'Speech service busy', { 'retry-after': '5' });

      const form = new FormData();
      form.set('file', new File([audio as BlobPart], 'recording.wav', { type: 'audio/wav' }));
      form.set('model', config.model || 'parakeet-tdt-0.6b-v3');
      form.set('language', language.slice(0, 2));

      const response = await (config.fetch ?? globalThis.fetch)(`${trimTrailingSlashes(config.url)}/v1/audio/transcriptions`, {
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
      if (request.signal.aborted) return failed(499, 'Recording cancelled');
      onError(error instanceof TranscriptionFailure ? error : new TranscriptionFailure(contentFreeError(error)));
      return failed(502, 'Transcription failed');
    } finally {
      release?.();
    }
  };
}
