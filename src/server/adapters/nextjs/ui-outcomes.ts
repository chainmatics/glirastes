/**
 * Outcome protocol of UI actions on the server (protocol version 1).
 *
 * A UI tool only hands its action to the browser. When the client says it
 * reports what became of it (`glirastesUiOutcomes: 1` in the body), the
 * built-in stream handler marks such a result with `awaitsOutcome` and ends
 * the request after that step; the browser writes `outcome: { v: 1, code }`
 * into the result and sends the history again. In that next request every
 * marked result is replaced completely by a fixed text per code, so nothing
 * the client wrote reaches the model through this channel.
 */
import {
  MAX_UI_OUTCOME_CONTINUATIONS,
  UI_OUTCOMES_REQUEST_FIELD,
  uiOutcomeModelResult,
  isDeferredUiActionOutcome,
  UI_ACTION_DEFERRED_MODEL_TEXT,
} from '../../../contracts/ui-outcome.js';
import type { TurnContinuation } from '../../../contracts/events.js';

/**
 * `confirm`: the browser reports the outcome and the model answers after it
 * (a second request). `report-only`: the browser reports it for the next
 * turn, the model answers in the same request. `off`: nothing is reported.
 */
export type UiActionOutcomeMode = 'confirm' | 'report-only' | 'off';

/** A mode for every UI tool, or one per tool name. */
export type UiActionOutcomesOption = UiActionOutcomeMode | ((toolName: string) => UiActionOutcomeMode);

const MODES: ReadonlyArray<UiActionOutcomeMode> = ['confirm', 'report-only', 'off'];

/** Throws for a value that is neither a mode nor a function. */
export function assertUiActionOutcomesOption(value: unknown, where: string): asserts value is UiActionOutcomesOption | undefined {
  if (value === undefined || typeof value === 'function') return;
  if (typeof value === 'string' && (MODES as readonly string[]).includes(value)) return;
  throw new Error(`${where}: uiActionOutcomes must be 'confirm', 'report-only', 'off' or a function of the tool name`);
}

/** Whether the request body says the client reports outcomes (protocol version 1; anything else counts as missing). */
export function readUiOutcomesFlag(body: unknown): boolean {
  return typeof body === 'object' && body !== null
    && (body as Record<string, unknown>)[UI_OUTCOMES_REQUEST_FIELD] === 1;
}

/** The mode of one tool; a resolver that throws or answers something else turns the protocol off for it. */
export function uiOutcomeModeOf(option: UiActionOutcomesOption, toolName: string): UiActionOutcomeMode {
  if (typeof option !== 'function') return option;
  try {
    const mode = option(toolName);
    return (MODES as readonly unknown[]).includes(mode) ? mode : 'off';
  } catch {
    return 'off';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function actionsOf(output: Record<string, unknown>): unknown[] {
  const action = output.uiAction;
  if (action === undefined || action === null) return [];
  return Array.isArray(action) ? action : [action];
}

/**
 * Whether a tool result hands a UI action to the browser that takes part in
 * the protocol: a successful (`handedOff` or `success: true`) record with a
 * Glirastes action (`glirastes.*`), or with any action for a tool that opted
 * in (`defineUiTool({ outcome: 'confirm' })`).
 */
export function handsOffUiAction(output: unknown, ownActions: boolean): boolean {
  if (!isRecord(output) || (output.handedOff !== true && output.success !== true)) return false;
  const actions = actionsOf(output).filter((action): action is Record<string, unknown> & { type: string } => (
    isRecord(action) && typeof action.type === 'string'
  ));
  if (actions.length === 0) return false;
  // The marker makes the browser run every action of the result through the
  // bus: without the opt-in only a result of Glirastes actions alone, so an
  // app's own action types stay with its `onToolResult`.
  return ownActions || actions.every((action) => action.type.startsWith('glirastes.'));
}

export interface UiOutcomePlan {
  /** Mode per tool name. */
  modeOf(toolName: string): UiActionOutcomeMode;
  /** The turn reached `MAX_UI_OUTCOME_CONTINUATIONS`: no marker, no stop. */
  capReached: boolean;
}

/**
 * The result with its marker: `awaitsOutcome: true` (confirm) or `false`
 * (report-only). Unchanged for a result that hands nothing off, for `off`,
 * and once the cap is reached. A tool that opted in keeps `false` at the cap,
 * so the browser still runs its own actions through the bus.
 */
export function markUiOutcome(output: unknown, toolName: string, ownActions: boolean, plan: UiOutcomePlan): unknown {
  if (!handsOffUiAction(output, ownActions)) return output;
  const mode = plan.modeOf(toolName);
  if (mode === 'off') return output;
  if (plan.capReached) return ownActions ? { ...(output as Record<string, unknown>), awaitsOutcome: false } : output;
  return { ...(output as Record<string, unknown>), awaitsOutcome: mode === 'confirm' };
}

/**
 * Sets the marker outermost: after the output schema, the output bound, the
 * size limit, the PII shield and the managed guard have shaped the result.
 * `source` are the tools the stream handler got (for the opt-in flag).
 */
export function withUiOutcomeMarkers(
  tools: Record<string, unknown>,
  source: Record<string, unknown>,
  plan: UiOutcomePlan,
): Record<string, unknown> {
  const marked: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(tools)) {
    const tool = raw as { execute?: (...args: unknown[]) => unknown };
    if (typeof tool?.execute !== 'function') {
      marked[name] = raw;
      continue;
    }
    const execute = tool.execute;
    const ownActions = (source[name] as { _uiOutcome?: unknown } | undefined)?._uiOutcome === 'confirm';
    marked[name] = {
      ...tool,
      execute: async (...args: unknown[]) => markUiOutcome(await execute(...args), name, ownActions, plan),
    };
  }
  return marked;
}

/** Whether a finished step handed a UI action off that the browser confirms before the model goes on. */
export function stepAwaitsUiOutcome(step: { toolResults?: ReadonlyArray<unknown> } | undefined): boolean {
  return (step?.toolResults ?? []).some((result) => {
    const output = (result as { output?: unknown } | null)?.output;
    return isRecord(output) && output.awaitsOutcome === true;
  });
}

function isToolPart(part: Record<string, unknown>): boolean {
  return typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool');
}

/** The UI messages after the last user message (the running turn). */
function currentTurn(messages: ReadonlyArray<unknown>): Array<{ role?: unknown; parts?: unknown }> {
  const list = messages as ReadonlyArray<{ role?: unknown; parts?: unknown }>;
  let index = list.length - 1;
  while (index >= 0 && list[index]?.role !== 'user') index -= 1;
  return list.slice(index + 1) as Array<{ role?: unknown; parts?: unknown }>;
}

/** The steps of a message: its parts split at every `step-start`. */
function stepsOf(message: { parts?: unknown }): Array<Array<Record<string, unknown>>> {
  const steps: Array<Array<Record<string, unknown>>> = [[]];
  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (!isRecord(part)) continue;
    if (part.type === 'step-start') steps.push([]);
    else steps.at(-1)!.push(part);
  }
  return steps;
}

