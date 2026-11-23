import { preparePrivacyConversion } from '../core/privacy-conversion.js';
import { isResultReader, unsupportedPrivateResultRead } from '../core/result-reader.js';
import { randomUUID } from 'node:crypto';
import type { DurableRuntimeStore } from '../../runtime/postgres-store.js';
import { PrivacyError, toSafeError, type SafeErrorSummary } from './detection-result.js';
import type { PrivacyBoundary } from './model-boundary.js';
import { scopeKeyOf } from './mapping-store.js';
import { errorLeavesOutcomeUnknown, isOutcomeUnknown } from '../core/tool-outcome.js';

/** The tool-execution part of the runtime store, used as write receipts. */
export type ToolReceiptStore = Pick<DurableRuntimeStore, 'claimToolExecution' | 'completeToolExecution'>;

export interface PrivacyToolOptions {
  /**
   * Persistent receipts of tool writes. A resumed approval is keyed by its
   * approval id: it runs at most once, and a replay whose outcome is unknown
   * (timeout after a possible commit) is answered `privacy_tool_outcome_unknown`
   * for a business reconciliation. A call the model makes is recorded per
   * request (id and input); a new request (also a retry) is a new call.
   */
  receipts?: ToolReceiptStore;
  /** Environment id for the receipts. */
  environmentId?: string;
  /**
   * Approved calls this request resumes. The first call of that tool under
   * that tool call id is keyed by the verified approval id, so one approval
   * runs at most once in its generation; every other call (also a later one
   * reusing the id) is new in this request.
   */
  approvals?: ReadonlyArray<{ toolCallId: string; toolName: string; approvalId: string }>;
  /** Content-free diagnostics of a failed tool. */
  onToolError?: (toolName: string, error: SafeErrorSummary) => void;
  /**
   * Runs before a tool input is rehydrated and the tool executes, also for a
   * resumed approval. Throwing a `PrivacyError` (e.g. `privacy_policy_revoked`)
   * stops the call before any original leaves the boundary.
   */
  beforeExecute?: () => void | Promise<void>;
  /** Content-free notice of each tool call whose input was rehydrated. */
  onRehydrated?: () => void;
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

const outcomeMayBeCommitted = errorLeavesOutcomeUnknown;

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
  // The generation id is random and never reused: a receipt of an earlier
  // generation (expired, purged, lost) never applies again.
  const runId = `privacy:${scopeKeyOf(boundary.session.scope)}:${boundary.session.generation}`;
  // A provider may reuse call ids such as `call_0` in every request: a call
  // the model made in this request is keyed per request, so it is never
  // taken for a replay of an earlier, different call.
  const requestNonce = randomUUID();
  const approvalOf = new Map((options.approvals ?? []).map((approval) => [approval.toolCallId, approval]));
  // Keyed with the scope's secret: a receipt cannot be used to confirm a
  // guessed input, also where detection missed a value.
  const fingerprint = (value: unknown) => boundary.session.bindingDigest(canonical(['glirastes-tool-input/v1', value]));
  const environmentId = options.environmentId ?? boundary.session.scope.environment;
  const wrapped: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(tools)) {
    const tool = (typeof raw === 'object' && raw !== null ? preparePrivacyConversion(raw) : raw) as ExecutableTool;
    if (typeof tool !== 'object' || tool === null || typeof tool.execute !== 'function') {
      wrapped[name] = raw;
      continue;
    }
    const execute = tool.execute.bind(tool);
    const needsApproval = tool.needsApproval;
    wrapped[name] = {
      ...tool,
      ...(isResultReader(tool) ? { needsApproval: false } : typeof needsApproval === 'function'
        ? {
            needsApproval: (input: unknown, ...rest: unknown[]) =>
              (needsApproval as (...args: unknown[]) => unknown)(boundary.rehydrateToolInput(input), ...rest),
          }
        : {}),
      execute: async (input: unknown, executeOptions?: { toolCallId?: string }) => {
        await options.beforeExecute?.();
        if (isResultReader(tool)) return unsupportedPrivateResultRead();
        const original = boundary.rehydrateToolInput(input);
        try {
          options.onRehydrated?.();
        } catch {
          // A metrics sink never changes the decision.
        }
        const toolCallId = executeOptions?.toolCallId;
        const approval = toolCallId ? approvalOf.get(toolCallId) : undefined;
        const resumed = approval !== undefined && approval.toolName === name;
        // An approval opens one execution only; a later call reusing the id is a new call.
        if (resumed) approvalOf.delete(toolCallId!);
        const claim = options.receipts && toolCallId
          ? {
              environmentId,
              runId,
              idempotencyKey: resumed
                ? `approval:${approval.approvalId}`
                : `call:${requestNonce}:${toolCallId}:${fingerprint(input)}`,
              toolUuid: name,
              // A model's call holds scope-local pseudonyms only. A resumed
              // approval runs with the originals the principal saw: no digest
              // of them is stored (it could be checked against guessed
              // values); the signed approval id already binds the input.
              inputFingerprint: resumed ? 'approval-bound' : fingerprint(input),
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
        if (isOutcomeUnknown(result)) {
          // Timed out or aborted after the request may have reached the
          // backend: the receipt stays pending for a business reconciliation.
          options.onToolError?.(name, { name: 'TimeoutError', code: 'tool_outcome_unknown' });
          throw new PrivacyError('privacy_tool_outcome_unknown');
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

