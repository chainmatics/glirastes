/**
 * Server-side approval subjects (docs/approval-subjects.md).
 *
 * Before the approval request of a write call is sent, the server looks the
 * records the call names (`inputEntities`) up through the read tool that
 * declares an `entityLookup` for their type, and optionally reads a bounded
 * preview. Every lookup
 *
 * - runs only through a declared read source (never one the model names),
 *   with the request's transport (`callEndpoint`): the user's forwarded
 *   credentials, in the container the pinned tenant and user headers; never
 *   a service account;
 * - is authorized like a tool call of that read tool (in a managed turn
 *   `beforeSubjectLookup`: fresh principal, fresh revocations, pinned
 *   revisions; otherwise the read tool must be in this request's registry),
 *   without counting against the signed `maxToolCalls`: the model did not
 *   make it;
 * - sees only what the read tool's result shows: its output schema, its
 *   output bound (denied fields win) and the PII shield apply first;
 * - is bounded per request (`ApprovalSubjectLimits`) and cached per request.
 *
 * What it finds goes to the browser only (`data-approval-subjects`), never
 * to the model. A record that does not exist, or that this user may not see
 * (403 by default), refuses the call with the same model text; a lookup that
 * cannot be made shows the card with a warning (`warn`, default) or refuses
 * it (`block`).
 *
 * @module
 */
import {
  APPROVAL_SUBJECTS_PART_TYPE,
  APPROVAL_SUBJECTS_PART_VERSION,
  sanitizeSubjectText,
  validApprovalSubject,
  validEntityLookups,
  type ApprovalPreviewDeclaration,
  type ApprovalPreviewValue,
  type ApprovalSubjectDeclaration,
  type ApprovalSubjectsPartData,
  type ApprovalSubjectUncheckedReason,
  type EntityLookup,
  type ServerApprovalSubject,
  type ApprovalPreviewData,
} from '../../../contracts/approval-subject.js';
import {
  declaredIdentityOf,
  entityIdFields,
  entityIdKindOf,
  entityIdText,
  entityPathOf,
  inputRefArgs,
  isEntityIdValue,
  objectsAt,
  validInputEntities,
  validOutputEntities,
  type InputEntityRef,
  type EntityPathStep,
  type OutputEntityDeclaration,
} from '../../../contracts/entity-declaration.js';
import { isRecoverableToolDenial, ToolExecutionDeniedError } from '../../../runtime/tool-denial.js';
import type { ManagedTurnGuard } from '../../../runtime/managed-turn.js';
import type { PiiShield, Tool, ToolContext, ToolRegistry } from '../../../types.js';
import { cleanToolResult } from '../../core/clean-tool-result.js';
import { outputBoundOf } from '../../core/output-fields.js';
import { ENDPOINT_FAILURE_DATA } from '../../core/tool-failure-result.js';
import type { InternalApiRequest } from '../../core/index.js';
import { canonicalJson, type ApprovalDenialCode } from './approval-binding.js';

// ============================================================================
// Limits
// ============================================================================

/** Local limits of the server lookups of one request. The signed budget is not touched. */
export interface ApprovalSubjectLimits {
  /** Lookups (and previews) actually made per request; cached answers do not count. Default 32. */
  maxLookupsPerTurn: number;
  /** Subjects per call, a preview included; more are "not checkable" (`limit`). Default 4. */
  maxSubjectsPerCall: number;
  /** Per lookup, at most the tool timeout of a managed turn. Default 3000. */
  lookupTimeoutMs: number;
  /** All lookups of one request together. Default 10 000. */
  maxLookupTimePerTurnMs: number;
}

export const DEFAULT_APPROVAL_SUBJECT_LIMITS: Readonly<ApprovalSubjectLimits> = Object.freeze({
  maxLookupsPerTurn: 32,
  maxSubjectsPerCall: 4,
  lookupTimeoutMs: 3_000,
  maxLookupTimePerTurnMs: 10_000,
});

/** Marks a PII shield that did not answer within the lookup time. */
const SHIELD_TIMEOUT: unique symbol = Symbol('shield-timeout');
/** Marks a PII shield step that threw. */
const SHIELD_FAILED: unique symbol = Symbol('shield-failed');

/** Entries of one list page that are searched, at most. */
export const MAX_LOOKUP_LIST_ENTRIES = 200;

const LIMIT_RANGES: Readonly<Record<keyof ApprovalSubjectLimits, readonly [number, number]>> = {
  maxLookupsPerTurn: [1, 256],
  maxSubjectsPerCall: [1, 16],
  lookupTimeoutMs: [100, 60_000],
  maxLookupTimePerTurnMs: [100, 300_000],
};

