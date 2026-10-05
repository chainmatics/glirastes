// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatTransport } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { AiChatPanel } from '../../components/ai-chat-panel.js';

const transport: ChatTransport = {
  messages: [], status: 'ready', error: null,
  sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(),
  addToolApprovalResponse: vi.fn(async () => {}),
};

const panelStyle = () =>
  document.querySelector('[data-component="ai-chat-panel"]')?.getAttribute('style') ?? '';

describe('themeScope', () => {
  afterEach(cleanup);

  it('writes inline theme variables by default', () => {
    render(<AiChatProvider transport={transport} theme="professional-dark"><AiChatPanel /></AiChatProvider>);
    expect(panelStyle()).toContain('--cm-primary');
  });

  it('leaves variables to stylesheets and host CSS when inherit is chosen', () => {
    render(
      <AiChatProvider transport={transport} theme="professional-dark" themeScope="inherit">
        <AiChatPanel />
      </AiChatProvider>,
    );
    expect(panelStyle()).not.toContain('--cm-');
  });
});
