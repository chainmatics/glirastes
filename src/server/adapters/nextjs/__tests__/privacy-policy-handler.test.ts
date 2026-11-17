/**
 * The signed privacy block of the pinned snapshot in the chat handler (K1,
 * K4, K5 of the Platform cut): it decides whether a turn is protected,
 * narrows providers, screenshots and lifetimes, and a revocation of it stops
 * the next model call or tool execution of the running turn.
 */
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PrivacyPolicyBlock } from '../../../../contracts/privacy-policy.js';
import type { SecurityRevocation } from '../../../../contracts/revisions.js';
import { defineTool } from '../../../../types.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from '../../../../runtime/__tests__/turn-snapshot.test.js';
import { createTurnSnapshot } from '../../../../runtime/turn-snapshot.js';
import type { ChatPrivacyConfig } from '../../../pii-shield/chat-privacy.js';
import { PrivacyError } from '../../../pii-shield/detection-result.js';
import { createMemoryPrivacyMappingStore } from '../../../pii-shield/mapping-store.js';
import { createProviderRegistry, type ProviderAdapter } from '../../../pii-shield/provider-registry.js';
import { CANARY, CANARY_PATTERN, memoryShield, testScope } from '../../../pii-shield/__tests__/privacy-fixtures.js';
import { createAiChatHandler } from '../create-ai-chat-handler.js';
import type { ManagedLocalRuntimeConfig } from '../types.js';
import { streamChunks } from './command-fixtures.js';
import { PrivacyDecisionsEventSchema, type RuntimeMetricEvent } from '../../../../contracts/events.js';
import type { RuntimeMetricsSink } from '../../../../runtime/metrics/turn-recorder.js';
import { privacyDecisionRecorderFor } from '../../../../runtime/metrics/privacy-decisions.js';
import { effectivePrivacyPolicyDigest, privacyPolicyDigest } from '../../../../sync/privacy-digest.js';
import { mergePrivacyPolicy } from '../../../../contracts/privacy-policy.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function lastUserText(prompt: LanguageModelV3Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]!;
    if (message.role !== 'user') continue;
    return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

/** Echoes the latest user text; with `toolFirst`, step 1 calls `list_tasks` and runs `onFirst`. */
function echoModel(options: { toolFirst?: boolean; onFirst?: () => void } = {}) {
  const calls: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (call) => {
      calls.push(call);
      if (calls.length === 1) options.onFirst?.();
      const text = lastUserText(call.prompt);
      return {
        stream: convertArrayToReadableStream((options.toolFirst && calls.length === 1
          ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'list_tasks', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]
          : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: `Echo: ${text}` },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]) as never),
      };
    },
  });
  return { model, calls };
}

const DIGEST_OTHER = `sha256:${'B'.repeat(43)}`;

/** A registry with two entries whose adapter describes its binding. */
function providers() {
  const models: Record<string, ReturnType<typeof echoModel>> = { main: echoModel(), second: echoModel() };
  const adapter: ProviderAdapter = {
    id: 'fake',
    qualified: true,
    binding: { protocol: 'openai-chat', defaultEndpoint: 'https://models.example.invalid/v1' },
    createModel: ({ modelId }) => models[modelId]!.model,
  };
  const registry = createProviderRegistry({
    adapters: [adapter],
    entries: [
      { id: 'main', label: 'Main', adapter: 'fake', modelId: 'main', secretRef: 'K' },
      { id: 'second', label: 'Second', adapter: 'fake', modelId: 'second', secretRef: 'K' },
    ],
    defaultEntry: 'main',
    secrets: () => 'test-secret',
  });
  return { registry, models };
}

function block(registry: ReturnType<typeof providers>['registry'], extra: Partial<Extract<PrivacyPolicyBlock, { profile: 'protected-text/v1' }>> = {}): PrivacyPolicyBlock {
  return {
    schemaVersion: 1,
    profile: 'protected-text/v1',
    screenshots: { mode: 'blocked' },
    providers: {
      allowed: [
        { entryId: 'main', bindingDigest: registry.bindings().main! },
        { entryId: 'second', bindingDigest: registry.bindings().second! },
      ],
      defaultEntryId: 'main',
      userChoice: false,
    },
    mapping: { idleTtlSeconds: 600, absoluteTtlSeconds: 1800 },
    speech: { localOnly: true, maxDurationSeconds: 30 },
    ...extra,
  };
}

const listTasks = vi.fn(async () => ({ tasks: [] }));
const tools = {
  list_tasks: defineTool({
    id: agentRevision.toolAllowlist[0]!,
    description: 'List visible tasks.',
    inputSchema: z.object({}).strict(),
    execute: listTasks,
  }),
};

