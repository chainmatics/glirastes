import { createHmac, randomUUID } from 'node:crypto';
import {
  RUNTIME_METRIC_LABEL_PATTERN,
  RUNTIME_METRIC_MAX_COUNT,
  RUNTIME_METRIC_MAX_TOOLS,
  TechnicalRuntimeEventV2Schema,
  TechnicalRuntimeEventV3Schema,
  ToolContractRejectedEventSchema,
  TurnContinuedEventSchema,
  TurnContinuedEventV3Schema,
  type RuntimeMetricEvent,
  type TurnContinuation,
  type TurnContinuedEvent,
  type RuntimeTurnCost,
  type RuntimeTurnErrorCode,
  type RuntimeTurnStatus,
  type RuntimeRolloutCohort,
  type TechnicalRuntimeEventV2,
  type TechnicalRuntimeEventV3,
  type ToolContractRejectedEvent,
  type TurnContinuedEventV3,
} from '../../contracts/index.js';
import { modelFacingToolName } from '../local-tool-bindings.js';
import type { TurnSnapshot } from '../turn-snapshot.js';
import { combineTurnCost } from './cost.js';

const MAX_DURATION_MS = 86_400_000;
const MAX_CALLS = 10_000;

/** Who reports: fixed per sink, attached to every event. */
export interface RuntimeMetricsIdentity {
  readonly appId: string;
  readonly environmentId: string;
  readonly buildId: string | null;
  readonly instanceId: string;
}

/**
 * Receives finished turns and contract rejections. `record` must return
 * immediately and never throw: delivery happens later, off the turn, and is
 * dropped on failure.
 */
