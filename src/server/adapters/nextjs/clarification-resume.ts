import {
  CLARIFICATION_TOOL_NAME,
  parseClarificationAnswer,
  stripClarificationMarkers,
} from '../../../contracts/clarification.js';

/**
 * A clarification answer joined with the request it completes. The original
 * request stays in the client session; this only shapes routing input and
 * the model-facing copy of the latest user message.
 */
export interface ClarificationResume {
  readonly originalRequest: string;
  readonly question: string;
  readonly answer: string;
  readonly optionId?: string;
  /** Input for intent routing: no extra planner model call is needed. */
  readonly routingText: string;
  /** Replaces the latest user text for the model only. */
  readonly modelText: string;
  /** Index of the latest user message in the request's message array. */
  readonly answerMessageIndex: number;
}

const MAX_CHAIN_DEPTH = 3;
const MAX_ORIGINAL_LENGTH = 2_000;

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === 'object' && value !== null;
}

function messageText(message: MessageRecord): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .filter((part): part is MessageRecord =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

function clarificationQuestion(
  message: MessageRecord,
  toolCallId: string,
): string | undefined {
  if (message.role !== 'assistant' || !Array.isArray(message.parts)) return undefined;
  for (const part of message.parts) {
    if (!isRecord(part) || part.toolCallId !== toolCallId) continue;
    const isClarification = part.type === `tool-${CLARIFICATION_TOOL_NAME}`
      || (part.type === 'dynamic-tool' && part.toolName === CLARIFICATION_TOOL_NAME);
    if (!isClarification || !isRecord(part.input)) continue;
    const question = part.input.question;
    if (typeof question === 'string' && question.trim()) return question.trim();
  }
  return undefined;
}

function resolveAt(
  messages: ReadonlyArray<unknown>,
  userIndex: number,
  depth: number,
): ClarificationResume | undefined {
  const latest = messages[userIndex];
  if (!isRecord(latest) || latest.role !== 'user') return undefined;
  const parsed = parseClarificationAnswer(messageText(latest));
  if (!parsed) return undefined;

  let assistantIndex = -1;
  let question: string | undefined;
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isRecord(candidate)) continue;
    question = clarificationQuestion(candidate, parsed.reference.toolCallId);
    if (question) {
      assistantIndex = index;
      break;
    }
  }
  if (!question || assistantIndex < 0) return undefined;

  let originalIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isRecord(candidate) && candidate.role === 'user') {
      originalIndex = index;
      break;
    }
  }
  if (originalIndex < 0) return undefined;

  const earlier = depth < MAX_CHAIN_DEPTH
    ? resolveAt(messages, originalIndex, depth + 1)
    : undefined;
  const originalRequest = (earlier?.routingText
    ?? stripClarificationMarkers(messageText(messages[originalIndex] as MessageRecord)).trim())
    .slice(0, MAX_ORIGINAL_LENGTH);
  if (!originalRequest) return undefined;

  return {
    originalRequest,
    question,
    answer: parsed.answer,
    ...(parsed.reference.optionId ? { optionId: parsed.reference.optionId } : {}),
    routingText: `${originalRequest}\n${question} ${parsed.answer}`,
    modelText: [
      `Original request: ${originalRequest}`,
      `Clarification question: ${question}`,
      `Answer: ${parsed.answer}`,
      'Continue the original request with this answer.',
    ].join('\n'),
    answerMessageIndex: userIndex,
  };
}

/** Resolves the latest user message as a clarification answer, if it is one. */
export function resolveClarificationResume(
  messages: ReadonlyArray<unknown>,
): ClarificationResume | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isRecord(candidate) && candidate.role === 'user') {
      return resolveAt(messages, index, 1);
    }
  }
  return undefined;
}

/** Returns a copy whose latest user message carries the model-facing resume text. */
export function applyClarificationResume(
  messages: ReadonlyArray<unknown>,
  resume: ClarificationResume,
): unknown[] {
  return messages.map((message, index) => {
    if (index !== resume.answerMessageIndex || !isRecord(message)) return message;
    if (Array.isArray(message.parts)) {
      const others = message.parts.filter((part) =>
        !(isRecord(part) && part.type === 'text'));
      return { ...message, parts: [{ type: 'text', text: resume.modelText }, ...others] };
    }
    return { ...message, content: resume.modelText };
  });
}
