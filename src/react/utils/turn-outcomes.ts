import type { ChatMessage, TurnOutcome, TurnOutcomeReason } from '../types.js';

/**
 * Key of the turn outcome in a stored user message's `metadata`. Written only
 * into what `session.save` receives and removed again on load: the transport
 * and the requests never carry it.
 */
export const TURN_OUTCOME_METADATA_KEY = 'glirastesTurnOutcome';

const STATUSES = new Set<TurnOutcome['status']>(['completed', 'aborted', 'error', 'safety-stop']);
const REASONS = new Set<TurnOutcomeReason>(['finished', 'stopped', 'send-now', 'request-failed', 'pipeline']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOutcome(value: unknown, userMessageId: string): TurnOutcome | null {
  if (!isRecord(value)) return null;
  const status = value.status as TurnOutcome['status'];
  const reason = value.reason as TurnOutcomeReason;
  if (!STATUSES.has(status) || !REASONS.has(reason)) return null;
  return { userMessageId, status, reason, at: typeof value.at === 'string' ? value.at : '' };
}

/**
 * Splits a stored history into the messages without the outcome key and the
 * outcomes keyed by the user message that started each turn. A history
 * without outcomes comes back as the same array.
 */
export function readStoredTurnOutcomes<T extends { id?: unknown; role?: unknown }>(
  messages: T[],
): { messages: T[]; outcomes: Map<string, TurnOutcome> } {
  const outcomes = new Map<string, TurnOutcome>();
  let changed = false;
  const stripped = messages.map((message) => {
    const metadata = (message as { metadata?: unknown }).metadata;
    if (!isRecord(metadata) || !(TURN_OUTCOME_METADATA_KEY in metadata)) return message;
    changed = true;
    const { [TURN_OUTCOME_METADATA_KEY]: stored, ...rest } = metadata;
    if (message.role === 'user' && typeof message.id === 'string') {
      const outcome = readOutcome(stored, message.id);
      if (outcome) outcomes.set(message.id, outcome);
    }
    const next = { ...message } as T & { metadata?: unknown };
    if (Object.keys(rest).length > 0) next.metadata = rest;
    else delete next.metadata;
    return next as T;
  });
  return { messages: changed ? stripped : messages, outcomes };
}

/** The history to store: each user message with a recorded outcome carries it in `metadata`. */
export function withStoredTurnOutcomes(
  messages: ChatMessage[],
  outcomes: ReadonlyMap<string, TurnOutcome>,
): ChatMessage[] {
  if (outcomes.size === 0) return messages;
  return messages.map((message) => {
    const outcome = message.role === 'user' ? outcomes.get(message.id) : undefined;
    if (!outcome) return message;
    const metadata = (message as { metadata?: unknown }).metadata;
    const { userMessageId: _id, ...stored } = outcome;
    return {
      ...message,
      metadata: { ...(isRecord(metadata) ? metadata : {}), [TURN_OUTCOME_METADATA_KEY]: stored },
    } as ChatMessage;
  });
}

/** Id of the user message that started the turn `messageId` belongs to (a user message is its own turn). */
export function turnStartId(
  messages: ReadonlyArray<Pick<ChatMessage, 'id' | 'role'>>,
  messageId: string,
): string | null {
  const index = messages.findIndex((message) => message.id === messageId);
  for (let i = index; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') return messages[i]!.id;
  }
  return null;
}

/** Id of the latest user message: the turn a running or just ended request belongs to. */
export function latestUserMessageId(messages: ReadonlyArray<Pick<ChatMessage, 'id' | 'role'>>): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') return messages[i]!.id;
  }
  return null;
}