function awaitsOutcome(part: Record<string, unknown>): boolean {
  return isToolPart(part) && isRecord(part.output) && part.output.awaitsOutcome === true;
}

/** Requests of the running turn that ended for a UI outcome (steps with `awaitsOutcome: true`). */
export function uiOutcomeStopsSoFar(messages: ReadonlyArray<unknown>): number {
  let stops = 0;
  for (const message of currentTurn(messages)) {
    if (message.role !== 'assistant') continue;
    for (const step of stepsOf(message)) if (step.some(awaitsOutcome)) stops += 1;
  }
  return stops;
}

/** Whether the running turn may still stop for a UI outcome. */
export function uiOutcomeCapReached(messages: ReadonlyArray<unknown>): boolean {
  return uiOutcomeStopsSoFar(messages) >= MAX_UI_OUTCOME_CONTINUATIONS;
}

/**
 * Why this request continues the turn, if it does: the history ends with an
 * assistant message whose last step has answered approvals (`approval`,
 * which wins) or results that waited for a UI outcome (`ui-outcome`).
 */
export function turnContinuationOf(messages: ReadonlyArray<unknown>): TurnContinuation | undefined {
  const last = messages.at(-1) as { role?: unknown; parts?: unknown } | undefined;
  if (!last || last.role !== 'assistant') return undefined;
  const step = stepsOf(last).at(-1) ?? [];
  if (step.some((part) => isToolPart(part) && part.state === 'approval-responded')) return 'approval';
  if (step.some(awaitsOutcome)) return 'ui-outcome';
  return undefined;
}

/**
 * Tool names the running turn already called or `find_tools` found (for a
 * continuation's start set). Only candidates: discovery keeps a name only
 * when it is eligible for this turn, as for `find_tools` itself.
 */
export function currentTurnToolNames(messages: ReadonlyArray<unknown>): string[] {
  const names = new Set<string>();
  for (const message of currentTurn(messages)) {
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || typeof part.type !== 'string') continue;
      if (part.type === 'dynamic-tool' && typeof part.toolName === 'string') names.add(part.toolName);
      else if (part.type.startsWith('tool-')) names.add(part.type.slice('tool-'.length));
      if (part.type === 'tool-find_tools' && isRecord(part.output) && Array.isArray(part.output.tools)) {
        for (const found of part.output.tools.slice(0, 50)) {
          if (isRecord(found) && typeof found.name === 'string') names.add(found.name);
        }
      }
    }
  }
  return [...names];
}

/** A tool result of the outcome protocol: marked by the server, or carrying a browser outcome next to its action. */
function isOutcomeResult(output: unknown): output is Record<string, unknown> {
  if (!isRecord(output)) return false;
  if (typeof output.awaitsOutcome === 'boolean') return true;
  return isRecord(output.outcome) && output.outcome.v !== undefined && 'uiAction' in output;
}

/**
 * The UI history with every result of the outcome protocol replaced by the
 * fixed text of its code (`ok`, a refusal, `unavailable`, `failed`,
 * `initiated`; anything else or no outcome: "not confirmed"). The code is
 * only a key into that table; the result's own fields (also a `message` or
 * extra fields the client added) never reach the model.
 */
export function withModelFacingUiOutcomes<T>(messages: ReadonlyArray<T>): T[] {
  return messages.map((message) => {
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;
    let changed = false;
    const next = parts.map((part) => {
      if (!isRecord(part) || !isToolPart(part) || part.state !== 'output-available' || !isOutcomeResult(part.output)) return part;
      changed = true;
      const output = isDeferredUiActionOutcome(part.output)
        ? { message: UI_ACTION_DEFERRED_MODEL_TEXT }
        : uiOutcomeModelResult(part.output.outcome);
      return { ...part, output };
    });
    return changed ? { ...message, parts: next } : message;
  });
}
