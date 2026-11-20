import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { ModelFacingInputError } from '../../../runtime/ai-sdk/engine.js';
import { ToolExecutionDeniedError, toolDenialDisplayText } from '../../../runtime/tool-denial.js';
import { ToolInputValidationError } from '../../../runtime/tool-input-error.js';
import type { AiChatErrorInfo } from './types.js';
import { APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS, ApprovalSubjectRefusedError } from './approval-subject-lookup.js';

/** The chat's German texts, for a `de*` chat language. */
export const GENERIC_STREAM_ERROR_TEXT_DE = 'KI-Anfrage fehlgeschlagen';
export const INVALID_TOOL_INPUT_TEXT_DE = 'Der Assistent hat ungültige Eingaben für dieses Werkzeug gesendet; er wurde zur Korrektur aufgefordert.';

/** What the chat shows for any failure the SDK does not name itself. */
export const GENERIC_STREAM_ERROR_TEXT = 'AI request failed';
/** The chat's text for a model tool call whose arguments do not match the schema. */
export const INVALID_TOOL_INPUT_TEXT = 'The assistant sent invalid input for this tool; it was told what to correct.';
/** The fixed failure texts the chat shows, resolved for one turn language. */
export interface StreamErrorTexts {
  /** Any failure the SDK does not name itself. */
  streamError: string;
  /** A model tool call whose arguments do not match the schema. */
  invalidToolInput: string;
}

/** The built-in texts per language; the handler's `locales` adds or changes them. */
export const STREAM_ERROR_TEXTS: Readonly<{ en: StreamErrorTexts; de: StreamErrorTexts }> = Object.freeze({
  en: Object.freeze({ streamError: GENERIC_STREAM_ERROR_TEXT, invalidToolInput: INVALID_TOOL_INPUT_TEXT }),
  de: Object.freeze({ streamError: GENERIC_STREAM_ERROR_TEXT_DE, invalidToolInput: INVALID_TOOL_INPUT_TEXT_DE }),
});
const EN_STREAM_ERROR_TEXTS = STREAM_ERROR_TEXTS.en;

/**
 * What the model reads in a later request for a call the chat shows with
 * `INVALID_TOOL_INPUT_TEXT`. The browser keeps only the chat text as the
 * part's `errorText`, and `convertToModelMessages` hands it to the model as
 * the call's result; the chat text says the model "was told what to
 * correct", which a later turn no longer sees. Fixed and content-free.
 */
export const INVALID_TOOL_INPUT_HISTORY_TEXT = 'This call was not executed: its arguments did not match the tool\'s input schema. '
  + 'If it is still needed, correct the arguments and call the tool again; if a field expects an id or uuid and you only have a name, '
  + 'first find the id with a list or search tool. Do not ask the user for an id.';

/**
 * What a later turn reads for a call the server refused before its approval
 * card (`ApprovalSubjectRefusedError`), by the chat text the browser kept.
 * Fixed and content-free; the same for a missing and an invisible record.
 */
const APPROVAL_SUBJECT_HISTORY_TEXTS: ReadonlyMap<string, string> = new Map([
  [APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS.approval_subject_not_found,
    'This call was not executed and no approval was asked: the record it names does not exist or the user cannot see it. '
    + 'Look the id up with a list or search tool; do not ask the user. Do not quote this text.'],
  [APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS.approval_subject_invalid_id,
    'This call was not executed and no approval was asked: the id it names is not valid. '
    + 'Look the id up with a list or search tool; do not ask the user. Do not quote this text.'],
  [APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS.approval_subject_unavailable,
    'This call was not executed and no approval was asked: the record it names could not be checked. '
    + 'Tell the user it could not be checked and that they can try again later. Do not quote this text.'],
]);

/**
 * The UI history with the chat text of an invalid tool call replaced by
 * `INVALID_TOOL_INPUT_HISTORY_TEXT`, so a later turn reads an instruction
 * instead of the chat's note. Only that exact text changes; nothing the model
 * wrote is added.
 */
