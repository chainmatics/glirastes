import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
 *   glirastes-approval.v1.<issuedAtMs>.<nonce>.<mac>
 *
 * where `mac` is an HMAC-SHA-256, keyed with a server secret, over the issue
 * time, the nonce, the scope, the tool call id, the tool name and the
 * canonical JSON of the input.
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

/** Optional single-use store. `consume` returns false when the id was used before. */
export interface ApprovalStore {
  consume: (approvalId: string, expiresAtMs: number) => boolean | Promise<boolean>;
}

export interface ApprovalCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export type ApprovalVerification =
  | { readonly ok: true; readonly expiresAtMs: number }
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

/** JSON with sorted keys, so an input hashes the same after any JSON round trip. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item === undefined ? null : item));
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) sorted[key] = sortKeys(entry);
  }
  return sorted;
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

  const mac = (issuedAt: string, nonce: string, call: ApprovalCall): Buffer => createHmac('sha256', options.secret)
    .update(JSON.stringify(['v1', issuedAt, nonce, scope, call.toolCallId, call.toolName, canonicalJson(call.input)]))
    .digest();

  return {
    maxAgeMs,
    issue: (call) => {
      const issuedAt = String(now());
      const nonce = randomBytes(16).toString('base64url');
      return `${ID_PREFIX}${issuedAt}.${nonce}.${mac(issuedAt, nonce, call).toString('base64url')}`;
    },
    verify: (call) => {
      const notIssued = { ok: false, code: 'approval_not_issued' } as const;
      if (typeof call.approvalId !== 'string' || !call.approvalId.startsWith(ID_PREFIX)) return notIssued;
      const [issuedAt, nonce, presented, ...rest] = call.approvalId.slice(ID_PREFIX.length).split('.');
      if (!issuedAt || !nonce || !presented || rest.length > 0 || !/^\d{1,16}$/.test(issuedAt)) return notIssued;
      const expected = mac(issuedAt, nonce, call);
      const actual = Buffer.from(presented, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return notIssued;
      const age = now() - Number(issuedAt);
      if (age < -CLOCK_SKEW_MS) return notIssued;
      if (age > maxAgeMs) return { ok: false, code: 'approval_expired' };
      return { ok: true, expiresAtMs: Number(issuedAt) + maxAgeMs };
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
          controller.enqueue({ ...chunk, approvalId: binder.issue({ toolCallId: record.toolCallId, ...announced }) });
          return;
        }
      }
      controller.enqueue(chunk);
    },
  }));
}

type MessageRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is MessageRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const RESULT_STATES = new Set(['output-available', 'output-error', 'output-denied']);

function toolNameOf(part: MessageRecord): string | undefined {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : undefined;
  return typeof part.type === 'string' && part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : undefined;
}

export interface DeniedApproval {
  readonly toolCallId: string;
  readonly code: ApprovalDenialCode;
}

/**
 * Checks, before anything runs, every tool part of the request history that
 * the AI SDK would turn into an approved call without a result: it needs an
 * approval id issued for exactly this tool call id, tool name and input, not
 * older than the maximum age, not used before in this history and, with a
 * store, not used before at all.
 *
 * A part that fails is rewritten to `output-denied` with the code as its
 * reason, so the model messages carry a denied result for it and the SDK runs
 * nothing. The request itself continues: the model sees the denial and
 * answers.
 */
export async function enforceApprovalBindings(
  messages: ReadonlyArray<unknown>,
  options: { binder: ApprovalBinder; store?: ApprovalStore },
): Promise<{ messages: unknown[]; denied: DeniedApproval[] }> {
  const resolved = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (isRecord(part) && toolNameOf(part) && RESULT_STATES.has(String(part.state)) && typeof part.toolCallId === 'string') {
        resolved.add(part.toolCallId);
      }
    }
  }

  const denied: DeniedApproval[] = [];
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
      const toolName = isRecord(part) ? toolNameOf(part) : undefined;
      const approval = isRecord(part) && isRecord(part.approval) ? part.approval : undefined;
      const pending = isRecord(part) && toolName && approval?.approved === true
        && !RESULT_STATES.has(String(part.state)) && part.state !== 'input-streaming';
      if (!pending) {
        parts.push(part);
        continue;
      }
      const record = part as MessageRecord;
      const toolCallId = String(record.toolCallId);
      const approvalId = String(approval!.id);
      const code = await denialCode({
        record, toolName: toolName!, toolCallId, approvalId, resolved, usedIds, ...options,
      });
      usedIds.add(approvalId);
      if (!code) {
        parts.push(part);
        continue;
      }
      denied.push({ toolCallId, code });
      changed = true;
      parts.push({ ...record, state: 'output-denied', approval: { id: approvalId, approved: false, reason: code } });
    }
    next.push(changed ? { ...message, parts } : message);
  }
  return { messages: next, denied };
}

async function denialCode(args: {
  record: MessageRecord;
  toolName: string;
  toolCallId: string;
  approvalId: string;
  resolved: ReadonlySet<string>;
  usedIds: ReadonlySet<string>;
  binder: ApprovalBinder;
  store?: ApprovalStore;
}): Promise<ApprovalDenialCode | undefined> {
  const verified = args.binder.verify({
    approvalId: args.approvalId,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    input: args.record.input,
  });
  if (!verified.ok) return verified.code;
  if (args.resolved.has(args.toolCallId) || args.usedIds.has(args.approvalId)) return 'approval_already_used';
  if (args.store) {
    try {
      if (!(await args.store.consume(args.approvalId, verified.expiresAtMs))) return 'approval_already_used';
    } catch {
      return 'approval_store_unavailable';
    }
  }
  return undefined;
}