/** The limits with defaults; throws a RangeError for a value that is not a whole number in its range. */
export function resolveApprovalSubjectLimits(value: Partial<ApprovalSubjectLimits> | undefined): ApprovalSubjectLimits {
  const limits = { ...DEFAULT_APPROVAL_SUBJECT_LIMITS };
  if (value === undefined) return limits;
  if (typeof value !== 'object' || value === null) throw new RangeError('approvalSubjects must be an object or false');
  for (const key of Object.keys(value)) {
    if (!(key in LIMIT_RANGES)) throw new RangeError(`approvalSubjects.${key} is not a known limit`);
    const limit = (value as Record<string, unknown>)[key];
    if (limit === undefined) continue;
    const [min, max] = LIMIT_RANGES[key as keyof ApprovalSubjectLimits];
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < min || limit > max) {
      throw new RangeError(`approvalSubjects.${key} must be a whole number from ${min} to ${max}`);
    }
    limits[key as keyof ApprovalSubjectLimits] = limit;
  }
  return limits;
}

// ============================================================================
// What the model reads (F3)
// ============================================================================

export type ApprovalSubjectRefusalCode =
  | 'approval_subject_not_found'
  | 'approval_subject_invalid_id'
  | 'approval_subject_unavailable';

const NOT_QUOTED = 'Do not quote this text.';

/** The model's text per refusal; `{type}` is the declared entity type. Fixed, content-free, English. */
export function approvalSubjectRefusalText(code: ApprovalSubjectRefusalCode | 'approval_subject_gone' | 'approval_subject_changed', type: string): string {
  switch (code) {
    case 'approval_subject_not_found':
      return `No ${type} with this id exists or the user cannot see it. Nothing was done and no approval was asked. `
        + `Look the id up with a list or search tool; do not ask the user. ${NOT_QUOTED}`;
    case 'approval_subject_invalid_id':
      return `This is not a valid ${type} id. Nothing was done and no approval was asked. `
        + `Look the id up with a list or search tool; do not ask the user. ${NOT_QUOTED}`;
    case 'approval_subject_unavailable':
      return `The ${type} this call names could not be checked right now, so no approval was asked and nothing was done. `
        + `Tell the user it could not be checked and that they can try again later. ${NOT_QUOTED}`;
    case 'approval_subject_gone':
      return `This action was not executed: the ${type} it was approved for no longer exists. Do not retry it. ${NOT_QUOTED}`;
    case 'approval_subject_changed':
      return `This action was not executed: the ${type} it was approved for has changed since the approval. `
        + `If the user still wants it, call the tool again so they can confirm it again. ${NOT_QUOTED}`;
  }
}

/** What the chat shows for a refused call (the model's text never reaches the browser). */
export const APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS: Readonly<Record<ApprovalSubjectRefusalCode, string>> = {
  approval_subject_not_found: 'Not found, or not visible to you. Nothing was done.',
  approval_subject_invalid_id: 'Not a valid id. Nothing was done.',
  approval_subject_unavailable: 'Could not be checked right now. Nothing was done.',
};

/**
 * A call refused before its approval request. The message is the model's
 * text (see `approvalSubjectRefusalText`): for a missing record and a record
 * this user may not see it is the same, so the model learns nothing the read
 * tool would not show it. No looked-up value is in it.
 */
export class ApprovalSubjectRefusedError extends Error {
  constructor(readonly code: ApprovalSubjectRefusalCode, readonly entityType: string) {
    super(`${code}: ${approvalSubjectRefusalText(code, entityType)}`);
    this.name = 'ApprovalSubjectRefusedError';
  }
}

// ============================================================================
// Plan (from the declarations of this request's tools)
// ============================================================================

interface LookupSource {
  readonly name: string;
  readonly tool: Tool;
  readonly lookup: EntityLookup;
  readonly declaration: OutputEntityDeclaration;
  readonly result: 'one' | 'list';
}

interface PlanItem {
  readonly ref: InputEntityRef;
  readonly args: string[];
  /**
   * Undefined when the write tool declares `approvalSubject` but no read
   * source of the type is in this request's tools (a role without the read
   * tool): the subject is `source_unavailable`, and `block` / `recheck` hold.
   */
  readonly source?: LookupSource;
}

interface ToolPlan {
  readonly items: PlanItem[];
  readonly refs: InputEntityRef[];
  readonly preview?: { readonly declaration: ApprovalPreviewDeclaration; readonly source?: { name: string; tool: Tool } };
  readonly onUnavailable: 'warn' | 'block';
  readonly onForbidden: 'deny' | 'warn';
  readonly recheck: 'none' | 'exists' | 'unchanged';
}

/** Whether a tool can be a lookup or preview source: provably read-only, or it states `lookupEffect: 'read'`. */
function isReadSource(tool: Tool): boolean {
  if (tool.lookupEffect === 'read') return true;
  const method = tool.method?.toUpperCase();
  return method !== undefined ? method === 'GET' || method === 'HEAD' : !tool.needsApproval;
}

