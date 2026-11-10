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
      }
    })();
    return () => controller.abort();
  }, [endpoint]);

  return data;
}
