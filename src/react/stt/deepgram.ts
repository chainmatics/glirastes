import type {
  SttProviderAdapter,
  SttProviderConnection,
} from './controller.js';
import type { SttSegment } from './segments.js';

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
  let nextSequence = 0;

  return (message) => {
    const text = message.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return null;

    const id = Number.isFinite(message.start)
      ? `deepgram-${message.start}`
      : `deepgram-sequence-${nextSequence}`;
    let sequence = sequences.get(id);
    if (sequence === undefined) {
      sequence = nextSequence;
      sequences.set(id, sequence);
      nextSequence += 1;
    }

    return {
      id,
      sequence,
      text,
      isFinal: message.is_final === true,
    };
  };
}

export interface DeepgramSttAdapterOptions {
  baseUrl?: string;
  getToken?: () => string | null | undefined;
  connectTimeoutMs?: number;
  finalizeGraceMs?: number;
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

async function createPcmPipeline(
  stream: MediaStream,
  onAudio: (audio: ArrayBuffer) => void,
): Promise<() => Promise<void>> {
  const AudioContextCtor = globalThis.AudioContext
    ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('Browser does not support AudioContext');

  const context = new AudioContextCtor({ sampleRate: 16_000 });
  await context.audioWorklet.addModule('/audio-worklet-processor.js');
  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, 'audio-processor');
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
  constructor(private readonly options: DeepgramSttAdapterOptions = {}) {}

  async connect(input: Parameters<SttProviderAdapter['connect']>[0]): Promise<SttProviderConnection> {
    const token = this.options.getToken?.();
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
      });
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
