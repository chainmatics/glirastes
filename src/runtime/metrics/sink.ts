import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PlatformConnectionDescriptorSchema,
  RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
  RUNTIME_METRIC_LABEL_PATTERN,
  RUNTIME_METRIC_MAX_BATCH,
  RuntimeMetricEventSchema,
  type RuntimeMetricEvent,
  type TechnicalRuntimeEventBatch,
} from '../../contracts/index.js';
import type {
  RuntimeMetricsIdentity,
  RuntimeMetricsSink,
} from './turn-recorder.js';

export type RuntimeMetricsDropReason =
  | 'invalid'
  | 'queue-full'
  | 'send-failed'
  | 'closed';

export interface RuntimeMetricsSinkOptions {
  /** Control-plane base URL (HTTPS, or loopback HTTP for local tests). */
  controlPlaneUrl: string;
  /** The app-bound runtime key; sent only in the Authorization header. */
  apiKey: string;
  appId: string;
  environmentId: string;
  /** Build identifier of the deployed code, e.g. a commit; null if unknown. */
  buildId?: string | null;
  /** This process; defaults to a random id per sink. */
  instanceId?: string;
  fetch?: typeof globalThis.fetch;
  /** Events per request, 1–50 (default 50). */
  maxBatchSize?: number;
  /** Events waiting for delivery before new ones are dropped (default 1,000). */
  maxQueueSize?: number;
  /** Delivery interval (default 5 s). */
  flushIntervalMs?: number;
  /** Per-request timeout; a slower Platform loses the batch (default 5 s). */
  requestTimeoutMs?: number;
  /** Content-free notice about dropped events, e.g. for local logging. */
  onDrop?: (drop: { reason: RuntimeMetricsDropReason; count: number }) => void;
}

export interface BatchingRuntimeMetricsSink extends RuntimeMetricsSink {
  /** Events waiting for delivery. */
  readonly pending: number;
}

const label = z.string().regex(RUNTIME_METRIC_LABEL_PATTERN);

const SinkConfigSchema = z.object({
  controlPlaneUrl: PlatformConnectionDescriptorSchema.shape.baseUrl,
  apiKey: z.string().regex(/^\S{8,512}$/),
  appId: z.uuid(),
  environmentId: z.uuid(),
  buildId: label.nullable(),
  instanceId: label,
  maxBatchSize: z.number().int().min(1).max(RUNTIME_METRIC_MAX_BATCH),
  maxQueueSize: z.number().int().min(1).max(100_000),
  flushIntervalMs: z.number().int().min(100).max(3_600_000),
  requestTimeoutMs: z.number().int().min(10).max(60_000),
});

/**
 * Batches turn events and delivers them to the Platform off the turn path.
 * `record` validates and queues synchronously and never throws; delivery
 * runs on an unref'd interval or when a batch is full. A failed, rejected or
 * timed-out request drops its batch: metrics never retry, never block a turn
 * and never hold the process open.
 */
