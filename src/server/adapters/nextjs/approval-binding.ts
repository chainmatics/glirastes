import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AI_SDK_APPROVAL_GATE,
  AI_SDK_APPROVAL_GATE_PASSED,
  type AiSdkApprovalGate,
} from '../../../runtime/ai-sdk/engine.js';

/**
 * Approvals the server asked for, bound to the call they were asked for.
 *
 * When a tool call needs the user's approval, the AI SDK ends the turn with an
 * approval request. The browser sends the whole history back with the answer,
 * and the SDK then runs the approved call with the tool name and input *from
 * that history*, which the client wrote. Without a binding, a forged history
 * runs any tool with any input, and an old approved history runs it again.
 *
 * The binding is the approval id itself. The AI SDK sends the id to the
 * client, keeps it through `addToolApprovalResponse`, returns it in the
 * history and passes it on through `convertToModelMessages`; no other field of
 * an approval request survives that round trip (the stream chunk has only
 * `approvalId` and `toolCallId`). The id has the form
 *
 *   glirastes-approval.v1.<issuedAtMs>.<expiresAtMs>.<nonce>.<mac>
 *
 * where `mac` is an HMAC-SHA-256, keyed with a server secret, over the issue
 * time, the expiry, the nonce, the scope, the tool call id, the tool name and
 * the canonical JSON of the input. The expiry is the issuing handler's
 * decision and is signed, so a handler with a longer `approvalMaxAgeMs` that
 * shares the secret cannot accept what the issuer would refuse; the verifier
 * applies its own maximum age on top. (The format gained the expiry before
 * 0.5.0 was published, which is why it is still `v1`.)
 */

export const DEFAULT_APPROVAL_MAX_AGE_MS = 15 * 60_000;
export const APPROVAL_SECRET_ENV = 'GLIRASTES_APPROVAL_SECRET';

const ID_PREFIX = 'glirastes-approval.v1.';
const MIN_SECRET_LENGTH = 16;
/** Clock differences between processes sharing a secret. */
const CLOCK_SKEW_MS = 60_000;

export type ApprovalDenialCode =
  | 'approval_not_issued'
  | 'approval_expired'
  | 'approval_already_used'
  | 'approval_store_unavailable';

/**
 * Optional single-use store. `consume` returns false when the id was used
 * before. It receives the canonical id of a verified approval, never the text
 * the client sent, and the scope the approval was issued for (tenant and
 * subject of a managed turn, `''` otherwise), so a store can give each scope
 * a quota.
 */
export interface ApprovalStore {
  consume: (approvalId: string, expiresAtMs: number, context?: { scope: string }) => boolean | Promise<boolean>;
}

/** Default size of the in-process single-use store. */
export const DEFAULT_MEMORY_APPROVAL_STORE_ENTRIES = 10_000;
/** Default share of the in-process store one scope may hold. */
export const DEFAULT_MEMORY_APPROVAL_STORE_ENTRIES_PER_SCOPE = 1_000;
/** Approved calls that can run in one request; more is refused (`too_many_approvals`). */
export const MAX_RUNNABLE_APPROVALS_PER_REQUEST = 32;

/**
 * A single-use store in this process's memory. Each id is kept until its
 * approval has expired (plus the allowed clock skew), after which it can no
 * longer verify anyway. The store is bounded: when it holds `maxEntries` live
 * ids, or the approval's scope holds `maxEntriesPerScope`, `consume` throws,
 * which the handler reports as `approval_store_unavailable`, rather than
 * forgetting a live id and letting it run again. The per-scope quota keeps
 * one tenant and subject from filling the store for everyone else; without a
 * managed principal every request has the scope `''`, which is one scope.
 *
 * It protects one process only. Instances behind a load balancer each have
 * their own memory, so an approved history replayed to another instance runs
 * there again unless they share an `approvalStore`.
 */
