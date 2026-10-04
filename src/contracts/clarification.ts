/**
 * Wire protocol between the built-in `ask_clarification` tool, the chat UI
 * and the server-side resume. Dependency-free so both the React bundle and
 * the server adapters can import it without pulling in Zod.
 */

export const CLARIFICATION_TOOL_NAME = 'ask_clarification' as const;

export const CLARIFICATION_TARGETS = ['person', 'object', 'time', 'scope', 'other'] as const;

export type ClarificationTarget = (typeof CLARIFICATION_TARGETS)[number];

/**
 * Option and answer limits shared by the server tool schema, the chat UI
 * reader and the answer marker, so client and server validation cannot drift.
 */
export const CLARIFICATION_MAX_OPTIONS = 6;
export const CLARIFICATION_MAX_QUESTION_LENGTH = 300;
export const CLARIFICATION_MAX_LABEL_LENGTH = 120;
export const CLARIFICATION_MAX_DESCRIPTION_LENGTH = 200;
export const CLARIFICATION_MAX_ANSWER_LENGTH = 1_000;
/** Non-global on purpose: safe to share and to call `.test()` on repeatedly. */
export const CLARIFICATION_OPTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ClarificationRequest {
  readonly question: string;
  readonly target: ClarificationTarget;
  readonly options: ReadonlyArray<ClarificationOption>;
  readonly allowFreeText: boolean;
}

export interface ClarificationAnswerReference {
  readonly toolCallId: string;
  readonly optionId?: string;
}

export interface ParsedClarificationAnswer {
  readonly reference: ClarificationAnswerReference;
  /** The user's visible answer, marker removed and trimmed. */
  readonly answer: string;
}

const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MARKER = /<!--glirastes:clarification (\{[^<>\n]{1,400}\})-->/;
const MARKERS = /<!--glirastes:clarification \{[^<>\n]{0,400}\}-->[ \t]*\n?/g;

/**
 * Text the chat UI sends to answer a clarification. The marker is invisible
 * in rendered bubbles and survives mention serialization (it is not a
 * `<!--context:...-->` block).
 */
export function formatClarificationAnswer(input: {
  toolCallId: string;
  answer: string;
  optionId?: string;
}): string {
  if (!TOOL_CALL_ID.test(input.toolCallId)) {
    throw new Error('Invalid clarification tool call id');
  }
  if (input.optionId !== undefined && !CLARIFICATION_OPTION_ID_PATTERN.test(input.optionId)) {
    throw new Error('Invalid clarification option id');
  }
  const answer = input.answer.trim().slice(0, CLARIFICATION_MAX_ANSWER_LENGTH);
  if (!answer) throw new Error('A clarification answer must not be empty');
  const reference: ClarificationAnswerReference = input.optionId === undefined
    ? { toolCallId: input.toolCallId }
    : { toolCallId: input.toolCallId, optionId: input.optionId };
  return `<!--glirastes:clarification ${JSON.stringify(reference)}-->\n${answer}`;
}

/** Parses the first clarification marker; anything malformed is ignored. */
export function parseClarificationAnswer(
  text: string,
): ParsedClarificationAnswer | undefined {
  const match = MARKER.exec(text);
  if (!match) return undefined;
  let record: Record<string, unknown>;
  try {
    // MARKER only captures a brace-delimited payload: this is an object or throws.
    record = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (Object.keys(record).some((key) => key !== 'toolCallId' && key !== 'optionId')) {
    return undefined;
  }
  if (typeof record.toolCallId !== 'string' || !TOOL_CALL_ID.test(record.toolCallId)) {
    return undefined;
  }
  if (
    record.optionId !== undefined
    && (typeof record.optionId !== 'string' || !CLARIFICATION_OPTION_ID_PATTERN.test(record.optionId))
  ) {
    return undefined;
  }
  const answer = stripClarificationMarkers(text).trim().slice(0, CLARIFICATION_MAX_ANSWER_LENGTH);
  if (!answer) return undefined;
  return {
    reference: typeof record.optionId === 'string'
      ? { toolCallId: record.toolCallId, optionId: record.optionId }
      : { toolCallId: record.toolCallId },
    answer,
  };
}

/** Removes every clarification marker for display or routing. */
export function stripClarificationMarkers(text: string): string {
  return text.replace(MARKERS, '');
}
