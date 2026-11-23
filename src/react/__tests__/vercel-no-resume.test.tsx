// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useChatOptions: Array<Record<string, unknown>> = [];

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: Record<string, unknown>) => {
    useChatOptions.push(options);
    return {
      messages: [],
      sendMessage: async () => {},
      status: 'ready',
      error: undefined,
      stop: () => {},
      setMessages: () => {},
      addToolApprovalResponse: () => {},
    };
  },
}));

const { useVercelAiChatTransport } = await import('../transports/vercel.js');

afterEach(cleanup);

function Probe() {
  useVercelAiChatTransport({ endpoint: '/api/chat' });
  return null;
}

describe('Vercel transport stream resumption', () => {
  // A resumed stream would deliver UI actions of a request this page did not
  // send; they must never run late, so resumption stays off.
  it('does not resume streams on mount', () => {
    render(<Probe />);
    expect(useChatOptions.length).toBeGreaterThan(0);
    for (const options of useChatOptions) expect(options.resume).toBeFalsy();
  });
});
