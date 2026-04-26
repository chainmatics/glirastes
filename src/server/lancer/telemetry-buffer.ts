// ---------------------------------------------------------------------------
// Telemetry event buffer — batches events and flushes to the Proctor API
// ---------------------------------------------------------------------------

import type { TelemetryEvent } from './types.js';

const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 5_000;

export class TelemetryBuffer {
  private buffer: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string>,
    private readonly maxRetries: number,
  ) {
    this.timer = setInterval(() => {
      if (this.buffer.length > 0) this.flush().catch(() => { /* silent — retry on next interval */ });
    }, FLUSH_INTERVAL_MS);
  }

  /** Add an event to the buffer. Auto-flushes at threshold. */
  add(event: TelemetryEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= FLUSH_THRESHOLD) {
      this.flush().catch(() => { /* silent — events are re-queued on failure */ });
    }
  }

  /** Flush buffered events to the Proctor API. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ events: batch }),
        });
        if (res.ok) return;
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    // All retries exhausted — push events back to the buffer
    this.buffer.unshift(...batch);
    throw lastError;
  }

  /** Tear down the auto-flush interval. */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
