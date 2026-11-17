import { describe, expect, it } from 'vitest';
import { generateObject, generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { createPrivacyBoundary } from '../model-boundary.js';
import {
  anthropicAdapter,
  createProviderRegistry,
  openRouterAdapter,
  withOpenRouterRouting,
  type ProviderAdapter,
} from '../provider-registry.js';
import { CANARY, CANARY_PATTERN, captureFetch, memoryShield, testScope } from './privacy-fixtures.js';
import { createAiChatHandler } from '../../adapters/nextjs/create-ai-chat-handler.js';
import { defineTool, type ToolRegistry } from '../../../types.js';
import type { ChatPrivacyConfig } from '../chat-privacy.js';

const SECRETS: Record<string, string> = { OPENROUTER_KEY: 'test-secret-openrouter', ANTHROPIC_KEY: 'test-secret-anthropic' };

function setup(options: { text?: string; failFirst?: boolean } = {}) {
  const openrouter = captureFetch('openai-chat', options);
  const anthropic = captureFetch('anthropic', options);
  const registry = createProviderRegistry({
    adapters: [
      openRouterAdapter({ createOpenAI, fetch: openrouter.fetch, routing: { only: ['anthropic'] } }),
      anthropicAdapter({ createAnthropic, fetch: anthropic.fetch }),
    ],
    entries: [
      { id: 'standard', label: 'Standard (OpenRouter)', adapter: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', secretRef: 'OPENROUTER_KEY', baseURL: 'https://openrouter.example.invalid/api/v1' },
      { id: 'direct', label: 'Anthropic direkt', adapter: 'anthropic', modelId: 'claude-sonnet-4-5', secretRef: 'ANTHROPIC_KEY', baseURL: 'https://anthropic.example.invalid/v1', capabilities: { images: true } },
      { id: 'tenant-b-only', label: 'Nur Mandant B', adapter: 'anthropic', modelId: 'claude-haiku-4-5', secretRef: 'ANTHROPIC_KEY', allowed: (scope) => scope.tenantId === 'tenant-b' },
      { id: 'unconfigured', label: 'Ohne Schlüssel', adapter: 'anthropic', modelId: 'claude-haiku-4-5', secretRef: 'MISSING_KEY' },
    ],
    defaultEntry: 'standard',
    secrets: (ref) => SECRETS[ref],
  });
  return { registry, transports: { standard: openrouter, direct: anthropic } };
}

async function protectedSession() {
  const shield = memoryShield();
  const session = await shield.open(testScope());
  await session.registerIdentities([
    { id: CANARY.userId, name: CANARY.name, email: CANARY.email },
    { id: CANARY.colleagueId, name: CANARY.colleague, email: CANARY.colleagueEmail },
  ]);
  return { shield, session };
}

const bodies = (requests: Array<{ body: string }>) => requests.map((r) => JSON.parse(r.body || '{}') as Record<string, unknown>);

describe.each(['standard', 'direct'] as const)('provider conformance behind the boundary: %s', (providerId) => {
  it('stream and non-stream, tools, history and retry carry no original', async () => {
    const { registry, transports } = setup({ failFirst: true });
    const { session } = await protectedSession();
    const { model } = registry.resolve(session.scope, providerId);
    const wrapped = createPrivacyBoundary({ session }).wrapModel(model);
    const tools = {
      lookup: tool({ description: `Sucht Kontakte von ${CANARY.name}`, inputSchema: z.object({ q: z.string() }), execute: async () => ({ email: CANARY.colleagueEmail }) }),
    };
    await generateText({
      model: wrapped,
      system: `Du hilfst ${CANARY.name} (${CANARY.userId}).`,
      messages: [
        { role: 'user', content: `Wer ist ${CANARY.colleague}?` },
        { role: 'assistant', content: `${CANARY.colleague} hat die Adresse ${CANARY.colleagueEmail}.` },
        { role: 'user', content: `Schreib an ${CANARY.email}` },
      ],
      tools,
      maxRetries: 2,
    });
    await streamText({ model: wrapped, prompt: `Grüße ${CANARY.colleague}` }).text;
    const requests = transports[providerId].requests;
    expect(requests.length).toBeGreaterThanOrEqual(3); // 503, retry, stream
    expect(requests.map((r) => r.body).join('\n')).not.toMatch(CANARY_PATTERN);
    // The secret travels only as the provider credential, never in a body.
    expect(requests.map((r) => r.body).join('\n')).not.toContain('test-secret');
  });

  it('structured output passes the same boundary', async () => {
    const { registry, transports } = setup({ text: '{"title":"Termin"}' });
    const { session } = await protectedSession();
    const { model } = registry.resolve(session.scope, providerId);
    const result = await generateObject({
      model: createPrivacyBoundary({ session }).wrapModel(model),
      schema: jsonSchema<{ title: string }>({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }),
      prompt: `Plane ein Treffen mit ${CANARY.colleague}, ${CANARY.colleagueEmail}`,
    });
    expect(result.object).toEqual({ title: 'Termin' });
    expect(transports[providerId].requests.map((r) => r.body).join('\n')).not.toMatch(CANARY_PATTERN);
  });
});

describe('provider routing', () => {
  it('the OpenRouter policy reaches the HTTP body; the direct provider gets no OpenRouter fields', async () => {
    const { registry, transports } = setup();
    const { session } = await protectedSession();
    for (const id of ['standard', 'direct'] as const) {
      await generateText({ model: createPrivacyBoundary({ session }).wrapModel(registry.resolve(session.scope, id).model), prompt: 'Hallo' });
    }
    const [routed] = bodies(transports.standard.requests);
    expect(routed!.provider).toEqual({ only: ['anthropic'], allow_fallbacks: false, data_collection: 'deny', zdr: true });
    for (const body of bodies(transports.direct.requests)) {
      expect(body).not.toHaveProperty('provider');
      expect(JSON.stringify(body)).not.toMatch(/data_collection|allow_fallbacks|zdr/);
    }
  });

  it('a request cannot weaken the routing policy', async () => {
    const seen: string[] = [];
    const routed = withOpenRouterRouting({}, async (_input, init) => { seen.push(String(init?.body)); return new Response('{}'); });
    await routed('https://openrouter.example.invalid', { method: 'POST', body: JSON.stringify({ provider: { allow_fallbacks: true, data_collection: 'allow', order: ['x'] } }) });
    expect(JSON.parse(seen[0]!).provider).toEqual({ order: ['x'], allow_fallbacks: false, data_collection: 'deny', zdr: true });
    await expect(routed('https://openrouter.example.invalid', { method: 'POST', body: 'not json' })).rejects.toMatchObject({ code: 'provider_not_allowed' });
  });
});

describe('provider selection', () => {
  it('an unknown, foreign or unconfigured choice fails without falling back', async () => {
    const { registry, transports } = setup();
    const scope = testScope();
    expect(() => registry.resolve(scope, 'tenant-b-only')).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
    expect(() => registry.resolve(scope, 'https://evil.example.invalid')).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
    expect(() => registry.resolve(scope, 'unconfigured')).toThrow(expect.objectContaining({ code: 'provider_unavailable' }));
    expect(registry.resolve({ ...scope, tenantId: 'tenant-b' }, 'tenant-b-only').label).toBe('Nur Mandant B');
    expect(registry.resolve(scope).id).toBe('standard');
    expect(transports.standard.requests).toHaveLength(0);
  });

  it('the browser view has ids, labels and capabilities only', () => {
    const { registry } = setup();
    const options = registry.options(testScope());
    expect(options.map((o) => o.id)).toEqual(['standard', 'direct', 'unconfigured']);
    expect(JSON.stringify(options)).not.toMatch(/secret|KEY|example\.invalid|claude-/);
    for (const option of options) expect(Object.keys(option).sort()).toEqual(['capabilities', 'id', 'label']);
  });

  it('refuses an unqualified adapter in the protected profile', () => {
    const custom: ProviderAdapter = { id: 'custom', qualified: false, createModel: () => { throw new Error('never built'); } };
    const registry = createProviderRegistry({
      adapters: [custom],
      entries: [{ id: 'c', label: 'Custom', adapter: 'custom', modelId: 'm', secretRef: 'K' }],
      defaultEntry: 'c',
      secrets: () => 'k',
    });
    expect(registry.options(testScope())).toEqual([]);
    expect(() => registry.resolve(testScope())).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
  });
});

describe('provider switch through the chat handler', () => {
  function tools(): ToolRegistry {
    return { noop: defineTool({ id: 'noop', description: 'Nichts.', inputSchema: z.object({}).strict(), execute: async () => ({ ok: true }) }) };
  }
  const post = (text: string) => new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'chat-1', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] }),
  });

  function config(registry: ReturnType<typeof setup>['registry'], selection: string | undefined, tenantId = 'tenant-a'): ChatPrivacyConfig {
    return {
      shield: memoryShield(),
      scope: (_req, chat) => ({ ...testScope(), tenantId, conversationId: chat.conversationId ?? 'x' }),
      knownIdentities: () => [{ id: CANARY.colleagueId, name: CANARY.colleague, email: CANARY.colleagueEmail }],
      providers: { registry, selection: () => selection },
    };
  }

  it('each selected provider gets the protected turn; the handler model is not used', async () => {
    for (const id of ['standard', 'direct'] as const) {
      const { registry, transports } = setup();
      const handler = createAiChatHandler({ tools: tools(), systemPrompt: 'Assistent', privacy: config(registry, id) });
      const response = await handler(post(`Schreib ${CANARY.colleague}, ${CANARY.colleagueEmail}`));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(`"provider":"${id === 'standard' ? 'Standard (OpenRouter)' : 'Anthropic direkt'}"`);
      const other = id === 'standard' ? transports.direct : transports.standard;
      expect(transports[id].requests.length).toBeGreaterThan(0);
      expect(other.requests).toHaveLength(0);
      expect(transports[id].requests.map((r) => r.body).join('\n')).not.toMatch(CANARY_PATTERN);
    }
  });

  it('a choice from another tenant is refused with 403 before any model call', async () => {
    const { registry, transports } = setup();
    const handler = createAiChatHandler({ tools: tools(), systemPrompt: 'Assistent', privacy: config(registry, 'tenant-b-only') });
    const response = await handler(post('Hallo'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'provider_not_allowed' });
    expect(transports.standard.requests.length + transports.direct.requests.length).toBe(0);
  });
});
