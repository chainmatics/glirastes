/**
 * One runner process of the privacy restart proof
 * (privacy-restart.process.test.ts). It reads a scenario file, starts a
 * connected `createGlirastes` against an in-process fake Platform, with a
 * `FileRuntimeStateStore` at the scenario's path, waits for `ready()`, then
 * tries one chat turn and one recording and prints content-free counters as
 * one JSON line. The parent compares the counters across two processes.
 */
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type {
  ExecutionBudget,
  Principal,
  RuntimeDeploymentBundle,
  RuntimeRevisionEnvelope,
} from '../../contracts/index.js';
import type { PrivacyPolicyBlock } from '../../contracts/privacy-policy.js';
import { createAiChatHandler } from '../../server/adapters/nextjs/create-ai-chat-handler.js';
import { createRecordingTranscriptionHandler } from '../../server/adapters/nextjs/recording-transcription-handler.js';
import { endpointToolToTool } from '../../server/core/index.js';
import { createProviderRegistry, openRouterAdapter } from '../../server/pii-shield/provider-registry.js';
import { CANARY, CANARY_PATTERN, captureFetch, memoryShield, testScope } from '../../server/pii-shield/__tests__/privacy-fixtures.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import { FileRuntimeStateStore } from '../../sync/state-store.js';
import type { GeneratedEndpointToolBinding, GeneratedToolModule } from '../contract-bindings.js';
import { createGlirastes } from '../glirastes.js';
import { createLocalSchemaDigest } from '../local-tool-bindings.js';

export interface RestartScenario {
  statePath: string;
  privateKeyPem: string;
  platform: 'serve' | 'unreachable';
  /** The active deployment the Platform serves. */
  deployment?: { revision: number; profile: 'protected' | 'off'; bindingMatches?: boolean };
  /** false: a legacy runner without `privacy` and without a state store. */
  managed: boolean;
  /** Keep the persisted binding/store while removing activation/infrastructure. */
  retainedStore?: boolean;
  firstSyncTimeoutMs: number;
}

export interface RestartReport {
  chatStatus: number;
  chatError: string | null;
  /** Requests to the approved provider endpoint. */
  providerRequests: number;
  providerSawCanary: boolean;
  /** Calls of the handler's fallback model (the unprotected path). */
  fallbackModelCalls: number;
  audioStatus: number;
  /** Requests to the cloud speech service. */
  audioCloudRequests: number;
  policy: string;
  capabilityClaimed: boolean;
  appliedReported: boolean;
  privacyStates: string[];
  errors: string[];
}

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const APP_ID = id('3903');
const ENVIRONMENT_ID = id('3901');
const TENANT_ID = id('3902');
const TOOL_ID = id('a1');
const env = { GLIRASTES_API_KEY: `gl_${'k'.repeat(40)}`, GLIRASTES_CONTROL_PLANE_URL: 'https://control.example' };
const limits: ExecutionBudget = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};
const inputSchema = z.object({ status: z.enum(['open', 'done']).optional() }).strict();
const outputSchema = z.object({ tasks: z.array(z.string()) });

function generated(): GeneratedToolModule {
  const tool = {
    toolId: TOOL_ID, sourceFingerprint: digest('G'), name: 'tasks.list', description: 'List tasks.',
    modelName: 'tasks_list', module: 'tasks', sharedWith: [], usageHints: ['List tasks.'],
    presentation: { locale: 'en-US', singular: 'Task', plural: 'Tasks', approval: 'List tasks' },
    executionKind: 'endpoint', method: 'GET', path: '/api/tasks', authBindingRef: 'endpoint-authorization',
    allowedRoles: [], operationGroup: 'read', riskClass: 'safe-read', enabled: true, requiresApproval: false,
    inputSchemaDigest: createLocalSchemaDigest(inputSchema), outputSchemaDigest: createLocalSchemaDigest(outputSchema),
  };
  return {
    setupArtifact: {
      schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: APP_ID, discoveryDigest: digest('D'),
      assessmentMode: 'autonomous', status: 'ready', tools: [tool],
      planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [TOOL_ID] },
      prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('H'), responseStyleDigest: digest('I'), capabilityFragmentDigests: {} },
      warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
    },
    createToolBindings: () => [{
      toolId: TOOL_ID, definitionId: tool.name, executionKind: 'endpoint', method: 'GET', path: '/api/tasks',
      sourceFingerprint: tool.sourceFingerprint, inputSchemaDigest: tool.inputSchemaDigest,
      outputSchemaDigest: tool.outputSchemaDigest, inputSchema, outputSchema,
      tool: endpointToolToTool({
        id: tool.name, toolName: tool.modelName, description: tool.description,
        method: 'GET', path: '/api/tasks', inputSchema, needsApproval: false,
      }),
    } satisfies GeneratedEndpointToolBinding],
  } as GeneratedToolModule;
}

