import { useEffect, useRef, useState } from 'react';
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

let instances = 0;

/**
 * A source name of its own per hook instance: unique across React roots and
 * copies of the SDK on one page (a counter plus a random part), unlike
 * `useId`, which is unique per root only.
 */
function newSource(): string {
  instances += 1;
  return `glirastes.react:${instances}:${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Tells the chat what the calling component shows while it is mounted, for
 * example on an order page `{ entity: { type: 'order', id: order.id }, label: order.number }`.
 * Sent with the next new chat message the user sends (`registerViewContext`
 * of `glirastes/browser` underneath, one source per call). A new object with
 * the same content every render changes nothing (the entry is compared as
 * JSON on every render: keep `facts` small); `null` or `undefined`
 * withdraws it, unmounting too. Works outside an `AiChatProvider`; on the
 * server it does nothing.
 */
export function useViewContext(entry: ViewContextEntry | null | undefined): void {
  const [source] = useState(newSource);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const unregisterRef = useRef<() => void>(() => {});
  const key = contentKey(entry);
  useEffect(() => {
    unregisterRef.current = registerViewContext(source, entryRef.current ?? null);
  }, [source, key]);
  // Withdrawn on unmount only, so an update keeps its place among the sources.
  useEffect(() => () => {
    unregisterRef.current();
    unregisterRef.current = () => {};
  }, [source]);
}
