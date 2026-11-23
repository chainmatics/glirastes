import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../../../types.js';
import { createNodeHandler } from '../../../node/handler.js';
import { memoryShield, testScope } from '../../../pii-shield/__tests__/privacy-fixtures.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { streamChunks } from './command-fixtures.js';

const identity = 'ProtectedIdentityCanary' + 'X'.repeat(1600);

describe('new Node bridge and tool result shaping under protection', () => {
  it.each([false, true])('keeps the real Node HTTP route and provider transport scoped (protected=%s)', async (required) => {
    const requests: string[] = [];
    const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      const first = requests.length === 1;
      const chunk = (delta: unknown, finish: string | null) => ({ id: 'fixture', object: 'chat.completion.chunk',
        created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] });
      const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'c', type: 'function',
        function: { name: 'read_item', arguments: '{}' } }] } : { role: 'assistant', content: 'Done' };
      return new Response([chunk(delta, null), chunk({}, first ? 'tool_calls' : 'stop')]
        .map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    };
    const execute = vi.fn(async () => ({ success: false, error: identity, retryable: false }));
    const handler = createAiChatHandler({
      systemPrompt: 'Help', model: createOpenAI({ apiKey: 'fixture', fetch: fetch as typeof globalThis.fetch }).chat('fixture'),
      tools: { read_item: defineTool({ id: 'read.item', description: 'Read an item', inputSchema: z.object({}), execute }) },
      privacy: { shield: memoryShield(), policy: { required }, scope: () => testScope({ conversationId: 'node-port' }),
        knownIdentities: () => [{ name: identity }] },
    });
    const server = createServer(createNodeHandler(handler));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'node-port',
          // View-context is contract-only at this base; arbitrary request fields never become model context.
          viewContext: { title: 'VIEW_CONTEXT_PRIVATE_CANARY' },
          messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Read the item' }] }],
        }),
      });
      await streamChunks(response);
      expect(execute).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(2);
      expect(requests.join('')).not.toContain('VIEW_CONTEXT_PRIVATE_CANARY');
      if (required) expect(requests.join('')).not.toContain('ProtectedIdentityCanary');
      else expect(requests.join('')).toContain('ProtectedIdentityCanary');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
