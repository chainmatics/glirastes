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

/**
 * What loop detection fingerprints for a tool result. A `success: false`
 * result with a numeric `status` counts as an endpoint failure, and exactly
 * its stable fields are fingerprinted: `success`, `status`, `retryable` and
 * `expectedFailure`. The backend `body` (and `bodyTruncated`) and `error`
 * are left out, because `error` is taken from the body (its text, or its
 * `message`, `error` or `detail`) and many backends put a timestamp or a
 * trace id into every error body, which would make each repetition of the
 * same failing call look new. A failure without a numeric `status` (a
 * tool's own failure) keeps its `error` and its other fields. Any other
 * result is fingerprinted whole, except the random `id` of a result handle
 * (`_result.id` of an overview), so calling the same tool again with the
 * same result still looks like a repetition.
 */
export function toolResultForFingerprint(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  if ((result as { success?: unknown }).success !== false) return withoutResultHandleId(result as Record<string, unknown>);
  const {
    body: _body, bodyTruncated: _bodyTruncated, error, ...stable
  } = result as Record<string, unknown>;
  if (typeof stable.status === 'number') {
    return {
      success: false,
      status: stable.status,
      retryable: stable.retryable === true,
      expectedFailure: stable.expectedFailure === true,
    };
  }
  return error === undefined ? stable : { ...stable, error };
}

/** The form of a result handle id the SDK issues (`ro_`/`rw_` and 8 base36 characters). */
const RESULT_HANDLE_ID = /^r[ow]_[0-9a-z]{8}$/;

function withoutResultHandleId(result: Record<string, unknown>): Record<string, unknown> {
  const marker = result._result;
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return result;
  // Only a handle id this SDK issued; an app's own `_result.id` stays part of the fingerprint.
  if (typeof (marker as { id?: unknown }).id !== 'string' || !RESULT_HANDLE_ID.test((marker as { id: string }).id)) return result;
  const { id: _id, ...rest } = marker as Record<string, unknown>;
  return { ...result, _result: rest };
}
