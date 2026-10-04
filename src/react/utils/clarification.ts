import {
  CLARIFICATION_MAX_DESCRIPTION_LENGTH,
  CLARIFICATION_MAX_LABEL_LENGTH,
  CLARIFICATION_MAX_OPTIONS,
  CLARIFICATION_MAX_QUESTION_LENGTH,
  CLARIFICATION_OPTION_ID_PATTERN,
  CLARIFICATION_TARGETS,
  CLARIFICATION_TOOL_NAME,
  parseClarificationAnswer,
  type ClarificationOption,
  type ClarificationRequest,
  type ClarificationTarget,
} from '../../contracts/clarification.js';

export interface ClarificationPart {
  readonly toolCallId: string;
  readonly request: ClarificationRequest;
  /** True once the tool output exists; only then can the user answer. */
  readonly ready: boolean;
}

const TARGETS: ReadonlySet<string> = new Set<string>(CLARIFICATION_TARGETS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOptions(value: unknown): ClarificationOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: ClarificationOption[] = [];
  for (const candidate of value.slice(0, CLARIFICATION_MAX_OPTIONS)) {
    if (!isRecord(candidate)) continue;
    const { id, label, description } = candidate;
    if (typeof id !== 'string' || !CLARIFICATION_OPTION_ID_PATTERN.test(id)) continue;
    if (typeof label !== 'string' || !label.trim() || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: label.trim().slice(0, CLARIFICATION_MAX_LABEL_LENGTH),
      ...(typeof description === 'string' && description.trim()
        ? { description: description.trim().slice(0, CLARIFICATION_MAX_DESCRIPTION_LENGTH) }
        : {}),
    });
  }
  return options;
}

function readRequest(value: unknown): ClarificationRequest | undefined {
  if (!isRecord(value) || typeof value.question !== 'string' || !value.question.trim()) {
    return undefined;
  }
  const options = readOptions(value.options);
  const allowFreeText = value.allowFreeText !== false || options.length === 0;
  const target = typeof value.target === 'string' && TARGETS.has(value.target)
    ? value.target as ClarificationTarget
    : 'other';
  return {
    question: value.question.trim().slice(0, CLARIFICATION_MAX_QUESTION_LENGTH),
    target,
    options,
    allowFreeText,
  };
}

/** Reads an `ask_clarification` tool part from AI SDK 5/6 UI messages. */
export function readClarificationPart(part: unknown): ClarificationPart | undefined {
  if (!isRecord(part) || typeof part.toolCallId !== 'string') return undefined;
  const isClarification = part.type === `tool-${CLARIFICATION_TOOL_NAME}`
    || (part.type === 'dynamic-tool' && part.toolName === CLARIFICATION_TOOL_NAME);
  if (!isClarification) return undefined;
  const fromOutput = isRecord(part.output) ? readRequest(part.output.clarification) : undefined;
  const request = fromOutput ?? readRequest(part.input);
  if (!request) return undefined;
  return {
    toolCallId: part.toolCallId,
    request,
    ready: part.state === 'output-available',
  };
}

/** The clarification the latest assistant message is waiting on, if any. */
export function findOpenClarification(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
): ClarificationPart | undefined {
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== 'assistant') return undefined;
  for (let index = latest.parts.length - 1; index >= 0; index -= 1) {
    const clarification = readClarificationPart(latest.parts[index]);
    if (clarification?.ready) return clarification;
  }
  return undefined;
}

/** True once a user message carries the answer marker for this clarification. */
export function isClarificationAnswered(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
  toolCallId: string,
): boolean {
  return messages.some((message) => (
    message.role === 'user'
    && message.parts.some((part) => (
      isRecord(part)
      && part.type === 'text'
      && typeof part.text === 'string'
      && parseClarificationAnswer(part.text)?.reference.toolCallId === toolCallId
    ))
  ));
}
