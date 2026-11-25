import { describe, expect, it } from 'vitest';
import { createMessageChats } from '../message-chat-context.js';
import type { ChatContextValue } from '../chat-context.js';
import type { ComposerContextValue } from '../composer-context.js';
import type { ChatMessage, PendingApproval, TurnOutcome } from '../../types.js';

/**
 * Each thing a message bubble reads: when it changes the message gets a new view (its bubble renders again),
 * when something else changes the view stays.
 */
type Chat = ChatContextValue & ComposerContextValue;

const user = (id: string, text = id): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const answer = (id: string, parts: unknown[] = [{ type: 'text', text: id }]): ChatMessage => ({ id, role: 'assistant', parts: parts as ChatMessage['parts'] });

const LOCALE = {} as Chat['locale'];
const COMPONENTS = {} as Chat['components'];
const NONE = new Map<string, TurnOutcome>();
const noop = () => {};

/** The config of the provider: the same objects on every render, as the provider keeps them. */
const CONFIG = {
  classNames: {}, components: COMPONENTS, locale: LOCALE, language: undefined, toolResults: {}, toolLabels: {},
  activityLog: {} as Chat['activityLog'], approve: noop, reject: noop, approvalDescription: noop as unknown as Chat['approvalDescription'],
  approvalSubjects: true, approvalDisplay: { decided: 'none', open: 'panel' }, stop: noop, turnWorkedMs: () => null,
} as Partial<Chat>;
const NO_PENDING: PendingApproval[] = [];

function chatWith(messages: ChatMessage[], overrides: Partial<Chat> = {}): Chat {
  return {
    ...CONFIG,
    // New objects and functions per render, as the provider gives them.
    suggestions: { enabled: true, count: 3 }, messages, isLoading: false, isTurnRunning: false, canCompose: true,
    send: () => true, selectSuggestion: () => {}, pipelineState: null, pendingApprovals: NO_PENDING, isProcessingApproval: false,
    isApprovalResendPending: () => false, turnOutcomes: NONE,
    ...overrides,
  } as Chat;
}

/** The views of all messages after rendering `chat` with `messages`. */
function viewsOf(chats: ReturnType<typeof createMessageChats>, chat: Chat) {
  const of = chats(chat, chat.messages);
  return chat.messages.map((message, index) => of(message, index));
}

/** Renders `before`, then `after`; the ids whose view is new. */
function changed(before: Chat, after: Chat): string[] {
  const chats = createMessageChats();
  const first = viewsOf(chats, before);
  const byId = new Map(before.messages.map((message, index) => [message.id, first[index]]));
  const second = viewsOf(chats, after);
  return after.messages.filter((message, index) => byId.get(message.id) !== second[index]).map((message) => message.id);
}

const base = () => [user('q1'), answer('r1'), user('q2'), answer('r2')];

