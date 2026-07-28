import { describe, expect, it, vi } from 'vitest';
import {
  SttSessionController,
  type SttProviderAdapter,
  type SttProviderConnection,
  type SttProviderEvents,
} from '../controller.js';

function createTrack() {
  return { stop: vi.fn() };
}

function createHarness(options?: { failFirstConnect?: boolean }) {
  const track = createTrack();
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  let events: SttProviderEvents | undefined;
  let connects = 0;
  const connection: SttProviderConnection = {
    finalize: vi.fn(async () => {
      events?.onSegment({
        id: 'final-1',
        sequence: 1,
        text: 'Neue Aufgabe',
        isFinal: true,
      });
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const adapter: SttProviderAdapter = {
    connect: vi.fn(async (input) => {
      connects += 1;
      if (options?.failFirstConnect && connects === 1) {
        throw new Error('provider unavailable');
      }
      events = input.events;
      return connection;
    }),
  };
  const controller = new SttSessionController({
    adapter,
    getUserMedia,
    language: 'de',
  });

  return {
    adapter,
    connection,
    controller,
    events: () => events,
    getUserMedia,
    track,
  };
}

describe('SttSessionController', () => {
  it('uses one authoritative microphone stream and exposes live interim text', async () => {
    const harness = createHarness();

    await harness.controller.start('Vorheriger Entwurf');
    harness.events()?.onSegment({
      id: 'interim-1',
      sequence: 1,
      text: 'Neue',
      isFinal: false,
    });

    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    expect(harness.controller.getStream()).toBeTruthy();
    expect(harness.controller.snapshot).toMatchObject({
      phase: 'recording',
      displayTranscript: 'Neue',
      interimTranscript: 'Neue',
    });
  });

  it('finalizes before cleanup and returns the committed transcript', async () => {
    const harness = createHarness();
    await harness.controller.start('');

    const transcript = await harness.controller.stop();

    expect(transcript).toBe('Neue Aufgabe');
    expect(harness.connection.finalize).toHaveBeenCalledTimes(1);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.controller.snapshot.phase).toBe('completed');
    expect(harness.controller.getStream()).toBeNull();
  });

  it('cancel discards recording text and restores the previous draft', async () => {
    const harness = createHarness();
    await harness.controller.start('Nicht verlieren');
    harness.events()?.onSegment({
      id: 'interim-1',
      sequence: 1,
      text: 'Verwerfen',
      isFinal: false,
    });

    const draft = await harness.controller.cancel();

    expect(draft).toBe('Nicht verlieren');
    expect(harness.connection.cancel).toHaveBeenCalledTimes(1);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.controller.snapshot).toMatchObject({
      phase: 'cancelled',
      displayTranscript: '',
    });
  });

  it('cleans up a failed start and can retry without parallel sessions', async () => {
    const harness = createHarness({ failFirstConnect: true });

    await expect(harness.controller.start('Draft')).rejects.toThrow('provider unavailable');
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.controller.snapshot.phase).toBe('failed');

    await harness.controller.retry();

    expect(harness.getUserMedia).toHaveBeenCalledTimes(2);
    expect(harness.controller.snapshot.phase).toBe('recording');
  });

  it('cleanup is idempotent', async () => {
    const harness = createHarness();
    await harness.controller.start('');

    await harness.controller.dispose();
    await harness.controller.dispose();

    expect(harness.connection.close).toHaveBeenCalledTimes(1);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
  });

  it('does not enter recording when the provider fails during connect', async () => {
    const track = createTrack();
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    let events: SttProviderEvents | undefined;
    let resolveConnection: ((connection: SttProviderConnection) => void) | undefined;
    const connection: SttProviderConnection = {
      finalize: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const adapter: SttProviderAdapter = {
      connect: vi.fn((input) => {
        events = input.events;
        return new Promise<SttProviderConnection>((resolve) => {
          resolveConnection = resolve;
        });
      }),
    };
    const controller = new SttSessionController({
      adapter,
      getUserMedia: async () => stream,
      language: 'de',
    });

    const start = controller.start('');
    await vi.waitFor(() => expect(events).toBeDefined());
    events?.onError(new Error('provider disconnected'));
    resolveConnection?.(connection);

    await expect(start).rejects.toThrow('provider disconnected');
    expect(controller.snapshot).toMatchObject({
      phase: 'failed',
      error: 'provider disconnected',
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases the microphone when the provider closes unexpectedly', async () => {
    const harness = createHarness();
    await harness.controller.start('');

    harness.events()?.onClosed();

    await vi.waitFor(() => {
      expect(harness.controller.snapshot).toMatchObject({
        phase: 'failed',
        error: 'Speech provider connection closed unexpectedly',
      });
    });
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.controller.getStream()).toBeNull();
  });
});