export function withModelFacingToolErrors<T>(messages: ReadonlyArray<T>, invalidInputTexts: ReadonlyArray<string> = []): T[] {
  // The built-in texts of both languages plus the host's configured one.
  const invalidTexts = new Set([INVALID_TOOL_INPUT_TEXT, INVALID_TOOL_INPUT_TEXT_DE, ...invalidInputTexts]);
  return messages.map((message) => {
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;
    let changed = false;
    const next = parts.map((part) => {
      if (typeof part !== 'object' || part === null) return part;
      const record = part as Record<string, unknown>;
      if (record.state !== 'output-error') return part;
      const historyText = typeof record.errorText === 'string' && invalidTexts.has(record.errorText)
        ? INVALID_TOOL_INPUT_HISTORY_TEXT
        : typeof record.errorText === 'string' ? APPROVAL_SUBJECT_HISTORY_TEXTS.get(record.errorText) : undefined;
      if (historyText === undefined) return part;
      changed = true;
      return { ...record, errorText: historyText };
    });
    return changed ? { ...message, parts: next } : message;
  });
}

/** The chat's text for a call of a tool the model was not offered. */
export const UNAVAILABLE_TOOL_TEXT = 'This tool is not available in this chat.';

/**
 * The text the chat receives for an error in the UI message stream. Only the
 * SDK's own errors get their own fixed text: a denial of the managed turn
 * guard (see `toolDenialDisplayText`), invalid tool input and an unavailable
 * tool. Every other error keeps the generic text, because its message can
 * carry backend, provider or request content.
 */
export function streamErrorText(error: unknown, texts: StreamErrorTexts = EN_STREAM_ERROR_TEXTS): string {
  if (error instanceof ToolExecutionDeniedError) return toolDenialDisplayText(error);
  if (InvalidToolInputError.isInstance(error)) return texts.invalidToolInput;
  if (NoSuchToolError.isInstance(error)) return UNAVAILABLE_TOOL_TEXT;
  return texts.streamError;
}

export interface MaskedToolError {
  /** The chat's `errorText`. */
  text: string;
  /** What the app's `onError` gets, if anything: never a raw model-written argument. */
  report?: { error: unknown; info: AiChatErrorInfo };
}

/**
 * The UI stream's error mask for one turn. A failed tool call gets its chat
 * text and, when it is a failure the app should see, what `onError` gets.
 * Not reported: what the model gets back as a normal part of the turn (a
 * recoverable denial, a call of a tool it was not offered). The AI SDK
 * reports an invalid call twice, as the input error and as a tool error that
 * carries only that error's message as a string; the string gets the same
 * text and is not reported again.
 */
export function createToolStreamErrorMask(texts: StreamErrorTexts = EN_STREAM_ERROR_TEXTS): (error: unknown) => MaskedToolError {
  const invalidCallTexts = new Map<string, string>();
  return (error) => {
    if (typeof error === 'string') {
      return { text: invalidCallTexts.get(error) ?? texts.streamError };
    }
    if (error instanceof ToolExecutionDeniedError) {
      const text = toolDenialDisplayText(error);
      return error.recoverable ? { text } : { text, report: { error, info: { source: 'tool-call', kind: 'denied' } } };
    }
    // A record the call names does not exist, cannot be seen or checked: part of the turn, not reported.
    if (error instanceof ApprovalSubjectRefusedError) return { text: APPROVAL_SUBJECT_REFUSAL_DISPLAY_TEXTS[error.code] };
    if (NoSuchToolError.isInstance(error)) {
      invalidCallTexts.set(error.message, UNAVAILABLE_TOOL_TEXT);
      return { text: UNAVAILABLE_TOOL_TEXT };
    }
    if (InvalidToolInputError.isInstance(error)) {
      invalidCallTexts.set(error.message, texts.invalidToolInput);
      // The AI SDK error holds the model's arguments; the app gets fields and expectations only.
      const cause = error.cause instanceof ModelFacingInputError ? error.cause : undefined;
      return {
        text: texts.invalidToolInput,
        report: {
          error: new ToolInputValidationError(error.toolName, cause?.inputIssues ?? [], cause?.omittedIssues ?? 0),
          info: { source: 'tool-call', kind: 'invalid-input' },
        },
      };
    }
    return { text: texts.streamError, report: { error, info: { source: 'tool-call', kind: 'failed' } } };
  };
}
