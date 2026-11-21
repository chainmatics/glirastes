import type { ToolContext } from '../../types.js';

/** What a tool middleware sees of one tool call. Every guard has already passed. */
export interface ToolMiddlewareCall {
  /** Name the model calls the tool by. */
  readonly toolName: string;
  /** The tool's own id (`Tool.id`). */
  readonly toolId: string;
  /** The AI SDK tool call id; undefined for a direct command or a caller that passes none. */
  readonly toolCallId: string | undefined;
  /** The validated input as the tool receives it, as a structured clone: changing it changes nothing. */
  readonly input: unknown;
  /** HTTP method of an endpoint tool, upper case; undefined for UI and custom tools. */
  readonly method: string | undefined;
  /** True for GET/HEAD endpoint tools and method-less tools that need no approval. */
  readonly readOnly: boolean;
  /** The tool context the tool receives (locale, runtime, callEndpoint, abortSignal). */
  readonly context: Readonly<ToolContext>;
  /** Aborts with the request, the turn or the tool timeout. */
  readonly abortSignal: AbortSignal | undefined;
}

/** Runs the rest of the chain and, at its end, the tool. Takes no arguments, so the input cannot be replaced. Call it at most once. */
export type ToolMiddlewareNext = () => Promise<unknown>;

/** Onion model: the first array entry is outermost. Return `await next()` (or a mapped value), or a value of your own without calling `next`. */
export type ToolMiddleware = (
  call: ToolMiddlewareCall,
  next: ToolMiddlewareNext,
) => unknown | Promise<unknown>;

const TWICE = 'toolMiddleware called next() more than once';
const LATE = 'toolMiddleware called next() after the tool call ended';

/** Internal. Throws TypeError('toolMiddleware must be an array of functions') otherwise. */
export function assertToolMiddleware(
  value: unknown,
): asserts value is ReadonlyArray<ToolMiddleware> | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'function'))
    throw new TypeError('toolMiddleware must be an array of functions');
}

/**
 * Internal. Runs middleware[0..n) around run(); run() executes at most once.
 * A `next` is single-use and dead once its own middleware or the whole chain
 * has settled, so a late or repeated call never executes the tool.
 */
export function composeToolMiddleware(
  middleware: ReadonlyArray<ToolMiddleware>,
  call: ToolMiddlewareCall,
  run: () => Promise<unknown>,
): Promise<unknown> {
  let settled = false;
  const dispatch = (index: number): Promise<unknown> => {
    if (index === middleware.length) {
      try {
        return Promise.resolve(run());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const entry = middleware[index]!;
    let called = false;
    let done = false;
    const next: ToolMiddlewareNext = () => {
      if (settled || done) return Promise.reject(new Error(LATE));
      if (called) return Promise.reject(new Error(TWICE));
      called = true;
      return dispatch(index + 1);
    };
    let returned: unknown;
    try {
      returned = entry(call, next);
    } catch (error) {
      done = true;
      return Promise.reject(error);
    }
    const thenable =
      returned !== null &&
      (typeof returned === 'object' || typeof returned === 'function') &&
      typeof (returned as { then?: unknown }).then === 'function';
    if (!thenable) {
      done = true;
      return Promise.resolve(returned);
    }
    return Promise.resolve(returned).finally(() => {
      done = true;
    });
  };
  return dispatch(0).finally(() => {
    settled = true;
  });
}