function managed(privacy: PrivacyPolicyBlock | undefined, extra: Partial<ManagedLocalRuntimeConfig> = {}): ManagedLocalRuntimeConfig {
  return {
    resolvePrincipal: async () => principal,
    resolveTurnSnapshot: async ({ turnId }) => createTurnSnapshot({
      turnId,
      agentRevision,
      manifestRevision,
      policyRevision: { ...policyRevision, ...(privacy ? { privacy } : {}) },
      principal,
      localLimits,
    }),
    ...extra,
  };
}

function revocationOf(policyRevisionId: string): SecurityRevocation {
  return {
    revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a99',
    environmentId: manifestRevision.environmentId,
    effectiveAt: '2026-11-17T10:00:00.000Z',
    reasonCode: 'privacy-policy-revoked',
    toolIds: [],
    agentRevisionIds: [],
    policyRevisionIds: [policyRevisionId],
    signature: { algorithm: 'Ed25519', keyId: 'key-1', value: 'c2lnbmF0dXJl' },
  };
}

function privacyConfig(extra: Partial<ChatPrivacyConfig> = {}): ChatPrivacyConfig {
  const scope = testScope({ conversationId: 'chat-1' });
  return {
    shield: memoryShield(),
    scope: (_req, chat) => ({ ...scope, conversationId: chat.conversationId }),
    knownIdentities: () => [{ id: CANARY.userId, name: CANARY.name, email: CANARY.email }],
    ...extra,
  };
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const user = (text: string, parts: unknown[] = []) => ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }, ...parts] });
const post = (messages: unknown[]) => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'chat-1', messages }),
});

