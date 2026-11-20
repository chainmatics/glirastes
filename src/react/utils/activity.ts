import { CLARIFICATION_TOOL_NAME } from '../../contracts/clarification.js';
import { PLAN_TOOL_NAME, readPlanItems, type PlanItem } from '../../contracts/plan.js';
import { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
import { isUiActionHandoffMessage } from '../../browser/ui-action-handoff.js';
import { readUiOutcomeCode, type UiOutcomeCode } from '../../contracts/ui-outcome.js';
import {
  ENDPOINT_PATH_NOT_ALLOWED_ERROR,
  ENDPOINT_PATH_NOT_RELATIVE_ERROR,
  toolResultFailure,
} from '../../runtime/tool-failure.js';
import { readStepFailures, type StepFailure } from './step-failure.js';

/**
 * `declined`: the call did not run because its approval was refused (by the
 * user, or by the server for an expired or reused approval). It is not a
 * failure. `expected`: the call answered with a failure that is a normal
 * answer: one `classifyToolFailure` marked as expected, or a backend answer
 * with a 4xx status other than 408 and 429 (e.g. a 404 the model then looks
 * up, a 403). `error`: the call threw, or its output reports any other
 * failure (5xx, timeout, network error, a refused UI action, a custom tool's
 * `success: false`). `aborted`: the call was still running when its turn
 * ended without it (the user stopped, the request failed, a stored history
 * whose last call never got a result); neutral, not a failure. Set by the
 * log for a turn that no longer runs, never by `readActivitySteps`.
 */
export type ActivityStepStatus = 'running' | 'done' | 'error' | 'waiting' | 'declined' | 'expected' | 'aborted';

export interface ActivityStep {
  id: string;
  toolName: string;
  status: ActivityStepStatus;
  /** Tool output message or error text, when the detail policy (`activityLog.details`) allows it. */
  detail?: string;
  /**
   * Who refused a `declined` call: `'user'` (answered "no" in the approval
   * card), `'server'` (the user approved, but the server did not run it: an
   * expired or already used approval). Absent when the part does not say.
   */
  declinedBy?: 'user' | 'server';
  /**
   * What the app reported for a UI action the model waits on (outcome
   * protocol): `pending` until it reports, then its code (`ok` shows no
   * extra text) or `unconfirmed`. The log shows the matching locale text.
   */
  uiOutcome?: ActivityUiOutcome;
  /**
   * Set beside `detail` when the SDK wrote that text itself (a refused call,
   * invalid input, a limit, the endpoint caller's or a memory tool's fixed
   * text): its kind and values, so the log shows the locale's text
   * (`activityFailure…`) instead of the English one. Absent for a text of
   * the app's backend or tool and for a text this version does not know.
   */
  failures?: StepFailure[];
}

export type ActivityUiOutcome = 'pending' | Exclude<UiOutcomeCode, 'ok'> | 'unconfirmed';

/** Status and display of a result of the outcome protocol (`awaitsOutcome`), or undefined for any other. */
function uiOutcomeStep(output: unknown): { status: ActivityStepStatus; uiOutcome?: ActivityUiOutcome } | undefined {
  if (!isRecord(output) || typeof output.awaitsOutcome !== 'boolean') return undefined;
  if (output.outcome === undefined) return output.awaitsOutcome ? { status: 'waiting', uiOutcome: 'pending' } : { status: 'done' };
  const code = readUiOutcomeCode(output.outcome);
  if (code === 'ok') return { status: 'done' };
  if (code === undefined) return { status: 'done', uiOutcome: 'unconfirmed' };
  return { status: code === 'initiated' ? 'done' : 'error', uiOutcome: code };
}

/** SDK built-ins render elsewhere (plan, clarification card, suggestions) or are internal (find_tools, read_result). */
const BUILTIN_TOOL_NAMES = new Set<string>([
  'find_tools',
  'suggest_followups',
  CLARIFICATION_TOOL_NAME,
  PLAN_TOOL_NAME,
  READ_RESULT_TOOL_NAME,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Tool name of an AI SDK 5.x/6.x tool part (`tool-{name}` or `dynamic-tool`). */
function toolPartName(part: Record<string, unknown>): string | null {
  const type = typeof part.type === 'string' ? part.type : '';
  if (type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null;
  if (!type.startsWith('tool-') || type === 'tool-result' || type === 'tool-call') return null;
  return type.slice('tool-'.length);
}

/**
 * A tool that reports its own failure answers with an output, not an error:
 * an endpoint tool's failed backend call, a refused UI action, a custom tool,
 * a thrown tool error the server turned into `{ error }`. The same rule the
 * server counts failures by (`toolResultFailure`): `success: false` or an
 * `error` text.
 */
function isFailedOutput(output: unknown): output is Record<string, unknown> {
  return isRecord(output) && !Array.isArray(output) && toolResultFailure(output) !== undefined;
}

/**
 * A failure that is a normal answer, not a malfunction, so the step is shown
 * neutrally. Display only: what the server counts (`maxConsecutiveErrors`,
 * turn metrics) follows `classifyToolFailure` alone.
 * - The app's marker `expectedFailure: true` (`classifyToolFailure` returned
 *   `'expected'`), for any status. An explicit `expectedFailure: false` (the
 *   classifier returned `'error'`) is a failure, for any status.
 * - Without a marker (no classifier, an older server, stored history), a backend answer with a client-class status (400-499, e.g. a
 *   404 the model then looks up, a 403): the backend understood the call and
 *   said no. Except 408 and 429 (timeout, rate limit) and a call the SDK's
 *   endpoint caller refused itself before it reached the backend.
 * Everything else (5xx, no status: network error, timeout, a refused UI
 * action, a custom tool) stays a failure.
 */
function isExpectedFailure(output: Record<string, unknown>): boolean {
  if (output.success !== false) return false;
  if (output.expectedFailure === true) return true;
  if (output.expectedFailure === false) return false;
  const status = output.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) return false;
  if (status === 408 || status === 429) return false;
  return output.error !== ENDPOINT_PATH_NOT_ALLOWED_ERROR && output.error !== ENDPOINT_PATH_NOT_RELATIVE_ERROR;
}

function stepStatus(state: unknown, output: unknown): ActivityStepStatus {
  switch (state) {
    case 'output-available':
      if (!isFailedOutput(output)) return 'done';
      return isExpectedFailure(output) ? 'expected' : 'error';
    case 'output-error':
      return 'error';
    case 'output-denied':
      return 'declined';
    case 'approval-requested':
    case 'approval-responded':
      return 'waiting';
    default:
      return 'running';
  }
}

/**
 * Where a step's detail comes from: `'output'` the tool's own result (its
 * `error` or `message`), `'error-text'` the `errorText` of an `output-error`
 * part (the AI SDK or the runtime refused or aborted the call).
 */
export type ActivityDetailSource = 'output' | 'error-text';

/** `'server'` for a call the user approved that did not run, `'user'` for a refusal. */
function declinedByOf(approval: unknown): ActivityStep['declinedBy'] {
  if (!isRecord(approval) || typeof approval.approved !== 'boolean') return undefined;
  return approval.approved ? 'server' : 'user';
}

/**
 * App tool calls of a message in the order they ran. `allowDetail` decides
 * per tool (and step status) whether its output message or error text may be
 * shown.
 */
export function readActivitySteps(
  parts: ReadonlyArray<unknown>,
  allowDetail: (toolName: string, status: ActivityStepStatus, source: ActivityDetailSource) => boolean,
): ActivityStep[] {
  const steps: ActivityStep[] = [];
  parts.forEach((part, index) => {
    if (!isRecord(part)) return;
    const toolName = toolPartName(part);
    if (!toolName || BUILTIN_TOOL_NAMES.has(toolName)) return;
    const outcome = part.state === 'output-available' ? uiOutcomeStep(part.output) : undefined;
    const status = outcome?.status ?? stepStatus(part.state, part.output);
    const step: ActivityStep = {
      id: typeof part.toolCallId === 'string' ? part.toolCallId : `part-${index}`,
      toolName,
      status,
      ...(outcome?.uiOutcome ? { uiOutcome: outcome.uiOutcome } : {}),
    };
    if (status === 'declined') {
      const declinedBy = declinedByOf(part.approval);
      if (declinedBy) step.declinedBy = declinedBy;
    }
    // A UI action's outcome is shown by its own text, not by the result's message.
    if (outcome) {
      steps.push(step);
      return;
    }
    let detail: unknown;
    // `errorText` of an `output-error` part: written by the AI SDK or the runtime (invalid input, a guard), not by the tool.
    let source: ActivityDetailSource = 'output';
    if (status === 'error' || status === 'expected') {
      if (isFailedOutput(part.output) && part.state === 'output-available') {
        detail = part.output.error;
      } else {
        detail = part.errorText;
        source = 'error-text';
      }
    } else if (status === 'done' && isRecord(part.output)) {
      // The hand-off note of a UI tool is for the model, not the user.
      detail = isUiActionHandoffMessage(part.output.message) ? undefined : part.output.message;
    }
    if (typeof detail === 'string' && detail.trim() && allowDetail(toolName, status, source)) {
      step.detail = detail.trim();
      const resultStatus = isRecord(part.output) && typeof part.output.status === 'number' ? part.output.status : undefined;
      const failures = status === 'error' || status === 'expected'
        ? readStepFailures(step.detail, { source, toolName, ...(source === 'output' && resultStatus !== undefined ? { status: resultStatus } : {}) })
        : undefined;
      if (failures) step.failures = failures;
    }
    steps.push(step);
  });
  return steps;
}

/** Items of the last `update_plan` call in a message, or null without one. */
export function readLatestPlan(parts: ReadonlyArray<unknown>): PlanItem[] | null {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (isRecord(part) && toolPartName(part) === PLAN_TOOL_NAME) {
      const items = readPlanItems(part.input);
      if (items) return items;
    }
  }
  return null;
}