export function createMemoryApprovalStore(options: {
  maxEntries?: number;
  maxEntriesPerScope?: number;
  now?: () => number;
} = {}): ApprovalStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MEMORY_APPROVAL_STORE_ENTRIES;
  const maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MEMORY_APPROVAL_STORE_ENTRIES_PER_SCOPE;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { keepUntil: number; scope: string }>();
  const perScope = new Map<string, number>();
  const remove = (id: string, scope: string) => {
    entries.delete(id);
    const left = (perScope.get(scope) ?? 1) - 1;
    if (left > 0) perScope.set(scope, left);
    else perScope.delete(scope);
  };
  const purge = (at: number) => {
    for (const [id, entry] of entries) if (entry.keepUntil <= at) remove(id, entry.scope);
  };
  const full = (scope: string) => entries.size >= maxEntries || (perScope.get(scope) ?? 0) >= maxEntriesPerScope;
  return {
    consume: (approvalId, expiresAtMs, context) => {
      const at = now();
      const scope = context?.scope ?? '';
      const existing = entries.get(approvalId);
      if (existing && existing.keepUntil > at) return false;
      if (existing) remove(approvalId, existing.scope);
      if (full(scope)) purge(at);
      if (entries.size >= maxEntries) throw new Error('The in-process approval store is full');
      if ((perScope.get(scope) ?? 0) >= maxEntriesPerScope) {
        throw new Error('The in-process approval store quota of this scope is used up');
      }
      entries.set(approvalId, { keepUntil: expiresAtMs + CLOCK_SKEW_MS, scope });
      perScope.set(scope, (perScope.get(scope) ?? 0) + 1);
      return true;
    },
  };
}

let processApprovalStore: ApprovalStore | undefined;

/** The in-process store every handler of this process shares when none is configured. */
export function defaultApprovalStore(): ApprovalStore {
  processApprovalStore ??= createMemoryApprovalStore();
  return processApprovalStore;
}

export interface ApprovalCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export type ApprovalVerification =
  /**
   * `key` names the approval for single use: the canonical id, rebuilt from
   * the issue time, the nonce and the MAC this binder computed, never from the
   * presented text.
   */
  | { readonly ok: true; readonly expiresAtMs: number; readonly key: string }
  | { readonly ok: false; readonly code: 'approval_not_issued' | 'approval_expired' };

export interface ApprovalBinder {
  issue: (call: ApprovalCall) => string;
  verify: (call: ApprovalCall & { approvalId: string }) => ApprovalVerification;
  readonly maxAgeMs: number;
}

export class ApprovalSecretMissingError extends Error {
  readonly code = 'approval_secret_missing';
  constructor() {
    super(
      `Tools that ask for approval are registered, but no approval secret is configured. `
      + `Set ${APPROVAL_SECRET_ENV} (at least ${MIN_SECRET_LENGTH} characters, the same on every instance) `
      + `or pass approvalSecret to createAiChatHandler. Approvals are refused in production without it.`,
    );
    this.name = 'ApprovalSecretMissingError';
  }
}

const NONCE_BYTES = 16;
const MAC_BYTES = 32;
/** A decimal without sign or leading zeros, as `String(Date.now())` writes it. */
const CANONICAL_TIME = /^(?:0|[1-9]\d{0,15})$/;

