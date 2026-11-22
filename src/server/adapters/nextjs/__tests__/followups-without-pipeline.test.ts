import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { AiPipeline } from '../types.js';

const model = () => new MockLanguageModelV3({});
const pipeline = { process: async () => ({}) } as unknown as AiPipeline;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('followups without pipeline', () => {
  it('warns once at handler creation and names the fix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createAiChatHandler({ tools: {}, model: model(), systemPrompt: 'Help', followups: { enabled: true } });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('followups');
    expect(message).toContain('pipeline');
  });

  it('no warning with pipeline, without followups or with followups disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createAiChatHandler({ tools: {}, model: model(), systemPrompt: 'Help', followups: { enabled: true }, pipeline });
    createAiChatHandler({ tools: {}, model: model(), systemPrompt: 'Help' });
    createAiChatHandler({ tools: {}, model: model(), systemPrompt: 'Help', followups: { enabled: false } });
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('followups'))).toHaveLength(0);
  });
});
