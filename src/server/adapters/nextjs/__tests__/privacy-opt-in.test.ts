import { formatChatCommandMessage } from '../../../../contracts/chat-command.js';
import { defineTool } from '../../../../types.js';
import { z } from 'zod';
import { referenceTools } from './approval-subject-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import { CANARY, memoryShield, providerAdapters, testScope } from '../../../pii-shield/__tests__/privacy-fixtures.js';
import { effectivePrivacyPolicyFor, assertPrivacyTurn } from '../../../../runtime/privacy-runtime.js';
import { streamChunks } from './command-fixtures.js';

describe('pseudonymization is an explicit consumer opt-in', () => {
  it('does not activate or inspect providers merely because infrastructure is configured', () => {
    const bindings = vi.fn(() => { throw new Error('must not read inactive registry'); });
    const privacy = { shield: memoryShield(), providers: { bindings, defaultEntryId: 'main' } };
    expect(effectivePrivacyPolicyFor(undefined, privacy)).toBeNull();
    expect(bindings).not.toHaveBeenCalled();
    expect(() => assertPrivacyTurn({ pinned: undefined, privacy, revocations: [], awaitingPolicy: true })).not.toThrow();
  });

  for (const required of [undefined, false, true]) {
    it(`uses raw ordinary transport unless required is explicitly true (${required})`, async () => {
      const adapter = providerAdapters().openrouter;
      const scope = vi.fn(() => testScope({ conversationId: 'opt-in' }));
      const open = vi.spyOn(memoryShield(), 'open');
      const shield = { profile: 'protected-text/v1' as const, open, outbound: vi.fn(), deleteMapping: vi.fn() };
      const debug = vi.fn();
      const handler = createAiChatHandler({
        tools: {}, model: adapter.model, systemPrompt: 'Help', onModelInput: debug,
        privacy: { shield, scope, policy: required === undefined ? undefined : { required },
          knownIdentities: () => [{ name: CANARY.name, email: CANARY.email }] },
      });
      const response = await handler(new Request('http://fixture/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'opt-in', messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: CANARY.email }] }] }),
      }));
      const chunks = await streamChunks(response);
      expect(adapter.requests).toHaveLength(1);
      const captured = JSON.stringify(adapter.requests);
      if (required === true) {
        expect(captured).not.toContain(CANARY.email);
        expect(open).toHaveBeenCalledOnce();
        expect(debug).not.toHaveBeenCalled();
        expect(JSON.stringify(chunks)).toContain('data-privacy-status');
      } else {
        expect(captured).toContain(CANARY.email);
        expect(open).not.toHaveBeenCalled();
        expect(scope).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalled();
        expect(JSON.stringify(chunks)).not.toContain('data-privacy-status');
      }
    });
  }

  it('visibly refuses mention markers before their canonical labels can lose identity context', async () => {
    const adapter = providerAdapters().openrouter;
    const handler = createAiChatHandler({ tools: {}, model: adapter.model, systemPrompt: 'Help',
      privacy: { shield: memoryShield(), scope: () => testScope(), policy: { required: true } },
    });
    const response = await handler(new Request('http://fixture/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'opt-in',
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: '{{mention:person:123:Anna Must}}' }] }],
      }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'privacy_unsupported_content', feature: 'mentions' });
    expect(adapter.requests).toHaveLength(0);
  });
  it.each(['middleware', 'direct-commands'])('visibly blocks unsupported %s before execution or model egress', async (feature) => {
    const adapter = providerAdapters().openrouter;
    const execute = vi.fn(async () => ({ value: 'private' }));
    const middleware = vi.fn(async (_call, next) => next());
    const handler = createAiChatHandler({
      tools: { read_item: defineTool({ id: 'read.item', description: 'Read item', inputSchema: z.object({}), execute }) },
      model: adapter.model, systemPrompt: 'Help',
      ...(feature === 'middleware' ? { toolMiddleware: [middleware] } : {}),
      privacy: { shield: memoryShield(), scope: () => testScope(), policy: { required: true } },
    });
    const text = feature === 'direct-commands'
      ? formatChatCommandMessage({ commandId: 'read.item', tool: 'read.item', args: {}, label: '/Read' }) : 'Read';
    const response = await handler(new Request('http://fixture/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'opt-in',
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text }] }],
      }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'privacy_unsupported_content', feature });
    expect(adapter.requests).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(middleware).not.toHaveBeenCalled();
  });

  it('refuses approval subject and list lookup configuration before model or backend reads', async () => {
    const adapter = providerAdapters().openrouter;
    const backend = vi.fn();
    const handler = createAiChatHandler({ tools: referenceTools(), model: adapter.model, systemPrompt: 'Help',
      approvalSecret: 'privacy-port-fixture-secret-at-least-32-chars', endpointCaller: () => backend,
      privacy: { shield: memoryShield(), scope: () => testScope(), policy: { required: true } },
    });
    const response = await handler(new Request('http://fixture/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'opt-in',
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Delete playlist 7' }] }],
      }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'privacy_unsupported_content' });
    expect(adapter.requests).toHaveLength(0);
    expect(backend).not.toHaveBeenCalled();
  });

});