function revision(privateKey: KeyObject, input: Omit<RuntimeRevisionEnvelope, 'contentHash' | 'signature'>): RuntimeRevisionEnvelope {
  const contentHash = `sha256:${createHash('sha256').update(canonicalRuntimeJson(input.payload)).digest('base64url')}`;
  const unsigned = { ...input, contentHash };
  return {
    ...unsigned,
    signature: { algorithm: 'Ed25519', keyId: 'runtime-key', value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url') },
  };
}

function deployment(privateKey: KeyObject, revisionNumber: number, privacy: PrivacyPolicyBlock): RuntimeDeploymentBundle {
  const common = { schemaVersion: 1 as const, revision: revisionNumber, tenantId: TENANT_ID, targetAppId: APP_ID, publishedAt: '2026-07-29T00:00:00.000Z' };
  const n = String(revisionNumber);
  return {
    deploymentId: id(`${n}904`), environmentId: ENVIRONMENT_ID, status: 'active', rolloutMode: 'stable',
    targetPercentage: 100, pinned: false, healthStatus: 'healthy',
    agentRevision: revision(privateKey, {
      ...common, revisionId: id(`${n}905`), revisionType: 'agent', subjectId: id('3906'),
      payload: { name: 'Task agent', objective: 'Manage tasks', modelAlias: 'standard', promptBindingRef: 'local://prompts/task-agent', toolAllowlist: [], budget: limits },
    }),
    manifestRevision: revision(privateKey, {
      ...common, revisionId: id(`${n}907`), revisionType: 'manifest', environmentId: ENVIRONMENT_ID,
      payload: { sourceDigest: 'sha256:YWJj', tools: [] },
    }),
    policyRevision: revision(privateKey, {
      ...common, revisionId: id(`${n}908`), revisionType: 'policy', environmentId: ENVIRONMENT_ID,
      payload: { budget: limits, toolPolicies: [], privacy },
    }),
    updatedAt: '2026-07-29T00:01:00.000Z',
  };
}

/** A one-second, silent 16 kHz mono WAV. */
function wav(): ArrayBuffer {
  const samples = 16_000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24); buffer.writeUInt32LE(32_000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function run(scenario: RestartScenario): Promise<RestartReport> {
  const privateKey = createPrivateKey(scenario.privateKeyPem);
  const publicJwk = { ...createPrivateKey(scenario.privateKeyPem).export({ format: 'jwk' }) };
  delete (publicJwk as { d?: string }).d;

  const provider = captureFetch('openai-chat');
  const registry = createProviderRegistry({
    adapters: [openRouterAdapter({ createOpenAI, fetch: provider.fetch, routing: { only: ['anthropic'] } })],
    entries: [{ id: 'main', label: 'Main', adapter: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', secretRef: 'K', baseURL: 'https://openrouter.example.invalid/api/v1' }],
    defaultEntry: 'main',
    secrets: () => 'test-secret-openrouter',
  });
  const block = (spec: NonNullable<RestartScenario['deployment']>): PrivacyPolicyBlock => (spec.profile === 'off'
    ? { schemaVersion: 1, profile: 'off' }
    : {
        schemaVersion: 1, profile: 'protected-text/v1', screenshots: { mode: 'blocked' },
        providers: {
          allowed: [{ entryId: 'main', bindingDigest: spec.bindingMatches === false ? digest('A') : registry.bindings().main! }],
          defaultEntryId: 'main', userChoice: false,
        },
        mapping: { idleTtlSeconds: 1800, absoluteTtlSeconds: 7200 },
        speech: { localOnly: true, maxDurationSeconds: 45 },
      });

  const calls: Array<{ url: string; body: string }> = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (scenario.platform === 'unreachable') throw new TypeError('fetch failed');
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    if (url.includes('/v1/runtime/connection')) return json({ schemaVersion: 1, appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'runner-1' });
    if (url.includes('jwks')) return json({ keys: [{ ...publicJwk, kid: 'runtime-key', alg: 'EdDSA', use: 'sig' }] });
    if (url.includes('/sync?')) {
      return json({
        cursor: '2026-07-29T00:02:00.000Z', activeSnapshotComplete: true,
        deployments: scenario.deployment ? [deployment(privateKey, scenario.deployment.revision, block(scenario.deployment))] : [],
        revocations: [],
      });
    }
    if (url.includes('/metrics/events')) return new Response(null, { status: 202 });
    if (url.includes('/runtime-setup')) {
      return json({ runId: id('b2'), appId: APP_ID, status: 'ready', artifactDigest: digest('Z'), updatedAt: '2026-10-04T08:00:00.000Z' });
    }
    return json({ ok: true });
  }) as typeof fetch;

  const errors: string[] = [];
  const shield = memoryShield();
  // The signed policy decides; no local requirement keeps a turn protected.
  const local = { required: false } as const;
  const glirastes = createGlirastes({
    generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 60_000,
    firstSyncTimeoutMs: scenario.firstSyncTimeoutMs,
    onError: (error) => { errors.push((error as Error).name); },
    ...(scenario.managed
      ? { privacy: { managed: true, shield, providers: registry, local }, stateEnvironmentId: ENVIRONMENT_ID, stateStore: () => new FileRuntimeStateStore(scenario.statePath) }
      : scenario.retainedStore ? {stateEnvironmentId: ENVIRONMENT_ID, stateStore: () => new FileRuntimeStateStore(scenario.statePath)} : {}),
  });
  await glirastes.ready();

  let fallbackModelCalls = 0;
  const fallback = new MockLanguageModelV3({
    doStream: async () => {
      fallbackModelCalls += 1;
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
      ];
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  });
  const principal = (tenantId: string): Principal => ({ subjectId: 'alice', tenantId, roles: ['member'], attributes: {} });
  const handler = createAiChatHandler({
    ...(await glirastes.chatTurn(principal)),
    model: fallback,
    systemPrompt: 'Assistent',
    onError: (error) => { errors.push((error as Error).name); },
    ...(scenario.managed
      ? {
          privacy: {
            shield,
            scope: (_req: Request, chat: { conversationId?: string }) => ({ ...testScope(), conversationId: chat.conversationId ?? 'x' }),
            knownIdentities: () => [{ id: CANARY.colleagueId, name: CANARY.colleague, email: CANARY.colleagueEmail }],
            providers: { registry },
            policy: local,
          },
        }
      : {}),
  });
  const chat = await handler(new Request('https://app.example/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'chat-1', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: `Schreib ${CANARY.colleague}` }] }] }),
  }));
  const chatBody = await chat.text();
  let chatError: string | null = null;
  try {
    chatError = chat.status === 200 ? null : (JSON.parse(chatBody) as { error?: string }).error ?? null;
  } catch {
    chatError = 'unparsed';
  }

  let audioCloudRequests = 0;
  const recording = createRecordingTranscriptionHandler({
    authorize: () => true,
    url: 'https://stt.cloud.example.invalid',
    localOnly: false,
    policy: () => glirastes.speechPolicy(),
    fetch: (async () => { audioCloudRequests += 1; return Response.json({ text: 'ok' }); }) as typeof fetch,
    onError: () => undefined,
  });
  const audio = await recording(new Request('https://app.example/api/speech?language=de', {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav(),
  }));

  let policy: string;
  try {
    policy = glirastes.privacyPolicy()?.source ?? 'off';
  } catch (error) {
    policy = (error as { code?: string }).code ?? 'error';
  }
  const register = calls.find(({ url }) => url.endsWith('/register'));
  const heartbeats = calls.filter(({ url }) => url.includes('/heartbeat')).map(({ body }) => JSON.parse(body) as Record<string, unknown>);
  await glirastes.stop();
  return {
    chatStatus: chat.status,
    chatError,
    providerRequests: provider.requests.length,
    providerSawCanary: CANARY_PATTERN.test(provider.requests.map((r) => r.body).join('\n')),
    fallbackModelCalls,
    audioStatus: audio.status,
    audioCloudRequests,
    policy,
    capabilityClaimed: register ? 'privacyPolicyVersions' in ((JSON.parse(register.body) as { capabilities?: object }).capabilities ?? {}) : false,
    appliedReported: heartbeats.some((beat) => 'lastAppliedDeploymentId' in beat),
    privacyStates: heartbeats.map((beat) => String(((beat.technicalMetadata as { privacy?: { state?: string } } | undefined)?.privacy?.state) ?? 'none')),
    errors: [...new Set(errors)],
  };
}

const scenario = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as RestartScenario;
run(scenario).then(
  (report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(`runner failed: ${(error as Error).name}: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
