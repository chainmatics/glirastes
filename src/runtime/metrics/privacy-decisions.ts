import { randomUUID } from 'node:crypto';
import {
  PRIVACY_DECISION_CODES,
  PRIVACY_DECISION_MAX_COUNT,
  PRIVACY_DECISION_MAX_WINDOW_MS,
  type PrivacyDecisionCode,
} from '../../contracts/privacy-policy.js';
import {
  PRIVACY_DECISIONS_MAX_CODES,
  RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
  RUNTIME_METRIC_MAX_COUNT,
  type PrivacyDecisionsEvent,
} from '../../contracts/events.js';
import type { RuntimeMetricsSink } from './turn-recorder.js';
import { onRuntimeMetricsSinkClose } from './sink.js';

/** The policy a decision was taken under; content-free ids and digests. */
export interface PrivacyDecisionPolicy {
  /** The pinned policy revision, `null` for a profile required only locally. */
  policyRevisionId: string | null;
  /** Digest of the signed block, `null` without one. */
  privacyDigest: string | null;
  /** Digest of the policy enforced after local tightening. */
  effectivePolicyDigest: string;
}

export interface PrivacyDecisionRecorderOptions {
  sink: RuntimeMetricsSink;
  /** Window length; every window is closed and handed over after it. Default and at most 60 s. */
  windowMs?: number;
  /** Closed windows waiting for the sink; older ones are dropped and counted. Default 60. */
  maxWindows?: number;
  now?: () => number;
}

export interface PrivacyDecisionRecorder {
  /** Counts one decision; never throws and never waits. */
  count(code: PrivacyDecisionCode, policy: PrivacyDecisionPolicy): void;
  /** Closes the open windows and hands every closed one to the sink. */
  flush(): void;
  close(): void;
}

interface OpenWindow {
  policy: PrivacyDecisionPolicy;
  startedAt: number;
  counts: Map<PrivacyDecisionCode, number>;
}

const FIRST_FLUSH_MS = 60_000;
const CODES = new Set<string>(PRIVACY_DECISION_CODES);

/**
 * Counts privacy decisions per pinned policy and reports them as
 * `privacy.decisions` events through the runtime metrics sink. Windows
 * close at least every 60 s, so the first counts reach the sink within a
 * minute. The buffer is bounded: when the sink is not taking events, the
 * oldest windows are dropped and the next event reports how many. The
 * recorder never throws into a turn; a rejected batch changes nothing about
 * local enforcement.
 */
export function createPrivacyDecisionRecorder(options: PrivacyDecisionRecorderOptions): PrivacyDecisionRecorder {
  const windowMs = Math.min(FIRST_FLUSH_MS, PRIVACY_DECISION_MAX_WINDOW_MS, Math.max(1_000, options.windowMs ?? FIRST_FLUSH_MS));
  const maxWindows = Math.max(1, Math.min(10_000, options.maxWindows ?? 60));
  const now = options.now ?? Date.now;
  const open = new Map<string, OpenWindow>();
  const closed: PrivacyDecisionsEvent[] = [];
  let sequence = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const keyOf = (policy: PrivacyDecisionPolicy) =>
    `${policy.policyRevisionId ?? '-'}|${policy.privacyDigest ?? '-'}|${policy.effectivePolicyDigest}`;

  const closeWindows = () => {
    const at = now();
    for (const window of open.values()) {
      const decisions = [...window.counts]
        .map(([code, count]) => ({ code, count }))
        .slice(0, PRIVACY_DECISIONS_MAX_CODES);
      const endedAt = Math.max(at, window.startedAt + 1);
      const identity = options.sink.identity;
      closed.push({
        schemaVersion: RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
        eventId: randomUUID(),
        eventType: 'privacy.decisions',
        occurredAt: new Date(endedAt).toISOString(),
        appId: identity.appId,
        environmentId: identity.environmentId,
        buildId: identity.buildId,
        instanceId: identity.instanceId,
        policyRevisionId: window.policy.policyRevisionId,
        privacyDigest: window.policy.privacyDigest,
        effectivePolicyDigest: window.policy.effectivePolicyDigest,
        window: {
          startedAt: new Date(window.startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          sequence: sequence = (sequence + 1) % (RUNTIME_METRIC_MAX_COUNT + 1),
        },
        decisions,
        droppedWindows: 0,
      });
    }
    open.clear();
    while (closed.length > maxWindows) {
      closed.shift();
      dropped = Math.min(RUNTIME_METRIC_MAX_COUNT, dropped + 1);
    }
  };

  const flush = () => {
    try {
      closeWindows();
      while (closed.length > 0) {
        const event = closed[0]!;
        event.droppedWindows = dropped;
        // The sink validates, queues and delivers off the turn. A window
        // leaves the buffer only once the sink took it.
        options.sink.record(event);
        closed.shift();
        dropped = 0;
      }
    } catch {
      // Telemetry never reaches enforcement.
    }
  };

  const ensureTimer = () => {
    if (timer || stopped) return;
    timer = setInterval(flush, windowMs);
    timer.unref?.();
  };

  return {
    count(code, policy) {
      try {
        if (stopped || !CODES.has(code)) return;
        const key = keyOf(policy);
        let window = open.get(key);
        if (!window) {
          window = { policy: { ...policy }, startedAt: now(), counts: new Map() };
          open.set(key, window);
        }
        window.counts.set(code, Math.min(PRIVACY_DECISION_MAX_COUNT, (window.counts.get(code) ?? 0) + 1));
        ensureTimer();
      } catch {
        // Counting is best effort.
      }
    },
    flush,
    close() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      flush();
    },
  };
}

const recorders = new WeakMap<RuntimeMetricsSink, PrivacyDecisionRecorder>();

/**
 * The one decision recorder of a metrics sink (shared by every turn on it).
 * Closing the sink closes the recorder first: its open windows reach the
 * sink and its timer stops.
 */
export function privacyDecisionRecorderFor(sink: RuntimeMetricsSink): PrivacyDecisionRecorder {
  let recorder = recorders.get(sink);
  if (!recorder) {
    const created = createPrivacyDecisionRecorder({ sink });
    recorder = created;
    recorders.set(sink, created);
    onRuntimeMetricsSinkClose(sink, () => created.close());
  }
  return recorder;
}
