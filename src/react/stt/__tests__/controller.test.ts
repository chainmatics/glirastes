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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createRaceHarness() {
  const finalization = deferred();
  const closing = deferred();
  const tracks = [createTrack(), createTrack()];
  const streams = tracks.map((track) => ({ getTracks: () => [track] }) as unknown as MediaStream);
  let mediaIndex = 0;
  let connectionIndex = 0;
  const events: SttProviderEvents[] = [];
  const finalize = vi.fn(async () => { await finalization.promise; });
  const close = vi.fn(async () => { await closing.promise; });
  const cancel = vi.fn(async () => {});
  const controller = new SttSessionController({
    language: 'de',
    getUserMedia: async () => streams[mediaIndex++],
    adapter: { connect: async (input) => {
      events.push(input.events);
      return connectionIndex++ === 0
        ? { finalize, close, cancel }
        : { finalize: async () => {}, close: async () => {}, cancel: async () => {} };
    },
    },
  });
  return { controller, tracks, streams, events, finalize, close, cancel, finalization, closing };
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
  it('joins repeated stop calls until provider finalization and cleanup finish', async () => {
    const h = createRaceHarness();
    await h.controller.start('');
    const first = h.controller.stop();
    const second = h.controller.stop();
    let settled = false;
    void second.then(() => { settled = true; });
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalled());
    h.finalization.resolve();
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    const finalizeCount = h.finalize.mock.calls.length;
    const settledBeforeCleanup = settled;
    h.closing.resolve();
    await Promise.all([first, second]);
    expect(finalizeCount).toBe(1);
    expect(settledBeforeCleanup).toBe(false);
    expect(h.tracks[0].stop).toHaveBeenCalledOnce();
    expect(h.controller.snapshot.phase).toBe('completed');
  });

  it('does not let stale stop cleanup stop a new microphone or overwrite its phase', async () => {
    const h = createRaceHarness();
    await h.controller.start('first');
    const stopping = h.controller.stop();
    h.finalization.resolve();
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    await h.controller.start('second');
    expect(h.controller.snapshot.phase).toBe('recording');
    h.closing.resolve();
    await stopping;
    expect(h.tracks[1].stop).not.toHaveBeenCalled();
    expect(h.controller.getStream()).toBe(h.streams[1]);
    expect(h.controller.snapshot.phase).toBe('recording');
    await h.controller.dispose();
  });

  it('keeps cancel authoritative over a pending finalization', async () => {
    const h = createRaceHarness();
    await h.controller.start('keep draft');
    const stopping = h.controller.stop();
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledOnce());
    h.closing.resolve();
    await expect(h.controller.cancel()).resolves.toBe('keep draft');
    h.finalization.resolve();
    await stopping;
    expect(h.controller.snapshot.phase).toBe('cancelled');
    expect(h.controller.snapshot.displayTranscript).toBe('');
  });

  it('returns the cancelled draft without overwriting a recording started during close', async () => {
    const h = createRaceHarness();
    await h.controller.start('first draft');
    const cancelling = h.controller.cancel();
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    await h.controller.start('second draft');
    h.closing.resolve();
    const draft = await cancelling;
    expect(draft).toBe('first draft');
    expect(h.controller.snapshot.phase).toBe('recording');
    expect(h.tracks[1].stop).not.toHaveBeenCalled();
    await h.controller.dispose();
  });

  it('does not release a newer stream after an old provider cancel finishes', async () => {
    const h = createRaceHarness();
    const cancelGate = deferred();
    h.cancel.mockImplementationOnce(() => cancelGate.promise);
    h.closing.resolve();
    await h.controller.start('first draft');
    const cancelling = h.controller.cancel();
    await h.controller.start('second draft');
    cancelGate.resolve();
    await cancelling;
    expect(h.tracks[1].stop).not.toHaveBeenCalled();
    expect(h.controller.snapshot.phase).toBe('recording');
    await h.controller.dispose();
  });

  it('ignores an old provider failure after its cleanup is overtaken by a new start', async () => {
    const h = createRaceHarness();
    await h.controller.start('first');
    h.events[0].onError(new Error('old provider failed'));
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    await h.controller.start('second');
    h.closing.resolve();
    // Drain asynchronous provider-failure cleanup before inspecting new state.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.controller.snapshot.phase).toBe('recording');
    expect(h.controller.snapshot.error).toBeNull();
    expect(h.tracks[1].stop).not.toHaveBeenCalled();
    await h.controller.dispose();
  });

  it('releases the microphone and exposes a recoverable failure when cancel rejects', async () => {
    const h = createHarness();
    await h.controller.start('draft');
    vi.mocked(h.connection.cancel).mockRejectedValueOnce(new Error('cancel failed'));
    await expect(h.controller.cancel()).rejects.toThrow('cancel failed');
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.controller.getStream()).toBeNull();
    expect(h.controller.snapshot.phase).toBe('failed');
  });

  it('exposes failed restart cleanup instead of reporting recording with no stream', async () => {
    const h = createHarness();
    await h.controller.start('first');
    vi.mocked(h.connection.close).mockRejectedValueOnce(new Error('restart cleanup failed'));
    await expect(h.controller.start('second')).rejects.toThrow('restart cleanup failed');
    expect(h.controller.snapshot.phase).toBe('failed');
    expect(h.controller.getStream()).toBeNull();
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it('stops a restart that is still waiting for the previous provider to close', async () => {
    const h = createRaceHarness();
    await h.controller.start('first');
    const restarting = h.controller.start('second');
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    await h.controller.stop();
    h.closing.resolve();
    await restarting;
    expect(h.controller.snapshot.phase).toBe('completed');
    expect(h.controller.getStream()).toBeNull();
    expect(h.events).toHaveLength(1);
  });

  it('does not finalize after a subscriber disposes during the finalizing notification', async () => {
    const h = createHarness();
    await h.controller.start('');
    const unsubscribe = h.controller.subscribe((snapshot) => {
      if (snapshot.phase === 'finalizing') void h.controller.dispose();
    });
    await expect(h.controller.stop()).resolves.toBe('');
    expect(h.connection.finalize).not.toHaveBeenCalled();
    expect(h.track.stop).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('does not connect after a subscriber disposes during the connecting notification', async () => {
    const h = createHarness();
    const unsubscribe = h.controller.subscribe((snapshot) => {
      if (snapshot.phase === 'connecting') void h.controller.dispose();
    });
    await expect(h.controller.start('')).resolves.toBeUndefined();
    expect(h.adapter.connect).not.toHaveBeenCalled();
    expect(h.track.stop).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('does not start a microphone after immediate disposal during start cleanup', async () => {
    const h = createHarness();
    const starting = h.controller.start('');
    await h.controller.dispose();
    await starting;
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.controller.getStream()).toBeNull();
  });

  it('releases microphone tracks even when provider close rejects', async () => {
    const h = createHarness();
    await h.controller.start('');
    vi.mocked(h.connection.close).mockRejectedValueOnce(new Error('close failed'));
    await expect(h.controller.dispose()).rejects.toThrow('close failed');
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.controller.getStream()).toBeNull();
  });
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

  it('cancel invalidates a pending permission request before its stream arrives', async () => {
    const track = createTrack();
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    let resolvePermission:
      | ((stream: MediaStream) => void)
      | undefined;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    }));
    const adapter: SttProviderAdapter = {
      connect: vi.fn(),
    };
    const controller = new SttSessionController({
      adapter,
      getUserMedia,
      language: 'de',
    });

    const starting = controller.start('Entwurf behalten');
    await vi.waitFor(() => {
      expect(controller.snapshot.phase).toBe('requesting_permission');
    });
    await expect(controller.cancel()).resolves.toBe('Entwurf behalten');
    resolvePermission?.(stream);
    await starting;

    expect(adapter.connect).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.phase).toBe('cancelled');
    expect(controller.getStream()).toBeNull();
  });

  it('stop completes a pending permission request without reviving recording', async () => {
    const track = createTrack();
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    let resolvePermission:
      | ((stream: MediaStream) => void)
      | undefined;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    }));
    const adapter: SttProviderAdapter = {
      connect: vi.fn(),
    };
    const controller = new SttSessionController({
      adapter,
      getUserMedia,
      language: 'de',
    });

    const starting = controller.start('');
    await vi.waitFor(() => {
      expect(controller.snapshot.phase).toBe('requesting_permission');
    });
    await expect(controller.stop()).resolves.toBe('');
    resolvePermission?.(stream);
    await starting;

    expect(adapter.connect).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.phase).toBe('completed');
    expect(controller.getStream()).toBeNull();
  });

  it('keeps cancel authoritative when a pending permission request rejects later', async () => {
    let rejectPermission:
      | ((error: Error) => void)
      | undefined;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(
      (_resolve, reject) => {
        rejectPermission = reject;
      },
    ));
    const controller = new SttSessionController({
      adapter: { connect: vi.fn() },
      getUserMedia,
      language: 'de',
    });

    const starting = controller.start('Entwurf');
    await vi.waitFor(() => {
      expect(controller.snapshot.phase).toBe('requesting_permission');
    });
    await controller.cancel();
    rejectPermission?.(new Error('Permission denied'));

    await expect(starting).resolves.toBeUndefined();
    expect(controller.snapshot).toMatchObject({
      phase: 'cancelled',
      error: null,
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
