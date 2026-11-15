import { describe, expect, it } from 'vitest';
import { sanitizeStoredMessages } from '../sanitize-stored-messages.js';
const pending = { type: 'tool-update', toolCallId: 'call-1', input: { id: '1' }, state: 'approval-responded', approval: { id: 'signed', approved: true } };
const done = { ...pending, state: 'output-available', output: { success: true } };
const assistant = (id: string, parts: unknown[]) => ({ id, role: 'assistant', parts });
describe('recovery of legacy approval continuations', () => {
  it('keeps one completed call and all text without mutating stored data', () => {
    const old = [assistant('a', [pending, { type: 'text', text: 'Please confirm' }]), assistant('b', [done])];
    const fixed = sanitizeStoredMessages(old) as typeof old;
    expect(fixed[0]!.parts).toEqual([{ type: 'text', text: 'Please confirm' }]);
    expect(fixed[1]!.parts).toEqual([done]);
    expect(old[0]!.parts).toHaveLength(2);
    expect(sanitizeStoredMessages(fixed)).toEqual(fixed);
  });
  it('deduplicates the completed read call copied alongside an approval continuation', () => {
    const read = { type: 'tool-list', toolCallId: 'read-1', input: {}, state: 'output-available', output: { items: [] } };
    const fixed = sanitizeStoredMessages([assistant('a', [read, pending]), assistant('b', [read, done])]) as Array<{ parts: unknown[] }>;
    expect(fixed.flatMap(message => message.parts)).toEqual([read, done]);
  });
  it('does not repair conflicting inputs, approvals or results', () => {
    for (const changed of [{ ...done, input: { id: '2' } }, { ...done, approval: { id: 'other', approved: true } }]) {
      const messages = [assistant('a', [pending]), assistant('b', [changed])];
      expect(sanitizeStoredMessages(messages)).toEqual(messages);
    }
    const messages = [assistant('a', [done]), assistant('b', [{ ...done, output: { success: false } }])];
    expect(sanitizeStoredMessages(messages)).toEqual(messages);
  });
  it('never joins calls across a user turn', () => {
    const messages = [assistant('a', [pending]), { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Next' }] }, assistant('b', [done])];
    expect(sanitizeStoredMessages(messages)).toEqual(messages);
  });
});

it('migrates legacy generated browser results to unconfirmed without changing signed arguments or source', () => {
  const original = { ...done, output: { success: true, message: 'Action executed.', uiAction: { type: 'glirastes.action', actionId: 'highlight', payload: { id: 'wrong' } } } };
  const messages = [assistant('a', [original])];
  const fixed = sanitizeStoredMessages(messages) as typeof messages;
  expect(fixed[0]!.parts[0]).toMatchObject({ input: original.input, approval: original.approval, output: { requested: true, executionStatus: 'unconfirmed', success: true } });
  expect(original.output).not.toHaveProperty('executionStatus');
  expect(sanitizeStoredMessages(fixed)).toEqual(fixed);
});

it('migrates the older tool-result/result shape too', () => {
 const result = { success: true, message: 'Action executed.', uiAction: { type: 'glirastes.navigate' } };
 const messages = [assistant('a', [{ type: 'tool-result', result }])];
 expect(sanitizeStoredMessages(messages)).toMatchObject([{ parts: [{ result: { executionStatus: 'unconfirmed' } }] }]);
 expect(result).not.toHaveProperty('executionStatus');
});
