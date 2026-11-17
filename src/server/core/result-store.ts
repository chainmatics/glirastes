/**
 * Turn-scoped store of large tool results.
 *
 * A store belongs to exactly one turn: `createAiChatHandler` creates it inside
 * the request and drops it when the turn ends; it is never module or global
 * state. A result that exceeds its tool's limit is kept here in full (after
 * the optional `seal`, e.g. the PII shield) and the model gets an overview
 * with a handle; `read_result` reads more from that handle without calling
 * the backend again.
 */
import {
  READ_RESULT_ID_PREFIX,
  WRITE_RESULT_ID_PREFIX,
} from '../../contracts/result-handle.js';
import { buildResultOverview } from './result-overview.js';

/** Default limits of a turn's result store. */
export const DEFAULT_RESULT_HANDLE_LIMITS = Object.freeze({
  /** Handles per turn. */
  maxResults: 8,
  /** Serialized UTF-8 size of one stored result. */
  maxResultBytes: 2 * 1024 * 1024,
  /** Serialized UTF-8 size of all stored results of the turn. */
  maxTotalBytes: 16 * 1024 * 1024,
});

/** Limits of the result handles of a turn (`AiChatHandlerConfig.resultHandles`). */
export interface ResultHandleLimits {
  /** Handles per turn (default 8). */
  maxResults?: number;
  /** Serialized UTF-8 bytes of one stored result (default 2 MiB); a larger result is cut instead. */
  maxResultBytes?: number;
  /** Serialized UTF-8 bytes of all stored results of a turn (default 16 MiB). */
  maxTotalBytes?: number;
}

/** Who a handle belongs to: the managed principal at the moment it was created. */
export interface ResultHandleOwner {
  subjectId: string;
  tenantId: string;
}

export interface ResultStoreOptions extends ResultHandleLimits {
  /**
   * Applied once to the complete result before it is stored (the chat
   * handler passes the PII shield's `anonymizeResult`). The store keeps only
   * its output; overviews and `read_result` projections are cut from it and
   * must not pass the shield again (see `isIssued`).
   */
  seal?: (value: unknown) => unknown | Promise<unknown>;
  /**
   * Resolves the current principal (managed turns). When given, a handle is
   * bound to the owner captured before the origin tool ran
   * (`captureOwner`, passed as `ResultStorePutInput.owner`); `put` resolves
   * it again and creates no handle when it is missing or differs, so a
   * result produced for one principal is never stored for another.
   * `read_result` compares the owner with the principal of every read.
   */
  owner?: () => ResultHandleOwner | undefined | Promise<ResultHandleOwner | undefined>;
}

export interface ResultHandle {
  /** `ro_…` for a read tool, `rw_…` otherwise; random per handle. */
  readonly id: string;
  /** Model-facing name of the tool that produced the result. */
  readonly toolName: string;
  readonly readOnly: boolean;
  /** Effective result limit of the origin tool; bounds every read of this handle. */
  readonly maxChars: number;
  /** The sealed result. Never handed out by reference. */
  readonly value: Record<string, unknown>;
  readonly owner?: ResultHandleOwner;
}

export interface ResultStorePutInput {
  toolName: string;
  readOnly: boolean;
  maxChars: number;
  /**
   * A successful record result (`success` not false), larger than
   * `maxChars` serialized or, with `defaultFields`, with fields the default
   * view leaves out.
   */
  value: Record<string, unknown>;
  /**
   * The tool's `outputDefaultFields`: the overview is the default view of
   * the sealed copy (see `BuildResultOverviewOptions.defaultFields`); the
   * whole value stays readable through the handle.
   */
  defaultFields?: ReadonlyArray<string>;
  /**
   * The owner `captureOwner` returned before the origin tool ran. Required
   * when the store has `owner`: without it, or when it is not the principal
   * resolved now, no handle is created.
   */
  owner?: ResultHandleOwner;
}