export function createRuntimeMetricsSink(
  options: RuntimeMetricsSinkOptions,
): BatchingRuntimeMetricsSink {
  const parsed = SinkConfigSchema.safeParse({
    controlPlaneUrl: options.controlPlaneUrl,
    apiKey: options.apiKey,
    appId: options.appId,
    environmentId: options.environmentId,
    buildId: options.buildId ?? null,
    instanceId: options.instanceId ?? randomUUID(),
    maxBatchSize: options.maxBatchSize ?? RUNTIME_METRIC_MAX_BATCH,
    maxQueueSize: options.maxQueueSize ?? 1_000,
    flushIntervalMs: options.flushIntervalMs ?? 5_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
  });
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
    throw new RangeError(`Invalid runtime metrics sink options: ${[...new Set(paths)].join(', ')}`);
  }
  const config = parsed.data;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = `${config.controlPlaneUrl.replace(/\/+$/, '')}/v1/runtime/apps/`
    + `${config.appId}/environments/${config.environmentId}/metrics/events`;
  const identity: RuntimeMetricsIdentity = Object.freeze({
    appId: config.appId,
    environmentId: config.environmentId,
    buildId: config.buildId,
    instanceId: config.instanceId,
  });
  // One queue per event type: a batch never mixes types, so a Platform that
  // does not know `tool_contract_rejected` yet refuses only those batches.
  // Turns are listed first, so they are sent first whatever arrives first.
  const queues = new Map<RuntimeMetricEvent['eventType'], RuntimeMetricEvent[]>([['turn.finished', []]]);
  const queued = () => [...queues.values()].reduce((sum, events) => sum + events.length, 0);
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let flushScheduled = false;
  let closed = false;

  const drop = (reason: RuntimeMetricsDropReason, count: number) => {
    try {
      options.onDrop?.({ reason, count });
    } catch {
      // Diagnostics must not reach the turn either.
    }
  };

  const send = async (events: RuntimeMetricEvent[]): Promise<boolean> => {
    try {
      const body: TechnicalRuntimeEventBatch = {
        schemaVersion: RUNTIME_METRIC_EVENT_SCHEMA_VERSION,
        events,
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      try {
        await response.body?.cancel();
      } catch {
        // The answer carries nothing the runtime needs.
      }
      return response.ok;
    } catch {
      return false;
    }
  };

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (queued() === 0) return Promise.resolve();
    inFlight = (async () => {
      try {
        // An event recorded while another type is on the wire may land in a
        // queue that was already drained: go round again until all are empty.
        while (queued() > 0) {
          for (const queue of queues.values()) {
            while (queue.length > 0) {
              const batch = queue.splice(0, config.maxBatchSize);
              if (!await send(batch)) drop('send-failed', batch.length);
            }
          }
        }
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const ensureTimer = () => {
    if (timer || closed) return;
    timer = setInterval(() => {
      void flush();
    }, config.flushIntervalMs);
    timer.unref?.();
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flush();
    });
  };

  return {
    identity,
    get pending() {
      return queued();
    },
    record(event) {
      try {
        if (closed) {
          drop('closed', 1);
          return;
        }
        const checked = RuntimeMetricEventSchema.safeParse(event);
        if (
          !checked.success
          || checked.data.appId !== identity.appId
          || checked.data.environmentId !== identity.environmentId
        ) {
          drop('invalid', 1);
          return;
        }
        if (queued() >= config.maxQueueSize) {
          drop('queue-full', 1);
          return;
        }
        const queue = queues.get(checked.data.eventType) ?? [];
        queues.set(checked.data.eventType, queue);
        queue.push(checked.data);
        ensureTimer();
        if (queue.length >= config.maxBatchSize) scheduleFlush();
      } catch {
        // Recording is best effort and must never fail a turn.
      }
    },
    flush,
    async close() {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await flush();
    },
  };
}

/**
 * The sink of a connected app (`glirastes connect` writes these variables),
 * or undefined. Standalone apps (no `GLIRASTES_CONTROL_PLANE_URL`) get no
 * sink and stay network-silent; an incomplete or invalid connection also
 * yields none, because metrics must never stop a chat from starting.
 * `GLIRASTES_BUILD_ID` (optional) names the deployed build.
 */
export function createRuntimeMetricsSinkFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<
    RuntimeMetricsSinkOptions,
    'controlPlaneUrl' | 'apiKey' | 'appId' | 'environmentId' | 'buildId'
  > = {},
): BatchingRuntimeMetricsSink | undefined {
  const controlPlaneUrl = env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  const apiKey = env.GLIRASTES_API_KEY?.trim();
  const appId = env.GLIRASTES_APP_ID?.trim();
  const environmentId = env.GLIRASTES_ENVIRONMENT_ID?.trim();
  if (!controlPlaneUrl || !apiKey || !appId || !environmentId) return undefined;
  const buildId = env.GLIRASTES_BUILD_ID?.trim();
  try {
    return createRuntimeMetricsSink({
      ...options,
      controlPlaneUrl,
      apiKey,
      appId,
      environmentId,
      buildId: buildId && RUNTIME_METRIC_LABEL_PATTERN.test(buildId) ? buildId : null,
    });
  } catch {
    return undefined;
  }
}
