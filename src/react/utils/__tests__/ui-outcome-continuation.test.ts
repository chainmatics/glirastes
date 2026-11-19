import { describe, expect, it } from 'vitest';
import {
  continuesAfterPageLoad,
  shouldContinueChat,
  UI_OUTCOME_RELOAD_CONTINUATION_MS,
  waitingToolCallIds,
} from '../ui-outcome-continuation.js';

const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Open the tasks' }] };
const uiPart = (toolCallId: string, extra: Record<string, unknown> = {}, awaitsOutcome: boolean = true) => ({
  type: 'tool-ui_navigate', toolCallId, state: 'output-available', input: {},
  output: { handedOff: true, message: 'Handed to the app.', uiAction: { type: 'glirastes.navigate' }, awaitsOutcome, ...extra },
});
const endpointPart = (toolCallId: string, state = 'output-available') => ({
  type: 'tool-tasks_list', toolCallId, state, input: {}, ...(state === 'output-available' ? { output: { success: true } } : {}),
});
const approvalPart = (state: string) => ({
  type: 'tool-tasks_archive', toolCallId: 'call-a', state, input: {},
  approval: { id: 'ap-1', ...(state === 'approval-responded' ? { approved: true } : {}) },
});
const assistant = (...parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, ...parts] });
const ok = { outcome: { v: 1, code: 'ok' } };
const at = (ms: number) => ({ outcome: { v: 1, code: 'initiated', at: ms } });

const continues = (messages: unknown[], approvals = true) => shouldContinueChat({ messages }, { approvals });

describe('shouldContinueChat', () => {
  it('sends again once every waiting UI result has its outcome', () => {
    expect(continues([user, assistant(uiPart('c1'))])).toBe(false);
    expect(continues([user, assistant(uiPart('c1', ok))])).toBe(true);
    expect(continues([user, assistant(uiPart('c1', { outcome: { v: 1 } }))])).toBe(true);
    expect(continues([user, assistant(uiPart('c1', ok), uiPart('c2'))])).toBe(false);
    expect(continues([user, assistant(uiPart('c1', ok), uiPart('c2', ok), endpointPart('c3'))])).toBe(true);
  });

  it('waits for an open call and never sends for a clarification or a page load', () => {
    expect(continues([user, assistant(uiPart('c1', ok), endpointPart('c2', 'input-available'))])).toBe(false);
    const clarification = { type: 'tool-ask_clarification', toolCallId: 'c9', state: 'output-available', input: {}, output: {} };
    expect(continues([user, assistant(uiPart('c1', ok), clarification)])).toBe(false);
    expect(continues([user, assistant(uiPart('c1', at(Date.now())))])).toBe(false);
  });

  it('does not send for report-only results or a turn without UI results', () => {
    expect(continues([user, assistant(uiPart('c1', ok, false))])).toBe(false);
    expect(continues([user, assistant(endpointPart('c1'))])).toBe(false);
    expect(continues([user])).toBe(false);
  });

  it('keeps the approval rule and waits for UI outcomes in the same step', () => {
    expect(continues([user, assistant(approvalPart('approval-responded'))])).toBe(true);
    expect(continues([user, assistant(approvalPart('approval-responded'))], false)).toBe(false);
    expect(continues([user, assistant(approvalPart('approval-requested'), uiPart('c1', ok))])).toBe(false);
    expect(continues([user, assistant(approvalPart('approval-responded'), uiPart('c1'))])).toBe(false);
    expect(continues([user, assistant(approvalPart('approval-responded'), uiPart('c1', ok))])).toBe(true);
  });

  it('looks only at the last step', () => {
    const message = { id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, uiPart('c1', ok), { type: 'step-start' }, { type: 'text', text: 'Done.' }] };
    expect(continues([user, message])).toBe(false);
  });
});

describe('continuesAfterPageLoad', () => {
  const now = 1_000_000;

  it('continues a turn whose UI action loaded this page within a minute', () => {
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', at(now - 1_000)))], now)).toBe(true);
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', ok), uiPart('c2', at(now)))], now)).toBe(true);
  });

  it('does not continue later, without a code, with text after it or without a page load', () => {
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', at(now - UI_OUTCOME_RELOAD_CONTINUATION_MS - 1)))], now)).toBe(false);
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', at(now + 5_000)))], now)).toBe(false);
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', at(now)), uiPart('c2'))], now)).toBe(false);
    // A later result the page load cut off counts as settled once it says "not confirmed".
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', at(now)), uiPart('c2', { outcome: { v: 1 } }))], now)).toBe(true);
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', at(now)), { type: 'text', text: 'Opened.' })], now)).toBe(false);
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', ok))], now)).toBe(false);
    expect(continuesAfterPageLoad([user, assistant(uiPart('c1', { outcome: { v: 1, code: 'initiated' } }))], now)).toBe(false);
    expect(continuesAfterPageLoad([user], now)).toBe(false);
  });

  it('names the waiting results for the once-only guard', () => {
    expect(waitingToolCallIds([user, assistant(uiPart('c1', at(now)), endpointPart('c2'), uiPart('c3', ok))])).toEqual(['c1', 'c3']);
  });
});