describe('the view of each message (MessageList)', () => {
  it('reads the current chat value: the fields are live, also through an old view', () => {
    const chats = createMessageChats();
    const messages = base();
    const [view] = viewsOf(chats, chatWith(messages, { isLoading: false }));
    expect(view!.isLoading).toBe(false);
    viewsOf(chats, chatWith(messages, { isLoading: true }));
    expect(view!.isLoading).toBe(true);
    expect(view!.messages).toBe(messages);
    expect(Object.keys(view!)).toEqual([]);
  });

  it('a new chat value with nothing new for the messages: every view stays', () => {
    const messages = base();
    expect(changed(chatWith(messages), chatWith([...messages], { send: () => true, selectSuggestion: noop, isApprovalResendPending: () => false }))).toEqual([]);
  });

  it('a running turn changes only the latest message', () => {
    const messages = base();
    expect(changed(chatWith(messages), chatWith(messages, { isLoading: true }))).toEqual(['r2']);
    expect(changed(chatWith(messages), chatWith(messages, { isTurnRunning: true }))).toEqual(['r2']);
    expect(changed(chatWith(messages), chatWith(messages, { canCompose: false }))).toEqual(['r2']);
    expect(changed(chatWith(messages), chatWith(messages, { pipelineState: { status: 'aborted' } as Chat['pipelineState'] }))).toEqual(['r2']);
    expect(changed(chatWith(messages), chatWith(messages, { pendingApprovals: [] }))).toEqual(['r2']);
    expect(changed(chatWith(messages), chatWith(messages, { isProcessingApproval: true }))).toEqual(['r2']);
    expect(changed(chatWith(messages), chatWith(messages, { turnOutcomes: new Map() }))).toEqual(['r2']);
  });

  it.each([
    'classNames', 'components', 'locale', 'language', 'toolResults', 'toolRendererRegistry', 'toolLabels', 'activityLog',
    'approve', 'reject', 'approvalDescription', 'approvalSubjects', 'approvalDisplay', 'entityDeclarations', 'mentionPrefix',
    'composer', 'messageFooter', 'stop', 'continueAfterBudgetStop', 'turnWorkedMs',
  ] as const)('a new %s: every message', (field) => {
    const messages = base();
    const value = typeof chatWith(messages)[field] === 'function' ? () => {} : { changed: true };
    expect(changed(chatWith(messages), chatWith(messages, { [field]: value } as Partial<Chat>))).toEqual(['q1', 'r1', 'q2', 'r2']);
  });

  it('config as plain data compares by value (an inline object on every render), functions by identity', () => {
    const messages = base();
    const declared = () => ({ list: { output: [{ type: 'channel', id: 'key', name: 'title', path: 'items[]' }] } });
    const before = chatWith(messages, { locale: { a: 'A' } as unknown as Chat['locale'], entityDeclarations: declared() });
    expect(changed(before, chatWith(messages, { locale: { a: 'A' } as unknown as Chat['locale'], entityDeclarations: declared() }))).toEqual([]);
    expect(changed(before, chatWith(messages, { locale: { a: 'B' } as unknown as Chat['locale'], entityDeclarations: declared() }))).toHaveLength(4);
    const other = declared();
    other.list.output[0]!.path = 'other[]';
    expect(changed(before, chatWith(messages, { locale: { a: 'A' } as unknown as Chat['locale'], entityDeclarations: other }))).toHaveLength(4);
    const Bubble = () => null;
    const withBubble = chatWith(messages, { components: { MessageBubble: Bubble } as unknown as Chat['components'] });
    expect(changed(withBubble, chatWith(messages, { components: { MessageBubble: Bubble } as unknown as Chat['components'] }))).toEqual([]);
    expect(changed(withBubble, chatWith(messages, { components: { MessageBubble: () => null } as unknown as Chat['components'] }))).toHaveLength(4);
    const pattern = /x/;
    const regex = chatWith(messages, { composer: { a: pattern } as unknown as Chat['composer'] });
    expect(changed(regex, chatWith(messages, { composer: { a: /x/ } as unknown as Chat['composer'] }))).toHaveLength(4);
  });

  it('the suggestions: by their placement, count and enabled, not by the object', () => {
    const messages = base();
    const before = chatWith(messages, { suggestions: { enabled: true, count: 3 } });
    expect(changed(before, chatWith(messages, { suggestions: { enabled: true, count: 3 } }))).toEqual([]);
    expect(changed(before, chatWith(messages, { suggestions: { enabled: true, count: 3, placement: 'message' } }))).toHaveLength(4);
    expect(changed(before, chatWith(messages, { suggestions: { enabled: true, count: 2 } }))).toHaveLength(4);
    expect(changed(before, chatWith(messages, { suggestions: { enabled: false, count: 3 } }))).toHaveLength(4);
  });

  it('a new message object: only it', () => {
    const messages = base();
    const next = messages.map((message) => (message.id === 'r1' ? { ...message } : message));
    expect(changed(chatWith(messages), chatWith(next))).toEqual(['r1']);
  });

  it('whether the next message is a user message (`isLastOfTurn`)', () => {
    const messages = base();
    const inserted = [messages[0]!, messages[1]!, answer('r1b'), messages[2]!, messages[3]!];
    expect(changed(chatWith(messages), chatWith(inserted))).toEqual(['r1', 'r1b']);
  });

  it("the outcome of the message's turn", () => {
    const messages = base();
    const outcome = { status: 'completed' } as TurnOutcome;
    expect(changed(chatWith(messages, { turnOutcomes: new Map([['q2', outcome]]) }), chatWith(messages, {
      turnOutcomes: new Map([['q2', outcome], ['q1', outcome]]),
    }))).toEqual(['q1', 'r1', 'r2']);
  });

  it('a message appended: the one before it is no longer the latest', () => {
    const messages = base();
    expect(changed(chatWith(messages), chatWith([...messages, user('q3')]))).toEqual(['r2', 'q3']);
  });

  describe('approvals', () => {
    const requested = (id: string) => answer(id, [{ type: 'tool-x', toolCallId: `c-${id}`, state: 'approval-requested', input: {}, approval: { id: `ap-${id}` } }]);
    const decided = (id: string) => answer(id, [{ type: 'tool-x', toolCallId: `c-${id}`, state: 'output-available', input: {}, output: {}, approval: { id: `ap-${id}`, approved: true } }]);
    const pendingFor = (id: string) => ({ id: `ap-${id}`, toolName: 'x', args: {}, messageId: id }) as PendingApproval;

    it('an open approval at a part: its pending entry and whether one is being sent', () => {
      const messages = [user('q1'), requested('r1'), user('q2'), answer('r2')];
      const before = chatWith(messages);
      expect(changed(before, chatWith(messages, { pendingApprovals: [pendingFor('r1')] }))).toEqual(['r1', 'r2']);
      expect(changed(before, chatWith(messages, { isProcessingApproval: true }))).toEqual(['r1', 'r2']);
      expect(changed(before, chatWith(messages, { pendingApprovals: [pendingFor('other')] }))).toEqual(['r2']);
    });

    it('the latest answer: whether an answered approval is still to be sent', () => {
      const messages = [user('q1'), decided('r1')];
      expect(changed(chatWith(messages), chatWith(messages, { isApprovalResendPending: () => true }))).toEqual(['r1']);
    });

    it('approvals shown at their part: a change of a message that is not streaming', () => {
      const messages = [user('q1'), decided('r1'), user('q2'), answer('r2'), user('q3')];
      const inline = { approvalDisplay: { decided: 'entry', open: 'panel' } as Chat['approvalDisplay'] };
      const edited = messages.map((message) => (message.id === 'q2' ? { ...message } : message));
      expect(changed(chatWith(messages, inline), chatWith(edited, inline))).toEqual(['r1', 'q2']);
      // The streaming latest message is left out while the turn runs.
      const loading = { ...inline, isLoading: true };
      const streamed = [...messages.slice(0, -1), answer('r3')];
      expect(changed(chatWith(streamed, loading), chatWith([...messages.slice(0, -1), answer('r3')], loading))).toEqual(['r3']);
      // In the panel (default), no app bubble or parts: not read.
      expect(changed(chatWith(messages), chatWith(edited))).toEqual(['q2']);
      // An app's bubble or parts may read `MessagePartEntry.approval`.
      const parts = { components: { MessageParts: () => null } as unknown as Chat['components'] };
      expect(changed(chatWith(messages, parts), chatWith(edited, parts))).toEqual(['r1', 'q2']);
    });
  });

  it('a clarification: a change of a message that is not streaming (whether it was answered)', () => {
    const asked = answer('r1', [{ type: 'tool-ask_clarification', toolCallId: 'k', state: 'output-available', input: { question: 'Which?' }, output: {} }]);
    const messages = [user('q1'), asked, user('q2'), answer('r2')];
    const edited = messages.map((message) => (message.id === 'q2' ? { ...message } : message));
    expect(changed(chatWith(messages), chatWith(edited))).toEqual(['r1', 'q2']);
  });
});
