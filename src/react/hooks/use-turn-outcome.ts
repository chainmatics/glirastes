import { useChatContext } from '../provider/chat-context.js';
import type { ChatMessage, TurnOutcome } from '../types.js';
import { turnStartId } from '../utils/turn-outcomes.js';

/**
 * The recorded outcome of the turn a message belongs to (stopped or failed),
 * else null: for a user message its own turn, for an assistant message the
 * turn of the user message before it. Also for a turn without an assistant
 * message, after later turns and, with a session store, after a reload.
 */
export function useTurnOutcome(message: Pick<ChatMessage, 'id' | 'role'>): TurnOutcome | null {
  const { turnOutcomes, messages } = useChatContext();
  if (!turnOutcomes || turnOutcomes.size === 0) return null;
  const id = turnStartId(messages ?? [message], message.id) ?? (message.role === 'user' ? message.id : null);
  return (id ? turnOutcomes.get(id) : undefined) ?? null;
}

/** Every recorded turn outcome, keyed by the id of the user message that started the turn. */
export function useTurnOutcomes(): ReadonlyMap<string, TurnOutcome> {
  return useChatContext().turnOutcomes ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, TurnOutcome> = new Map();