describe('signed privacy block in the chat handler', () => {
  it('a protected block without privacy configured is refused before any model call', async () => {
    const { registry } = providers();
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({ tools, model, systemPrompt: 'Assistant', managedRuntime: managed(block(registry)) });
    const response = await handler(post([user(`Hallo, ich bin ${CANARY.name}`)]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'privacy_not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('a signed approval list without a provider registry is refused (privacy_not_configured)', async () => {
    const { registry } = providers();
    const { model, calls } = echoModel();
    const onDecision = vi.fn();
    const handler = createAiChatHandler({
      tools, model, systemPrompt: 'Assistant', managedRuntime: managed(block(registry)), privacy: privacyConfig({ onDecision }),
    });
    const response = await handler(post([user('Hallo')]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'privacy_not_configured' });
    expect(calls).toHaveLength(0);
    expect(onDecision).toHaveBeenCalledWith('privacy_not_configured');
  });

  it('runs the approved default; another choice without user choice is refused without fallback', async () => {
    const { registry, models } = providers();
    const handlerModel = echoModel();
    let selection: string | undefined;
    const handler = createAiChatHandler({
      tools, model: handlerModel.model, systemPrompt: 'Assistant', managedRuntime: managed(block(registry)),
      privacy: privacyConfig({ providers: { registry, selection: () => selection } }),
    });
    const ok = await handler(post([user(`Ich bin ${CANARY.name}`)]));
    expect(ok.status).toBe(200);
    await streamChunks(ok);
    expect(models.main!.calls).toHaveLength(1);
    expect(JSON.stringify(models.main!.calls)).not.toMatch(CANARY_PATTERN);
    expect(handlerModel.calls).toHaveLength(0);
    selection = 'second';
    const refused = await handler(post([user('Nochmal')]));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'provider_not_allowed' });
    expect(models.second!.calls).toHaveLength(0);
  });

  it('an approval for another binding of the same entry id does not apply', async () => {
    const { registry, models } = providers();
    const signed = block(registry, {
      providers: { allowed: [{ entryId: 'main', bindingDigest: DIGEST_OTHER }], defaultEntryId: 'main', userChoice: false },
    });
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant', managedRuntime: managed(signed),
      privacy: privacyConfig({ providers: { registry } }),
    });
    const response = await handler(post([user('Hallo')]));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'provider_not_allowed' });
    expect(models.main!.calls).toHaveLength(0);
  });

  it('a signed screenshot block wins over a local allow-original', async () => {
    const { registry, models } = providers();
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant', managedRuntime: managed(block(registry)),
      attachments: { enabled: true },
      privacy: privacyConfig({ providers: { registry }, attachments: () => ({ app: 'allow-original' }) }),
    } as never);
    const response = await handler(post([user('Was siehst du?', [{ type: 'file', mediaType: 'image/png', url: PNG }])]));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'privacy_attachment_blocked' });
    expect(models.main!.calls).toHaveLength(0);
  });

  it('opens the mapping with the lifetimes of the signed policy', async () => {
    const { registry } = providers();
    const store = createMemoryPrivacyMappingStore();
    const load = vi.spyOn(store, 'load');
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant', managedRuntime: managed(block(registry)),
      privacy: privacyConfig({ shield: memoryShield({ store }), providers: { registry }, policy: { mapping: { idleTtlSeconds: 300 } } }),
    });
    await streamChunks(await handler(post([user('Hallo')])));
    expect(load).toHaveBeenCalledWith(expect.anything(), { idleTtlMs: 300_000, absoluteTtlMs: 1_800_000 });
  });

  it('a revocation of the pinned policy at turn start is refused before any model call', async () => {
    const { registry, models } = providers();
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant',
      managedRuntime: managed(block(registry), { loadRevocations: async () => [revocationOf(policyRevision.revisionId)] }),
      privacy: privacyConfig({ providers: { registry } }),
    });
    const response = await handler(post([user('Hallo')]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'privacy_policy_revoked' });
    expect(models.main!.calls).toHaveLength(0);
  });

  async function revocationTurn(revokeWhen: 'before-tool' | 'during-tool') {
    let revoked = false;
    const routed = echoModel({ toolFirst: true, onFirst: () => { if (revokeWhen === 'before-tool') revoked = true; } });
    const adapter: ProviderAdapter = {
      id: 'fake', qualified: true,
      binding: { protocol: 'openai-chat', defaultEndpoint: 'https://models.example.invalid/v1' },
      createModel: () => routed.model,
    };
    const registry = createProviderRegistry({
      adapters: [adapter],
      entries: [{ id: 'main', label: 'Main', adapter: 'fake', modelId: 'main', secretRef: 'K' }],
      defaultEntry: 'main',
      secrets: () => 'test-secret',
    });
    const signed = block(registry, {
      providers: { allowed: [{ entryId: 'main', bindingDigest: registry.bindings().main! }], defaultEntryId: 'main', userChoice: false },
    });
    listTasks.mockReset();
    listTasks.mockImplementation(async () => {
      if (revokeWhen === 'during-tool') revoked = true;
      return { tasks: [] };
    });
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant',
      managedRuntime: managed(signed, { loadRevocations: async () => (revoked ? [revocationOf(policyRevision.revisionId)] : []) }),
      privacy: privacyConfig({ providers: { registry } }),
    });
    const response = await handler(post([user('Zeig meine Aufgaben')]));
    expect(response.status).toBe(200);
    const chunks = await streamChunks(response);
    return { routed, chunks };
  }

  it('a revocation before a tool runs stops the tool and the next model step', async () => {
    const { routed, chunks } = await revocationTurn('before-tool');
    expect(listTasks).not.toHaveBeenCalled();
    expect(routed.calls).toHaveLength(1);
    expect(JSON.stringify(chunks)).not.toMatch(/Echo:/);
  });

  it('a revocation that lands while a tool runs stops the next model step', async () => {
    const { routed, chunks } = await revocationTurn('during-tool');
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(routed.calls).toHaveLength(1);
    expect(JSON.stringify(chunks)).not.toMatch(/Echo:/);
  });

  it('a privacy lock that arrives during a protected turn stops the tool and the next model step', async () => {
    let locked = false;
    const routed = echoModel({ toolFirst: true, onFirst: () => { locked = true; } });
    const adapter: ProviderAdapter = {
      id: 'fake', qualified: true,
      binding: { protocol: 'openai-chat', defaultEndpoint: 'https://models.example.invalid/v1' },
      createModel: () => routed.model,
    };
    const registry = createProviderRegistry({
      adapters: [adapter],
      entries: [{ id: 'main', label: 'Main', adapter: 'fake', modelId: 'main', secretRef: 'K' }],
      defaultEntry: 'main',
      secrets: () => 'test-secret',
    });
    const signed = block(registry, {
      providers: { allowed: [{ entryId: 'main', bindingDigest: registry.bindings().main! }], defaultEntryId: 'main', userChoice: false },
    });
    listTasks.mockReset();
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant',
      managedRuntime: managed(signed, { privacyGate: () => { if (locked) throw new PrivacyError('privacy_not_configured'); } }),
      privacy: privacyConfig({ providers: { registry } }),
    });
    const response = await handler(post([user('Zeig meine Aufgaben')]));
    expect(response.status).toBe(200);
    const chunks = await streamChunks(response);
    expect(listTasks).not.toHaveBeenCalled();
    expect(routed.calls).toHaveLength(1);
    expect(JSON.stringify(chunks)).not.toMatch(/Echo:/);
  });

  it('runs only what the runtime reports: another registry or local policy than createGlirastes is refused', async () => {
    const { registry, models } = providers();
    const signed = block(registry);
    const reported = effectivePrivacyPolicyDigest(mergePrivacyPolicy(
      signed, { required: true }, { bindings: registry.bindings(), defaultEntryId: registry.defaultEntryId },
    )!);
    const matching = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant',
      managedRuntime: managed(signed, { privacyEffectiveDigest: () => reported }),
      privacy: privacyConfig({ providers: { registry } }),
    });
    const ok = await matching(post([user('Hallo')]));
    expect(ok.status).toBe(200);
    await streamChunks(ok);
    expect(models.main!.calls).toHaveLength(1);

    const onError = vi.fn();
    const differing = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant', onError,
      managedRuntime: managed(signed, { privacyEffectiveDigest: () => reported }),
      // A shorter local lifetime than the runtime's: another effective policy.
      privacy: privacyConfig({ providers: { registry }, policy: { mapping: { idleTtlSeconds: 60 } } }),
    });
    const refused = await differing(post([user('Hallo')]));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'privacy_not_configured' });
    expect(models.main!.calls).toHaveLength(1);
    expect(onError.mock.calls.map(([error]) => (error as { name: string }).name)).toContain('PrivacyConfigMismatch');

    // A handler without privacy while the runtime reports a protected policy.
    const { model, calls } = echoModel();
    const unprotected = createAiChatHandler({
      tools, model, systemPrompt: 'Assistant',
      managedRuntime: managed(undefined, { privacyEffectiveDigest: () => reported }),
    });
    const blocked = await unprotected(post([user('Hallo')]));
    expect(blocked.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('required: false without a protected block leaves the turn unprotected', async () => {
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({
      tools, model, systemPrompt: 'Assistant', managedRuntime: managed({ schemaVersion: 1, profile: 'off' }),
      privacy: privacyConfig({ policy: { required: false } }),
    });
    const response = await handler(post([user(`Ich bin ${CANARY.name}`)]));
    expect(response.status).toBe(200);
    await streamChunks(response);
    expect(JSON.stringify(calls)).toContain(CANARY.name);
  });

  it('a privacy gate of the runtime refuses with its code', async () => {
    const { model, calls } = echoModel();
    const handler = createAiChatHandler({
      tools, model, systemPrompt: 'Assistant',
      managedRuntime: managed(undefined, { privacyGate: () => { throw new PrivacyError('privacy_policy_unavailable'); } }),
      privacy: privacyConfig(),
    });
    const response = await handler(post([user('Hallo')]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'privacy_policy_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('counts content-free decisions of a protected turn', async () => {
    const { registry } = providers();
    const onDecision = vi.fn();
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant', managedRuntime: managed(block(registry)),
      privacy: privacyConfig({ providers: { registry }, onDecision }),
    });
    await streamChunks(await handler(post([user(`Ich bin ${CANARY.name}`)])));
    const codes = onDecision.mock.calls.map(([code]) => code);
    expect(codes).toContain('turn_protected');
    expect(codes).toContain('model_call_protected');
    expect(JSON.stringify(onDecision.mock.calls)).not.toMatch(CANARY_PATTERN);
  });

  it('reports the decisions as privacy.decisions under the pinned policy through the metrics sink', async () => {
    const { registry } = providers();
    const events: RuntimeMetricEvent[] = [];
    const metrics: RuntimeMetricsSink = {
      identity: { appId: manifestRevision.targetAppId, environmentId: manifestRevision.environmentId, buildId: null, instanceId: 'web-1' },
      record: (event) => { events.push(event); },
      flush: async () => undefined,
      close: async () => undefined,
    };
    const signed = block(registry);
    const handler = createAiChatHandler({
      tools, model: echoModel().model, systemPrompt: 'Assistant', managedRuntime: managed(signed),
      privacy: privacyConfig({ providers: { registry } }), metrics,
    });
    await streamChunks(await handler(post([user(`Ich bin ${CANARY.name}`)])));
    privacyDecisionRecorderFor(metrics).flush();
    const decisions = events.filter((event) => event.eventType === 'privacy.decisions');
    expect(decisions).toHaveLength(1);
    const [event] = decisions;
    expect(PrivacyDecisionsEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({ policyRevisionId: policyRevision.revisionId, privacyDigest: privacyPolicyDigest(signed) });
    expect(event?.eventType === 'privacy.decisions' && event.decisions.map(({ code }) => code))
      .toEqual(expect.arrayContaining(['turn_protected', 'model_call_protected']));
    expect(JSON.stringify(events)).not.toMatch(CANARY_PATTERN);
  });
});
