import { z } from 'zod';
import {
  findForbiddenContentPath,
  findForbiddenPlatformContentPath,
} from './content-boundary.js';

export const TechnicalRuntimeEventSchema = z.object({
  eventId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  eventType: z.string().trim().min(1).max(100),
  tenantId: z.uuid(),
  targetAppId: z.uuid(),
  environmentId: z.uuid(),
  agentRevisionId: z.uuid().optional(),
  policyRevisionId: z.uuid().optional(),
  manifestRevisionId: z.uuid().optional(),
  runId: z.string().trim().min(1).max(200),
  status: z.string().trim().min(1).max(100),
  durationMs: z.number().int().nonnegative().optional(),
  errorClass: z.string().trim().min(1).max(200).optional(),
  budget: z.object({
    modelSteps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
  }).strict().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((event, context) => {
  const path = findForbiddenContentPath(event.metadata, ['metadata']);
  if (path) {
    context.addIssue({
      code: 'custom',
      message: 'Technical runtime events must not contain business content or credentials',
      path,
    });
  }
});

export type TechnicalRuntimeEvent = z.infer<typeof TechnicalRuntimeEventSchema>;

// ---------------------------------------------------------------------------
// TechnicalRuntimeEvent v2: one content-free metric event per chat turn
// ---------------------------------------------------------------------------

export const RUNTIME_METRIC_EVENT_SCHEMA_VERSION = 2;
/** Turn events of a runner that selects a cohort per turn (canary): v2 plus rollout fields. */
export const RUNTIME_METRIC_EVENT_SCHEMA_VERSION_V3 = 3;
/** Most events one ingest request carries (keeps a batch far below 256 KB). */
export const RUNTIME_METRIC_MAX_BATCH = 50;
/** Most distinct tools one turn event lists; further tools only count. */
export const RUNTIME_METRIC_MAX_TOOLS = 32;
/** Largest count or token number a metric carries (Postgres `integer`). */
export const RUNTIME_METRIC_MAX_COUNT = 2_147_483_647;

/**
 * A technical label (model slug, build id, instance id): no whitespace, no
 * quotes, at most 200 characters. Free text cannot pass.
 */
export const RUNTIME_METRIC_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
export const RUNTIME_PRICING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const metricLabel = z.string().regex(RUNTIME_METRIC_LABEL_PATTERN);
const metricCount = z.number().int().nonnegative().max(RUNTIME_METRIC_MAX_COUNT);
const callCount = z.number().int().nonnegative().max(10_000);
const durationMs = z.number().int().nonnegative().max(86_400_000);

export const RuntimeTurnStatusSchema = z.enum([
  'completed',
  'safety-stop',
  'aborted',
  'error',
]);
export const RuntimeTurnErrorCodeSchema = z.enum([
  'model_error',
  'pipeline_error',
  'budget_exhausted',
  'step_limit',
]);
export const RuntimeCostSourceSchema = z.enum(['provider-reported', 'price-table']);

const ERROR_CODES_BY_STATUS: Partial<Record<
  z.infer<typeof RuntimeTurnStatusSchema>,
  ReadonlyArray<z.infer<typeof RuntimeTurnErrorCodeSchema>>
>> = {
  error: ['model_error', 'pipeline_error'],
  'safety-stop': ['budget_exhausted', 'step_limit'],
};

/**
 * Cost of a turn with its provenance. Unknown stays `null`, never 0: a
 * provider-reported amount (OpenRouter `usage.cost`) or a price-table
 * estimate that names its pricing version.
 */
export const RuntimeTurnCostSchema = z.object({
  usd: z.number().finite().nonnegative().max(1_000_000).nullable(),
  source: RuntimeCostSourceSchema.nullable(),
  pricingVersion: z.string().regex(RUNTIME_PRICING_VERSION_PATTERN).nullable(),
}).strict().superRefine((cost, context) => {
  if ((cost.usd === null) !== (cost.source === null)) {
    context.addIssue({
      code: 'custom',
      message: 'A cost amount and its source are known together or not at all',
      path: ['source'],
    });
  }
  if ((cost.source === 'price-table') !== (cost.pricingVersion !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'Exactly a price-table cost names its pricing version',
      path: ['pricingVersion'],
    });
  }
});

export const RuntimeTurnToolUsageSchema = z.object({
  toolId: z.uuid(),
  calls: callCount.min(1),
  errors: callCount,
}).strict().refine((usage) => usage.errors <= usage.calls, {
  message: 'A tool cannot fail more often than it was called',
  path: ['errors'],
});

/** Fields of a turn event, without its type. */
const turnEventFields = {
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
  eventId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  appId: z.uuid(),
  environmentId: z.uuid(),
  buildId: metricLabel.nullable(),
  instanceId: metricLabel,
  revisionId: z.uuid().nullable(),
  model: metricLabel.nullable(),
  status: RuntimeTurnStatusSchema,
  errorCode: RuntimeTurnErrorCodeSchema.nullable(),
  inputTokens: metricCount,
  outputTokens: metricCount,
  cost: RuntimeTurnCostSchema,
  latency: z.object({
    firstTokenMs: durationMs.nullable(),
    totalMs: durationMs,
  }).strict(),
  toolCallCount: callCount,
  toolErrorCount: callCount,
  tools: z.array(RuntimeTurnToolUsageSchema).max(RUNTIME_METRIC_MAX_TOOLS),
};

type TurnEventFields = Omit<z.infer<z.ZodObject<typeof turnEventFields>>, 'schemaVersion'>;

function refineTurnEvent(event: TurnEventFields, context: z.RefinementCtx): void {
  const allowed = ERROR_CODES_BY_STATUS[event.status];
  if (allowed ? !event.errorCode || !allowed.includes(event.errorCode) : event.errorCode !== null) {
    context.addIssue({
      code: 'custom',
      message: 'The error code does not match the turn status',
      path: ['errorCode'],
    });
  }
  if (
    event.latency.firstTokenMs !== null
    && event.latency.firstTokenMs > event.latency.totalMs
  ) {
    context.addIssue({
      code: 'custom',
      message: 'The first token cannot arrive after the turn ended',
      path: ['latency', 'firstTokenMs'],
    });
  }
  if (event.toolErrorCount > event.toolCallCount) {
    context.addIssue({
      code: 'custom',
      message: 'A turn cannot have more failed than started tool calls',
      path: ['toolErrorCount'],
    });
  }
  const toolIds = event.tools.map((tool) => tool.toolId);
  if (new Set(toolIds).size !== toolIds.length) {
    context.addIssue({
      code: 'custom',
      message: 'Each tool is listed once',
      path: ['tools'],
    });
  }
  const listedCalls = event.tools.reduce((sum, tool) => sum + tool.calls, 0);
  const listedErrors = event.tools.reduce((sum, tool) => sum + tool.errors, 0);
  if (listedCalls > event.toolCallCount || listedErrors > event.toolErrorCount) {
    context.addIssue({
      code: 'custom',
      message: 'Listed tools cannot exceed the turn totals',
      path: ['tools'],
    });
  }
  const forbidden = findForbiddenPlatformContentPath(event);
  if (forbidden) {
    context.addIssue({
      code: 'custom',
      message: 'Runtime metric events must not contain content or credentials',
      path: forbidden,
    });
  }
}

export const TechnicalRuntimeEventV2Schema = z.object({
  ...turnEventFields,
  eventType: z.literal('turn.finished'),
}).strict().superRefine(refineTurnEvent);

/** Why a request continued a turn instead of starting one: answered approvals, or reported UI outcomes. */
export const TurnContinuationSchema = z.enum(['approval', 'ui-outcome']);

/**
 * Opaque reference of the turn a continuation belongs to: 32 lower-case hex
 * characters (128 bits of an HMAC-SHA-256 under a key that never leaves the
 * consumer). Every continuation of one turn carries the same value; it
 * reveals nothing about the turn, its messages or the client's message id.
 */
const RUNTIME_METRIC_TURN_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * A request that continued a turn (no new user message): the same numbers
 * as `turn.finished` for that request, so turns are not counted twice. A
 * type of its own, sent in batches of its own: a Platform that does not know
 * it yet refuses only these batches and keeps receiving finished turns.
 * `turnId` groups the continuations of one turn; `turn.finished` carries
 * none, so the first request of a turn cannot be joined to them.
 */
export const TurnContinuedEventSchema = z.object({
  ...turnEventFields,
  eventType: z.literal('turn.continued'),
  continuation: TurnContinuationSchema,
  turnId: z.string().regex(RUNTIME_METRIC_TURN_ID_PATTERN),
}).strict().superRefine(refineTurnEvent);

export const RuntimeRolloutCohortSchema = z.enum(['stable', 'canary']);

/** v3: the deployment and cohort the turn ran in, and the approvals its request raised and declined. */
const turnEventV3Fields = {
  ...turnEventFields,
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION_V3),
  deploymentId: z.uuid().nullable(),
  cohort: RuntimeRolloutCohortSchema.nullable(),
  approvalsRequested: callCount,
  approvalsDeclined: callCount,
};

