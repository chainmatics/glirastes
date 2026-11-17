import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { defineTool, type ToolRegistry } from '../../../../../types.js';
import { AiChatService, errorName } from '../ai-chat.service.js';
import { CANARY, CANARY_PATTERN } from '../../../../pii-shield/__tests__/privacy-fixtures.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function service(options: Record<string, unknown> | null, tools: Record<string, unknown> = {}) {
  const aiTools = { buildToolRegistry: () => tools } as never;
  const config = { get: (_k: string, d: unknown) => d } as never;
  return new AiChatService(options as never, aiTools, config);
}

async function drain(response: Response): Promise<string> {
  return response.body ? await new Response(response.body).text() : '';
}

describe('NestJS chat adapter and the protected-text profile', () => {
  it('refuses a privacy configuration instead of running unprotected', async () => {
    const model = new MockLanguageModelV3();
    for (const key of ['privacy', 'piiShield']) {
      await expect(service({ model, systemPrompt: 's', [key]: {} }).streamChat([], ''))
        .rejects.toThrow('privacy_profile_unsupported');
    }
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('logs no message, tool argument, tool result or error text', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const spies = (['log', 'debug', 'error', 'warn', 'verbose'] as const)
      .map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(capture));
    try {
      let step = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: convertArrayToReadableStream((step++ === 0
            ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'mail_send', input: JSON.stringify({ to: CANARY.email }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ]
            : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: `Hallo ${CANARY.name}` },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ]) as never),
        }),
      });
      const tools: ToolRegistry = {
        mail_send: defineTool({
          id: 'mail.send', description: 'Sendet eine Mail.',
          inputSchema: z.object({ to: z.string() }),
          execute: async (input: { to: string }) => { throw new Error(`Postfach ${input.to} voll`); },
        }),
      };
      const response = await service({ model, systemPrompt: `Nutzer ${CANARY.email}` }, tools).streamChat(
        [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: `Schreib ${CANARY.name}` }] }] as never,
        'Bearer x',
      );
      await drain(response);
      expect(lines.join('\n')).not.toMatch(CANARY_PATTERN);
      expect(lines.some((line) => line.startsWith('Step finished: toolCalls=1'))).toBe(true);
      expect(lines.some((line) => line.includes('execution error: Error'))).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('does not print a provider error, which carries the request body, through the AI SDK default', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${JSON.stringify(a)}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    const consoleSpies = (['error', 'warn', 'log', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(capture));
    const loggerSpies = (['log', 'debug', 'error', 'warn', 'verbose'] as const)
      .map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(capture));
    try {
      const model = new MockLanguageModelV3({
        doStream: async () => {
          const error = Object.assign(new Error(`Provider rejected ${CANARY.email}`), {
            name: 'AI_APICallError',
            statusCode: 400,
            requestBodyValues: { prompt: `Schreib ${CANARY.name}` },
            responseBody: `{"echo":"${CANARY.email}"}`,
          });
          throw error;
        },
      });
      const response = await service({ model, systemPrompt: 's' }).streamChat(
        [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: `Schreib ${CANARY.name}` }] }] as never,
        'Bearer x',
      );
      await drain(response).catch(() => '');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lines.join('\n')).not.toMatch(CANARY_PATTERN);
      expect(lines.join('\n')).not.toContain('requestBodyValues');
    } finally {
      for (const spy of [...consoleSpies, ...loggerSpies]) spy.mockRestore();
    }
  });

  it('reduces errors to their class', () => {
    expect(errorName(new TypeError(CANARY.email))).toBe('TypeError');
    expect(errorName(CANARY.email)).toBe('string');
  });
});
