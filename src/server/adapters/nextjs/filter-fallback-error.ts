/**
 * The Vercel AI SDK emits a generic
 *   { type: 'error', errorText: 'No output generated. Check the stream for errors.' }
 * chunk whenever `streamText` finishes with no text output — including the
 * (very common) case where it already streamed a real error chunk earlier
 * in the same response (e.g. an upstream provider rejection).
 *
 * That double-error confuses chat UIs: the first message says "API key
 * invalid", the second says "no output, check the stream for errors", and
 * users have no way to tell they describe the same incident.
 *
 * This transform drops the fallback error iff a more specific error chunk
 * has already been forwarded in the same stream. The first error always
 * passes through unchanged.
 */
const FALLBACK_ERROR_TEXT = 'No output generated. Check the stream for errors.';

type ErrorChunk = { type: 'error'; errorText: string };

function isErrorChunk(chunk: unknown): chunk is ErrorChunk {
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    (chunk as { type?: unknown }).type === 'error' &&
    typeof (chunk as { errorText?: unknown }).errorText === 'string'
  );
}

export function filterFallbackError<T>(source: ReadableStream<T>): ReadableStream<T> {
  let seenError = false;
  return source.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        if (isErrorChunk(chunk)) {
          if (seenError && chunk.errorText === FALLBACK_ERROR_TEXT) {
            return; // drop the duplicate fallback
          }
          seenError = true;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export const __testing__ = { FALLBACK_ERROR_TEXT, isErrorChunk };
