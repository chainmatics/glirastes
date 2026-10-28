import { CLARIFICATION_TOOL_NAME } from '../../contracts/clarification.js';
import { PLAN_TOOL_NAME, readPlanItems, type PlanItem } from '../../contracts/plan.js';

export type ActivityStepStatus = 'running' | 'done' | 'error' | 'waiting';

export interface ActivityStep {
  id: string;
  toolName: string;
  status: ActivityStepStatus;
  /** Tool output message or error text, when the display mode allows it. */
  detail?: string;
}

/** SDK built-ins render elsewhere (plan, clarification card, suggestions). */
const BUILTIN_TOOL_NAMES = new Set<string>([
  'find_tools',
  'suggest_followups',
  CLARIFICATION_TOOL_NAME,
  PLAN_TOOL_NAME,
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

function stepStatus(state: unknown): ActivityStepStatus {
  switch (state) {
    case 'output-available':
      return 'done';
    case 'output-error':
    case 'output-denied':
      return 'error';
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
    const status = stepStatus(part.state);
    const step: ActivityStep = {
      id: typeof part.toolCallId === 'string' ? part.toolCallId : `part-${index}`,
      toolName,
      status,
    };
    if (allowDetail(toolName)) {
      const detail = status === 'error'
        ? part.errorText
        : status === 'done' && isRecord(part.output) ? part.output.message : undefined;
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
