import { useEffect, useRef, useState } from 'react';
import {
  parseChatInteractions,
  type ChatInteractionsData,
} from '../../contracts/chat-interactions.js';

export interface UseChatInteractionsDataOptions {
  headers?: Record<string, string>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** A failed request or invalid data; the chat then runs without interactions. */
  onError?: (error: unknown) => void;
}

/** The loads of `useChatInteractionsData` that have not answered yet, in this page. */
const pendingLoads = new Set<object>();
const pendingListeners = new Set<() => void>();

function setPending(token: object, pending: boolean): void {
  if (pending === pendingLoads.has(token)) return;
  if (pending) pendingLoads.add(token);
  else pendingLoads.delete(token);
  for (const listener of pendingListeners) listener();
}

/**
 * Internal: whether a `useChatInteractionsData` load is still waiting for its
 * answer (not after a failure, not with the endpoint off). The default of
 * `ChatInteractionsConfig.loading` derives from it.
 */
export function hasPendingChatInteractionsLoad(): boolean {
  return pendingLoads.size > 0;
}

/** Internal: called when a load starts or ends. */
export function subscribeChatInteractionsLoads(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

/**
 * Loads the chat's `@` entities and `/` commands from the GET handler of
 * `createChatInteractionsHandler` (usually the chat endpoint itself), once
 * per endpoint and with the user's session. `undefined` until loaded or when
 * the request fails.
 */
export function useChatInteractionsData(
  endpoint: string | undefined,
  options: UseChatInteractionsDataOptions = {},
): ChatInteractionsData | undefined {
  const [data, setData] = useState<ChatInteractionsData | undefined>(undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!endpoint) return undefined;
    const controller = new AbortController();
    const token = {};
    setPending(token, true);
    const { fetch: fetcher = globalThis.fetch, headers } = optionsRef.current;
    void (async () => {
      try {
        const response = await fetcher(endpoint, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json', ...headers },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Chat interactions request failed (${response.status})`);
        const parsed = parseChatInteractions(await response.json());
        if (!controller.signal.aborted) setData(parsed);
      } catch (error) {
        if (!controller.signal.aborted) optionsRef.current.onError?.(error);
      } finally {
        setPending(token, false);
      }
    })();
    return () => {
      controller.abort();
      setPending(token, false);
    };
  }, [endpoint]);

  return data;
}
