/**
 * Continuing a turn the handler stopped at a limit, on the server (see
 * `contracts/budget-continuation.ts`): reading the request, the instruction
 * for the continued run, the guard that never runs a write call of the
 * stopped turn again, and the "done / open" summary of the stop notice.
 * Local only: nothing here reaches the Platform.
 */
import {
  BUDGET_CONTINUATION,
  BUDGET_STOP_PART_TYPE,
  CONTINUATION_REQUEST_FIELD,
  MAX_BUDGET_CONTINUATIONS,
  endsWithContinuableBudgetStop,
  readBudgetStopPart,
} from '../../../contracts/budget-continuation.js';
import { PLAN_TOOL_NAME, readPlanItems, type PlanItem } from '../../../contracts/plan.js';
import { createCallFingerprint } from '../../../runtime/fingerprint.js';
import { toolResultFailure } from '../../../runtime/tool-failure.js';

type Part = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The UI messages after the last user message (the running turn). */
function currentTurn(messages: ReadonlyArray<unknown>): Array<{ role?: unknown; parts?: unknown }> {
  const list = messages as ReadonlyArray<{ role?: unknown; parts?: unknown }>;
  let index = list.length - 1;
  while (index >= 0 && list[index]?.role !== 'user') index -= 1;
  return list.slice(index + 1) as Array<{ role?: unknown; parts?: unknown }>;
}

function toolNameOf(part: Part): string | null {
  const type = typeof part.type === 'string' ? part.type : '';
  if (type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null;
  if (!type.startsWith('tool-') || type === 'tool-result' || type === 'tool-call') return null;
  return type.slice('tool-'.length);
}

/** One tool call of a turn: name, arguments and whether it ended with a successful result. */
export interface TurnToolCall {
  /** The tool call id, when known. */
  id?: string;
  toolName: string;
  input: unknown;
  /** `done` a result that is no failure, `failed` a failure or error, `declined` refused approval, `open` no result. */
  state: 'done' | 'failed' | 'declined' | 'open';
}

/** The parts of the running turn's assistant messages, in order. */
function turnParts(messages: ReadonlyArray<unknown>): Part[] {
  const parts: Part[] = [];
  for (const message of currentTurn(messages)) {
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) if (isRecord(part)) parts.push(part);
  }
  return parts;
}

/** The tool calls of the running turn in the history, in order. */
export function turnToolCallsOf(messages: ReadonlyArray<unknown>): TurnToolCall[] {
  return toolCallsIn(turnParts(messages));
}

/**
 * The tool calls of the running turn before its latest budget stop (every
 * segment the handler stopped), empty for a turn without a stop. A later
 * request of the turn (a continuation, an approval or UI outcome after it)
 * must not run a write call of these again.
 */
export function turnToolCallsBeforeLatestStop(messages: ReadonlyArray<unknown>): TurnToolCall[] {
  const parts = turnParts(messages);
  let stopAt = parts.length - 1;
  while (stopAt >= 0 && !readBudgetStopPart(parts[stopAt])) stopAt -= 1;
  return stopAt < 0 ? [] : toolCallsIn(parts.slice(0, stopAt));
}

function toolCallsIn(parts: ReadonlyArray<Part>): TurnToolCall[] {
  const calls: TurnToolCall[] = [];
  for (const part of parts) {
    const toolName = toolNameOf(part);
    if (!toolName) continue;
    const state = part.state === 'output-available'
      ? (isRecord(part.output) && toolResultFailure(part.output) !== undefined ? 'failed' : 'done')
      : part.state === 'output-error' ? 'failed'
        : part.state === 'output-denied' ? 'declined' : 'open';
    calls.push({ ...(typeof part.toolCallId === 'string' ? { id: part.toolCallId } : {}), toolName, input: part.input, state });
  }
  return calls;
}

/** Budget stops of the running turn so far (`data-budget-stop` parts). */
export function budgetStopsSoFar(messages: ReadonlyArray<unknown>): number {
  let stops = 0;
  for (const message of currentTurn(messages)) {
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) if (readBudgetStopPart(part)) stops += 1;
  }
  return stops;
}

/**
 * What the request asks for: `'budget'` a valid continuation of a stopped
 * turn, `'invalid'` the field is set but the history does not end with a
 * continuable stop (or the turn used up its continuations), `undefined` the
 * field is absent.
 */
export function readBudgetContinuation(body: unknown, messages: ReadonlyArray<unknown>): 'budget' | 'invalid' | undefined {
  if (!isRecord(body) || !(CONTINUATION_REQUEST_FIELD in body)) return undefined;
  if (body[CONTINUATION_REQUEST_FIELD] !== BUDGET_CONTINUATION) return 'invalid';
  if (!endsWithContinuableBudgetStop(messages.at(-1))) return 'invalid';
  if (budgetStopsSoFar(messages) > MAX_BUDGET_CONTINUATIONS) return 'invalid';
  return 'budget';
}

/** The data of the stop part this request writes: continuable while the turn has continuations left. */
export function budgetStopPart(messages: ReadonlyArray<unknown>, offered: boolean) {
  return {
    type: BUDGET_STOP_PART_TYPE,
    data: { v: 1 as const, continuable: offered && budgetStopsSoFar(messages) < MAX_BUDGET_CONTINUATIONS },
  };
}