export interface RuntimeMetricsSink {
  readonly identity: RuntimeMetricsIdentity;
  record(event: RuntimeMetricEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** One model step, already reduced to content-free numbers and tool names. */
export interface TurnMetricsStep {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: RuntimeTurnCost;
  /** Model-facing names of every tool call in the step (one entry per call). */
  toolNames: ReadonlyArray<string>;
  /** Model-facing names of the calls that failed (one entry per failure). */
  failedToolNames: ReadonlyArray<string>;
  /** Approvals the step asked the user for. */
  approvalRequests?: number;
}

/** A turn event of either schema version. */
export type TurnMetricsEvent =
  | TechnicalRuntimeEventV2
  | TurnContinuedEvent
  | TechnicalRuntimeEventV3
  | TurnContinuedEventV3;

/** The deployment and cohort a turn ran in; null for a turn on the local code. */
export interface TurnRollout {
  readonly deploymentId: string | null;
  readonly cohort: RuntimeRolloutCohort | null;
}

// The rollout of a snapshot `createGlirastes` resolved, so a recorder given only the snapshot reports it too.
const snapshotRollouts = new WeakMap<TurnSnapshot, TurnRollout>();

/** Internal: remembers the rollout a cohort-selecting runner chose for that snapshot. */
export function attachTurnRollout(snapshot: TurnSnapshot, rollout: TurnRollout | undefined): TurnSnapshot {
  if (rollout) snapshotRollouts.set(snapshot, rollout);
  return snapshot;
}

export interface TurnMetricsOutcome {
  status: RuntimeTurnStatus;
  errorCode: RuntimeTurnErrorCode | null;
}

export interface TurnMetricsRecorder {
  /** The first streamed chunk of the turn; later calls do nothing. */
  markFirstChunk(): void;
  recordStep(step: TurnMetricsStep): void;
  /**
   * Builds the turn's event and hands it to the sink exactly once. Returns
   * the event, or undefined when the turn was already finished. Never throws.
   */
  finish(outcome: TurnMetricsOutcome): TurnMetricsEvent | undefined;
  /**
   * An endpoint refused a call its tool schema accepted (spec 4.7). Hands a
   * content-free `tool_contract_rejected` event to the sink right away and
   * returns it; undefined for a tool outside the pinned snapshot. The name is
   * the manifest name or its model-facing encoding. Never throws.
   */
  recordToolContractRejected(toolName: string, httpStatus: 400 | 422): ToolContractRejectedEvent | undefined;
}

export interface TurnMetricsRecorderOptions {
  sink: RuntimeMetricsSink;
  /** Pinned snapshot: names the revision and maps tool names to tool ids. */
  snapshot?: TurnSnapshot;
  /** Turn start (request start), in the clock of `now`. */
  startedAtMs: number;
  /**
   * Set when the request continues a turn (no new user message): the
   * request is reported as `turn.continued` instead of `turn.finished`.
   */
  continuation?: TurnContinuation;
  /**
   * Required with `continuation`: the turn's id (the handler's id of the
   * last user message, chosen by the client) and a key that never leaves the
   * consumer. The event carries only `turnId` = the first 128 bits (hex) of
   * HMAC-SHA-256 over app, environment and turn id under that key, never
   * the id itself. Without it (or with an empty key) no `turn.continued`
   * event is built. Instances that share the key give every continuation of
   * a turn the same value, also after a restart.
   */
  continuedTurn?: { readonly turnId: string; readonly secret: string };
  /**
   * Set only by a runner that selects a cohort per turn (canary
   * negotiation): the turn is then reported as schema version 3 with these
   * fields, `approvalsRequested` and `approvalsDeclined`. Without it the event stays v2,
   * unless `snapshot` was resolved by `createGlirastes().chatTurn()` with a rollout.
   */
  rollout?: TurnRollout;
  /** Approvals this request declined; reported with `rollout` only. */
  approvalsDeclined?: number;
  now?: () => number;
  createEventId?: () => string;
}

/**
 * The opaque `turnId` of a continuation: domain-separated subkey of the
 * consumer's key, then HMAC over app, environment and the client's turn id,
 * truncated to 128 bits. Undefined for an empty key or turn id.
 */
function opaqueTurnId(
  identity: RuntimeMetricsIdentity,
  turn: { readonly turnId: string; readonly secret: string } | undefined,
): string | undefined {
  if (!turn || typeof turn.secret !== 'string' || turn.secret === ''
    || typeof turn.turnId !== 'string' || turn.turnId === '') return undefined;
  const subkey = createHmac('sha256', turn.secret).update('glirastes-metrics-turn-id-v1').digest();
  return createHmac('sha256', subkey)
    .update(JSON.stringify([identity.appId, identity.environmentId, turn.turnId]))
    .digest('hex')
    .slice(0, 32);
}

function bounded(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;
}

function technicalLabel(value: string | null): string | null {
  return value !== null && RUNTIME_METRIC_LABEL_PATTERN.test(value) ? value : null;
}

export function createTurnMetricsRecorder(
  options: TurnMetricsRecorderOptions,
): TurnMetricsRecorder {
  const now = options.now ?? Date.now;
  const createEventId = options.createEventId ?? randomUUID;
  const rollout = options.rollout ?? (options.snapshot && snapshotRollouts.get(options.snapshot));
  const manifestTools = options.snapshot?.manifestRevision.tools ?? [];
  const toolIdByName = new Map(manifestTools.map((tool) => [
    modelFacingToolName(tool.name),
    tool.toolId,
  ] as const));
  const schemaDigestByName = new Map(manifestTools.map((tool) => [
    modelFacingToolName(tool.name),
    tool.inputSchemaDigest,
  ] as const));
  const costs: RuntimeTurnCost[] = [];
  const usage = new Map<string, { calls: number; errors: number }>();
  let firstChunkAtMs: number | undefined;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let approvalRequests = 0;
  let finished = false;

  const usageOf = (toolName: string) => {
    const toolId = toolIdByName.get(toolName);
    if (!toolId) return undefined;
    let entry = usage.get(toolId);
    if (!entry) {
      entry = { calls: 0, errors: 0 };
      usage.set(toolId, entry);
    }
    return entry;
  };

  const listedTools = () => [...usage.entries()]
    .map(([toolId, entry]) => ({
      toolId,
      calls: Math.min(MAX_CALLS, entry.calls),
      errors: Math.min(MAX_CALLS, entry.errors, entry.calls),
    }))
    .filter((tool) => tool.calls > 0)
    .sort((left, right) => right.calls - left.calls
      || left.toolId.localeCompare(right.toolId))
    .slice(0, RUNTIME_METRIC_MAX_TOOLS)
    .sort((left, right) => left.toolId.localeCompare(right.toolId));

  const build = (outcome: TurnMetricsOutcome): TurnMetricsEvent | undefined => {
    const endedAtMs = now();
    const totalMs = bounded(endedAtMs - options.startedAtMs, MAX_DURATION_MS);
    const firstTokenMs = firstChunkAtMs === undefined
      ? null
      : Math.min(totalMs, bounded(firstChunkAtMs - options.startedAtMs, MAX_DURATION_MS));
    const calls = Math.min(MAX_CALLS, toolCallCount);
    const fields = {
      schemaVersion: 2,
      eventId: createEventId(),
      occurredAt: new Date(endedAtMs).toISOString(),
      appId: options.sink.identity.appId,
      environmentId: options.sink.identity.environmentId,
      buildId: options.sink.identity.buildId,
      instanceId: options.sink.identity.instanceId,
      revisionId: options.snapshot?.agentRevision.revisionId ?? null,
      model,
      status: outcome.status,
      errorCode: outcome.errorCode,
      inputTokens: bounded(inputTokens, RUNTIME_METRIC_MAX_COUNT),
      outputTokens: bounded(outputTokens, RUNTIME_METRIC_MAX_COUNT),
      cost: combineTurnCost(costs),
      latency: { firstTokenMs, totalMs },
      toolCallCount: calls,
      toolErrorCount: Math.min(calls, toolErrorCount),
      tools: listedTools(),
    };
    if (rollout) {
      const v3 = {
        ...fields,
        schemaVersion: 3,
        deploymentId: rollout.deploymentId,
        cohort: rollout.cohort,
        approvalsRequested: bounded(approvalRequests, MAX_CALLS),
        approvalsDeclined: bounded(options.approvalsDeclined ?? 0, MAX_CALLS),
      };
      if (options.continuation) {
        const turnId = opaqueTurnId(options.sink.identity, options.continuedTurn);
        if (!turnId) return undefined;
        const continued = TurnContinuedEventV3Schema.safeParse({
          ...v3, eventType: 'turn.continued', continuation: options.continuation, turnId,
        });
        return continued.success ? continued.data : undefined;
      }
      const parsed = TechnicalRuntimeEventV3Schema.safeParse({ ...v3, eventType: 'turn.finished' });
      return parsed.success ? parsed.data : undefined;
    }
    if (options.continuation) {
      const turnId = opaqueTurnId(options.sink.identity, options.continuedTurn);
      if (!turnId) return undefined;
      const continued = TurnContinuedEventSchema.safeParse({
        ...fields, eventType: 'turn.continued', continuation: options.continuation, turnId,
      });
      return continued.success ? continued.data : undefined;
    }
    const parsed = TechnicalRuntimeEventV2Schema.safeParse({ ...fields, eventType: 'turn.finished' });
    return parsed.success ? parsed.data : undefined;
  };

  return {
    markFirstChunk() {
      firstChunkAtMs ??= now();
    },

    recordStep(step) {
      if (finished) return;
      model = technicalLabel(step.model) ?? model;
      inputTokens += Number.isFinite(step.inputTokens) ? step.inputTokens : 0;
      outputTokens += Number.isFinite(step.outputTokens) ? step.outputTokens : 0;
      costs.push(step.cost);
      toolCallCount += step.toolNames.length;
      toolErrorCount += step.failedToolNames.length;
      approvalRequests += Number.isInteger(step.approvalRequests) && step.approvalRequests! > 0 ? step.approvalRequests! : 0;
      for (const name of step.toolNames) {
        const entry = usageOf(name);
        if (entry) entry.calls += 1;
      }
      for (const name of step.failedToolNames) {
        const entry = usageOf(name);
        if (entry) entry.errors += 1;
      }
    },

    recordToolContractRejected(toolName, httpStatus) {
      try {
        // Endpoint tools may carry the dotted definitionId as `toolName`; the
        // maps are keyed by the model-facing encoding (idempotent for names
        // that are already encoded).
        const modelName = modelFacingToolName(toolName);
        const toolId = toolIdByName.get(modelName);
        const inputSchemaDigest = schemaDigestByName.get(modelName);
        if (!toolId || !inputSchemaDigest) return undefined;
        const parsed = ToolContractRejectedEventSchema.safeParse({
          schemaVersion: 2,
          eventId: createEventId(),
          eventType: 'tool_contract_rejected',
          occurredAt: new Date(now()).toISOString(),
          appId: options.sink.identity.appId,
          environmentId: options.sink.identity.environmentId,
          buildId: options.sink.identity.buildId,
          instanceId: options.sink.identity.instanceId,
          revisionId: options.snapshot?.agentRevision.revisionId ?? null,
          toolId,
          inputSchemaDigest,
          httpStatus,
        });
        if (!parsed.success) return undefined;
        try {
          options.sink.record(parsed.data);
        } catch {
          // A sink must never fail a tool call.
        }
        return parsed.data;
      } catch {
        return undefined;
      }
    },

    finish(outcome) {
      if (finished) return undefined;
      finished = true;
      try {
        const event = build(outcome);
        if (!event) return undefined;
        try {
          options.sink.record(event);
        } catch {
          // A sink must never fail a turn.
        }
        return event;
      } catch {
        return undefined;
      }
    },
  };
}
