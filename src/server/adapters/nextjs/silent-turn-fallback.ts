/**
 * A model can end a turn with nothing the chat shows: no text (or only
 * whitespace), reasoning only, no tool call. Without a guard the user sees an
 * empty bubble while the turn counts as completed.
 */
const FALLBACK_TEXT = {
  de: 'Darauf habe ich gerade keine Antwort erzeugt. Bitte formuliere die Anfrage noch einmal, gern etwas genauer.',
  en: 'I did not produce an answer to that. Please send the request again, ideally with a bit more detail.',
} as const;

export function silentTurnFallbackText(locale?: string): string {
  return locale?.toLowerCase().startsWith('de') ? FALLBACK_TEXT.de : FALLBACK_TEXT.en;
}

/** True when no step produced visible text or a tool call. */
export function isSilentTurn(steps: ReadonlyArray<{
  text: string;
  toolCalls: ReadonlyArray<unknown>;
}>): boolean {
  return steps.every((step) => step.text.trim() === '' && step.toolCalls.length === 0);
}

/** Inserts the fallback text before `finish` when the stream showed nothing. */
export function withSilentTurnFallback<T>(
  source: ReadableStream<T>,
  text: string,
): ReadableStream<T> {
  let visible = false;
  return source.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      const part = chunk as { type?: unknown; delta?: unknown };
      const type = typeof part.type === 'string' ? part.type : '';
      if (
        (type === 'text-delta' && typeof part.delta === 'string' && part.delta.trim() !== '')
        || type.startsWith('tool-')
        || type === 'error'
        || type === 'abort'
      ) {
        visible = true;
      }
      if (type === 'finish' && !visible) {
        const id = 'glirastes-silent-turn';
        controller.enqueue({ type: 'text-start', id } as T);
        controller.enqueue({ type: 'text-delta', id, delta: text } as T);
        controller.enqueue({ type: 'text-end', id } as T);
        visible = true;
      }
      controller.enqueue(chunk);
    },
  }));
}
