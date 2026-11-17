import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { ModelFacingInputError } from '../../../runtime/ai-sdk/engine.js';
import { ToolExecutionDeniedError, toolDenialDisplayText } from '../../../runtime/tool-denial.js';
import { ToolInputValidationError } from '../../../runtime/tool-input-error.js';
import type { AiChatErrorInfo } from './types.js';

/** What the chat shows for any failure the SDK does not name itself. */
export const GENERIC_STREAM_ERROR_TEXT = 'AI request failed';
/** The chat's text for a model tool call whose arguments do not match the schema. */
export const INVALID_TOOL_INPUT_TEXT = 'The assistant sent invalid input for this tool; it was told what to correct.';
/** The chat's text for a call of a tool the model was not offered. */
export const UNAVAILABLE_TOOL_TEXT = 'This tool is not available in this chat.';

/**
 * The text the chat receives for an error in the UI message stream. Only the
 * SDK's own errors get their own fixed text: a denial of the managed turn
 * guard (see `toolDenialDisplayText`), invalid tool input and an unavailable
 * tool. Every other error keeps the generic text, because its message can
 * carry backend, provider or request content.
 */
export function streamErrorText(error: unknown): string {
  if (error instanceof ToolExecutionDeniedError) return toolDenialDisplayText(error);
  if (InvalidToolInputError.isInstance(error)) return INVALID_TOOL_INPUT_TEXT;
  if (NoSuchToolError.isInstance(error)) return UNAVAILABLE_TOOL_TEXT;
  return GENERIC_STREAM_ERROR_TEXT;
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
export function createToolStreamErrorMask(): (error: unknown) => MaskedToolError {
  const invalidCallTexts = new Map<string, string>();
  return (error) => {
    if (typeof error === 'string') {
      return { text: invalidCallTexts.get(error) ?? GENERIC_STREAM_ERROR_TEXT };
    }
    if (error instanceof ToolExecutionDeniedError) {
      const text = toolDenialDisplayText(error);
      return error.recoverable ? { text } : { text, report: { error, info: { source: 'tool-call', kind: 'denied' } } };
    }
    if (NoSuchToolError.isInstance(error)) {
      invalidCallTexts.set(error.message, UNAVAILABLE_TOOL_TEXT);
      return { text: UNAVAILABLE_TOOL_TEXT };
    }
    if (InvalidToolInputError.isInstance(error)) {
      invalidCallTexts.set(error.message, INVALID_TOOL_INPUT_TEXT);
      // The AI SDK error holds the model's arguments; the app gets fields and expectations only.
      const cause = error.cause instanceof ModelFacingInputError ? error.cause : undefined;
      return {
        text: INVALID_TOOL_INPUT_TEXT,
        report: {
          error: new ToolInputValidationError(error.toolName, cause?.inputIssues ?? [], cause?.omittedIssues ?? 0),
          info: { source: 'tool-call', kind: 'invalid-input' },
        },
      };
    }
    return { text: GENERIC_STREAM_ERROR_TEXT, report: { error, info: { source: 'tool-call', kind: 'failed' } } };
  };
}
