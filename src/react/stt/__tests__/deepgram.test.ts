import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepgramSegmentParser,
  DeepgramSttAdapter,
} from '../deepgram.js';

const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

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
      sequence: 0,
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
      sequence: 0,
      text: 'Neue Aufgabe',
      isFinal: true,
    });
  });

  it('ignores empty and non-transcript messages', () => {
    const parse = createDeepgramSegmentParser();
    expect(parse({ type: 'Metadata' })).toBeNull();
    expect(parse({ channel: { alternatives: [{ transcript: '' }] } })).toBeNull();
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
});
