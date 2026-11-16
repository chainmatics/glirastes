/**
 * How an app classifies a failed backend call of an endpoint tool:
 * `'error'` counts as a tool error (the default), `'expected'` is a known
 * business outcome (e.g. a 403 for a user without the role, a 409 for a
 * duplicate) that neither counts toward `maxConsecutiveErrors` nor as a
 * tool error in the turn metrics.
 */
export type ToolFailureClassification = 'error' | 'expected';

/** A non-2xx response of the backend, as the classifier sees it. */
export interface ToolFailureInfo {
  /** The endpoint tool's `toolName`. */
  toolName: string;
  /** The HTTP status of the backend response. */
  status: number;
  /**
   * The full parsed response body: the parsed JSON value when the response
   * was JSON, otherwise its text, or undefined when it had none. Not the
   * truncated copy the model sees.
   */
  body: unknown;
}

/**
 * Synchronous; a throw or any return value other than `'expected'` counts
 * as `'error'`. Only called for real backend responses, never for thrown
 * errors (timeout, network, response size) or calls the endpoint caller
 * refused locally.
 */
export type ToolFailureClassifier = (failure: ToolFailureInfo) => ToolFailureClassification;

/**
 * The one rule every counting site (budget, turn metrics, direct commands)
 * uses for a tool result: `undefined` for a success, `'error'` for a result
 * with an `error` message or `success: false`, `'expected'` for a failure an
 * app classified as expected. Only `toolToAiTool` emits `expectedFailure`,
 * and only on a `success: false` result it built from a real backend
 * response; a backend body travels nested under `body` and cannot set it.
 */
export function toolResultFailure(result: unknown): ToolFailureClassification | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const record = result as { error?: unknown; success?: unknown; expectedFailure?: unknown };
  if (typeof record.error !== 'string' && record.success !== false) return undefined;
  return record.success === false && record.expectedFailure === true ? 'expected' : 'error';
}
