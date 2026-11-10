import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepgramSegmentParser,
  DeepgramSttAdapter,
} from '../deepgram.js';

const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;
const originalAudioContext = globalThis.AudioContext;
const originalAudioWorkletNode = globalThis.AudioWorkletNode;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: originalWebSocket,
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: originalAudioContext,
  });
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: originalAudioWorkletNode,
  });
});

describe('Deepgram segment parser', () => {
  it('keeps interim and final updates on the same segment identity', () => {
    const parse = createDeepgramSegmentParser();

    expect(parse({
      start: 1.25,
      duration: 0.5,
      is_final: false,
      channel: { alternatives: [{ transcript: 'Neue' }] },
    })).toMatchObject({
      id: 'deepgram-1.25',
      sequence: 1.25,
      text: 'Neue',
      isFinal: false,
    });
    expect(parse({
      start: 1.25,
      duration: 0.8,
      is_final: true,
      channel: { alternatives: [{ transcript: 'Neue Aufgabe' }] },
    })).toMatchObject({
      id: 'deepgram-1.25',
      sequence: 1.25,
      text: 'Neue Aufgabe',
      isFinal: true,
    });
  });

  it('ignores empty and non-transcript messages', () => {
    const parse = createDeepgramSegmentParser();
    expect(parse({ type: 'Metadata' })).toBeNull();
    expect(parse({ channel: { alternatives: [{ transcript: '' }] } })).toBeNull();
  });

  it('orders delayed final segments by provider timestamp', () => {
    const parse = createDeepgramSegmentParser();

    const later = parse({
      start: 1,
      is_final: true,
      channel: { alternatives: [{ transcript: 'morgen' }] },
    });
    const earlier = parse({
      start: 0,
      is_final: true,
      channel: { alternatives: [{ transcript: 'Bis' }] },
    });

    expect(earlier?.sequence).toBeLessThan(later?.sequence ?? 0);
  });

  it('closes the socket when the provider handshake fails', async () => {
    let socketInstance: FailedWebSocket | undefined;
    class FailedWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;

      readonly close = vi.fn();
      readyState = FailedWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(_url: string) {
        socketInstance = this;
        queueMicrotask(() => this.onerror?.());
      }
    }

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          protocol: 'https:',
          host: 'example.test',
          href: 'https://example.test/',
        },
      },
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FailedWebSocket,
    });

    const adapter = new DeepgramSttAdapter();
    const connect = adapter.connect({
      stream: {} as MediaStream,
      language: 'de',
      signal: new AbortController().signal,
      events: {
        onSegment: vi.fn(),
        onError: vi.fn(),
        onClosed: vi.fn(),
      },
    });

    await expect(connect).rejects.toThrow('Speech provider connection failed');
    expect(socketInstance?.close).toHaveBeenCalledTimes(1);
  });

  it('finishes as soon as the final provider segment is received', async () => {
    vi.useFakeTimers();
    let socketInstance: SuccessfulWebSocket | undefined;
    class SuccessfulWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;

      readonly send = vi.fn();
      readonly close = vi.fn();
      readyState = SuccessfulWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(_url: string) {
        socketInstance = this;
        queueMicrotask(() => {
          this.readyState = SuccessfulWebSocket.OPEN;
          this.onopen?.();
        });
      }
    }
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamSource: vi.fn(() => source),
      destination: {},
      close: vi.fn(async () => {}),
    };
    class TestAudioContext {
      constructor(_options: AudioContextOptions) {
        return context;
      }
    }
    class TestAudioWorkletNode {
      readonly port = { onmessage: null };
      readonly connect = vi.fn();
      readonly disconnect = vi.fn();
      constructor(
        _context: AudioContext,
        _name: string,
      ) {}
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          protocol: 'https:',
          host: 'example.test',
          href: 'https://example.test/',
        },
      },
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: SuccessfulWebSocket,
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: TestAudioContext,
    });
    Object.defineProperty(globalThis, 'AudioWorkletNode', {
      configurable: true,
      value: TestAudioWorkletNode,
    });
    const onSegment = vi.fn();
    const connection = await new DeepgramSttAdapter({
      finalizeGraceMs: 10_000,
    }).connect({
      stream: {} as MediaStream,
      language: 'de',
      signal: new AbortController().signal,
      events: {
        onSegment,
        onError: vi.fn(),
        onClosed: vi.fn(),
      },
    });

    let finalized = false;
    const finalizing = connection.finalize().then(() => {
      finalized = true;
    });
    socketInstance?.onmessage?.({
      data: JSON.stringify({
        start: 0,
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [{ transcript: 'Neue Aufgabe' }],
        },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(finalized).toBe(true);
    expect(onSegment).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Neue Aufgabe',
      isFinal: true,
    }));
    await finalizing;
    await connection.close();
  });
});
