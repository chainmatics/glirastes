import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyDecisionsEventSchema, type RuntimeMetricEvent } from '../../contracts/events.js';
import { findForbiddenPlatformContentPath } from '../../contracts/content-boundary.js';
import type { RuntimeMetricsSink } from './turn-recorder.js';
import {
  createPrivacyDecisionRecorder,
  privacyDecisionRecorderFor,
  type PrivacyDecisionPolicy,
} from './privacy-decisions.js';
import { createRuntimeMetricsSink } from './sink.js';

const APP_ID = '019fb900-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '019fb900-0000-7000-8000-0000000000e1';
const REVISION_ID = '019fb900-0000-7000-8000-0000000000f1';

const signed: PrivacyDecisionPolicy = {
  policyRevisionId: REVISION_ID,
  privacyDigest: `sha256:${'A'.repeat(43)}`,
  effectivePolicyDigest: `sha256:${'B'.repeat(43)}`,
};
const localOnly: PrivacyDecisionPolicy = {
  policyRevisionId: null,
  privacyDigest: null,
  effectivePolicyDigest: `sha256:${'C'.repeat(43)}`,
};

function fakeSink(record: (event: RuntimeMetricEvent) => void = () => undefined) {
  const events: RuntimeMetricEvent[] = [];
  const sink: RuntimeMetricsSink = {
    identity: { appId: APP_ID, environmentId: ENVIRONMENT_ID, buildId: null, instanceId: 'web-1' },
    record: vi.fn((event: RuntimeMetricEvent) => {
      record(event);
      events.push(event);
    }),
    flush: async () => undefined,
    close: async () => undefined,
  };
  return { sink, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('privacy decision recorder (K5)', () => {
  it('hands a valid, content-free event to the sink within 60 seconds of the first count', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-17T10:00:00.000Z') });
    const { sink, events } = fakeSink();
    const recorder = createPrivacyDecisionRecorder({ sink });
    recorder.count('turn_protected', signed);
    recorder.count('model_call_protected', signed);
    recorder.count('model_call_protected', signed);
    recorder.count('privacy_provider_not_allowed' as never, signed);
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(60_000);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(PrivacyDecisionsEventSchema.safeParse(event).success).toBe(true);
    expect(findForbiddenPlatformContentPath(event)).toBeNull();
    expect(event).toMatchObject({
      eventType: 'privacy.decisions',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      instanceId: 'web-1',
      policyRevisionId: REVISION_ID,
      privacyDigest: signed.privacyDigest,
      effectivePolicyDigest: signed.effectivePolicyDigest,
      window: { startedAt: '2026-11-17T10:00:00.000Z', endedAt: '2026-11-17T10:01:00.000Z', sequence: 1 },
      droppedWindows: 0,
    });
    expect(event.eventType === 'privacy.decisions' && event.decisions).toEqual([
      { code: 'turn_protected', count: 1 },
      { code: 'model_call_protected', count: 2 },
    ]);
    recorder.close();
  });

  it('counts each policy in its own window and orders windows by sequence', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-17T10:00:00.000Z') });
    const { sink, events } = fakeSink();
    const recorder = createPrivacyDecisionRecorder({ sink });
    recorder.count('turn_protected', signed);
    recorder.count('turn_protected', localOnly);
    recorder.flush();
    recorder.count('tool_call_rehydrated', signed);
    recorder.flush();
    expect(events.map((event) => event.eventType === 'privacy.decisions' && [event.policyRevisionId, event.window.sequence]))
      .toEqual([[REVISION_ID, 1], [null, 2], [REVISION_ID, 3]]);
    for (const event of events) expect(PrivacyDecisionsEventSchema.safeParse(event).success).toBe(true);
    recorder.close();
  });

  it('drops the oldest windows when the buffer is full and reports how many', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-17T10:00:00.000Z') });
    let accepting = false;
    const { sink, events } = fakeSink(() => {
      if (!accepting) throw new Error('sink unavailable');
    });
    const recorder = createPrivacyDecisionRecorder({ sink, maxWindows: 2 });
    // Each flush closes one window; the sink throws, so they pile up and the
    // recorder keeps them only up to its bound.
    for (let index = 0; index < 5; index += 1) {
      recorder.count('turn_protected', signed);
      expect(() => recorder.flush()).not.toThrow();
      vi.advanceTimersByTime(1_000);
    }
    accepting = true;
    recorder.count('turn_protected', signed);
    recorder.flush();
    // Six windows closed, two fit the buffer: the four oldest were dropped
    // and the first delivered event says so.
    expect(events.map((event) => event.eventType === 'privacy.decisions' && [event.window.sequence, event.droppedWindows]))
      .toEqual([[5, 4], [6, 0]]);
    for (const event of events) expect(PrivacyDecisionsEventSchema.safeParse(event).success).toBe(true);
    recorder.close();
  });

  it('never throws into the turn, whatever the sink does', () => {
    const { sink } = fakeSink(() => {
      throw new Error('rejected batch');
    });
    const recorder = createPrivacyDecisionRecorder({ sink });
    expect(() => {
      recorder.count('turn_protected', signed);
      recorder.flush();
      recorder.count('unknown_code' as never, signed);
      recorder.close();
      recorder.count('turn_protected', signed);
    }).not.toThrow();
  });

  it('caps a counter at the contract maximum', () => {
    const { sink, events } = fakeSink();
    const recorder = createPrivacyDecisionRecorder({ sink });
    for (let index = 0; index < 1_000_002; index += 1) recorder.count('turn_protected', signed);
    recorder.close();
    const [event] = events;
    expect(event?.eventType === 'privacy.decisions' && event.decisions).toEqual([{ code: 'turn_protected', count: 1_000_000 }]);
    expect(PrivacyDecisionsEventSchema.safeParse(event).success).toBe(true);
  });

  it('closing the runtime sink hands over the open windows and stops the recorder', async () => {
    const sent: unknown[] = [];
    const sink = createRuntimeMetricsSink({
      controlPlaneUrl: 'https://platform.example.invalid',
      apiKey: 'test-runtime-key-0000',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      instanceId: 'web-1',
      fetch: (async (_input: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      }) as typeof globalThis.fetch,
    });
    const recorder = privacyDecisionRecorderFor(sink);
    recorder.count('turn_protected', signed);
    recorder.count('model_call_protected', signed);
    await sink.close();
    const events = sent.flatMap((batch) => (batch as { events: RuntimeMetricEvent[] }).events);
    const decisions = events.filter((e) => e.eventType === 'privacy.decisions');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.eventType === 'privacy.decisions' && decisions[0]!.decisions).toEqual([
      { code: 'turn_protected', count: 1 },
      { code: 'model_call_protected', count: 1 },
    ]);
    // Closed: later counts go nowhere.
    recorder.count('turn_protected', signed);
    recorder.flush();
    expect(sent.flatMap((batch) => (batch as { events: unknown[] }).events)).toHaveLength(events.length);
  });

  it('keeps one recorder per sink', () => {
    const { sink } = fakeSink();
    expect(privacyDecisionRecorderFor(sink)).toBe(privacyDecisionRecorderFor(sink));
    expect(privacyDecisionRecorderFor(fakeSink().sink)).not.toBe(privacyDecisionRecorderFor(sink));
  });
});
