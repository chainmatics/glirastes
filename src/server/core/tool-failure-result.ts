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

/** At most this many path parameters are named in the not-found hint. */
const MAX_NOT_FOUND_PARAMS = 5;
const MAX_NOT_FOUND_PARAM_CHARS = 64;

/**
 * The hint a 404 of an endpoint tool carries when its route template has
 * path parameters (`/playlists/:id`): the record the call addressed was not
 * found. It names the parameters (route-template names the input schema also
 * shows), never a value, and holds in apps with lookup tools and in apps
 * whose users type keys (order numbers): look the value up when a list or
 * search tool can, otherwise tell the user. `undefined` without path
 * parameters: a 404 of `/playlists` says nothing about an id.
 */
export function notFoundHint(pathTemplate: string): string | undefined {
  const names = [...new Set([...pathTemplate.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!))];
  if (names.length === 0) return undefined;
  const shown = names.slice(0, MAX_NOT_FOUND_PARAMS)
    .map((name) => `"${name.slice(0, MAX_NOT_FOUND_PARAM_CHARS)}"`)
    .join(', ') + (names.length > MAX_NOT_FOUND_PARAMS ? ', …' : '');
  return `Not found: no record matches the path parameter${names.length > 1 ? 's' : ''} ${shown}. `
    + 'The value may not exist, or it may be the id of a different kind of record. '
    + 'If a list or search tool can find the record (for example by its name), look it up first, '
    + 'then call this tool again with the value it returns. '
    + 'Only if there is no such tool or the lookup finds nothing, tell the user it was not found; '
    + 'do not ask the user for an id before that.';
}

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
 * information and, for a failed backend call, its status, bounded body and,
 * for a 404 of a route with path parameters, the fixed `notFoundHint`.
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
    // Only the fixed not-found hint `endpointToolToTool` sets (a backend body travels under `body`).
    ...(fromEndpoint && result.status === 404 && typeof result.hint === 'string'
      ? { hint: cutToolErrorText(result.hint, MAX_TOOL_ERROR_MESSAGE_CHARS) }
      : {}),
    // `false` too: the app's classifier said `'error'` (the browser then shows it as failed, whatever the status).
    ...(fromEndpoint && typeof result.expectedFailure === 'boolean' ? { expectedFailure: result.expectedFailure } : {}),
  };
}
