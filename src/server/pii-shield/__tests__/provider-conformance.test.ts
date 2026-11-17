import { describe, expect, it, vi } from 'vitest';
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
import { defineTool, type ModuleDefinition, type ToolRegistry } from '../../../types.js';
import { createLocalAiPipeline } from '../../local-pipeline.js';
import type { ChatPrivacyConfig } from '../chat-privacy.js';
import type { LocalPrivacyPolicy, PrivacyPolicyBlock } from '../../../contracts/privacy-policy.js';
import { createTurnSnapshot } from '../../../runtime/turn-snapshot.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from '../../../runtime/__tests__/turn-snapshot.test.js';

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

  it('a request cannot weaken, change or add to the routing policy', async () => {
    const seen: string[] = [];
    const routed = withOpenRouterRouting({}, async (_input, init) => { seen.push(String(init?.body)); return new Response('{}'); });
    await routed('https://openrouter.example.invalid', { method: 'POST', body: JSON.stringify({ provider: { allow_fallbacks: true, data_collection: 'allow', order: ['x'], only: ['openai'] } }) });
    expect(JSON.parse(seen[0]!).provider).toEqual({ allow_fallbacks: false, data_collection: 'deny', zdr: true });
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

describe('provider bindings and policy approval (K1)', () => {
  type Constraint = NonNullable<Parameters<ReturnType<typeof setup>['registry']['resolve']>[2]>;
  const approve = (registry: ReturnType<typeof setup>['registry'], ids: string[], extra: Partial<Constraint> = {}): Constraint => ({
    allowed: ids.map((entryId) => ({ entryId, bindingDigest: registry.bindings()[entryId]! })),
    defaultEntryId: ids[0] ?? null,
    userChoice: true,
    ...extra,
  });

  it('every entry of a describing adapter has a content-free binding and digest', () => {
    const { registry } = setup();
    expect(Object.keys(registry.bindings()).sort()).toEqual(['direct', 'standard', 'tenant-b-only', 'unconfigured']);
    for (const digest of Object.values(registry.bindings())) expect(digest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(registry.bindingOf('standard')).toEqual({
      v: 1,
      adapter: 'openrouter',
      adapterProtocol: 'openrouter-chat',
      endpoint: 'https://openrouter.example.invalid/api/v1',
      modelId: 'anthropic/claude-sonnet-4.5',
      routing: { allowFallbacks: false, dataCollection: 'deny', zdr: true, only: ['anthropic'] },
      capabilities: { images: false },
    });
    // Neither secret values nor secret names are part of a binding.
    const all = JSON.stringify(Object.keys(registry.bindings()).map((id) => registry.bindingOf(id)));
    expect(all).not.toMatch(/test-secret|_KEY|secretRef/);
  });

  it('resolves only approved entries whose binding matches now', () => {
    const { registry } = setup();
    const scope = testScope();
    const constraint = approve(registry, ['direct']);
    expect(registry.resolve(scope, undefined, constraint).id).toBe('direct');
    expect(registry.resolve(scope, 'direct', constraint).id).toBe('direct');
    expect(() => registry.resolve(scope, 'standard', constraint)).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
    expect(registry.options(scope, constraint).map((o) => o.id)).toEqual(['direct']);
  });

  it('the same entry id re-pointed at another endpoint, model or a wider routing is not approved', () => {
    const approvedRegistry = setup().registry;
    const constraint = approve(approvedRegistry, ['standard', 'direct']);
    const variants = [
      { standard: { baseURL: 'https://other.example.invalid/api/v1' } },
      { standard: { modelId: 'openai/gpt-x' } },
      { direct: { baseURL: 'https://anthropic.other.invalid/v1' } },
      { direct: { capabilities: { images: false } } },
    ];
    for (const change of variants) {
      const [[id, patch]] = Object.entries(change) as [[string, Record<string, unknown>]];
      const changed = createProviderRegistry({
        adapters: [
          openRouterAdapter({ createOpenAI, fetch: captureFetch('openai-chat').fetch, routing: { only: ['anthropic'] } }),
          anthropicAdapter({ createAnthropic, fetch: captureFetch('anthropic').fetch }),
        ],
        entries: [
          { id: 'standard', label: 'S', adapter: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', secretRef: 'OPENROUTER_KEY', baseURL: 'https://openrouter.example.invalid/api/v1', ...(id === 'standard' ? patch : {}) },
          { id: 'direct', label: 'D', adapter: 'anthropic', modelId: 'claude-sonnet-4-5', secretRef: 'ANTHROPIC_KEY', baseURL: 'https://anthropic.example.invalid/v1', capabilities: { images: true }, ...(id === 'direct' ? patch : {}) },
        ],
        defaultEntry: 'standard',
        secrets: (ref) => SECRETS[ref],
      });
      expect(changed.bindings()[id]).not.toBe(approvedRegistry.bindings()[id]);
      expect(() => changed.resolve(testScope(), id, constraint)).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
    }
    // A wider routing (no upstream restriction) is another binding as well.
    const wide = createProviderRegistry({
      adapters: [openRouterAdapter({ createOpenAI, fetch: captureFetch('openai-chat').fetch })],
      entries: [{ id: 'standard', label: 'S', adapter: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', secretRef: 'OPENROUTER_KEY', baseURL: 'https://openrouter.example.invalid/api/v1' }],
      defaultEntry: 'standard',
      secrets: (ref) => SECRETS[ref],
    });
    expect(() => wide.resolve(testScope(), 'standard', constraint)).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
  });

  it('a rotated key or renamed secret keeps the approval', () => {
    const before = setup().registry;
    const constraint = approve(before, ['direct']);
    const after = createProviderRegistry({
      adapters: [anthropicAdapter({ createAnthropic, fetch: captureFetch('anthropic').fetch })],
      entries: [{ id: 'direct', label: 'Neu', adapter: 'anthropic', modelId: 'claude-sonnet-4-5', secretRef: 'ROTATED_KEY', baseURL: 'https://anthropic.example.invalid/v1/', capabilities: { images: true } }],
      defaultEntry: 'direct',
      secrets: (ref) => (ref === 'ROTATED_KEY' ? 'test-secret-rotated' : undefined),
    });
    expect(after.bindings().direct).toBe(before.bindings().direct);
    expect(after.resolve(testScope(), undefined, constraint).id).toBe('direct');
  });

  it('an adapter without binding description is never approved by a policy', () => {
    const custom: ProviderAdapter = { id: 'custom', qualified: true, createModel: () => { throw new Error('never built'); } };
    const registry = createProviderRegistry({
      adapters: [custom],
      entries: [{ id: 'c', label: 'Custom', adapter: 'custom', modelId: 'm', secretRef: 'K' }],
      defaultEntry: 'c',
      secrets: () => 'k',
    });
    expect(registry.bindings()).toEqual({});
    expect(() => registry.resolve(testScope(), undefined, { allowed: null, defaultEntryId: 'c', userChoice: true }))
      .toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
  });

  it('without user choice only the policy default runs; an unusable default has no substitute', () => {
    const { registry } = setup();
    const scope = testScope();
    const fixed = approve(registry, ['direct', 'standard'], { userChoice: false });
    expect(registry.resolve(scope, 'direct', fixed).id).toBe('direct');
    expect(() => registry.resolve(scope, 'standard', fixed)).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
    expect(registry.options(scope, fixed).map((o) => o.id)).toEqual(['direct']);
    const noDefault = approve(registry, ['direct'], { defaultEntryId: null });
    expect(() => registry.resolve(scope, undefined, noDefault)).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
  });

  it('openRouterOnly narrows the upstream list in the request; an empty list is unavailable', async () => {
    const { registry, transports } = setup();
    const { session } = await protectedSession();
    const narrowed = approve(registry, ['standard'], { openRouterOnly: ['anthropic', 'amazon-bedrock'] });
    await generateText({ model: createPrivacyBoundary({ session }).wrapModel(registry.resolve(session.scope, undefined, narrowed).model), prompt: 'Hallo' });
    // Configured ['anthropic'] ∩ policy ['anthropic', 'amazon-bedrock'].
    expect(bodies(transports.standard.requests)[0]!.provider).toMatchObject({ only: ['anthropic'], allow_fallbacks: false });
    const disjoint = approve(registry, ['standard'], { openRouterOnly: ['google-vertex'] });
    expect(() => registry.resolve(session.scope, undefined, disjoint)).toThrow(expect.objectContaining({ code: 'provider_unavailable' }));
    const empty = approve(registry, ['standard', 'direct'], { openRouterOnly: [] });
    expect(() => registry.resolve(session.scope, 'standard', empty)).toThrow(expect.objectContaining({ code: 'provider_unavailable' }));
    expect(registry.options(session.scope, empty).map((o) => o.id)).toEqual(['direct']);
    // A direct provider is not an OpenRouter entry: the list does not touch it.
    expect(registry.resolve(session.scope, 'direct', empty).id).toBe('direct');
  });
});

describe('provider switch through the chat handler', () => {
  function tools(): ToolRegistry {
    return { noop: defineTool({ id: 'noop', description: 'Nichts.', inputSchema: z.object({}).strict(), execute: async () => ({ ok: true }) }) };
  }
  const post = (text: string, files: unknown[] = []) => new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'chat-1', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }, ...files] }] }),
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

  it('a request without a chat id is refused before the scope is built (no shared mapping)', async () => {
    const { registry, transports } = setup();
    const scope = vi.fn(config(registry, 'standard').scope);
    const handler = createAiChatHandler({ tools: tools(), systemPrompt: 'Assistent', privacy: { ...config(registry, 'standard'), scope } });
    const response = await handler(new Request('https://app.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] }] }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'privacy_scope_invalid' });
    expect(scope).not.toHaveBeenCalled();
    expect(transports.standard.requests).toHaveLength(0);
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

describe('signed provider approval through the chat handler (K1, request capture)', () => {
  const APPROVED = {
    standard: { baseURL: 'https://openrouter.example.invalid/api/v1', modelId: 'anthropic/claude-sonnet-4.5' },
    direct: { baseURL: 'https://anthropic.example.invalid/v1', modelId: 'claude-sonnet-4-5' },
  };
  type Patch = Partial<Record<'standard' | 'direct', Partial<{ baseURL: string; modelId: string }>>>;

  /**
   * The registry of this runtime; `patch` is a local change after the
   * approval, `routing` the OpenRouter options it was configured with.
   */
  function runtimeRegistry(patch: Patch = {}, routing: Parameters<typeof openRouterAdapter>[0]['routing'] = { only: ['anthropic'] }) {
    const openrouter = captureFetch('openai-chat');
    const anthropic = captureFetch('anthropic');
    const registry = createProviderRegistry({
      adapters: [
        openRouterAdapter({ createOpenAI, fetch: openrouter.fetch, routing }),
        anthropicAdapter({ createAnthropic, fetch: anthropic.fetch }),
      ],
      entries: [
        { id: 'standard', label: 'Standard', adapter: 'openrouter', secretRef: 'OPENROUTER_KEY', ...APPROVED.standard, ...patch.standard },
        { id: 'direct', label: 'Direkt', adapter: 'anthropic', secretRef: 'ANTHROPIC_KEY', capabilities: { images: true }, ...APPROVED.direct, ...patch.direct },
      ],
      defaultEntry: 'standard',
      secrets: (ref) => SECRETS[ref],
    });
    const total = () => openrouter.requests.length + anthropic.requests.length;
    return { registry, transports: { standard: openrouter, direct: anthropic }, total };
  }

  /** The block the Platform signed for the bindings reported by setup (the unchanged registry). */
  function signedBlock(userChoice: boolean): PrivacyPolicyBlock {
    const approved = runtimeRegistry().registry.bindings();
    return {
      schemaVersion: 1,
      profile: 'protected-text/v1',
      screenshots: { mode: 'blocked' },
      providers: {
        allowed: [
          { entryId: 'standard', bindingDigest: approved.standard! },
          { entryId: 'direct', bindingDigest: approved.direct! },
        ],
        defaultEntryId: 'standard',
        userChoice,
      },
      mapping: { idleTtlSeconds: 600, absoluteTtlSeconds: 1800 },
      speech: { localOnly: true, maxDurationSeconds: 30 },
    };
  }

  function handlerFor(
    registry: ReturnType<typeof runtimeRegistry>['registry'],
    block: PrivacyPolicyBlock | null,
    selection?: string,
    extra: { pipeline?: ReturnType<typeof createLocalAiPipeline>; policy?: LocalPrivacyPolicy } = {},
  ) {
    const tools: ToolRegistry = {
      list_tasks: defineTool({
        id: agentRevision.toolAllowlist[0]!, description: 'Aufgaben.', inputSchema: z.object({}).strict(), execute: async () => ({ tasks: [] }),
      }),
    };
    return createAiChatHandler({
      tools,
      systemPrompt: 'Assistent',
      ...(extra.pipeline ? { pipeline: extra.pipeline } : {}),
      attachments: { enabled: true },
      managedRuntime: {
        resolvePrincipal: async () => principal,
        resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
          turnId, agentRevision, manifestRevision, policyRevision: block ? { ...policyRevision, privacy: block } : policyRevision, principal, localLimits,
        }),
      },
      privacy: {
        shield: memoryShield(),
        scope: (_req, chat) => ({ ...testScope(), conversationId: chat.conversationId ?? 'x' }),
        knownIdentities: () => [{ id: CANARY.colleagueId, name: CANARY.colleague, email: CANARY.colleagueEmail }],
        providers: { registry, selection: () => selection },
        // The tenant rule would allow originals; only the effective policy may.
        attachments: () => ({ app: 'allow-original', tenant: 'allow-original' }),
        ...(extra.policy ? { policy: extra.policy } : {}),
      },
    });
  }
  const post = (text: string, files: unknown[] = []) => new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'chat-1', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }, ...files] }] }),
  });

  it('the approved default sends only to its approved endpoint', async () => {
    const { registry, transports } = runtimeRegistry();
    const response = await handlerFor(registry, signedBlock(false))(post(`Schreib ${CANARY.colleague}`));
    expect(response.status).toBe(200);
    await response.text();
    expect(transports.standard.requests.length).toBeGreaterThan(0);
    for (const request of transports.standard.requests) expect(request.url.startsWith(`${APPROVED.standard.baseURL}/`)).toBe(true);
    expect(transports.direct.requests).toHaveLength(0);
    expect(transports.standard.requests.map((r) => r.body).join('\n')).not.toMatch(CANARY_PATTERN);
  });

  const drifts: Array<[string, Patch]> = [
    ['another endpoint', { standard: { baseURL: 'https://drift.example.invalid/api/v1' } }],
    ['another model', { standard: { modelId: 'openai/gpt-x' } }],
  ];
  for (const [name, patch] of drifts) {
    it(`a local change of the default to ${name} after approval sends nothing (provider_not_allowed)`, async () => {
      const { registry, total } = runtimeRegistry(patch);
      const response = await handlerFor(registry, signedBlock(true))(post('Hallo'));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'provider_not_allowed' });
      // No fallback to the other approved entry either.
      expect(total()).toBe(0);
    });
  }

  it('a user choice of another approved entry without userChoice sends nothing, and nothing falls back', async () => {
    const { registry, total } = runtimeRegistry();
    const response = await handlerFor(registry, signedBlock(false), 'direct')(post('Hallo'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'provider_not_allowed' });
    expect(total()).toBe(0);
  });

  it('a user choice of a drifted entry sends nothing, even with userChoice', async () => {
    const { registry, total } = runtimeRegistry({ direct: { baseURL: 'https://anthropic.drift.invalid/v1' } });
    const response = await handlerFor(registry, signedBlock(true), 'direct')(post('Hallo'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'provider_not_allowed' });
    expect(total()).toBe(0);
  });

  describe('the classifier and every side call use the approved provider only (H2)', () => {
    const modules: ModuleDefinition[] = [{
      id: 'tasks', name: 'Aufgaben', description: 'Aufgaben lesen.', tools: ['list_tasks'],
      classification: { hint: 'Aufgaben lesen', examples: ['zeig meine aufgaben'] },
    }];
    /** A classifier model on a transport no approval covers. */
    function rogueModel() {
      const rogue = captureFetch('anthropic', { text: JSON.stringify({ moduleId: 'tasks', confidence: 0.99 }) });
      const model = createAnthropic({ apiKey: 'rogue-key', baseURL: 'https://rogue.example.invalid/v1', fetch: rogue.fetch })('claude-haiku-4-5');
      return { model, rogue };
    }
    const variants = {
      'the SDK facade': (_rogue: unknown) => generateText,
      'a callback that ignores the model it gets': (rogue: unknown) =>
        ((options: Parameters<typeof generateText>[0]) => generateText({ ...options, model: rogue as never })) as typeof generateText,
    };
    for (const [name, callback] of Object.entries(variants)) {
      it(`a configured classifier model and ${name} send nothing; classifier and answer reach only the approved endpoint`, async () => {
        const { registry, transports } = runtimeRegistry();
        const { model, rogue } = rogueModel();
        const pipeline = createLocalAiPipeline({ modules, classifier: { modules, model }, generateText: callback(model) as never });
        const response = await handlerFor(registry, signedBlock(false), undefined, { pipeline })(post(`Zeig Aufgaben von ${CANARY.colleague}`));
        expect(response.status).toBe(200);
        await response.text();
        expect(rogue.requests).toHaveLength(0);
        expect(transports.direct.requests).toHaveLength(0);
        const sent = bodies(transports.standard.requests);
        // One classifier call (non-streaming) and the streamed answer.
        expect(sent.filter((body) => body.stream !== true).length).toBeGreaterThanOrEqual(1);
        expect(sent.filter((body) => body.stream === true).length).toBeGreaterThanOrEqual(1);
        for (const request of transports.standard.requests) expect(request.url.startsWith(`${APPROVED.standard.baseURL}/`)).toBe(true);
        for (const body of sent) expect(body.model).toBe(APPROVED.standard.modelId);
        expect(transports.standard.requests.map((r) => r.body).join('\n')).not.toMatch(CANARY_PATTERN);
      });
    }

    it('under a signed list the boundary refuses any model the registry did not build under that approval', async () => {
      const { registry, transports } = runtimeRegistry();
      const { model: rogue, rogue: rogueTransport } = rogueModel();
      const { session } = await protectedSession();
      const signed = signedBlock(false);
      if (signed.profile !== 'protected-text/v1') throw new Error('fixture');
      const constraint = { allowed: signed.providers.allowed, defaultEntryId: 'standard', userChoice: false };
      const resolved = registry.resolve(session.scope, undefined, constraint);
      expect(registry.approves(resolved.model, constraint)).toBe(true);
      // The same model under another constraint, a foreign model, a non-object: refused.
      expect(registry.approves(resolved.model, { ...constraint })).toBe(false);
      expect(registry.approves(rogue, constraint)).toBe(false);
      expect(registry.approves(null, constraint)).toBe(false);
      const boundary = createPrivacyBoundary({
        session,
        approveModel: (model) => { if (!registry.approves(model, constraint)) throw Object.assign(new Error('provider_not_allowed'), { code: 'provider_not_allowed' }); },
      });
      expect(() => boundary.wrapModel(rogue)).toThrow(expect.objectContaining({ code: 'provider_not_allowed' }));
      await generateText({ model: boundary.wrapModel(resolved.model), prompt: 'Hallo' });
      expect(rogueTransport.requests).toHaveLength(0);
      expect(transports.standard.requests).toHaveLength(1);
    });
  });

  describe('the routing on the wire is exactly the approved one (M4)', () => {
    const STRICT = { only: ['anthropic'], allow_fallbacks: false, data_collection: 'deny', zdr: true };
    const sloppy: Array<[string, Record<string, unknown>]> = [
      ['undefined strict fields', { only: ['anthropic'], allow_fallbacks: undefined, data_collection: undefined, zdr: undefined }],
      ['widening strict fields', { only: ['anthropic'], allow_fallbacks: true, data_collection: 'allow', zdr: false, order: ['openai'] }],
    ];
    for (const [name, routing] of sloppy) {
      it(`an adapter configured with ${name} has the approved digest and sends exactly the strict routing`, async () => {
        const approved = runtimeRegistry().registry.bindings();
        const { registry, transports } = runtimeRegistry({}, routing as never);
        expect(registry.bindings()).toEqual(approved);
        const response = await handlerFor(registry, signedBlock(false))(post('Hallo'));
        expect(response.status).toBe(200);
        await response.text();
        const sent = bodies(transports.standard.requests);
        expect(sent.length).toBeGreaterThan(0);
        for (const body of sent) expect(body.provider).toEqual(STRICT);
      });
    }
  });

  describe('local restrictions without a signed block run as the digest reports (M5)', () => {
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')}`;
    const shot = { type: 'file', mediaType: 'image/png', url: png, filename: 'shot.png' };

    it('providerEntryIds narrow the offer: another entry is refused with 403 and nothing is sent', async () => {
      const { registry, total } = runtimeRegistry();
      const response = await handlerFor(registry, null, 'direct', { policy: { providerEntryIds: ['standard'] } })(post('Hallo'));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'provider_not_allowed' });
      expect(total()).toBe(0);
    });

    it('openRouterOnly reaches the wire', async () => {
      const { registry, transports } = runtimeRegistry({}, {});
      const response = await handlerFor(registry, null, undefined, { policy: { openRouterOnly: ['anthropic'] } })(post('Hallo'));
      expect(response.status).toBe(200);
      await response.text();
      const sent = bodies(transports.standard.requests);
      expect(sent.length).toBeGreaterThan(0);
      for (const body of sent) expect(body.provider).toEqual({ only: ['anthropic'], allow_fallbacks: false, data_collection: 'deny', zdr: true });
    });

    it('screenshots stay blocked although the tenant rule allows originals; only the declared mode opens them', async () => {
      const blocked = runtimeRegistry();
      const refused = await handlerFor(blocked.registry, null, 'direct')(post('Bild', [shot]));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'privacy_attachment_blocked' });
      expect(blocked.total()).toBe(0);

      const declared = runtimeRegistry();
      const response = await handlerFor(declared.registry, null, 'direct', { policy: { screenshots: { mode: 'allow-original' } } })(post('Bild', [shot]));
      expect(response.status).toBe(200);
      await response.text();
      expect(declared.transports.direct.requests.length).toBeGreaterThan(0);
      expect(declared.transports.direct.requests[0]!.body).toContain('"image"');
    });

    it('a signed blocked mode is not widened by the tenant rule either', async () => {
      const { registry, total } = runtimeRegistry();
      const response = await handlerFor(registry, signedBlock(true), 'direct', { policy: { screenshots: { mode: 'allow-original' } } })(post('Bild', [shot]));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'privacy_attachment_blocked' });
      expect(total()).toBe(0);
    });
  });
});