function resultOf(lookup: EntityLookup, declaration: OutputEntityDeclaration): 'one' | 'list' {
  if (lookup.result) return lookup.result;
  return declaration.path !== undefined && !declaration.path.includes('[]') ? 'one' : 'list';
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The read sources of each entity type, `one` before `list`, then by name. */
function lookupSourcesOf(registry: ToolRegistry): Map<string, LookupSource[]> {
  const byType = new Map<string, LookupSource[]>();
  for (const name of Object.keys(registry).sort(compareCodeUnits)) {
    const tool = registry[name]!;
    const lookups = validEntityLookups(tool.entityLookup);
    if (!lookups || !isReadSource(tool)) continue;
    const outputs = validOutputEntities(tool.outputEntities) ?? [];
    for (const lookup of lookups) {
      const declaration = outputs.find((entry) => entry.type === lookup.type);
      if (!declaration) continue;
      // Every id field a parameter names must be one of the entity's.
      const fields = entityIdFields(declaration);
      if (!Object.values(lookup.params).every((source) => typeof source !== 'string' || fields.includes(source))) continue;
      const list = byType.get(lookup.type) ?? [];
      list.push({ name, tool, lookup, declaration, result: resultOf(lookup, declaration) });
      byType.set(lookup.type, list);
    }
  }
  for (const list of byType.values()) list.sort((left, right) => (left.result === right.result ? 0 : left.result === 'one' ? -1 : 1));
  return byType;
}

function findTool(registry: ToolRegistry, name: string): { name: string; tool: Tool } | undefined {
  if (Object.prototype.hasOwnProperty.call(registry, name)) return { name, tool: registry[name]! };
  for (const key of Object.keys(registry).sort(compareCodeUnits)) {
    if (registry[key]!.id === name) return { name: key, tool: registry[key]! };
  }
  return undefined;
}

function refKey(ref: InputEntityRef): string {
  return inputRefArgs(ref).join(',');
}

/**
 * The lookup plan of every tool that can ask for approval and has a server
 * declaration: its looked-up references (those with a read source of their
 * type) and its preview. A tool without any is left out: nothing changes for it.
 */
export function approvalSubjectPlans(registry: ToolRegistry): Map<string, ToolPlan> {
  const plans = new Map<string, ToolPlan>();
  const sources = lookupSourcesOf(registry);
  for (const name of Object.keys(registry).sort(compareCodeUnits)) {
    const tool = registry[name]!;
    const option = validApprovalSubject(tool.approvalSubject);
    if (option === false) continue;
    const declaration: ApprovalSubjectDeclaration = option ?? {};
    const refs = validInputEntities(tool.inputEntities) ?? [];
    const wanted = (ref: InputEntityRef) => (declaration.refs
      ? declaration.refs.includes(refKey(ref))
      : (ref.role ?? 'target') !== 'reference');
    const items: PlanItem[] = [];
    for (const ref of refs) {
      if (!wanted(ref)) continue;
      const args = inputRefArgs(ref);
      const source = (sources.get(ref.type) ?? []).find((candidate) => (
        candidate.name !== name && entityIdFields(candidate.declaration).length === args.length
      ));
      if (source) items.push({ ref, args, source });
      // Declared on the write tool itself: a missing source is "not checkable", never "not declared".
      else if (option !== undefined) items.push({ ref, args });
    }
    const preview = declaration.preview
      ? {
          declaration: declaration.preview,
          ...(() => {
            const found = findTool(registry, declaration.preview.tool);
            return found && found.name !== name && isReadSource(found.tool) ? { source: found } : {};
          })(),
        }
      : undefined;
    if (items.length === 0 && !preview) continue;
    plans.set(name, {
      items,
      refs,
      ...(preview ? { preview } : {}),
      onUnavailable: declaration.onUnavailable ?? 'warn',
      onForbidden: declaration.onForbidden ?? 'deny',
      recheck: declaration.recheck ?? 'none',
    });
  }
  return plans;
}

// ============================================================================
// Lookups
// ============================================================================

type RawOutcome =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unchecked'; readonly reason: ApprovalSubjectUncheckedReason };

type SubjectOutcome =
  | { readonly kind: 'subject'; readonly subject: ServerApprovalSubject; readonly canonical: unknown }
  | { readonly kind: 'deny'; readonly code: ApprovalSubjectRefusalCode; readonly type: string };

function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Equal ids: a number and its decimal text are one id; a speaking id ignores case. */
function sameId(left: string | number, right: string | number, speaking: boolean): boolean {
  const a = typeof left === 'string' ? left.trim() : String(left);
  const b = typeof right === 'string' ? right.trim() : String(right);
  return speaking ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether the list a declaration reads is in the answer at all (possibly empty). */
function listPresent(root: unknown, steps: ReadonlyArray<EntityPathStep>): boolean {
  if (steps.length === 0) return Array.isArray(root);
  const last = steps.at(-1)!;
  const holders = objectsAt(root, steps.slice(0, -1));
  return holders.some((holder) => Array.isArray(holder[last.key]));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusOf(result: unknown): number | undefined {
  return isRecordValue(result) && Number.isInteger(result.status) ? result.status as number : undefined;
}

export interface ApprovalSubjectResolverOptions {
  /** This request's tools (the RBAC-filtered registry); sources outside it are not available. */
  readonly registry: ToolRegistry;
  /** The tool context of the request: its `callEndpoint` carries the user's credentials. */
  readonly context: ToolContext;
  /** The managed turn guard, when the turn is managed. */
  readonly guard?: ManagedTurnGuard;
  /** The PII shield and the session it seals results under, when configured. */
  readonly shield?: { readonly shield: PiiShield; readonly sessionId: () => string };
  readonly limits: ApprovalSubjectLimits;
  /** Cancels every lookup with the request. */
  readonly signal?: AbortSignal;
  /** Groups the per-request cache; part of every cache key. */
  readonly scope?: string;
  readonly now?: () => number;
}

/** What the stream binding takes for an approval request with server subjects. */
export interface BoundApprovalSubjects {
  readonly part: ApprovalSubjectsPartData;
  /** The canonical form the approval id's subject digest is computed over. */
  readonly canonical: unknown;
}

export interface ApprovalSubjectResolver {
  /** Whether a tool has a server declaration (its approvals carry a subject digest: `glirastes-approval.v2.`). */
  isDeclared(toolName: string): boolean;
  /** Whether any tool of the request has a server declaration. */
  hasDeclarations(): boolean;
  /** The engine hook (`AiSdkToolHooks.resolveApprovalSubjects`). */
  resolve(call: { toolName: string; toolCallId: string; input: unknown }): Promise<{ deny: Error } | undefined>;
  /** The subjects resolved for an approval request, once. */
  take(toolCallId: string): BoundApprovalSubjects | undefined;
  /**
   * For an approved call of a tool with `recheck`: checks its subjects again
   * before it runs. A denial code, or undefined to run it.
   */
  recheck(call: {
    toolName: string;
    input: unknown;
    subjectDigest?: string;
    digestOf: (canonical: unknown) => string;
  }): Promise<ApprovalDenialCode | undefined>;
}

/** Creates the approval-subject resolver of one request. */
export function createApprovalSubjectResolver(options: ApprovalSubjectResolverOptions): ApprovalSubjectResolver {
  const plans = approvalSubjectPlans(options.registry);
  const limits = options.limits;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, Promise<RawOutcome>>();
  const rateLimited = new Set<string>();
  const resolved = new Map<string, BoundApprovalSubjects>();
  let lookups = 0;
  let spentMs = 0;

  /** Whether a source may be asked now: in this request's tools, authorized, not behind an approval. */
  const sourceDenial = async (name: string, tool: Tool, input: unknown): Promise<ApprovalSubjectUncheckedReason | undefined> => {
    if (!Object.prototype.hasOwnProperty.call(options.registry, name) || options.registry[name] !== tool) return 'source_unavailable';
    let policyApproval = false;
    if (options.guard) {
      try {
        policyApproval = (await options.guard.beforeSubjectLookup({ toolName: name, input })).requiresApproval;
      } catch (error) {
        // Not for this principal, agent or policy, or revoked: the source is not available.
        // Anything else (no principal, another tenant) ends the turn as for a tool call.
        if (isRecoverableToolDenial(error)) return 'source_unavailable';
        if (error instanceof ToolExecutionDeniedError && error.reason === 'revoked') return 'source_unavailable';
        throw error;
      }
    }
    // A source that asks for approval is not called without one, unless it states that its calls change nothing.
    if (tool.lookupEffect === 'read') return undefined;
    if (policyApproval) return 'source_unavailable';
    if (tool.needsApproval === true) return 'source_unavailable';
    if (typeof tool.needsApproval === 'function') {
      try {
        if (await tool.needsApproval(input, options.context)) return 'source_unavailable';
      } catch {
        return 'source_unavailable';
      }
    }
    return undefined;
  };

  /** A rejection once the request is cancelled. */
  const abortion = (signal: AbortSignal): Promise<never> => new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });

  /** `work`, or `fallback` after `ms`; rejects when the request is cancelled. */
  const bounded = <T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work,
      new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); }),
      ...(options.signal ? [abortion(options.signal)] : []),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  };

  /** The shield's original values of a lookup's parameters (the same session as the tool call). */
  const rehydrate = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!options.shield) return params;
    const { shield, sessionId } = options.shield;
    return shield.rehydrateArgsAsync ? shield.rehydrateArgsAsync(params, sessionId()) : shield.rehydrateArgs(params, sessionId());
  };

  /**
   * A shield step of a lookup: its value, `SHIELD_TIMEOUT` past the deadline,
   * `SHIELD_FAILED` when it throws. A cancelled request still rejects.
   */
  const guarded = async <T,>(work: Promise<T>, deadline: number): Promise<T | typeof SHIELD_TIMEOUT | typeof SHIELD_FAILED> => {
    try {
      return await bounded(work, deadline - now(), SHIELD_TIMEOUT);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return SHIELD_FAILED;
    }
  };

  /** Runs the source once: its result as the tool would show it (schema, bound, shield), or why not. */
  const execute = async (name: string, tool: Tool, input: unknown, timeoutMs: number): Promise<RawOutcome> => {
    const timeout = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const endpoint = options.context as ToolContext & { callEndpoint?: (request: InternalApiRequest) => Promise<unknown> };
    const context = {
      ...options.context,
      abortSignal: signal,
      ...(endpoint.callEndpoint
        ? {
            callEndpoint: (request: InternalApiRequest) => endpoint.callEndpoint!({
              ...request, signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
            }),
          }
        : {}),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool.execute(input, context as ToolContext)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            const error = new Error('approval subject lookup timed out');
            timeout.abort(error);
            reject(error);
          }, timeoutMs);
        }),
        // A source that ignores its signal still does not hold up a cancelled request.
        ...(options.signal ? [abortion(options.signal)] : []),
      ]);
      if (isRecordValue(result) && result.success === false) {
        // A refusal of the local transport (a path outside the allowed ones) is no answer of the backend.
        const fromBackend = Object.prototype.hasOwnProperty.call(result, ENDPOINT_FAILURE_DATA);
        const status = statusOf(result);
        if (!fromBackend || status === undefined) return { kind: 'unchecked', reason: fromBackend ? 'unavailable' : 'source_unavailable' };
        if (status === 404) return { kind: 'not_found' };
        if (status === 403) return { kind: 'forbidden' };
        if (status === 400 || status === 422) return { kind: 'invalid' };
        if (status === 429) {
          rateLimited.add(name);
          return { kind: 'unchecked', reason: 'rate_limited' };
        }
        return { kind: 'unchecked', reason: 'unavailable' };
      }
      const cleaned = cleanToolResult(tool, result, outputBoundOf(tool), name);
      if (!cleaned.successful) return { kind: 'unchecked', reason: cleaned.withheld ? 'invalid_response' : 'unavailable' };
      return { kind: 'ok', value: cleaned.value };
    } catch {
      if (timedOut) return { kind: 'unchecked', reason: 'timeout' };
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
      return { kind: 'unchecked', reason: 'unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** One lookup through a source: validated input, authorization, cache, limits. */
  const lookUp = async (name: string, tool: Tool, modelParams: Record<string, unknown>, deadline: number): Promise<RawOutcome> => {
    options.signal?.throwIfAborted();
    // The values come from the model's call: with a PII shield they are pseudonyms, restored as for the tool call itself.
    const restored = await guarded(rehydrate(modelParams), deadline);
    if (restored === SHIELD_TIMEOUT) return { kind: 'unchecked', reason: 'timeout' };
    if (restored === SHIELD_FAILED) return { kind: 'unchecked', reason: 'unavailable' };
    const params = restored;
    const parsed = tool.inputSchema.safeParse(params);
    if (!parsed.success) return { kind: 'invalid' };
    if (rateLimited.has(name)) return { kind: 'unchecked', reason: 'rate_limited' };
    if (deadline - now() <= 0) return { kind: 'unchecked', reason: 'limit' };
    // Authorization, execution and shield share one deadline, and the request's cancellation.
    const denial = await bounded(sourceDenial(name, tool, parsed.data), deadline - now(), 'timeout' as const);
    if (denial) return { kind: 'unchecked', reason: denial };
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) return { kind: 'unchecked', reason: 'timeout' };
    let key: string;
    try {
      key = canonicalJson([options.scope ?? '', name, params]);
    } catch {
      return { kind: 'invalid' };
    }
    const cached = cache.get(key);
    if (cached) return cached;
    if (lookups >= limits.maxLookupsPerTurn || timeoutMs <= 0) return { kind: 'unchecked', reason: 'limit' };
    lookups += 1;
    const running = execute(name, tool, parsed.data, timeoutMs);
    cache.set(key, running);
    return running;
  };

  /** The browser gets a tool result in the shielded form; so does the card. Once per answer. */
  const displays = new WeakMap<object, Promise<unknown>>();
  const displayOf = (outcome: Extract<RawOutcome, { kind: 'ok' }>): Promise<unknown> => {
    if (!options.shield) return Promise.resolve(outcome.value);
    let shown = displays.get(outcome);
    if (!shown) {
      shown = options.shield.shield.anonymizeResult(outcome.value, options.shield.sessionId());
      displays.set(outcome, shown);
    }
    return shown;
  };

  const lookupTimeout = () => {
    const toolTimeout = options.guard?.toolTimeoutMs;
    const own = toolTimeout !== undefined ? Math.min(limits.lookupTimeoutMs, toolTimeout) : limits.lookupTimeoutMs;
    return Math.min(own, limits.maxLookupTimePerTurnMs - spentMs);
  };

  const unchecked = (item: PlanItem, values: Array<string | number>, reason: ApprovalSubjectUncheckedReason): SubjectOutcome => {
    const subject = baseSubject(item, values, 'unknown', 'unchecked');
    return { kind: 'subject', subject: { ...subject, reason }, canonical: canonicalSubject(subject, undefined) };
  };

  const baseSubject = (
    item: PlanItem,
    values: Array<string | number>,
    status: ServerApprovalSubject['status'],
    check: ServerApprovalSubject['check'],
  ): ServerApprovalSubject => {
    // Without a source the argument names stand in for the id fields (the last step of a path: `playlist.id` → `id`).
    const fields = item.source ? entityIdFields(item.source.declaration) : item.args.map((arg) => arg.split('.').at(-1)!);
    const ids: Record<string, string> = Object.create(null);
    fields.forEach((field, index) => {
      ids[field] = sanitizeSubjectText(values[index]) ?? '';
    });
    return {
      type: item.ref.type,
      role: item.ref.role ?? 'target',
      id: sanitizeSubjectText(entityIdText(values)) ?? '',
      ids,
      path: item.args.join(','),
      status,
      check,
      idKind: item.ref.idKind ?? (item.source ? entityIdKindOf(item.source.declaration) : 'opaque'),
    };
  };

  /**
   * The canonical form of a subject for the digest, from the raw (bounded,
   * unshielded) record only: its status, name and fallback as found, never
   * the shielded display, so a recheck of an unchanged record matches.
   */
  const canonicalSubject = (
    subject: ServerApprovalSubject,
    raw: { status: ServerApprovalSubject['status']; name?: string; fallbackField?: string; fallback?: string | number } | undefined,
  ): unknown => [
    subject.type, subject.role, subject.path, Object.entries(subject.ids).sort(([a], [b]) => compareCodeUnits(a, b)),
    raw?.status ?? subject.status, raw?.name ?? null, raw?.fallbackField ?? null, raw?.fallback ?? null,
  ];
  /** The raw identity of a found record for the digest. */
  const rawOf = (identity: { name?: string; fallbackField?: string; fallbackValue?: string | number }) => ({
    status: (identity.name !== undefined ? 'named' : 'seen') as ServerApprovalSubject['status'],
    ...(identity.name !== undefined ? { name: identity.name } : {}),
    ...(identity.fallbackField !== undefined && identity.name === undefined
      ? { fallbackField: identity.fallbackField, fallback: identity.fallbackValue } : {}),
  });

  /** The parameters of a lookup for one reference, or undefined when a `{ ref }` parameter has no value. */
  const paramsFor = (lookup: LookupSource, values: Array<string | number>, refs: InputEntityRef[], input: unknown) => {
    const fields = entityIdFields(lookup.declaration);
    const params: Record<string, unknown> = {};
    for (const [param, source] of Object.entries(lookup.lookup.params)) {
      if (typeof source === 'string') {
        params[param] = values[fields.indexOf(source)];
        continue;
      }
      const other = refs.find((ref) => ref.type === source.ref && inputRefArgs(ref).length === 1);
      const value = other ? valueAt(input, inputRefArgs(other)[0]!) : undefined;
      if (!isEntityIdValue(value)) return undefined;
      params[param] = value;
    }
    for (const [param, value] of Object.entries(lookup.lookup.const ?? {})) params[param] = value;
    return params;
  };

  /** Finds the record the reference names in a source's answer. */
  const match = (
    item: PlanItem,
    source: LookupSource,
    values: Array<string | number>,
    outcome: RawOutcome,
    plan: ToolPlan,
    displayed: unknown,
  ): SubjectOutcome => {
    const type = item.ref.type;
    switch (outcome.kind) {
      case 'not_found':
        return { kind: 'deny', code: 'approval_subject_not_found', type };
      case 'forbidden':
        // Default: the same as a missing record, for the model and the card.
        return plan.onForbidden === 'warn' ? unchecked(item, values, 'forbidden') : { kind: 'deny', code: 'approval_subject_not_found', type };
      case 'invalid':
        return { kind: 'deny', code: 'approval_subject_invalid_id', type };
      case 'unchecked':
        return unchecked(item, values, outcome.reason);
      case 'ok':
        break;
    }
    const declaration = source.declaration;
    const speaking = (item.ref.idKind ?? entityIdKindOf(declaration)) === 'speaking';
    // The same path as the model sees the result; the display copy is read at the same position.
    const steps = entityPathOf(declaration, outcome.value);
    const records = steps ? objectsAt(outcome.value, steps, MAX_LOOKUP_LIST_ENTRIES + 1) : [];
    const shown = steps ? objectsAt(displayed, steps, MAX_LOOKUP_LIST_ENTRIES + 1) : [];
    const overflow = records.length > MAX_LOOKUP_LIST_ENTRIES;
    const identities = records.slice(0, MAX_LOOKUP_LIST_ENTRIES).map((record, index) => ({
      identity: declaredIdentityOf(record, declaration),
      shown: shown[index],
    }));
    const known = identities.filter((entry) => entry.identity !== undefined);
    const hits = known.filter(({ identity }) => identity!.idValues.every((part, index) => sameId(part, values[index]!, speaking)));
    if (hits.length === 0) {
      // No record of the declared shape where the declaration says: the answer is not what was declared.
      if (known.length === 0 && (records.length > 0 || source.result === 'one' || !steps || !listPresent(outcome.value, steps))) {
        return unchecked(item, values, 'invalid_response');
      }
      if (source.result === 'one') return unchecked(item, values, 'mismatch');
      // A page that may not hold every record says nothing about one that is not on it.
      if (source.lookup.complete === true && !overflow) return { kind: 'deny', code: 'approval_subject_not_found', type };
      return unchecked(item, values, 'not_in_page');
    }
    const shownIdentity = (entry: (typeof hits)[number]) => (entry.shown ? declaredIdentityOf(entry.shown, declaration) : undefined);
    if (hits.length > 1) {
      const subject = baseSubject(item, values, 'ambiguous', 'found');
      const candidates = hits.slice(0, 10)
        .map((entry) => sanitizeSubjectText(shownIdentity(entry)?.name))
        .filter((name): name is string => name !== undefined);
      return {
        kind: 'subject',
        subject: { ...subject, ...(candidates.length > 0 ? { candidates } : {}) },
        canonical: canonicalSubject(subject, { status: 'ambiguous', name: JSON.stringify(hits.map((entry) => entry.identity!.name ?? null)) }),
      };
    }
    const hit = hits[0]!;
    const display = shownIdentity(hit);
    const name = sanitizeSubjectText(display?.name);
    if (name !== undefined) {
      const subject = { ...baseSubject(item, values, 'named', 'found'), name };
      return { kind: 'subject', subject, canonical: canonicalSubject(subject, rawOf(hit.identity!)) };
    }
    const fallbackValue = display?.fallbackValue === undefined
      ? undefined
      : typeof display.fallbackValue === 'number' ? display.fallbackValue : sanitizeSubjectText(display.fallbackValue);
    const subject: ServerApprovalSubject = {
      ...baseSubject(item, values, 'seen', 'found'),
      ...(display?.fallbackField !== undefined && fallbackValue !== undefined ? { fallbackField: display.fallbackField, fallbackValue } : {}),
    };
    return {
      kind: 'subject',
      subject,
      canonical: canonicalSubject(subject, rawOf(hit.identity!)),
    };
  };

  const previewOf = async (plan: ToolPlan, input: unknown, deadline: number, overLimit: boolean): Promise<ApprovalPreviewData> => {
    const preview = plan.preview!;
    const none = (reason: ApprovalSubjectUncheckedReason): ApprovalPreviewData => ({ check: 'unchecked', reason, fields: [] });
    if (overLimit) return none('limit');
    if (!preview.source) return none('source_unavailable');
    const params: Record<string, unknown> = {};
    for (const [param, source] of Object.entries(preview.declaration.params)) {
      if (typeof source === 'string') {
        const value = valueAt(input, source);
        if (value !== undefined) params[param] = value;
      } else {
        params[param] = source.const;
      }
    }
    const outcome = await lookUp(preview.source.name, preview.source.tool, params, deadline);
    if (outcome.kind === 'unchecked') return none(outcome.reason);
    if (outcome.kind === 'forbidden') return none('forbidden');
    if (outcome.kind !== 'ok') return none('unavailable');
    const displayed = await guarded(displayOf(outcome), deadline);
    if (displayed === SHIELD_TIMEOUT) return none('timeout');
    if (displayed === SHIELD_FAILED) return none('unavailable');
    const fields: ApprovalPreviewValue[] = [];
    for (const field of preview.declaration.fields) {
      const raw = valueAt(displayed, field.path);
      let value: string | number | boolean | undefined;
      if (field.format === 'count') value = Array.isArray(raw) ? raw.length : undefined;
      else if (field.format === 'number') value = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
      else if (typeof raw === 'boolean') value = raw;
      else if (typeof raw === 'number') value = Number.isFinite(raw) ? raw : undefined;
      else value = sanitizeSubjectText(raw);
      if (value !== undefined) fields.push({ key: field.path, label: field.label, value, ...(field.format ? { format: field.format } : {}) });
    }
    return fields.length > 0 ? { check: 'found', fields } : none('invalid_response');
  };

  /** Looks up every planned subject of a call (parallel within the call) and its preview. */
  const subjectsOf = async (plan: ToolPlan, input: unknown, forDisplay: boolean): Promise<{
    outcomes: SubjectOutcome[];
    preview?: ApprovalPreviewData;
  }> => {
    const startedAt = now();
    const deadline = startedAt + lookupTimeout();
    let slots = limits.maxSubjectsPerCall;
    const tasks: Array<Promise<SubjectOutcome>> = [];
    for (const item of plan.items) {
      const values = item.args.map((arg) => valueAt(input, arg));
      // An argument without an id value (absent, a list) has no subject.
      if (!values.every(isEntityIdValue)) continue;
      const ids = values as Array<string | number>;
      if (slots <= 0) {
        tasks.push(Promise.resolve(unchecked(item, ids, 'limit')));
        continue;
      }
      slots -= 1;
      const source = item.source;
      const params = source ? paramsFor(source, ids, plan.refs, input) : undefined;
      tasks.push(source === undefined || params === undefined
        ? Promise.resolve(unchecked(item, ids, 'source_unavailable'))
        : lookUp(source.name, source.tool, params, deadline).then(async (outcome) => {
          // Only what reaches the browser is shielded (bounded like the lookup); a recheck compares the raw values.
          const displayed = outcome.kind === 'ok' && forDisplay
            ? await guarded(displayOf(outcome), deadline)
            : outcome.kind === 'ok' ? outcome.value : undefined;
          if (displayed === SHIELD_TIMEOUT) return unchecked(item, ids, 'timeout');
          if (displayed === SHIELD_FAILED) return unchecked(item, ids, 'unavailable');
          return match(item, source, ids, outcome, plan, displayed);
        }));
    }
    const previewTask = plan.preview ? previewOf(plan, input, deadline, slots <= 0) : undefined;
    try {
      const [outcomes, preview] = await Promise.all([Promise.all(tasks), previewTask]);
      return { outcomes, ...(preview ? { preview } : {}) };
    } finally {
      spentMs += Math.max(0, now() - startedAt);
    }
  };

  return {
    hasDeclarations: () => plans.size > 0,
    isDeclared: (toolName) => plans.has(toolName),

    async resolve({ toolName, toolCallId, input }) {
      const plan = plans.get(toolName);
      if (!plan) return undefined;
      const { outcomes, preview } = await subjectsOf(plan, input, true);
      const denied = outcomes.find((outcome): outcome is Extract<SubjectOutcome, { kind: 'deny' }> => outcome.kind === 'deny');
      if (denied) return { deny: new ApprovalSubjectRefusedError(denied.code, denied.type) };
      const subjects = outcomes.map((outcome) => (outcome as Extract<SubjectOutcome, { kind: 'subject' }>));
      if (plan.onUnavailable === 'block') {
        const blocked = subjects.find((outcome) => outcome.subject.check === 'unchecked');
        if (blocked) return { deny: new ApprovalSubjectRefusedError('approval_subject_unavailable', blocked.subject.type) };
      }
      resolved.set(toolCallId, {
        part: {
          v: APPROVAL_SUBJECTS_PART_VERSION,
          toolCallId,
          subjects: subjects.map((outcome) => outcome.subject),
          ...(preview ? { preview } : {}),
        },
        canonical: subjects.map((outcome) => outcome.canonical),
      });
      return undefined;
    },

    take(toolCallId) {
      const entry = resolved.get(toolCallId);
      resolved.delete(toolCallId);
      return entry;
    },

    async recheck({ toolName, input, subjectDigest, digestOf }) {
      const plan = plans.get(toolName);
      if (!plan || plan.recheck === 'none' || plan.items.length === 0) return undefined;
      // The same validated input the approval was decided on (defaults, transforms): the history holds the model's raw one.
      const parsed = options.registry[toolName]?.inputSchema.safeParse(input);
      if (!parsed?.success) return 'approval_subject_unavailable';
      const { outcomes } = await subjectsOf({ ...plan, preview: undefined } as ToolPlan, parsed.data, false);
      if (outcomes.some((outcome) => outcome.kind === 'deny')) return 'approval_subject_gone';
      const subjects = outcomes as Array<Extract<SubjectOutcome, { kind: 'subject' }>>;
      if (plan.onUnavailable === 'block' && subjects.some((outcome) => outcome.subject.check === 'unchecked')) {
        return 'approval_subject_unavailable';
      }
      if (plan.recheck === 'exists') return undefined;
      // Every subject compared, also a not checkable one (as `unknown`): a record that was found at the
      // approval and cannot be checked now counts as changed, so it never hides a change of another.
      return subjectDigest !== undefined && digestOf(subjects.map((outcome) => outcome.canonical)) === subjectDigest
        ? undefined
        : 'approval_subject_changed';
    },
  };
}

/** The UI stream chunk of the subjects of one approval request (F1), persistent. */
export function approvalSubjectsChunk(part: ApprovalSubjectsPartData): { type: typeof APPROVAL_SUBJECTS_PART_TYPE; id: string; data: ApprovalSubjectsPartData } {
  return { type: APPROVAL_SUBJECTS_PART_TYPE, id: part.toolCallId, data: part };
}

/**
 * The UI history without `data-approval-subjects` parts: they are for the
 * browser only (the AI SDK leaves data parts out of model messages unless a
 * `convertDataPart` says otherwise; this states it once more, explicitly).
 */
export function withoutApprovalSubjectParts<T>(messages: ReadonlyArray<T>): T[] {
  return messages.map((message) => {
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts) || !parts.some((part) => isRecordValue(part) && part.type === APPROVAL_SUBJECTS_PART_TYPE)) return message;
    return { ...message, parts: parts.filter((part) => !(isRecordValue(part) && part.type === APPROVAL_SUBJECTS_PART_TYPE)) };
  });
}