export interface ResultStore {
  /**
   * The current principal as a handle owner, resolved now; call it before
   * the origin tool runs and pass the answer to `put` as `owner`. Undefined
   * (no call) for a store without `owner` (no principal to bind to).
   */
  captureOwner(): Promise<ResultHandleOwner | undefined> | undefined;
  /**
   * Stores `value` and returns its overview, or undefined when the store
   * refuses it (handle count or size limits, an unserializable value, no
   * owner, a cleared store, or an overview that cannot fit); the caller then
   * cuts the result as before.
   */
  put(input: ResultStorePutInput): Promise<Record<string, unknown> | undefined>;
  /** The handle with this id in this turn; undefined when unknown or cleared. */
  get(id: string): ResultHandle | undefined;
  /** Marks an object handed to the model that was cut from sealed data. */
  markIssued(value: unknown): void;
  /** Whether `value` was cut from sealed data (it must not be sealed again). */
  isIssued(value: unknown): boolean;
  /** Drops every handle; later `put` calls are refused. Safe to call more than once. */
  clear(): void;
  /** Number of handles. */
  readonly size: number;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Throws a clear error naming `label` when a limit is set but no positive safe integer. */
export function assertResultHandleLimits(limits: ResultHandleLimits | undefined, label: string): void {
  if (!limits) return;
  for (const key of ['maxResults', 'maxResultBytes', 'maxTotalBytes'] as const) {
    if (limits[key] !== undefined && !positiveInteger(limits[key])) {
      throw new Error(`${label}: resultHandles.${key} must be a positive integer`);
    }
  }
}

/** UTF-8 length of a string without encoding it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  // 252 = 7 × 36: values below it map evenly; the rare rest is drawn again.
  for (let index = 0; index < bytes.length; index += 1) {
    let byte = bytes[index]!;
    while (byte >= 252) {
      const again = new Uint8Array(1);
      globalThis.crypto.getRandomValues(again);
      byte = again[0]!;
    }
    text += ID_ALPHABET[byte % 36];
  }
  return text;
}

/** A result store for one turn. See `ResultStore`. */
export function createResultStore(options: ResultStoreOptions = {}): ResultStore {
  assertResultHandleLimits(options, 'createResultStore');
  const maxResults = options.maxResults ?? DEFAULT_RESULT_HANDLE_LIMITS.maxResults;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_RESULT_HANDLE_LIMITS.maxResultBytes;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_RESULT_HANDLE_LIMITS.maxTotalBytes;
  const handles = new Map<string, ResultHandle>();
  const issued = new WeakSet<object>();
  let reservedCount = 0;
  let reservedBytes = 0;
  let cleared = false;

  const newId = (readOnly: boolean): string => {
    const prefix = readOnly ? READ_RESULT_ID_PREFIX : WRITE_RESULT_ID_PREFIX;
    for (;;) {
      const id = prefix + randomSuffix();
      if (!handles.has(id)) return id;
    }
  };

  return {
    captureOwner() {
      if (!options.owner) return undefined;
      return Promise.resolve(options.owner()).then((owner) => (
        owner ? { subjectId: owner.subjectId, tenantId: owner.tenantId } : undefined
      ));
    },
    async put(input) {
      if (cleared) return undefined;
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(input.value);
      } catch {
        return undefined;
      }
      if (serialized === undefined) return undefined;
      const rawBytes = utf8Length(serialized);
      if (reservedCount + 1 > maxResults || rawBytes > maxResultBytes || reservedBytes + rawBytes > maxTotalBytes) {
        return undefined;
      }
      // Reserved before any await, so parallel tool calls cannot overshoot.
      reservedCount += 1;
      reservedBytes += rawBytes;
      let keptBytes = rawBytes;
      const release = () => {
        reservedCount -= 1;
        reservedBytes -= keptBytes;
      };
      try {
        // The owner is the principal the tool ran for; still the same one now, or no handle.
        const owner = input.owner;
        if (options.owner) {
          const current = await options.owner();
          if (!owner || !current || current.subjectId !== owner.subjectId || current.tenantId !== owner.tenantId) {
            release();
            return undefined;
          }
        }
        // A private copy: the caller's object may change later.
        const copy = JSON.parse(serialized) as unknown;
        const sealed = options.seal ? await options.seal(copy) : copy;
        if (typeof sealed !== 'object' || sealed === null || Array.isArray(sealed)) {
          release();
          return undefined;
        }
        // The sealed copy is what is kept (a pseudonym can be longer than its original).
        const sealedText = JSON.stringify(sealed);
        const sealedBytes = utf8Length(sealedText);
        reservedBytes += sealedBytes - rawBytes;
        keptBytes = sealedBytes;
        if (cleared || sealedBytes > maxResultBytes || reservedBytes > maxTotalBytes) {
          release();
          return undefined;
        }
        const value = JSON.parse(sealedText) as Record<string, unknown>;
        const id = newId(input.readOnly);
        const overview = buildResultOverview(value, {
          id, maxChars: input.maxChars, readOnly: input.readOnly,
          ...(input.defaultFields ? { defaultFields: input.defaultFields } : {}),
        });
        if (!overview) {
          release();
          return undefined;
        }
        handles.set(id, {
          id,
          toolName: input.toolName,
          readOnly: input.readOnly,
          maxChars: input.maxChars,
          value,
          ...(owner ? { owner: { subjectId: owner.subjectId, tenantId: owner.tenantId } } : {}),
        });
        issued.add(overview);
        return overview;
      } catch {
        release();
        return undefined;
      }
    },
    get(id) {
      if (cleared || typeof id !== 'string') return undefined;
      return handles.get(id);
    },
    markIssued(value) {
      if (typeof value === 'object' && value !== null) issued.add(value);
    },
    isIssued(value) {
      return typeof value === 'object' && value !== null && issued.has(value);
    },
    clear() {
      cleared = true;
      handles.clear();
    },
    get size() {
      return handles.size;
    },
  };
}