/** Fingerprints (tool + normalized arguments) of the calls of the stopped turn that a continuation must not run again. */
export function blockedCallFingerprints(
  calls: ReadonlyArray<TurnToolCall>,
  isReadOnly: (toolName: string) => boolean,
): Set<string> {
  const blocked = new Set<string>();
  for (const call of calls) {
    // A refused approval did not run; everything else may have (fail closed).
    if (call.state === 'declined' || isReadOnly(call.toolName)) continue;
    blocked.add(createCallFingerprint({ toolName: call.toolName, arguments: call.input ?? null }));
  }
  return blocked;
}

/** The tool result a blocked call gets instead of running. Its text is for the model and the activity log. */
export const REPEATED_WRITE_REFUSAL = Object.freeze({
  success: false,
  error: 'Not run again: this action was already attempted in this turn before it was stopped (same tool and arguments); '
    + 'it may have succeeded or failed. Do not retry it; tell the user it was already attempted and continue with the open steps.',
});

/**
 * The tools with the continuation guard: a call of a tool that is not
 * read-only whose fingerprint ran in the stopped turn is answered with
 * `REPEATED_WRITE_REFUSAL` and never reaches the tool, its approval or the
 * managed guard. Every other call runs as before.
 */
export function withBudgetContinuationGuard(
  tools: Record<string, unknown>,
  blocked: ReadonlySet<string>,
  isReadOnly: (toolName: string) => boolean,
  /** Called for each refused call (e.g. to count it as a tool error of the turn's budget). */
  onRefused?: (toolName: string, input: unknown) => void,
): Record<string, unknown> {
  if (blocked.size === 0) return tools;
  const guarded: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(tools)) {
    const tool = raw as { execute?: (...args: unknown[]) => unknown; needsApproval?: unknown };
    if (typeof tool?.execute !== 'function' || isReadOnly(name)) {
      guarded[name] = raw;
      continue;
    }
    const isBlocked = (input: unknown) => {
      try {
        return blocked.has(createCallFingerprint({ toolName: name, arguments: input ?? null }));
      } catch {
        // Arguments that cannot be fingerprinted are refused (fail closed).
        return true;
      }
    };
    const execute = tool.execute;
    const needsApproval = tool.needsApproval;
    guarded[name] = {
      ...tool,
      // A refused call asks for no approval: it would never run.
      ...(needsApproval !== undefined
        ? {
            needsApproval: async (input: unknown, ...rest: unknown[]) => {
              if (isBlocked(input)) return false;
              return typeof needsApproval === 'function' ? needsApproval(input, ...rest) : needsApproval;
            },
          }
        : {}),
      execute: async (input: unknown, ...rest: unknown[]) => {
        if (!isBlocked(input)) return execute(input, ...rest);
        onRefused?.(name, input);
        return { ...REPEATED_WRITE_REFUSAL };
      },
    };
  }
  return guarded;
}

/** The instruction for the continued run (a user-role model message of this request only, never part of the chat). */
export function budgetContinuationInstruction(calls: ReadonlyArray<TurnToolCall>, hiddenNames: ReadonlySet<string>): string {
  const ran = calls.filter((call) => call.state !== 'declined' && !hiddenNames.has(call.toolName));
  const counts = new Map<string, number>();
  for (const call of ran) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
  const listed = [...counts].map(([name, count]) => (count > 1 ? `${name} (${count}x)` : name)).join(', ');
  return [
    'The user asked you to continue the request above, which was stopped at a limit before it was finished.',
    listed
      ? `These tool calls were already attempted in this turn (each may have succeeded or failed): ${listed}. Their results are above.`
      : '',
    'Do only the steps that are still open, then answer the original request completely.',
    'Do not call a tool again with the same arguments; never retry an action that changes data, tell the user it was already attempted instead.',
  ].filter(Boolean).join(' ');
}

/** The latest plan of the turn (`update_plan` input), or null without one. */
export function latestPlanOf(calls: ReadonlyArray<TurnToolCall>): PlanItem[] | null {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index]!.toolName !== PLAN_TOOL_NAME) continue;
    const items = readPlanItems(calls[index]!.input);
    if (items) return items;
  }
  return null;
}

/** Texts of the summary lines; `{items}` is a comma-separated list. */
export interface BudgetStopSummaryTexts {
  done: string;
  open: string;
  openUnanswered: string;
  continueHint: string;
  continueTypedHint: string;
}

const MAX_LISTED = 8;

function list(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED);
  return items.length > MAX_LISTED ? `${shown.join(', ')}, …` : shown.join(', ');
}

/**
 * The paragraphs after the closing notice: what was done (the labels of the
 * successful app tool calls of the turn, each once), what is open (the
 * unchecked plan items, else that the question is not answered yet) and how
 * to continue.
 */
export function budgetStopSummary(options: {
  calls: ReadonlyArray<TurnToolCall>;
  labelOf: (toolName: string) => string;
  hiddenNames: ReadonlySet<string>;
  texts: BudgetStopSummaryTexts;
  continuable: boolean;
}): string {
  const { calls, labelOf, hiddenNames, texts } = options;
  const done: string[] = [];
  for (const call of calls) {
    if (call.state !== 'done' || hiddenNames.has(call.toolName)) continue;
    const label = labelOf(call.toolName);
    if (!done.includes(label)) done.push(label);
  }
  const plan = latestPlanOf(calls);
  const open = (plan ?? []).filter((item) => item.status !== 'completed').map((item) => item.title);
  return [
    done.length > 0 ? texts.done.split('{items}').join(list(done)) : '',
    open.length > 0 ? texts.open.split('{items}').join(list(open)) : texts.openUnanswered,
    options.continuable ? texts.continueHint : texts.continueTypedHint,
  ].filter(Boolean).join('\n\n');
}