function refineTurnEventV3(
  event: TurnEventFields & { deploymentId: string | null; cohort: string | null },
  context: z.RefinementCtx,
): void {
  refineTurnEvent(event, context);
  if ((event.deploymentId === null) !== (event.cohort === null)) {
    context.addIssue({
      code: 'custom',
      message: 'A deployment and its cohort are known together or not at all',
      path: ['cohort'],
    });
  }
}

export const TechnicalRuntimeEventV3Schema = z.object({
  ...turnEventV3Fields,
  eventType: z.literal('turn.finished'),
}).strict().superRefine(refineTurnEventV3);

export const TurnContinuedEventV3Schema = z.object({
  ...turnEventV3Fields,
  eventType: z.literal('turn.continued'),
  continuation: TurnContinuationSchema,
  turnId: z.string().regex(RUNTIME_METRIC_TURN_ID_PATTERN),
}).strict().superRefine(refineTurnEventV3);

export type TechnicalRuntimeEventV2 = z.infer<typeof TechnicalRuntimeEventV2Schema>;
export type TechnicalRuntimeEventV3 = z.infer<typeof TechnicalRuntimeEventV3Schema>;
export type TurnContinuedEventV3 = z.infer<typeof TurnContinuedEventV3Schema>;
export type RuntimeRolloutCohort = z.infer<typeof RuntimeRolloutCohortSchema>;
export type TurnContinuation = z.infer<typeof TurnContinuationSchema>;
export type TurnContinuedEvent = z.infer<typeof TurnContinuedEventSchema>;
export type RuntimeTurnStatus = z.infer<typeof RuntimeTurnStatusSchema>;
export type RuntimeTurnErrorCode = z.infer<typeof RuntimeTurnErrorCodeSchema>;
export type RuntimeCostSource = z.infer<typeof RuntimeCostSourceSchema>;
export type RuntimeTurnCost = z.infer<typeof RuntimeTurnCostSchema>;
export type RuntimeTurnToolUsage = z.infer<typeof RuntimeTurnToolUsageSchema>;

