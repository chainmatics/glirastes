import { createHash } from 'node:crypto';
import type { DurableRuntimeStore } from '../../runtime/postgres-store.js';
import { PrivacyError, toSafeError, type SafeErrorSummary } from './detection-result.js';
import type { PrivacyBoundary } from './model-boundary.js';
import { scopeKeyOf } from './mapping-store.js';

/** The tool-execution part of the runtime store, used as write receipts. */
export type ToolReceiptStore = Pick<DurableRuntimeStore, 'claimToolExecution' | 'completeToolExecution'>;

export interface PrivacyToolOptions {
  /**
   * Persistent receipts keyed by the tool call id. A call that already
   * completed is not executed again (for example after the turn failed while
   * protecting its result); a call whose outcome is unknown (timeout after a
   * possible commit) is not retried but answered `privacy_tool_outcome_unknown`
   * for a business reconciliation.
   */
  receipts?: ToolReceiptStore;
  /** Environment id for the receipts. */
  environmentId?: string;
  /** Content-free diagnostics of a failed tool. */
  onToolError?: (toolName: string, error: SafeErrorSummary) => void;
}

interface ExecutableTool {
  execute?: (input: unknown, options?: { toolCallId?: string }) => unknown;
  needsApproval?: unknown;
  [key: string]: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function outcomeMayBeCommitted(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Wraps AI SDK tools of a protected turn:
 * - the model's input (pseudonyms) is rehydrated to the authorized originals
 *   of this scope right before `needsApproval` and `execute`; the backend
 *   authorizes the final values with the principal's own credentials;
 * - the result goes back unchanged; the model boundary protects it before
 *   the next model call, so a protection failure never re-runs the tool;
 * - a thrown error reaches the model only as a content-free code.
 */
export function wrapToolsForPrivacy<T extends Record<string, unknown>>(
  tools: T,
  boundary: PrivacyBoundary,
  options: PrivacyToolOptions = {},
): T {
  const runId = `privacy:${scopeKeyOf(boundary.session.scope)}`;
  const environmentId = options.environmentId ?? boundary.session.scope.environment;
  const wrapped: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(tools)) {
    const tool = raw as ExecutableTool;
    if (typeof tool !== 'object' || tool === null || typeof tool.execute !== 'function') {
      wrapped[name] = raw;
      continue;
    }
    const execute = tool.execute.bind(tool);
    const needsApproval = tool.needsApproval;
    wrapped[name] = {
      ...tool,
      ...(typeof needsApproval === 'function'
        ? {
            needsApproval: (input: unknown, ...rest: unknown[]) =>
              (needsApproval as (...args: unknown[]) => unknown)(boundary.rehydrateToolInput(input), ...rest),
          }
        : {}),
      execute: async (input: unknown, executeOptions?: { toolCallId?: string }) => {
        const original = boundary.rehydrateToolInput(input);
        const toolCallId = executeOptions?.toolCallId;
        const claim = options.receipts && toolCallId
          ? {
              environmentId,
              runId,
              // A provider may reuse ids such as `call_0` across turns: the
              // key also binds the (pseudonymized) input, so a different call
              // under a reused id is not taken for a replay.
              idempotencyKey: `${toolCallId}:${fingerprint(input)}`,
              toolUuid: name,
              // The model's input holds scope-local pseudonyms only; a digest of
              // the originals could be checked against guessed values.
              inputFingerprint: fingerprint(input),
            }
          : undefined;
        if (claim) {
          let evidence;
          try {
            evidence = await options.receipts!.claimToolExecution(claim);
          } catch (error) {
            options.onToolError?.(name, toSafeError(error));
            throw new PrivacyError('privacy_tool_failed');
          }
          if (!evidence.claimed) {
            if (evidence.status === 'completed') return { success: true, replayed: true };
            throw new PrivacyError(evidence.status === 'pending' ? 'privacy_tool_outcome_unknown' : 'privacy_tool_failed');
          }
        }
        let result: unknown;
        try {
          result = await execute(original, executeOptions);
        } catch (error) {
          options.onToolError?.(name, toSafeError(error));
          if (claim && !outcomeMayBeCommitted(error)) {
            await options.receipts!.completeToolExecution({ ...claim, status: 'failed', result: null, resultFingerprint: 'failed' }).catch(() => undefined);
          }
          throw new PrivacyError(outcomeMayBeCommitted(error) ? 'privacy_tool_outcome_unknown' : 'privacy_tool_failed');
        }
        if (claim) {
          // The receipt records the outcome only, never the result or a digest of it.
          // An SDK tool reports a caught failure as a returned `{ error }` or
          // `{ success: false }`: that is not a completed write.
          await options.receipts!.completeToolExecution({
            ...claim,
            status: isFailureResult(result) ? 'failed' : 'completed',
            result: null,
            resultFingerprint: 'not-recorded',
          }).catch((error) => options.onToolError?.(name, toSafeError(error)));
        }
        return result;
      },
    };
  }
  return wrapped as T;
}

/** A tool result that reports a failure instead of throwing. */
function isFailureResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return record.success === false || (typeof record.error === 'string' && record.error.length > 0);
}
