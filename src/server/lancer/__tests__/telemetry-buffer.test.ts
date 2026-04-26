import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TelemetryBuffer } from '../telemetry-buffer';
import type { TelemetryEvent } from '../types';

function makeEvent(n = 0): TelemetryEvent {
  return { eventType: `test.event.${n}` };
}

describe('TelemetryBuffer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('buffers events and flushes manually', async () => {
    const buf = new TelemetryBuffer('https://api.test/v1/proctor/events', {}, 0);
    buf.add(makeEvent(1));
    buf.add(makeEvent(2));

    await buf.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.events).toHaveLength(2);
    buf.destroy();
  });

  it('auto-flushes when buffer reaches 50 events', async () => {
    const buf = new TelemetryBuffer('https://api.test/v1/proctor/events', {}, 0);

    for (let i = 0; i < 50; i++) {
      buf.add(makeEvent(i));
    }

    // The 50th add triggers a void flush — let microtasks resolve
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.events).toHaveLength(50);
    buf.destroy();
  });

  it('auto-flushes on interval', async () => {
    const buf = new TelemetryBuffer('https://api.test/v1/proctor/events', {}, 0);
    buf.add(makeEvent(1));

    // Advance past the 5-second interval
    await vi.advanceTimersByTimeAsync(5_001);

    expect(fetchMock).toHaveBeenCalledOnce();
    buf.destroy();
  });

  it('pushes events back to buffer on failure', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const buf = new TelemetryBuffer('https://api.test/v1/proctor/events', {}, 1);
    buf.add(makeEvent(1));

    await expect(buf.flush()).rejects.toThrow('network');

    // Events should be back in the buffer — a successful flush now should
    // send them again
    fetchMock.mockResolvedValue({ ok: true });
    await buf.flush();

    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 failed + 1 success
    const body = JSON.parse(
      fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body as string,
    );
    expect(body.events).toHaveLength(1);
    buf.destroy();
  });

  it('does nothing when flushing an empty buffer', async () => {
    const buf = new TelemetryBuffer('https://api.test/v1/proctor/events', {}, 0);
    await buf.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    buf.destroy();
  });
});
