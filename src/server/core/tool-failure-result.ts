/**
 * Failure results of tools: the bounded error, retry information and, for a
 * failed backend call, its status and (cut) body. Shared by `toolToAiTool`
 * and `executeTool`.
 */
import { reduceFailureBody, type OutputBound } from './output-fields.js';

const MAX_TOOL_ERROR_MESSAGE_CHARS = 1_000;
const MAX_TOOL_ERROR_BODY_CHARS = 4_000;

/**
 * Marks a failure result `endpointToolToTool` built from a backend response.
 * A non-enumerable symbol key: a backend body (or a 2xx answer with
 * `success: false`) is JSON and cannot set it, so only such a result keeps
 * its status, body and classification through `boundedToolFailure`. It is a
 * registry symbol (`Symbol.for`) so the ESM and the CJS build of this module
 * share it: a tool built by one copy and wrapped by the other keeps its
 * fields instead of silently losing them.
 */
export const ENDPOINT_FAILURE = Symbol.for('glirastes.endpointFailure');

/**
 * The parsed body of the failed backend call, non-enumerable on the failure
 * result, so `boundedToolFailure` can reduce it under the bound of the tool
 * that shows it (before it is serialized and cut). Never serialized.
 */
export const ENDPOINT_FAILURE_DATA = Symbol.for('glirastes.endpointFailureData');

/** How far a cut may move back to end on a whole token. */
const MAX_TOOL_ERROR_BACKTRACK_CHARS = 256;
const TOOL_ERROR_TOKEN_DELIMITER = /[\s",:{}[\]]/;

/**
 * Cuts a failure text (the body, or the `error` message taken from it) to at
 * most `limit` characters. A configured PII shield reads the text after this
 * cut, and a value split by it (an email reduced to `max.mueller@exa`) no
 * longer matches a detector. So the cut moves back to the last whitespace or
 * JSON delimiter and drops the partial token. That keeps a single-token value
 * whole; a value written with spaces (a grouped IBAN, a phone number) can
 * still be split. A text without a delimiter in the last
 * `MAX_TOOL_ERROR_BACKTRACK_CHARS` characters is cut hard. The window is the
 * same for both limits: it is sized by the longest token worth keeping whole
 * (an email address has at most 254 characters), not by the limit.
 */
function cutToolErrorText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  // The cut already ends on a whole token.
  if (TOOL_ERROR_TOKEN_DELIMITER.test(text.charAt(limit))) return cut;
  const floor = Math.max(0, limit - MAX_TOOL_ERROR_BACKTRACK_CHARS);
  for (let index = cut.length - 1; index >= floor; index -= 1) {
    if (!TOOL_ERROR_TOKEN_DELIMITER.test(cut.charAt(index))) continue;
    // Never cut a text down to nothing but whitespace.
    return cut.slice(0, index).trim().length > 0 ? cut.slice(0, index) : cut;
  }
  return cut;
}

export function endpointFailureBody(data: unknown): { body?: unknown; bodyTruncated?: true } {
  if (data === undefined) return {};
  if (typeof data === 'string') {
    return data.length > MAX_TOOL_ERROR_BODY_CHARS
      ? { body: cutToolErrorText(data, MAX_TOOL_ERROR_BODY_CHARS), bodyTruncated: true }
      : { body: data };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return {};
  }
  if (serialized === undefined) return {};
  return serialized.length > MAX_TOOL_ERROR_BODY_CHARS
    ? { body: cutToolErrorText(serialized, MAX_TOOL_ERROR_BODY_CHARS), bodyTruncated: true }
    : { body: data };
}

/**
 * `status`, `body` and `bodyTruncated` of a failed backend call. Under a
 * bound the body is reduced first (`reduceFailureBody`); a withheld body is
 * replaced by `bodyWithheld` with a fixed note. Without a bound: as before.
 */
export function endpointFailureFields(data: unknown, bound: OutputBound | undefined): Record<string, unknown> {
  if (!bound) return endpointFailureBody(data);
  const reduced = reduceFailureBody(data, bound);
  return reduced.withheld !== undefined ? { bodyWithheld: reduced.withheld } : endpointFailureBody(reduced.data);
}

/**
 * The failure result the model and the browser get: the error (cut), retry
 * information and, for a failed backend call, its status and bounded body.
 * Under a tool's bound (`outputAllowedFields`, `outputDeniedFields`) the body
 * is reduced from the parsed backend body (`reduceFailureBody`); a body that
 * is no longer available unserialized (cut) is withheld.
 */
export function boundedToolFailure(
  result: Readonly<Record<string, unknown>>,
  bound?: OutputBound,
): Record<string, unknown> {
  const rawError = result.error;
  const cutError = typeof rawError === 'string'
    ? cutToolErrorText(rawError, MAX_TOOL_ERROR_MESSAGE_CHARS)
    : '';
  // Also when the cut leaves nothing but whitespace.
  const error = cutError.trim().length > 0 ? cutError : 'Tool execution failed.';

  const fromEndpoint = (result as { [ENDPOINT_FAILURE]?: unknown })[ENDPOINT_FAILURE] === true;
  let body: Record<string, unknown> = {
    ...(fromEndpoint && result.body !== undefined ? { body: result.body } : {}),
    ...(fromEndpoint && result.bodyTruncated === true ? { bodyTruncated: true } : {}),
    ...(fromEndpoint && typeof result.bodyWithheld === 'string' ? { bodyWithheld: result.bodyWithheld } : {}),
  };
  if (bound && fromEndpoint) {
    if (Object.prototype.hasOwnProperty.call(result, ENDPOINT_FAILURE_DATA)) {
      body = endpointFailureFields((result as { [ENDPOINT_FAILURE_DATA]?: unknown })[ENDPOINT_FAILURE_DATA], bound);
    } else if (body.body !== undefined) {
      // A cut body is a text and can no longer be checked.
      body = endpointFailureFields(body.bodyTruncated === true ? String(body.body) : body.body, bound);
    }
  }
  return {
    success: false,
    error,
    retryable: result.retryable === true,
    ...(fromEndpoint && Number.isInteger(result.status) ? { status: result.status } : {}),
    ...body,
    ...(fromEndpoint && result.expectedFailure === true ? { expectedFailure: true } : {}),
  };
}
