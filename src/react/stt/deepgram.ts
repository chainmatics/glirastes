import type {
  SttProviderAdapter,
  SttProviderConnection,
} from './controller.js';
import type { SttSegment } from './segments.js';
import type { MaybePromise } from '../types.js';
import { AudioWorkletLoadError } from './worklet-error.js';

interface DeepgramMessage {
  type?: string;
  message?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

export function createDeepgramSegmentParser(): (
  message: DeepgramMessage,
) => SttSegment | null {
  const sequences = new Map<string, number>();
  let nextUntimedSequence = 0;

  return (message) => {
    const text = message.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return null;

    const hasProviderTimestamp = Number.isFinite(message.start);
    const id = hasProviderTimestamp
      ? `deepgram-${message.start}`
      : `deepgram-sequence-${nextUntimedSequence}`;
    let sequence = sequences.get(id);
    if (sequence === undefined) {
      sequence = hasProviderTimestamp
        ? message.start!
        : 1_000_000_000 + nextUntimedSequence;
      sequences.set(id, sequence);
      if (!hasProviderTimestamp) nextUntimedSequence += 1;
    }

    return {
      id,
      sequence,
      text,
      isFinal: message.is_final === true,
    };
  };
}

/** Served path of the PCM worklet; the host must serve the file here or pass `workletUrl`. */
export const DEFAULT_AUDIO_WORKLET_URL = '/audio-worklet-processor.js';

export interface DeepgramSttAdapterOptions {
  baseUrl?: string;
  getToken?: () => MaybePromise<string | null | undefined>;
  connectTimeoutMs?: number;
  finalizeGraceMs?: number;
  /**
   * URL of the PCM worklet file. Wins over the chat's `voice.workletUrl`.
   * Default: that one, else `DEFAULT_AUDIO_WORKLET_URL`.
   */
  workletUrl?: string;
}

export interface PcmPipelineOptions {
  workletUrl?: string;
}

function resolveWebSocketUrl(
  baseUrl: string | undefined,
  language: string,
  token: string | null | undefined,
): string {
  const fallbackProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const fallback = `${fallbackProtocol}//${window.location.host}/api/ai/speech-stream`;
  const url = new URL(baseUrl ?? fallback, window.location.href);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  url.searchParams.set('language', language);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/** Microphone audio as 16 kHz mono 16-bit PCM chunks; returns its stop function. */
export async function createPcmPipeline(
  stream: MediaStream,
  onAudio: (audio: ArrayBuffer) => void,
  options: PcmPipelineOptions = {},
): Promise<() => Promise<void>> {
  const AudioContextCtor = globalThis.AudioContext
    ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('Browser does not support AudioContext');

  const context = new AudioContextCtor({ sampleRate: 16_000 });
  const workletUrl = options.workletUrl ?? DEFAULT_AUDIO_WORKLET_URL;
  const closeQuietly = () => {
    void Promise.resolve().then(() => context.close()).catch(() => {});
  };
  const workletFailed = (workletLoadFailure: unknown): never => {
    // Never silent: the developer sees the URL and the fix in the console,
    // the user sees the chat's localized error text. Query and hash may
    // carry tokens, so only the path is logged.
    const workletPath = workletUrl.split(/[?#]/)[0];
    console.error(
      `[glirastes] Voice input: the audio worklet could not be loaded from ${workletPath}. Serve glirastes/react/audio-worklet-processor.js at that URL (\`glirastes stt worklet\` copies it into public/) or set workletUrl to where it is served.`,
      workletLoadFailure,
    );
    closeQuietly();
    throw new AudioWorkletLoadError(workletUrl, { cause: workletLoadFailure });
  };
  try {
    await context.audioWorklet.addModule(workletUrl);
  } catch (workletLoadFailure) {
    workletFailed(workletLoadFailure);
  }
  let source: MediaStreamAudioSourceNode;
  try {
    source = context.createMediaStreamSource(stream);
  } catch (error) {
    closeQuietly();
    throw error;
  }
  let processor: AudioWorkletNode;
  try {
    // Throws when the loaded file does not register 'audio-processor'.
    processor = new AudioWorkletNode(context, 'audio-processor');
  } catch (workletLoadFailure) {
    return workletFailed(workletLoadFailure);
  }
  processor.port.onmessage = (event: MessageEvent<Int16Array>) => {
    onAudio(event.data.buffer as ArrayBuffer);
  };
  source.connect(processor);
  processor.connect(context.destination);

  return async () => {
    processor.port.onmessage = null;
    processor.disconnect();
    source.disconnect();
    await context.close();
  };
}

export class DeepgramSttAdapter implements SttProviderAdapter {
  /** `connect()` loads `input.workletUrl` when the constructor sets none. */
  readonly acceptsWorkletUrl = true;

  constructor(private readonly options: DeepgramSttAdapterOptions = {}) {}

  async connect(input: Parameters<SttProviderAdapter['connect']>[0]): Promise<SttProviderConnection> {
    const token = await this.options.getToken?.();
    if (input.signal.aborted) throw new Error('Speech provider connection cancelled');
    const url = resolveWebSocketUrl(this.options.baseUrl, input.language, token);
    const socket = new WebSocket(url);
    const parser = createDeepgramSegmentParser();
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 5_000;
    const finalizeGraceMs = this.options.finalizeGraceMs ?? 750;
    let disposed = false;
    let closeAudio: (() => Promise<void>) | null = null;
    let finalizePromise: Promise<void> | null = null;
    let resolveFinalize: (() => void) | null = null;
    let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const settleFinalization = () => {
      if (!resolveFinalize) return;
      if (finalizeTimeout) clearTimeout(finalizeTimeout);
      finalizeTimeout = null;
      const resolve = resolveFinalize;
      resolveFinalize = null;
      resolve();
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => finish('aborted');
        const finish = (
          result: 'open' | 'error' | 'aborted' | 'timeout',
        ) => {
          clearTimeout(timeout);
          input.signal.removeEventListener('abort', abort);
          if (result === 'open') resolve();
          if (result === 'error') reject(new Error('Speech provider connection failed'));
          if (result === 'aborted') reject(new Error('Speech provider connection cancelled'));
          if (result === 'timeout') reject(new Error('Speech provider connection timeout'));
        };
        const timeout = setTimeout(() => finish('timeout'), connectTimeoutMs);
        socket.onopen = () => finish('open');
        socket.onerror = () => finish('error');
        input.signal.addEventListener('abort', abort, { once: true });
      });
    } catch (error) {
      socket.onopen = null;
      socket.onerror = null;
      if (
        socket.readyState === WebSocket.OPEN
        || socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
      throw error;
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as DeepgramMessage;
        if (message.type === 'error') {
          input.events.onError(new Error(message.message ?? 'Transcription failed'));
          return;
        }
        const segment = parser(message);
        if (segment) input.events.onSegment(segment);
        if (message.is_final === true || message.speech_final === true) {
          settleFinalization();
        }
      } catch {
        // Provider metadata may be non-JSON; it carries no transcript.
      }
    };
    socket.onerror = () => input.events.onError(
      new Error('Speech provider connection failed'),
    );
    socket.onclose = () => {
      settleFinalization();
      input.events.onClosed();
    };

    const close = async () => {
      if (disposed) return;
      disposed = true;
      settleFinalization();
      await closeAudio?.();
      closeAudio = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (
        socket.readyState === WebSocket.OPEN
        || socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    };

    input.signal.addEventListener('abort', () => {
      void close();
    }, { once: true });

    try {
      closeAudio = await createPcmPipeline(input.stream, (audio) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(audio);
      }, { workletUrl: this.options.workletUrl ?? input.workletUrl });
    } catch (error) {
      await close();
      throw error;
    }

    return {
      finalize: () => {
        if (socket.readyState !== WebSocket.OPEN) return Promise.resolve();
        if (finalizePromise) return finalizePromise;

        finalizePromise = new Promise<void>((resolve) => {
          resolveFinalize = resolve;
          finalizeTimeout = setTimeout(settleFinalization, finalizeGraceMs);
        });
        try {
          socket.send(JSON.stringify({ type: 'Finalize' }));
        } catch (error) {
          settleFinalization();
          return Promise.reject(error);
        }
        return finalizePromise;
      },
      cancel: close,
      close,
    };
  }
}