function isCanonicalBase64Url(text: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return false;
  const decoded = Buffer.from(text, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === text;
}

/**
 * JSON with sorted keys, so an input hashes the same after any JSON round
 * trip. A non-finite number (`JSON.parse` turns `1e999` into `Infinity`)
 * throws a RangeError: `JSON.stringify` would write it as `null`, so an
 * approval for `null` would also hold for it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError('An approval input must contain only finite numbers');
  }
  if (Array.isArray(value)) return value.map((item) => sortKeys(item === undefined ? null : item));
  if (typeof value !== 'object' || value === null) return value;
  // No prototype: an own `__proto__` key (JSON.parse creates one) must stay a
  // key. On a plain object the assignment would set the prototype and the key
  // would drop out of the JSON, so two different inputs would share a MAC.
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) sorted[key] = sortKeys(entry);
  }
  return sorted;
}

/**
 * The binder scope of a principal. Tenant and subject are encoded as a JSON
 * array, so ids that contain a separator cannot make two principals share a
 * scope (`acme:ops` + `alice` and `acme` + `ops:alice`).
 */
export function approvalScope(principal: { tenantId: string; subjectId: string } | undefined): string {
  return principal ? JSON.stringify([principal.tenantId, principal.subjectId]) : '';
}

export function createApprovalBinder(options: {
  secret: string;
  /** Who the approval is for, e.g. tenant and subject; part of the MAC. */
  scope?: string;
  maxAgeMs?: number;
  now?: () => number;
}): ApprovalBinder {
  if (typeof options.secret !== 'string' || options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`The approval secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_APPROVAL_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new RangeError('approvalMaxAgeMs must be a positive finite number');
  }
  const now = options.now ?? Date.now;
  const scope = options.scope ?? '';

  const mac = (issuedAt: string, expiresAt: string, nonce: string, call: ApprovalCall): Buffer => createHmac('sha256', options.secret)
    .update(JSON.stringify(['v1', issuedAt, expiresAt, nonce, scope, call.toolCallId, call.toolName, canonicalJson(call.input)]))
    .digest();

  return {
    maxAgeMs,
    issue: (call) => {
      const issued = now();
      const issuedAt = String(issued);
      const expiresAt = String(issued + maxAgeMs);
      const nonce = randomBytes(NONCE_BYTES).toString('base64url');
      return `${ID_PREFIX}${issuedAt}.${expiresAt}.${nonce}.${mac(issuedAt, expiresAt, nonce, call).toString('base64url')}`;
    },
    verify: (call) => {
      const notIssued = { ok: false, code: 'approval_not_issued' } as const;
      if (typeof call.approvalId !== 'string' || !call.approvalId.startsWith(ID_PREFIX)) return notIssued;
      const [issuedAt, expiresAt, nonce, presented, ...rest] = call.approvalId.slice(ID_PREFIX.length).split('.');
      // Every segment must be spelled exactly as `issue` spells it: Node's
      // base64url decoder accepts padding, stray characters and changed low
      // bits, which would give one approval many ids.
      if (!issuedAt || !expiresAt || !nonce || !presented || rest.length > 0) return notIssued;
      if (!CANONICAL_TIME.test(issuedAt) || !CANONICAL_TIME.test(expiresAt)) return notIssued;
      if (!isCanonicalBase64Url(nonce, NONCE_BYTES) || !isCanonicalBase64Url(presented, MAC_BYTES)) return notIssued;
      let expected: Buffer;
      try {
        expected = mac(issuedAt, expiresAt, nonce, call);
      } catch {
        return notIssued;
      }
      const actual = Buffer.from(presented, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return notIssued;
      const at = now();
      if (at - Number(issuedAt) < -CLOCK_SKEW_MS) return notIssued;
      // The issuer's signed expiry, and this handler's own maximum age.
      const expiresAtMs = Math.min(Number(expiresAt), Number(issuedAt) + maxAgeMs);
      if (at > expiresAtMs) return { ok: false, code: 'approval_expired' };
      return {
        ok: true,
        expiresAtMs,
        key: `${ID_PREFIX}${issuedAt}.${expiresAt}.${nonce}.${expected.toString('base64url')}`,
      };
    },
  };
}

let processSecret: string | undefined;
let warnedAboutProcessSecret = false;

/**
 * The binder of a request. The secret is the configured one, else
 * `GLIRASTES_APPROVAL_SECRET`. Without one, and when approvals can occur, a
 * production process refuses to serve them (`ApprovalSecretMissingError`);
 * any other process derives a random secret that lives as long as the process
 * and warns once. Approvals then do not survive a restart or reach another
 * instance, which is why they are refused in production.
 */
export function resolveApprovalBinder(options: {
  secret?: string;
  env?: Record<string, string | undefined>;
  hasApprovalTools: boolean;
  scope?: string;
  maxAgeMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
}): ApprovalBinder {
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
  const configured = options.secret || env[APPROVAL_SECRET_ENV] || undefined;
  const common = { scope: options.scope, maxAgeMs: options.maxAgeMs, now: options.now };
  if (configured) return createApprovalBinder({ secret: configured, ...common });

  if (options.hasApprovalTools && env.NODE_ENV === 'production') throw new ApprovalSecretMissingError();
  if (options.hasApprovalTools && !warnedAboutProcessSecret) {
    warnedAboutProcessSecret = true;
    (options.warn ?? ((message) => console.warn(message)))(
      `[glirastes] No ${APPROVAL_SECRET_ENV} is set. Approvals are signed with a random secret that lives as long as `
      + `this process, so they do not survive a restart and do not work across instances. `
      + `Production refuses to serve approvals without the secret.`,
    );
  }
  processSecret ??= randomBytes(32).toString('base64url');
  return createApprovalBinder({ secret: processSecret, ...common });
}

type Chunk = { type: string };

/**
 * Gives every approval request of a UI message stream an id bound to the
 * call it announced (tool name and input come from the preceding
 * `tool-input-available` chunk, which is also what the client stores).
 */
export function bindApprovalRequests<T extends Chunk>(
  stream: ReadableStream<T>,
  binder: ApprovalBinder,
): ReadableStream<T> {
  const calls = new Map<string, { toolName: string; input: unknown }>();
  return stream.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      const record = chunk as unknown as Record<string, unknown>;
      if (record.type === 'tool-input-available' && typeof record.toolCallId === 'string') {
        calls.set(record.toolCallId, { toolName: String(record.toolName), input: record.input });
      }
      if (record.type === 'tool-approval-request' && typeof record.toolCallId === 'string') {
        const announced = calls.get(record.toolCallId);
        if (announced) {
          let approvalId: string | undefined;
          try {
            approvalId = binder.issue({ toolCallId: record.toolCallId, ...announced });
          } catch {
            // An input that cannot be hashed (a non-finite number) gets no
            // bound id; the AI SDK's own id never verifies, so the approval
            // can be answered but never runs.
          }
          if (approvalId) {
            controller.enqueue({ ...chunk, approvalId });
            return;
          }
        }
      }
      controller.enqueue(chunk);
    },
  }));
}

type MessageRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is MessageRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const RESULT_STATES = new Set(['output-available', 'output-error', 'output-denied']);

/** A UI tool part as the AI SDK recognizes one (`isToolUIPart`). */
function isToolPart(part: MessageRecord): boolean {
  return typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool');
}

function toolNameOf(part: MessageRecord): string | undefined {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' && part.toolName ? part.toolName : undefined;
  return typeof part.type === 'string' && part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : undefined;
}

/**
 * The input of the tool call that `convertToModelMessages` writes for a part,
 * which is what the AI SDK would execute: for `output-error` it falls back to
 * `rawInput`.
 */
function modelInputOf(part: MessageRecord): unknown {
  return part.state === 'output-error' && part.input == null && 'rawInput' in part ? part.rawInput : part.input;
}

export type ApprovalHistoryErrorCode =
  | 'duplicate_tool_call_id'
  | 'duplicate_approval_id'
  | 'approval_malformed'
  | 'tool_part_malformed'
  | 'too_many_approvals';

/** A history the handler refuses as a whole (HTTP 400) instead of repairing it. */
export class ApprovalHistoryError extends Error {
  constructor(readonly code: ApprovalHistoryErrorCode, message: string) {
    super(message);
    this.name = 'ApprovalHistoryError';
  }
}

/**
 * Refuses a history that the AI SDK could read in more than one way.
 *
 * - Every tool part has a string tool call id, and a dynamic tool part a
 *   tool name that is a non-empty string (`tool_part_malformed`): the AI SDK
 *   converts any value and looks the tool up with it.
 * - A tool call id may belong to one tool part only, in the whole history
 *   (`duplicate_tool_call_id`). The AI SDK maps an approval response to a
 *   tool call by the tool call id alone (`collectToolApprovals` keeps the last
 *   tool call of an id, and the model message sanitizer keeps the first one of
 *   a message), so a second part with the same id can lend its tool name and
 *   input to the approval of the other one.
 * - An approval id may belong to one tool part only, in the whole history
 *   (`duplicate_approval_id`). Every part with an `approval` becomes an
 *   approval request with that id, and `collectToolApprovals` keeps the last
 *   request of an id, so a copy of a genuine id on another part would take
 *   over the genuine part's approved answer.
 * - An `approval` is an object with a non-empty string `id`, and its
 *   `approved`, when set, is a boolean (`approval_malformed`). The AI SDK
 *   turns any value other than `null` / `undefined` into an approval response
 *   and treats a truthy one as approved.
 *
 * The AI SDK's own client never writes any of these: its UI message reducer
 * (`updateToolPart` / `updateDynamicToolPart` in `processUIMessageStream`)
 * updates the existing part of a tool call id in place, also for a
 * provider-executed tool whose result arrives later, an approval continuation
 * goes on in the same assistant message, and every approval request carries
 * its own id. There is therefore no legitimate shape with a repeated id, and
 * none is allowed.
 */
export function assertUnambiguousToolHistory(messages: ReadonlyArray<unknown>): void {
  const toolCallIds = new Set<string>();
  const approvalIds = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || !isToolPart(part)) continue;
      if (!toolNameOf(part)) {
        throw new ApprovalHistoryError('tool_part_malformed', 'A dynamic tool part has no tool name.');
      }
      if (typeof part.toolCallId !== 'string') {
        throw new ApprovalHistoryError('tool_part_malformed', 'A tool part has no tool call id.');
      }
      if (toolCallIds.has(part.toolCallId)) {
        throw new ApprovalHistoryError('duplicate_tool_call_id', 'A tool call id appears in more than one tool part.');
      }
      toolCallIds.add(part.toolCallId);
      if (part.approval !== undefined && part.approval !== null) {
        const approval = part.approval;
        if (!isRecord(approval)) {
          throw new ApprovalHistoryError('approval_malformed', 'A tool part carries an approval that is not an object.');
        }
        if (typeof approval.id !== 'string' || approval.id === '') {
          throw new ApprovalHistoryError('approval_malformed', 'An approval has no id.');
        }
        if (approval.approved !== undefined && approval.approved !== null && typeof approval.approved !== 'boolean') {
          throw new ApprovalHistoryError('approval_malformed', 'approval.approved must be true or false.');
        }
        if (approvalIds.has(approval.id)) {
          throw new ApprovalHistoryError('duplicate_approval_id', 'An approval id appears in more than one tool part.');
        }
        approvalIds.add(approval.id);
      }
    }
  }
}

export interface DeniedApproval {
  readonly toolCallId: string;
  readonly code: ApprovalDenialCode;
}

/** An approved call of the history that passed every check of this request. */
export interface VerifiedApproval {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/**
 * Checks, before anything runs, every tool part of the request history that
 * carries an approval, whatever its state, its answer and whether or not the
 * provider executed it. The history must first pass
 * `assertUnambiguousToolHistory` (this function calls it and throws
 * `ApprovalHistoryError`).
 *
 * - An approved part that the AI SDK can run in this request (no result yet,
 *   or provider-executed, and in the last block of a last assistant message,
 *   see `runnableBlockOf`) needs an approval id issued for exactly this tool
 *   call id, tool name and input, not older than the maximum age, not used
 *   before in this history and not consumed before by the store (with the
 *   request's scope). More than `MAX_RUNNABLE_APPROVALS_PER_REQUEST` of them
 *   refuse the request (`too_many_approvals`) before any is consumed. A part that
 *   fails is rewritten to `output-denied` with the code as its reason, so the
 *   model messages carry a denied result for it and the AI SDK runs nothing.
 *   The request continues: the model sees the denial and answers.
 * - Every other part with an approval (an approved part that has its result
 *   or cannot run in this request, an unanswered request, a refusal) needs an id issued for this tool call
 *   id, tool name and input; age and use do not count. A part that fails
 *   loses its approval (an `output-denied` part, which the AI SDK cannot
 *   convert without one, gets an id of its own that verifies for nothing).
 *   Such parts are not refused, because an honest history holds them after a
 *   secret rotation, a restart of a process without a configured secret, or
 *   from 0.4.0; they run nothing either way.
 *
 * The invariant this establishes, together with `assertUnambiguousToolHistory`:
 * every approval id left in the history belongs to exactly one tool part and
 * was issued for that part's tool call id, tool name and model input (the
 * input `convertToModelMessages` writes, `rawInput` for an `output-error`
 * part without input). The AI SDK pairs an approved answer with a call by
 * approval id → the one request with that id, emitted from the same part →
 * its tool call id, which is unique → the tool call emitted from that same
 * part. So an approved answer can only ever pair with the call its id was
 * issued for, and every approved answer the AI SDK can run in this request
 * has also passed age and single use.
 */
export async function enforceApprovalBindings(
  messages: ReadonlyArray<unknown>,
  options: { binder: ApprovalBinder; store?: ApprovalStore; scope?: string },
): Promise<{ messages: unknown[]; denied: DeniedApproval[]; verified: VerifiedApproval[] }> {
  assertUnambiguousToolHistory(messages);
  const lastBlock = runnableBlockOf(messages);
  const runnableCount = [...lastBlock].filter((part) => isRunnableApproval(part as MessageRecord)).length;
  if (runnableCount > MAX_RUNNABLE_APPROVALS_PER_REQUEST) {
    throw new ApprovalHistoryError(
      'too_many_approvals',
      `At most ${MAX_RUNNABLE_APPROVALS_PER_REQUEST} approved calls can run in one request.`,
    );
  }
  const denied: DeniedApproval[] = [];
  const verified: VerifiedApproval[] = [];
  const usedIds = new Set<string>();
  const next: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) {
      next.push(message);
      continue;
    }
    let changed = false;
    const parts: unknown[] = [];
    for (const part of message.parts) {
      const toolName = isRecord(part) && isToolPart(part) ? toolNameOf(part) : undefined;
      const approval = isRecord(part) && isRecord(part.approval) ? part.approval : undefined;
      if (!toolName || !approval) {
        parts.push(part);
        continue;
      }
      const record = part as MessageRecord;
      const toolCallId = record.toolCallId as string;
      const approvalId = approval.id as string;
      const input = modelInputOf(record);
      const runnable = lastBlock.has(part) && isRunnableApproval(record);
      const code = runnable
        ? await denialCode({ input, toolName, toolCallId, approvalId, usedIds, ...options })
        : bindingCode({ input, toolName, toolCallId, approvalId, binder: options.binder });
      if (!code) {
        if (runnable && record.providerExecuted !== true) verified.push({ toolCallId, toolName, input });
        parts.push(part);
        continue;
      }
      changed = true;
      if (runnable) {
        denied.push({ toolCallId, code });
        parts.push({ ...record, state: 'output-denied', approval: { id: approvalId, approved: false, reason: code } });
        continue;
      }
      if (approval.approved === true) denied.push({ toolCallId, code });
      if (record.state === 'output-denied') {
        parts.push({ ...record, approval: { ...approval, id: `glirastes-approval-unbound.${toolCallId}`, approved: false } });
      } else {
        const { approval: _dropped, ...withoutApproval } = record;
        parts.push(withoutApproval);
      }
    }
    next.push(changed ? { ...message, parts } : message);
  }
  return { messages: next, denied, verified };
}

/** An approved part without its result: the AI SDK runs it if it is in the runnable block. */
function isRunnableApproval(part: MessageRecord): boolean {
  if (!isRecord(part) || !isToolPart(part) || !isRecord(part.approval) || part.approval.approved !== true) return false;
  return !(RESULT_STATES.has(String(part.state)) && part.providerExecuted !== true);
}

/**
 * The parts whose approvals the AI SDK can run in this request.
 * `collectToolApprovals` reads only the last model message, and only when it
 * is a tool message; `convertToModelMessages` writes that message for the
 * last block (the parts after the last `step-start`) of the last UI message,
 * when that message is the assistant's. Approved parts anywhere else never
 * run, so they are not consumed and not handed to the execution gate.
 */
function runnableBlockOf(messages: ReadonlyArray<unknown>): Set<unknown> {
  const last = messages.at(-1);
  if (!isRecord(last) || last.role !== 'assistant' || !Array.isArray(last.parts)) return new Set();
  const parts = last.parts as unknown[];
  let start = 0;
  parts.forEach((part, index) => {
    if (isRecord(part) && part.type === 'step-start') start = index + 1;
  });
  return new Set(parts.slice(start));
}

function bindingCode(args: {
  input: unknown;
  toolName: string;
  toolCallId: string;
  approvalId: string;
  binder: ApprovalBinder;
}): ApprovalDenialCode | undefined {
  const verified = args.binder.verify({
    approvalId: args.approvalId,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    input: args.input,
  });
  // Only the binding counts here: an executed call may be older than the maximum age.
  return !verified.ok && verified.code === 'approval_not_issued' ? 'approval_not_issued' : undefined;
}

async function denialCode(args: {
  input: unknown;
  toolName: string;
  toolCallId: string;
  approvalId: string;
  usedIds: Set<string>;
  binder: ApprovalBinder;
  store?: ApprovalStore;
  scope?: string;
}): Promise<ApprovalDenialCode | undefined> {
  const verified = args.binder.verify({
    approvalId: args.approvalId,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    input: args.input,
  });
  if (!verified.ok) return verified.code;
  if (args.usedIds.has(verified.key)) return 'approval_already_used';
  args.usedIds.add(verified.key);
  if (args.store) {
    try {
      if (!(await args.store.consume(verified.key, verified.expiresAtMs, { scope: args.scope ?? '' }))) return 'approval_already_used';
    } catch {
      return 'approval_store_unavailable';
    }
  }
  return undefined;
}

/** Why the execution gate refused a call; the tool error the model sees starts with it. */
export type ApprovalExecutionRefusal = 'approval_not_verified' | 'approval_already_used';

export class ApprovalExecutionRefusedError extends Error {
  constructor(readonly code: ApprovalExecutionRefusal, toolName: string) {
    super(`${code}: the call of "${toolName}" was not approved for this tool call and input`);
    this.name = 'ApprovalExecutionRefusedError';
  }
}

/**
 * The second layer of the binding, checked where the tool executes.
 *
 * The AI SDK never executes a call within the run whose `needsApproval`
 * answered true: it emits the approval request and the run ends (traced in
 * `ai` 6.0: `runToolsTransformation` stops at `isApprovalNeeded`, and only
 * `collectToolApprovals` on the next request's history executes an approved
 * call). So a gated tool executes only
 *
 * - for an approval this request verified, with exactly its tool call id,
 *   tool name and canonical input, once; or
 * - for a live call whose `needsApproval` this run answered with false.
 *
 * Everything else, including a call whose `needsApproval` was never asked,
 * is refused.
 */
export function createApprovalExecutionGate(verified: ReadonlyArray<VerifiedApproval>): AiSdkApprovalGate {
  const approvals = new Map(verified.map((entry) => [entry.toolCallId, {
    toolName: entry.toolName,
    input: canonicalJson(entry.input),
  }]));
  const executed = new Set<string>();
  const liveWithoutApproval = new Map<string, string>();
  return {
    recordDecision: ({ toolName, toolCallId, needed }) => {
      if (typeof toolCallId !== 'string' || approvals.has(toolCallId)) return;
      if (needed) liveWithoutApproval.delete(toolCallId);
      else liveWithoutApproval.set(toolCallId, toolName);
    },
    authorize: ({ toolName, toolCallId, input }) => {
      if (typeof toolCallId !== 'string') throw new ApprovalExecutionRefusedError('approval_not_verified', toolName);
      const approval = approvals.get(toolCallId);
      if (approval) {
        if (executed.has(toolCallId)) throw new ApprovalExecutionRefusedError('approval_already_used', toolName);
        if (approval.toolName !== toolName || approval.input !== canonicalOrUndefined(input)) {
          throw new ApprovalExecutionRefusedError('approval_not_verified', toolName);
        }
        executed.add(toolCallId);
        return;
      }
      if (liveWithoutApproval.get(toolCallId) === toolName) {
        liveWithoutApproval.delete(toolCallId);
        return;
      }
      throw new ApprovalExecutionRefusedError('approval_not_verified', toolName);
    },
  };
}

function canonicalOrUndefined(value: unknown): string | undefined {
  try {
    return canonicalJson(value);
  } catch {
    return undefined;
  }
}

interface GateableTool {
  needsApproval?: unknown;
  execute?: (input: unknown, options?: unknown) => unknown;
  [key: string]: unknown;
}

/**
 * Puts the gate on every tool for which `isGated` says it can ask for
 * approval. The gated tool records its own `needsApproval` answers and checks
 * the gate in its own `execute`, so a stream handler that builds AI SDK tools
 * from these objects itself is held to the gate as well; `createAiSdkTools`
 * finds the gate on the tool and checks it with the input before validation.
 */
export function gateApprovalTools<T extends Record<string, unknown>>(
  tools: T,
  gate: AiSdkApprovalGate,
  isGated: (toolName: string, tool: GateableTool) => boolean,
): T {
  const gated: Record<string, unknown> = {};
  for (const [toolName, raw] of Object.entries(tools)) {
    const tool = raw as GateableTool;
    if (typeof raw !== 'object' || raw === null || typeof tool.execute !== 'function' || !isGated(toolName, tool)) {
      gated[toolName] = raw;
      continue;
    }
    const original = tool.needsApproval;
    const execute = tool.execute;
    gated[toolName] = {
      ...tool,
      [AI_SDK_APPROVAL_GATE]: gate,
      needsApproval: async (input: unknown, options?: { toolCallId?: string }) => {
        const needed = typeof original === 'function'
          ? Boolean(await (original as (value: unknown, extra?: unknown) => unknown)(input, options))
          : original === true;
        gate.recordDecision({ toolName, toolCallId: options?.toolCallId, needed });
        return needed;
      },
      execute: async (input: unknown, options?: unknown) => {
        const passed = (options as { [AI_SDK_APPROVAL_GATE_PASSED]?: unknown } | undefined)?.[AI_SDK_APPROVAL_GATE_PASSED];
        if (passed !== gate) {
          gate.authorize({ toolName, toolCallId: (options as { toolCallId?: string } | undefined)?.toolCallId, input });
        }
        return execute(input, options);
      },
    };
  }
  return gated as T;
}
