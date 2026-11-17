/**
 * Tool calls whose effect is unknown: the request may have reached the
 * backend and committed, but no answer says so (timeout, abort, a connection
 * lost after sending, an unreadable answer, a gateway error). Such a call is
 * neither a success nor a failure and must not be repeated blindly.
 *
 * The marker is a symbol, so a backend payload that happens to carry an
 * `outcome` field can never claim it.
 */
export const TOOL_OUTCOME_UNKNOWN = Symbol.for('glirastes.toolOutcomeUnknown');

/** HTTP answers of a gateway or proxy that say nothing about whether the backend acted. */
export const AMBIGUOUS_HTTP_STATUS: ReadonlySet<number> = new Set([408, 502, 504]);

/** Connection errors that can happen after the request was sent. */
const AMBIGUOUS_NETWORK_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Thrown when an answer arrived but could not be read (too large, broken stream). */
export class ResponseUnreadableError extends Error {
  constructor(message = 'Endpoint response could not be read') {
    super(message);
    this.name = 'ResponseUnreadableError';
  }
}

function codeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { code?: unknown }).code : undefined;
}

/** True when a thrown error leaves open whether the call took effect. */
export function errorLeavesOutcomeUnknown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'ResponseUnreadableError') return true;
  const code = codeOf(error) ?? codeOf((error as { cause?: unknown }).cause);
  return typeof code === 'string' && AMBIGUOUS_NETWORK_CODES.has(code);
}

/** Marks a tool result as "outcome unknown". */
export function markOutcomeUnknown<T extends object>(result: T): T {
  Object.defineProperty(result, TOOL_OUTCOME_UNKNOWN, { value: true });
  return result;
}

export function isOutcomeUnknown(result: unknown): boolean {
  return typeof result === 'object' && result !== null
    && (result as { [TOOL_OUTCOME_UNKNOWN]?: unknown })[TOOL_OUTCOME_UNKNOWN] === true;
}
