import { useEffect, useId, useRef } from 'react';
import { registerViewContext } from '../../browser/view-context.js';
import type { ViewContextEntry } from '../../contracts/view-context.js';

/** Content of an entry as an effect dependency: equal content, equal key; an entry without JSON form falls back to its identity. */
function contentKey(entry: ViewContextEntry | null | undefined): unknown {
  if (entry === null || entry === undefined) return null;
  try {
    return JSON.stringify(entry);
  } catch {
    return entry;
  }
}

/**
 * Tells the chat what the calling component shows while it is mounted, for
 * example on an order page `{ entity: { type: 'order', id: order.id }, label: order.number }`.
 * Sent with the next chat message the user sends (`registerViewContext` of
 * `glirastes/browser` underneath, one source per call). A new object with
 * the same content every render changes nothing; `null` or `undefined`
 * withdraws it, unmounting too. Works outside an `AiChatProvider`; on the
 * server it does nothing.
 */
export function useViewContext(entry: ViewContextEntry | null | undefined): void {
  const source = `glirastes.react:${useId()}`;
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const key = contentKey(entry);
  useEffect(() => {
    registerViewContext(source, entryRef.current ?? null);
  }, [source, key]);
  // Withdrawn on unmount only, so an update keeps its place among the sources.
  useEffect(() => () => {
    registerViewContext(source, null);
  }, [source]);
}
