// @vitest-environment jsdom

/**
 * Everything an app written against 0.19.0 passes INTO the SDK must keep
 * compiling: provider config, session store, transport, queue storage, locale,
 * the props of SDK components it renders and the custom components it
 * implements. `bun run typecheck:tests` checks this file; the test only
 * renders it once. (Values the SDK hands OUT, such as `ChatContextValue`,
 * `ChatQueueApi` and `MessageParts`, may gain required members: see the
 * CHANGELOG for the list a hand-built mock needs.)
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiChatProvider,
  MessageBubble,
  MessageList,
  TurnNotice,
  deChatLocale,
  type ActivityLogConfig,
  type AiChatProviderConfig,
  type ChatComponents,
  type ChatLocale,
  type ChatMessage,
  type ChatQueueConfig,
  type ChatQueueStorage,
  type ChatTransport,
  type MessageBubbleProps,
  type MessagePartsProps,
  type SessionConfig,
  type TurnNoticeProps,
} from '../index.js';

afterEach(cleanup);

// The 0.19.0 shapes, member for member (no member added since).
const activityLog: ActivityLogConfig = {
  expandWhileRunning: false,
  noticePlacement: 'log',
  details: 'auto',
  grouping: 'message',
};

const session: SessionConfig = {
  save: (_id: string, _messages: ChatMessage[]) => {},
  load: async () => [],
  clear: async () => {},
  activeId: 'a',
  onActiveIdChange: () => {},
};

const queueStorage: ChatQueueStorage = { load: () => [], save: () => {} };
const queue: ChatQueueConfig = { enabled: true, storage: queueStorage };

// A full locale object without the key added after 0.19.0.
const { queueApprovalWaitingHint: _added, ...locale019 } = deChatLocale;
const locale: ChatLocale = locale019;

const transport: ChatTransport = {
  messages: [],
  status: 'ready',
  error: null,
  sendMessage: async () => {},
  stop: () => {},
  setMessages: () => {},
  addToolApprovalResponse: () => {},
};

// Custom components implemented against the 0.19.0 props.
function Bubble019({ message, className }: { message: ChatMessage; className?: string }) {
  return <div className={className}>{message.id}</div>;
}
function Notice019({ text, status, placement }: { text: string; status: TurnNoticeProps['status']; placement: 'log' | 'message' }) {
  return <p data-status={status} data-placement={placement}>{text}</p>;
}
function Parts019({ children }: Omit<MessagePartsProps, 'turnOutcome'>) {
  return <>{children}</>;
}
const components: ChatComponents = { MessageBubble: Bubble019, TurnNotice: Notice019, MessageParts: Parts019 };

const config: AiChatProviderConfig = { session, queue, locale, activityLog, components };

// SDK components rendered with the 0.19.0 props.
const message: ChatMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
const bubbleProps: MessageBubbleProps = { message };
const noticeProps: TurnNoticeProps = { text: 'Stopped', status: 'aborted', placement: 'message' };
// A test of the app's own MessageParts slot builds its props by hand.
const partsProps: Omit<MessagePartsProps, 'turnOutcome'> & Partial<Pick<MessagePartsProps, 'turnOutcome'>> = {
  message, parts: [], children: null, plan: null, activity: null, notice: null, attachments: null, text: null, toolResults: null,
};
const partsPropsAsDeclared: MessagePartsProps = partsProps;

describe('0.19.0-shaped consumer inputs', () => {
  it('compile and render', () => {
    const { container } = render(
      <AiChatProvider transport={transport} {...config}>
        <MessageList />
        <MessageBubble {...bubbleProps} />
        <TurnNotice {...noticeProps} />
        <Parts019 {...partsPropsAsDeclared} />
      </AiChatProvider>,
    );
    expect(container.querySelector('[data-component="message-list"]')).not.toBeNull();
  });
});
