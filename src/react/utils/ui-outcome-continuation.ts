/**
 * When the chat sends the history again by itself: after answered approvals
 * and after the browser reported the outcome of every UI action that waits
 * for one (`awaitsOutcome: true`). Pure functions over AI SDK UI messages.
 */
import { CLARIFICATION_TOOL_NAME } from '../../contracts/clarification.js';
import { readUiOutcomeCode } from '../../contracts/ui-outcome.js';

/** How long after a page load started for a UI action the new page still continues the turn. */
export const UI_OUTCOME_RELOAD_CONTINUATION_MS = 60_000;

type Part = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolPart(part: Part): boolean {
  return typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool');
}

function toolNameOf(part: Part): string {
  return part.type === 'dynamic-tool' ? String(part.toolName ?? '') : String(part.type).slice('tool-'.length);
}

/** The parts of the last step of the last message, when it is the assistant's. */
function lastAssistantStep(messages: ReadonlyArray<unknown>): Part[] | undefined {
  const last = messages.at(-1) as { role?: unknown; parts?: unknown } | undefined;
  if (!last || last.role !== 'assistant' || !Array.isArray(last.parts)) return undefined;
  const parts = last.parts.filter(isRecord);
  const start = parts.reduce((index, part, position) => (part.type === 'step-start' ? position : index), -1);
  return parts.slice(start + 1);
}

/** A result the server marked: the browser reports its outcome before the model goes on. */
export function awaitsUiOutcome(part: Part): boolean {
  return isToolPart(part) && isRecord(part.output) && part.output.awaitsOutcome === true;
}

const SETTLED = new Set(['output-available', 'output-error', 'output-denied', 'approval-responded']);

/**
 * Whether the chat sends the history again by itself, checked by the AI SDK
 * after every request and every written tool output: the last step of the
 * assistant has no open call and no clarification, every result that waits
 * for a UI outcome has one (and none started a page load, which continues
 * on the next page), and it either answered approvals (with `approvals`) or
 * reported outcomes. The AI SDK's own approval check would send before the
 * outcome of a UI action in the same step arrived.
 */
export function shouldContinueChat(
  { messages }: { messages: ReadonlyArray<unknown> },
  options: { approvals: boolean } = { approvals: true },
): boolean {
  const step = lastAssistantStep(messages);
  if (!step) return false;
  const tools = step.filter(isToolPart);
  const waiting = tools.filter(awaitsUiOutcome);
  for (const part of waiting) {
    const output = part.output as Record<string, unknown>;
    if (!isRecord(output.outcome)) return false;
    if (readUiOutcomeCode(output.outcome) === 'initiated') return false;
  }
  // A clarification waits for the user, also next to approvals (a step without UI outcomes keeps the AI SDK's rule).
  if (waiting.length > 0 && tools.some((part) => toolNameOf(part) === CLARIFICATION_TOOL_NAME)) return false;
  // Answered approvals: the AI SDK's own rule (`lastAssistantMessageIsCompleteWithApprovalResponses`).
  if (tools.some((part) => part.state === 'approval-responded')) {
    return options.approvals && tools.every((part) => (
      part.state === 'output-available' || part.state === 'output-error' || part.state === 'approval-responded'
    ));
  }
  if (waiting.length === 0) return false;
  if (tools.some((part) => toolNameOf(part) === CLARIFICATION_TOOL_NAME)) return false;
  return tools.every((part) => SETTLED.has(String(part.state)));
}

/**
 * Whether a history loaded on a new page continues its turn once: the last
 * step of the assistant waited for UI outcomes, every one of them has an
 * outcome (a code, or none for one the page load cut off), at least one
 * started the page load (`initiated`) at most
 * `UI_OUTCOME_RELOAD_CONTINUATION_MS` ago, and no text follows them. Nothing
 * runs again: the continuation is only a model call.
 */
export function continuesAfterPageLoad(messages: ReadonlyArray<unknown>, now: number): boolean {
  const step = lastAssistantStep(messages);
  if (!step) return false;
  const waiting = step.filter(awaitsUiOutcome);
  if (waiting.length === 0) return false;
  if (step.filter(isToolPart).some((part) => !SETTLED.has(String(part.state)) || toolNameOf(part) === CLARIFICATION_TOOL_NAME)) {
    return false;
  }
  // Every waiting result is settled; one the page load cut off is "not confirmed" (`{ v: 1 }`).
  if (waiting.some((part) => !isRecord((part.output as Record<string, unknown>).outcome))) return false;
  let started = false;
  // The page load may come from a report-only result of the same step.
  for (const part of step.filter((entry) => isToolPart(entry) && isRecord(entry.output) && typeof entry.output.awaitsOutcome === 'boolean')) {
    const outcome = (part.output as Record<string, unknown>).outcome;
    const code = readUiOutcomeCode(outcome);
    if (code === 'initiated') {
      const at = (outcome as { at?: unknown }).at;
      if (typeof at === 'number' && at <= now && now - at <= UI_OUTCOME_RELOAD_CONTINUATION_MS) started = true;
    }
  }
  const lastWaiting = step.lastIndexOf(waiting.at(-1)!);
  const textAfter = step.slice(lastWaiting + 1)
    .some((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '');
  return started && !textAfter;
}

/** The ids of the results a page-load continuation answers (for its once-only guard). */
export function waitingToolCallIds(messages: ReadonlyArray<unknown>): string[] {
  return (lastAssistantStep(messages) ?? [])
    .filter(awaitsUiOutcome)
    .map((part) => String(part.toolCallId ?? ''));
}
