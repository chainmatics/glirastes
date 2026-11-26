/**
 * Continuing a turn the chat handler stopped at a limit (protocol version 1).
 * Dependency-free so the React bundle and the server adapters share it.
 *
 * When the built-in stream handler closes a turn with its stop notice it
 * writes a `data-budget-stop` part (`{ v: 1, continuable }`) right before the
 * notice text. A "Continue" click sends the history again without a new user
 * message and with `glirastesContinuation: 'budget'` in the body. The server
 * accepts that only when the history ends with such a part and nothing after
 * it; the continued run gets a fresh budget, an instruction that lists what
 * already ran, and never runs a write call of the stopped turn again.
 * Everything here stays between the browser and the app's server.
 */

/** Data part type of a budget stop (UI message stream, kept in the message). */
export const BUDGET_STOP_PART_TYPE = 'data-budget-stop' as const;

/** Request body field that asks to continue a stopped turn. */
export const CONTINUATION_REQUEST_FIELD = 'glirastesContinuation' as const;

/** The value of `glirastesContinuation` for a turn stopped at a limit. */
export const BUDGET_CONTINUATION = 'budget' as const;

/**
 * Most continuations of one turn after budget stops. The stop after the last
 * one is no longer offered as continuable.
 */
export const MAX_BUDGET_CONTINUATIONS = 3;

export const DEFAULT_CONTINUE_HINTS = {
  en: 'Use the button below to go on with the open steps.',
  de: 'Nutze den Button unten, um mit den offenen Schritten fortzufahren.',
} as const;

export interface BudgetStopPartData {
  v: 1;
  /** Whether the chat may offer "Continue" for this stop. */
  continuable: boolean;
  /** Exact suffix of the stop notice, if supplied by the emitting handler. */
  continueHint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The data of a `data-budget-stop` part, or undefined for any other part or an unknown version. */
export function readBudgetStopPart(part: unknown): BudgetStopPartData | undefined {
  if (!isRecord(part) || part.type !== BUDGET_STOP_PART_TYPE || !isRecord(part.data)) return undefined;
  if (part.data.v !== 1 || typeof part.data.continuable !== 'boolean') return undefined;
  return {
    v: 1,
    continuable: part.data.continuable,
    ...(typeof part.data.continueHint === 'string' && { continueHint: part.data.continueHint }),
  };
}

/** Parts that are content of an answer: after a stop they mean the turn went on. */
function isContentPart(part: unknown): boolean {
  if (!isRecord(part) || typeof part.type !== 'string') return false;
  const type = part.type;
  return type === 'text' || type === 'step-start' || type === 'reasoning' || type === 'file'
    || type === 'dynamic-tool' || (type.startsWith('tool-'));
}

/**
 * Whether a message ends with a continuable budget stop: its last
 * `data-budget-stop` part says `continuable: true` and no content (text other
 * than the stop notice itself, a tool call, a new step) follows it. The stop
 * notice is the one text part right after the stop part.
 */
export function endsWithContinuableBudgetStop(message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.parts)) return false;
  const parts = message.parts as unknown[];
  let index = parts.length - 1;
  while (index >= 0 && !readBudgetStopPart(parts[index])) index -= 1;
  if (index < 0 || !readBudgetStopPart(parts[index])!.continuable) return false;
  const after = parts.slice(index + 1).filter(isContentPart);
  // The notice text belongs to the stop.
  return after.length === 0 || (after.length === 1 && (after[0] as Record<string, unknown>).type === 'text');
}
