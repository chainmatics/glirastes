import { describe, expect, it } from 'vitest';
import type { ChatMessage, TurnOutcome } from '../../types.js';
import { readStoredTurnOutcomes, TURN_OUTCOME_METADATA_KEY, withStoredTurnOutcomes } from '../turn-outcomes.js';

const outcome: TurnOutcome = { userMessageId: 'u1', status: 'aborted', reason: 'stopped', at: '2026-11-20T00:00:00.000Z' };
const outcomes = new Map([['u1', outcome]]);
const message = (metadata?: unknown) => ({
  id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q' }], ...(metadata === undefined ? {} : { metadata }),
}) as unknown as ChatMessage;
const roundTrip = (input: ChatMessage) => readStoredTurnOutcomes(withStoredTurnOutcomes([input], outcomes));

describe("an app's user-message metadata round-trips exactly through save and load", () => {
  it.each([
    ['an object with keys', { app: 'value', nested: { n: 1 } }],
    ['an empty object', {}],
  ])('%s: comes back equal and the outcome is stored', (_name, metadata) => {
    const input = message(metadata);
    const stored = withStoredTurnOutcomes([input], outcomes)[0] as { metadata?: Record<string, unknown> };
    expect(stored.metadata?.[TURN_OUTCOME_METADATA_KEY]).toEqual(expect.objectContaining({ status: 'aborted' }));
    const loaded = roundTrip(input);
    expect((loaded.messages[0] as { metadata?: unknown }).metadata).toEqual(metadata);
    expect(loaded.outcomes.get('u1')).toEqual(outcome);
  });

  it('no metadata: none comes back, the outcome is stored', () => {
    const loaded = roundTrip(message());
    expect('metadata' in loaded.messages[0]!).toBe(false);
    expect(loaded.outcomes.get('u1')).toEqual(outcome);
  });

  it.each([
    ['an array', ['app', 'tags']],
    ['a string', 'tag'],
    ['a number', 7],
    ['null', null],
    ['a class instance', new Date(0)],
  ])('%s: the message is stored unchanged, without its outcome', (_name, metadata) => {
    const input = message(metadata);
    const [stored] = withStoredTurnOutcomes([input], outcomes);
    expect(stored).toBe(input);
    const loaded = roundTrip(input);
    expect((loaded.messages[0] as { metadata?: unknown }).metadata).toEqual(metadata);
    expect(loaded.outcomes.size).toBe(0);
  });

  it("never changes the app's objects", () => {
    const metadata = { app: 'value' };
    const input = message(metadata);
    const snapshot = structuredClone(input);
    const stored = withStoredTurnOutcomes([input], outcomes);
    readStoredTurnOutcomes(stored);
    expect(input).toEqual(snapshot);
    expect(metadata).toEqual({ app: 'value' });
    expect((stored[0] as { metadata?: unknown }).metadata).not.toBe(metadata);
  });
});
