import { CLARIFICATION_TOOL_NAME } from '../../contracts/clarification.js';
import { PLAN_TOOL_NAME, readPlanItems, type PlanItem } from '../../contracts/plan.js';
import { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
import { isUiActionHandoffMessage } from '../../browser/ui-action-handoff.js';

/**
 * `declined`: the call did not run because its approval was refused (by the
 * user, or by the server for an expired or reused approval). It is not a
 * failure. `error`: the call threw, or its output is an object with
 * `success: false` (a failed backend call, a refused UI action).
 */
export type ActivityStepStatus = 'running' | 'done' | 'error' | 'waiting' | 'declined';

export interface ActivityStep {
  id: string;
  toolName: string;
  status: ActivityStepStatus;
  /** Tool output message or error text, when the display mode allows it. */
  detail?: string;
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
 * an endpoint tool's failed backend call, a refused UI action, a custom tool.
 * Any object output with `success: false` is a failed step.
 */
function isFailedOutput(output: unknown): output is Record<string, unknown> {
  return isRecord(output) && !Array.isArray(output) && output.success === false;
}

function stepStatus(state: unknown, output: unknown): ActivityStepStatus {
  switch (state) {
    case 'output-available':
      return isFailedOutput(output) ? 'error' : 'done';
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
 * App tool calls of a message in the order they ran. `allowDetail` decides
 * per tool whether its output message or error text may be shown.
 */
export function readActivitySteps(
  parts: ReadonlyArray<unknown>,
  allowDetail: (toolName: string) => boolean,
): ActivityStep[] {
  const steps: ActivityStep[] = [];
  parts.forEach((part, index) => {
    if (!isRecord(part)) return;
    const toolName = toolPartName(part);
    if (!toolName || BUILTIN_TOOL_NAMES.has(toolName)) return;
    const status = stepStatus(part.state, part.output);
    const step: ActivityStep = {
      id: typeof part.toolCallId === 'string' ? part.toolCallId : `part-${index}`,
      toolName,
      status,
    };
    if (allowDetail(toolName)) {
      let detail: unknown;
      if (status === 'error') {
        detail = isFailedOutput(part.output) ? part.output.error : part.errorText;
      } else if (status === 'done' && isRecord(part.output)) {
        // The hand-off note of a UI tool is for the model, not the user.
        detail = isUiActionHandoffMessage(part.output.message) ? undefined : part.output.message;
      }
      if (typeof detail === 'string' && detail.trim()) step.detail = detail.trim();
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