/** Statuses of an endpoint that refused a call its tool schema accepted. */
export const TOOL_CONTRACT_REJECTED_STATUSES = [400, 422] as const;

/**
 * An endpoint refused a call that passed the tool's input schema (spec 4.7):
 * the contract the model saw is wrong, so the tool belongs on the next work
 * list or managed job. Content-free: tool, schema version and status, never
 * arguments, response or message.
 */
export const ToolContractRejectedEventSchema = z.object({
  schemaVersion: z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
  eventId: z.uuid(),
  eventType: z.literal('tool_contract_rejected'),
  occurredAt: z.iso.datetime({ offset: true }),
  appId: z.uuid(),
  environmentId: z.uuid(),
  buildId: metricLabel.nullable(),
  instanceId: metricLabel,
  revisionId: z.uuid().nullable(),
  toolId: z.uuid(),
  /** The manifest's digest of the input schema the call passed (same alphabet as the manifest). */
  inputSchemaDigest: z.string().regex(/^sha256:[A-Za-z0-9+/=_-]{1,88}$/),
  httpStatus: z.union([z.literal(400), z.literal(422)]),
}).strict().superRefine((event, context) => {
  const forbidden = findForbiddenPlatformContentPath(event);
  if (forbidden) {
    context.addIssue({
      code: 'custom',
      message: 'Runtime metric events must not contain content or credentials',
      path: forbidden,
    });
  }
});

export type ToolContractRejectedEvent = z.infer<typeof ToolContractRejectedEventSchema>;

/** Every content-free metric event of the runtime: finished and continued turns, contract rejections. */
export const RuntimeMetricEventSchema = z.union([
  TechnicalRuntimeEventV2Schema,
  TurnContinuedEventSchema,
  TechnicalRuntimeEventV3Schema,
  TurnContinuedEventV3Schema,
  ToolContractRejectedEventSchema,
]);

export type RuntimeMetricEvent = z.infer<typeof RuntimeMetricEventSchema>;

/**
 * Body of `POST /v1/runtime/apps/:appId/environments/:environmentId/metrics/events`.
 * One batch carries one event type of the batch's schema version, so a
 * Platform that does not know a newer type or version refuses only that
 * batch and keeps receiving turns.
 */
export const TechnicalRuntimeEventBatchSchema = z.object({
  schemaVersion: z.union([
    z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION),
    z.literal(RUNTIME_METRIC_EVENT_SCHEMA_VERSION_V3),
  ]),
  events: z.array(RuntimeMetricEventSchema).min(1).max(RUNTIME_METRIC_MAX_BATCH),
}).strict().refine((batch) => new Set(batch.events.map((event) => event.eventType)).size === 1, {
  message: 'A batch carries one event type',
  path: ['events'],
}).refine((batch) => batch.events.every((event) => event.schemaVersion === batch.schemaVersion), {
  message: 'A batch carries events of its own schema version',
  path: ['events'],
});

export type TechnicalRuntimeEventBatch = z.infer<typeof TechnicalRuntimeEventBatchSchema>;
