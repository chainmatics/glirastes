import type { ChatMessage, TurnOutcome, TurnOutcomeReason } from '../types.js';

/**
 * Key of the turn outcome in a stored user message's `metadata`. Written only
 * into what `session.save` receives; the provider removes it from a history
 * from `session.load` and from one the app hands to the transport itself.
 */
export const TURN_OUTCOME_METADATA_KEY = 'glirastesTurnOutcome';

const STATUSES = new Set<TurnOutcome['status']>(['completed', 'aborted', 'error', 'safety-stop']);
const REASONS = new Set<TurnOutcomeReason>(['finished', 'stopped', 'send-now', 'request-failed', 'pipeline', 'chat-left']);

/**
 * Set in the stored outcome when the SDK created the `metadata` object for it
 * (the message had none): loading removes `metadata` again. Without it the
 * app's own object stays, also when nothing else is in it.
 */
const ADDED_METADATA_KEY = 'addedMetadata';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object literal (or `Object.create(null)`): the only metadata the outcome is written into. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    // The app's metadata comes back as it was; one the SDK added for the outcome goes again.
    if (isRecord(stored) && stored[ADDED_METADATA_KEY] === true && Object.keys(rest).length === 0) delete next.metadata;
    else next.metadata = rest;
    return next as T;
  });
  return { messages: changed ? stripped : messages, outcomes };
}

/**
 * The history to store: each user message with a recorded outcome carries it
 * in `metadata`, a copy of the app's object with the key added (the app's own
 * object is never changed). A user message whose `metadata` is set but is not
 * a plain object (an array, a string, a number, `null`, a class instance)
 * stays as it is: its turn outcome is not stored.
 */
export function withStoredTurnOutcomes(
  messages: ChatMessage[],
  outcomes: ReadonlyMap<string, TurnOutcome>,
): ChatMessage[] {
  if (outcomes.size === 0) return messages;
  return messages.map((message) => {
    const outcome = message.role === 'user' ? outcomes.get(message.id) : undefined;
    if (!outcome) return message;
    const metadata = (message as { metadata?: unknown }).metadata;
    const added = metadata === undefined;
    if (!added && !isPlainObject(metadata)) return message;
    const { userMessageId: _id, ...stored } = outcome;
    return {
      ...message,
      metadata: {
        ...(added ? {} : metadata),
        [TURN_OUTCOME_METADATA_KEY]: added ? { ...stored, [ADDED_METADATA_KEY]: true } : stored,
      },
    } as ChatMessage;
  });
}

// Per messages array (the context's `messages` is a new array per render): message id -> its turn's user message id.
const TURN_STARTS = new WeakMap<ReadonlyArray<Pick<ChatMessage, 'id' | 'role'>>, Map<string, string | null>>();

/**
 * Id of the user message that started the turn `messageId` belongs to (a user
 * message is its own turn). Built once per messages array and then looked up,
 * so every bubble of a render asking costs one pass over the history, not one each.
 */
export function turnStartId(
  messages: ReadonlyArray<Pick<ChatMessage, 'id' | 'role'>>,
  messageId: string,
): string | null {
  let starts = TURN_STARTS.get(messages);
  if (!starts) {
    starts = new Map();
    let current: string | null = null;
    for (const message of messages) {
      if (message.role === 'user') current = message.id;
      // The first message with an id wins, as a scan from the start would find it.
      if (!starts.has(message.id)) starts.set(message.id, current);
    }
    TURN_STARTS.set(messages, starts);
  }
  return starts.get(messageId) ?? null;
}

/** Id of the latest user message: the turn a running or just ended request belongs to. */
export function latestUserMessageId(messages: ReadonlyArray<Pick<ChatMessage, 'id' | 'role'>>): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') return messages[i]!.id;
  }
  return null;
}
