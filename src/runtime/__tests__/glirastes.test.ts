import {createOpenAI} from '@ai-sdk/openai';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {materializeConnectionEnvironment} from '../../cli/commands/connection-environment.js';
import {createLocalAiPipeline} from '../../server/local-pipeline.js';
import {generateText} from 'ai';
import { createAiChatHandler } from '../../server/adapters/nextjs/create-ai-chat-handler.js';
import { providerAdapters } from '../../server/pii-shield/__tests__/privacy-fixtures.js';
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  ExecutionBudget,
  Principal,
  RuntimeDeploymentBundle,
  RuntimeRevisionEnvelope,
  SecurityRevocation,
} from '../../contracts/index.js';
import { endpointToolToTool } from '../../server/core/index.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import { RuntimeControlPlaneRequestError } from '../../sync/control-plane-client.js';
import type {
  GeneratedEndpointToolBinding,
  GeneratedToolBinding,
  GeneratedToolModule,
} from '../contract-bindings.js';
import type { AiChatHandlerConfig } from '../../server/adapters/nextjs/types.js';
import { createGlirastes, type Glirastes, type GlirastesChatTurn } from '../glirastes.js';
import type { PrivacyPolicyBlock } from '../../contracts/privacy-policy.js';
import { isPrivacyError } from '../../server/pii-shield/detection-result.js';
import type { GlirastesPrivacyOptions } from '../privacy-runtime.js';
import { SDK_VERSION } from '../sdk-version.js';
import {
  MemoryRuntimeStateStore,
  type RuntimeStateStore,
  type RuntimeSyncState,
} from '../../sync/state-store.js';
import { createLocalSchemaDigest } from '../local-tool-bindings.js';

/**
 * A test stand-in, declared durable on purpose: process memory shared by two
 * instances, with switchable load and save failures. It proves the rules in
 * one process; the restart proof runs in separate processes
 * (privacy-restart.process.test.ts) on a FileRuntimeStateStore.
 */
class SharedDurableTestStore implements RuntimeStateStore {
  readonly durable = true;
  readonly inner = new MemoryRuntimeStateStore();
  failLoad = false;
  failSave = false;
  saves = 0;
  async load(): Promise<RuntimeSyncState | null> {
    if (this.failLoad) throw new Error('EIO: state unreadable');
    return this.inner.load();
  }
  async saveAtomic(state: RuntimeSyncState): Promise<void> {
    if (this.failSave) throw new Error('ENOSPC: disk full');
    this.saves += 1;
    await this.inner.saveAtomic(state);
  }
}

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de1d${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const APP_ID = id('3903');
const OTHER_APP_ID = id('3999');
const ENVIRONMENT_ID = id('3901');
const TENANT_ID = id('3902');
const TOOL_ID = id('a1');
const API_KEY = `gl_${'k'.repeat(40)}`;
const BASE_URL = 'https://control.example';

const limits: ExecutionBudget = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

const inputSchema = z.object({ status: z.enum(['open', 'done']).optional() }).strict();
const outputSchema = z.object({ tasks: z.array(z.string()) });

function setupArtifact(appId = APP_ID) {
  return {
    schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId, discoveryDigest: digest('D'),
    assessmentMode: 'autonomous', status: 'ready',
    tools: [{
      toolId: TOOL_ID, sourceFingerprint: digest('G'), name: 'tasks.list', description: 'List tasks.',
      modelName: 'tasks_list', module: 'tasks', sharedWith: [], usageHints: ['List tasks.'],
      presentation: { locale: 'en-US', singular: 'Task', plural: 'Tasks', approval: 'List tasks' },
      executionKind: 'endpoint', method: 'GET', path: '/api/tasks', authBindingRef: 'endpoint-authorization',
      allowedRoles: [], operationGroup: 'read', riskClass: 'safe-read', enabled: true, requiresApproval: false,
      inputSchemaDigest: createLocalSchemaDigest(inputSchema), outputSchemaDigest: createLocalSchemaDigest(outputSchema),
    }],
    planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [TOOL_ID] },
    prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('H'), responseStyleDigest: digest('I'), capabilityFragmentDigests: {} },
    warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
  };
}

function binding(): GeneratedToolBinding {
  const artifactTool = setupArtifact().tools[0]!;
  return {
    toolId: TOOL_ID, definitionId: artifactTool.name, executionKind: 'endpoint', method: 'GET', path: '/api/tasks',
    sourceFingerprint: artifactTool.sourceFingerprint, inputSchemaDigest: artifactTool.inputSchemaDigest,
    outputSchemaDigest: artifactTool.outputSchemaDigest, inputSchema, outputSchema,
    tool: endpointToolToTool({
      id: artifactTool.name, toolName: artifactTool.modelName, description: artifactTool.description,
      method: 'GET', path: '/api/tasks', inputSchema, needsApproval: false,
    }),
  } satisfies GeneratedEndpointToolBinding;
}

function generated(appId = APP_ID, toolPatch: Record<string, unknown> = {}): GeneratedToolModule & { toolSearchSemantics: Record<string, { synonyms: string[] }> } {
  return {
    setupArtifact: (() => {
      const artifact = setupArtifact(appId);
      Object.assign(artifact.tools[0]!, toolPatch);
      return artifact;
    })(),
    createToolBindings: () => [binding()],
    toolSearchSemantics: { [TOOL_ID]: { synonyms: ['todos'] } },
  };
}

function revision(
  privateKey: KeyObject,
  input: Omit<RuntimeRevisionEnvelope, 'contentHash' | 'signature'>,
): RuntimeRevisionEnvelope {
  const contentHash = `sha256:${createHash('sha256').update(canonicalRuntimeJson(input.payload)).digest('base64url')}`;
  const unsigned = { ...input, contentHash };
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      keyId: 'runtime-key',
      value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url'),
    },
  };
}

function activeDeployment(
  privateKey: KeyObject,
  toolOverrides: Array<Record<string, unknown>> = [],
  privacy?: PrivacyPolicyBlock,
): RuntimeDeploymentBundle {
  const common = {
    schemaVersion: 1 as const, revision: 1, tenantId: TENANT_ID, targetAppId: APP_ID,
    publishedAt: '2026-07-29T00:00:00.000Z',
  };
  return {
    deploymentId: id('3904'), environmentId: ENVIRONMENT_ID, status: 'active', rolloutMode: 'stable',
    targetPercentage: 100, pinned: false, healthStatus: 'healthy',
    agentRevision: revision(privateKey, {
      ...common, revisionId: id('3905'), revisionType: 'agent', subjectId: id('3906'),
      payload: {
        name: 'Task agent', objective: 'Manage tasks', modelAlias: 'standard',
        promptBindingRef: 'local://prompts/task-agent', toolAllowlist: [], budget: limits,
      },
    }),
    manifestRevision: revision(privateKey, {
      ...common, revisionId: id('3907'), revisionType: 'manifest', environmentId: ENVIRONMENT_ID,
      payload: { sourceDigest: 'sha256:YWJj', tools: [] },
    }),
    policyRevision: revision(privateKey, {
      ...common, revisionId: id('3908'), revisionType: 'policy', environmentId: ENVIRONMENT_ID,
      payload: {
        budget: limits, toolPolicies: [],
        ...(toolOverrides.length ? { toolOverrides } : {}),
        ...(privacy ? { privacy } : {}),
      },
    }),
    updatedAt: '2026-07-29T00:01:00.000Z',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake Platform: answers the lookup, keys, registration, report and sync. */
function platform(options: {
  lookup?: Array<() => Response>;
  deployments?: RuntimeDeploymentBundle[];
  publicKey?: KeyObject;
  revocations?: SecurityRevocation[];
} = {}) {
  const lookups = [...options.lookup ?? []];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/v1/runtime/connection')) {
      const next = lookups.length > 1 ? lookups.shift()! : lookups[0];
      return next?.() ?? json({ schemaVersion: 1, appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'runner-1' });
    }
    if (url.includes('jwks')) {
      return json({
        keys: options.publicKey
          ? [{ ...options.publicKey.export({ format: 'jwk' }), kid: 'runtime-key', alg: 'EdDSA', use: 'sig' }]
          : [],
      });
    }
    if (url.includes('/sync?')) {
      return json({
        cursor: '2026-07-29T00:02:00.000Z',
        activeSnapshotComplete: true,
        deployments: options.deployments ?? [],
        revocations: options.revocations ?? [],
      });
    }
    if (url.includes('/metrics/events')) return new Response(null, { status: 202 });
    if (url.includes('/runtime-setup')) {
      // The capability report: the Platform already holds this artifact.
      return json({
        runId: id('b2'), appId: APP_ID, status: 'ready', artifactDigest: digest('Z'),
        updatedAt: '2026-10-04T08:00:00.000Z',
      });
    }
    return json({ ok: true });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, mock: fetchImpl };
}

const principal = (tenantId: string): Principal => ({
  subjectId: 'alice', tenantId, roles: ['member'], attributes: {},
});

const instances: Glirastes[] = [];
function track(instance: Glirastes): Glirastes {
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop()));
  // Each test creates a different synthetic Platform/backend with the same
  // fixture IDs. Replacement within one test must retain its restrictions.
  const retained = (globalThis as Record<symbol, unknown>)[Symbol.for('glirastes.runtime.accepted-stores.v1')];
  (retained as Map<string, unknown> | undefined)?.clear();
});

// The turn helper spreads straight into the chat handler config.
type SpreadsIntoChatHandler = GlirastesChatTurn extends Partial<AiChatHandlerConfig> ? true : never;
const spreadsIntoChatHandler: SpreadsIntoChatHandler = true;

describe('createGlirastes in standalone', () => {
  it('ordinary consumer after generic pairing preserves unconfigured transport without a binding or state store',async()=>{
    const root=await mkdtemp(join(tmpdir(),'privacy-ordinary-pairing-'));
    try {
      await mkdir(join(root,'.glirastes'));
      await materializeConnectionEnvironment({projectRoot:root,framework:'nextjs',connection:{schemaVersion:1,baseUrl:BASE_URL,appId:APP_ID,environmentId:ENVIRONMENT_ID,runnerKey:'fixture'},apiKey:API_KEY,isGitIgnored:async()=>true});
      const text=await readFile(join(root,'.env.local'),'utf8');expect(text).not.toContain('GLIRASTES_STATE_ENVIRONMENT_ID');
      const paired=Object.fromEntries(text.split('\n').filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
      const captures:unknown[]=[];
      for(const config of [{},paired]) {
        const lookup = vi.fn(async () => {throw new Error('offline');});
        const runtime=track(createGlirastes({generated:generated(),env:config,fetchImpl:lookup as typeof fetch,push:false,firstSyncTimeoutMs:5,pollIntervalMs:60000,onError:()=>{}}));
        await runtime.ready();expect(runtime.privacyPolicy()).toBeNull();
        const turn=await runtime.chatTurn(principal);const adapter=providerAdapters().openrouter;
        const handler=createAiChatHandler({model:adapter.model,tools:{},systemPrompt:'Assistant',managedRuntime:turn.managedRuntime,onError:()=>{}});
        const response=await handler(new Request('https://app.example/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{id:'u1',role:'user',parts:[{type:'text',text:'ordinary.canary@example.invalid'}]}]})}));
        expect(response.status).toBe(200);await response.text();expect(adapter.requests).toHaveLength(1);captures.push(adapter.requests);
        expect(lookup).toHaveBeenCalledTimes(config === paired ? 1 : 0);
        await runtime.stop();
      }
      expect(captures[1]).toEqual(captures[0]);expect(JSON.stringify(captures)).toContain('ordinary.canary@example.invalid');
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it('yields a chat turn the handler config accepts', () => {
    expect(spreadsIntoChatHandler).toBe(true);
  });

  it('runs on the local code without any network', async () => {
    const http = platform();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env: {}, fetchImpl: http.fetchImpl,
    }));

    await glirastes.ready();
    const turn = await glirastes.chatTurn(principal);

    expect(glirastes.mode).toBe('standalone');
    expect(glirastes.connection()).toBeUndefined();
    expect(glirastes.metrics).toBeUndefined();
    expect(glirastes.currentSource().mode).toBe('standalone');
    expect(glirastes.bindings.map((entry) => entry.toolId)).toEqual([TOOL_ID]);
    const request = new Request('https://app.example/api/chat');
    const resolved = await turn.managedRuntime.resolvePrincipal(request);
    expect(resolved?.tenantId).toBe(glirastes.currentSource().identity.tenantId);
    const snapshot = await turn.managedRuntime.resolveTurnSnapshot({ turnId: 'turn-1', principal: resolved! });
    expect(Object.keys(turn.loadTools({ turnSnapshot: snapshot }))).toEqual(['tasks_list']);
    expect(turn.loadTools({})).toEqual({});
    expect(await turn.managedRuntime.loadRevocations!({ request, snapshot })).toEqual([]);
    expect(turn.toolSemantics).toEqual({ [TOOL_ID]: { synonyms: ['todos'] } });
    expect(turn.metrics).toBeUndefined();
    expect(http.mock).not.toHaveBeenCalled();
  });

  it('hands classifyToolFailure to the chat turn, and nothing without it', async () => {
    const classifyToolFailure = () => 'expected' as const;
    const classified = track(createGlirastes({ generated: generated(), env: {}, classifyToolFailure }));
    expect((await classified.chatTurn(principal)).classifyToolFailure).toBe(classifyToolFailure);
    await classified.stop();
    instances.splice(instances.indexOf(classified), 1);

    const plain = track(createGlirastes({ generated: generated(), env: {} }));
    expect(await plain.chatTurn(principal)).not.toHaveProperty('classifyToolFailure');
  });

  it('hands maxResultChars to the chat turn, and rejects an invalid value', async () => {
    const limited = track(createGlirastes({ generated: generated(), env: {}, maxResultChars: 40_000 }));
    expect((await limited.chatTurn(principal)).maxResultChars).toBe(40_000);
    await limited.stop();
    instances.splice(instances.indexOf(limited), 1);

    const plain = track(createGlirastes({ generated: generated(), env: {} }));
    expect(await plain.chatTurn(principal)).not.toHaveProperty('maxResultChars');
    expect(() => createGlirastes({ generated: generated(OTHER_APP_ID), env: {}, maxResultChars: 500 }))
      .toThrow('createGlirastes: maxResultChars must be an integer from 1000 to 200000');
  });

  it('runs without localLimits', async () => {
    const glirastes = track(createGlirastes({ generated: generated(), env: {} }));
    await glirastes.ready();
    expect(glirastes.currentSource().mode).toBe('standalone');
  });

  it('keeps one instance per app in the process', async () => {
    const first = track(createGlirastes({ generated: generated(), localLimits: limits, env: {} }));
    const second = createGlirastes({ generated: generated(), localLimits: limits, env: {} });
    const other = track(createGlirastes({ generated: generated(OTHER_APP_ID), localLimits: limits, env: {} }));

    expect(second).toBe(first);
    expect(other).not.toBe(first);

    await first.stop();
    const fresh = track(createGlirastes({ generated: generated(), localLimits: limits, env: {} }));
    expect(fresh).not.toBe(first);
  });

  it('lets the app wrap its generated bindings', () => {
    const wrapBindings = vi.fn((bindings: ReadonlyArray<GeneratedToolBinding>) => bindings.map((entry) => ({
      ...entry,
      tool: { ...entry.tool, description: 'Wrapped.' },
    })));
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env: {}, wrapBindings,
    }));

    expect(wrapBindings).toHaveBeenCalledOnce();
    expect(glirastes.bindings[0]?.tool.description).toBe('Wrapped.');
  });

  it('fails closed on a malformed key, naming the variable only', () => {
    expect(() => createGlirastes({
      generated: generated(), localLimits: limits, env: { GLIRASTES_API_KEY: 'broken-value' },
    })).toThrow(/GLIRASTES_API_KEY/);
  });
});

describe('createGlirastes connected', () => {
  const env = { GLIRASTES_API_KEY: API_KEY, GLIRASTES_CONTROL_PLANE_URL: BASE_URL };

  it('stays silent until the app asks for it', () => {
    const http = platform();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
    }));

    expect(glirastes.mode).toBe('connected');
    expect(http.mock).not.toHaveBeenCalled();
  });

  it('looks up the connection, registers, syncs and runs in the accepted deployment', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({ deployments: [activeDeployment(privateKey)], publicKey });
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError,
    }));

    await glirastes.ready();

    expect(onError).not.toHaveBeenCalled();
    const lookup = http.calls[0]!;
    expect(lookup.url).toBe(`${BASE_URL}/v1/runtime/connection?digest=${encodeURIComponent(digest('D'))}`);
    expect(lookup.init.headers).toMatchObject({ 'x-api-key': API_KEY });
    expect(glirastes.connection()).toEqual({
      baseUrl: BASE_URL, appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'runner-1',
      mode: 'environment',
    });
    const register = http.calls.find(({ url }) => url.endsWith('/register'));
    expect(register?.url).toContain(`/v1/runtime/apps/${APP_ID}/environments/${ENVIRONMENT_ID}/runners`);
    expect(JSON.parse(String(register?.init.body))).toMatchObject({ runnerKey: 'runner-1' });
    expect(glirastes.accepted()?.policyRevision.tenantId).toBe(TENANT_ID);
    expect(glirastes.currentSource().identity).toEqual({
      tenantId: TENANT_ID, targetAppId: APP_ID, environmentId: ENVIRONMENT_ID,
    });
    expect(glirastes.currentSource()).toBe(glirastes.currentSource());
    expect(glirastes.metrics?.identity).toMatchObject({ appId: APP_ID, environmentId: ENVIRONMENT_ID });

    const turn = await glirastes.chatTurn(principal);
    const request = new Request('https://app.example/api/chat');
    expect((await turn.managedRuntime.resolvePrincipal(request))?.tenantId).toBe(TENANT_ID);
    expect(turn.metrics).toBe(glirastes.metrics);
  });

  it.each([
    ['an explicit version', { version: '2.3.4' }, { GLIRASTES_BUILD_ID: 'b1' }, '2.3.4'],
    ['the build id', {}, { GLIRASTES_BUILD_ID: ' build-42 ' }, 'build-42'],
    ['the SDK version', {}, {}, `glirastes@${SDK_VERSION}`],
  ])('registers the runner with %s', async (_label, extra, extraEnv, expected) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({ deployments: [activeDeployment(privateKey)], publicKey });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env: { ...env, ...extraEnv },
      fetchImpl: http.fetchImpl, push: false, pollIntervalMs: 60_000, ...extra,
    }));

    await glirastes.ready();

    const register = http.calls.find(({ url }) => url.endsWith('/register'));
    expect(JSON.parse(String(register?.init.body)).version).toBe(expected);
  });

  it('carries the platform environment before a deployment is accepted', async () => {
    const http = platform();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError: vi.fn(),
    }));

    await glirastes.ready();

    expect(glirastes.accepted()).toBeUndefined();
    expect(glirastes.currentSource().identity).toMatchObject({
      targetAppId: APP_ID, environmentId: ENVIRONMENT_ID,
    });
  });

  it('keeps running locally while the lookup fails, reports it and retries', async () => {
    const http = platform({
      lookup: [
        () => json({ code: 'connection_key_unbound' }, 409),
        () => json({ schemaVersion: 1, appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'runner-1' }),
      ],
    });
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 20, firstSyncTimeoutMs: 5, onError,
    }));

    await expect(glirastes.ready()).resolves.toBeUndefined();
    const error = onError.mock.calls[0]?.[0] as RuntimeControlPlaneRequestError;
    expect(error).toBeInstanceOf(RuntimeControlPlaneRequestError);
    expect(error.operation).toBe('connection');
    expect(error.status).toBe(409);
    expect(error.message).not.toContain(API_KEY);
    expect(glirastes.connection()).toBeUndefined();
    expect(glirastes.metrics).toBeUndefined();
    expect(glirastes.currentSource().identity.environmentId).not.toBe(ENVIRONMENT_ID);

    await vi.waitFor(() => expect(glirastes.connection()?.appId).toBe(APP_ID), { timeout: 1_000 });
  });

  it('does not hold every turn while the platform stays unreachable', async () => {
    const http = platform({ lookup: [() => json({}, 503)] });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, firstSyncTimeoutMs: 60_000, onError: vi.fn(),
    }));

    const started = Date.now();
    await glirastes.ready();
    await glirastes.chatTurn(principal);
    await glirastes.chatTurn(principal);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses a key that belongs to another app and does not switch', async () => {
    const http = platform({
      lookup: [() => json({ schemaVersion: 1, appId: OTHER_APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'runner-1' })],
    });
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 10, onError,
    }));

    await glirastes.ready();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onError).toHaveBeenCalledOnce();
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/different app/);
    expect(glirastes.connection()).toBeUndefined();
    expect(http.calls.filter(({ url }) => url.includes('/v1/runtime/connection'))).toHaveLength(1);
    expect(http.calls.some(({ url }) => url.endsWith('/register'))).toBe(false);
  });

  it('binds by GLIRASTES_ENVIRONMENT and sends NODE_ENV', async () => {
    const http = platform();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, push: false, pollIntervalMs: 60_000, onError: vi.fn(),
      env: { ...env, GLIRASTES_ENVIRONMENT: ' staging ', NODE_ENV: 'production' }, fetchImpl: http.fetchImpl,
    }));

    await glirastes.ready();

    const query = new URL(http.calls[0]!.url).searchParams;
    expect(query.get('environment')).toBe('staging');
    expect(query.get('nodeEnv')).toBe('production');
  });

  it('treats a blank GLIRASTES_ENVIRONMENT as absent', async () => {
    const http = platform();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, push: false, pollIntervalMs: 60_000, onError: vi.fn(),
      env: { ...env, GLIRASTES_ENVIRONMENT: '   ' }, fetchImpl: http.fetchImpl,
    }));

    await glirastes.ready();

    expect(new URL(http.calls[0]!.url).searchParams.has('environment')).toBe(false);
  });

  it('throws at startup on an invalid GLIRASTES_ENVIRONMENT', () => {
    expect(() => createGlirastes({
      generated: generated(), localLimits: limits, env: { ...env, GLIRASTES_ENVIRONMENT: 'Not Valid' },
    })).toThrow(/GLIRASTES_ENVIRONMENT/);
  });

  it('warns once in production without GLIRASTES_ENVIRONMENT', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const http = platform({
        lookup: [() => json({
          schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: null, runnerKey: 'dev-abcdefghijklm',
        })],
      });
      const glirastes = track(createGlirastes({
        generated: generated(), localLimits: limits, push: false, pollIntervalMs: 60_000, onError: vi.fn(),
        env: { ...env, NODE_ENV: 'production' }, fetchImpl: http.fetchImpl,
      }));
      await glirastes.ready();
      await glirastes.ready();

      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('No GLIRASTES_ENVIRONMENT set; running as a development connection');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays on local tools while an environment awaits approval, names it once and retries', async () => {
    const http = platform({
      lookup: [
        () => json({ code: 'environment_pending_approval' }, 409),
        () => json({ code: 'environment_pending_approval' }, 409),
        () => json({ schemaVersion: 1, appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'env-staging' }),
      ],
    });
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, push: false, pollIntervalMs: 20, firstSyncTimeoutMs: 5,
      env: { ...env, GLIRASTES_ENVIRONMENT: 'staging' }, fetchImpl: http.fetchImpl, onError,
    }));

    await glirastes.ready();

    expect(glirastes.connection()).toBeUndefined();
    await vi.waitFor(() => expect(glirastes.connection()?.runnerKey).toBe('env-staging'), { timeout: 1_000 });
    expect(onError).toHaveBeenCalledOnce();
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toBe(
      "Environment 'staging' is waiting for approval in Glirastes Citadel (App → Environments). Serving local tools until then.",
    );
  });

  it('exposes a development connection without registering a runner', async () => {
    const http = platform({
      lookup: [() => json({
        schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: null, runnerKey: 'dev-abcdefghijklm',
      })],
    });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError: vi.fn(),
    }));

    await glirastes.ready();

    expect(glirastes.connection()).toMatchObject({ mode: 'development', environmentId: null });
    expect(http.calls.some(({ url }) => url.endsWith('/register'))).toBe(false);
  });

  it('follows the reference environment read-only in a development connection', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({
      deployments: [activeDeployment(privateKey)], publicKey,
      lookup: [() => json({
        schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'dev-abcdefghijklm',
      })],
    });
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError,
    }));

    await glirastes.ready();

    expect(onError).not.toHaveBeenCalled();
    expect(glirastes.accepted()?.policyRevision.tenantId).toBe(TENANT_ID);
    expect(glirastes.currentSource().identity).toMatchObject({ environmentId: ENVIRONMENT_ID });
    expect(http.calls.some(({ url }) => url.includes('/sync?runnerKey=dev-abcdefghijklm'))).toBe(true);
    const forbidden = /\/(register|heartbeat|capabilities|leases)|\/metrics|\/runtime-setup/;
    expect(http.calls.filter(({ url }) => forbidden.test(url))).toEqual([]);
    expect(glirastes.metrics).toBeUndefined();
  });

  const developmentLookup = () => json({
    schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'dev-abcdefghijklm',
  });

  async function developmentPolicy(
    toolOverrides: Array<Record<string, unknown>>,
    toolPatch: Record<string, unknown> = {},
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({
      deployments: [activeDeployment(privateKey, toolOverrides)], publicKey, lookup: [developmentLookup],
    });
    const glirastes = track(createGlirastes({
      generated: generated(APP_ID, toolPatch), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError: vi.fn(),
    }));
    await glirastes.ready();
    const snapshot = glirastes.currentSource().resolveTurnSnapshot({ turnId: 't-1', principal: principal(TENANT_ID) });
    return snapshot.policyRevision.toolPolicies.find((policy) => policy.toolId === TOOL_ID);
  }

  it('disables a tool locally that the reference revision disables', async () => {
    expect(await developmentPolicy([{ toolId: TOOL_ID, enabled: false }])).toMatchObject({ enabled: false });
  });

  it('puts a tool on confirmation that the reference revision restricts', async () => {
    expect(await developmentPolicy([{ toolId: TOOL_ID, requiresApproval: true }]))
      .toMatchObject({ enabled: true, requiresApproval: true });
  });

  it('keeps a stricter local code rule against a looser reference revision', async () => {
    const policy = await developmentPolicy(
      [{ toolId: TOOL_ID, requiresApproval: false, riskClass: 'safe-read' }],
      { riskClass: 'delete', operationGroup: 'delete', requiresApproval: true },
    );
    expect(policy).toMatchObject({ requiresApproval: true, riskClass: 'delete' });
  });

  it('keeps polling in a development connection without a reference environment', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({
      deployments: [activeDeployment(privateKey)], publicKey,
      lookup: [
        () => json({ schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: null, runnerKey: 'dev-abcdefghijklm' }),
        developmentLookup,
      ],
    });
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 20, onError,
    }));

    await glirastes.ready();
    expect(http.calls.some(({ url }) => url.includes('/sync?'))).toBe(false);

    await vi.waitFor(() => expect(glirastes.accepted()).toBeDefined(), { timeout: 1_000 });
    expect(glirastes.connection()).toMatchObject({ environmentId: ENVIRONMENT_ID });
    expect(http.calls.some(({ url }) => url.includes('/sync?runnerKey=dev-abcdefghijklm'))).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('sends the runner key on the push stream of a development connection', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({
      deployments: [activeDeployment(privateKey)], publicKey,
      lookup: [() => json({
        schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'dev-abcdefghijklm',
      })],
    });
    const connect = vi.fn(() => new Promise<void>(() => {}));
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: { connect },
      pollIntervalMs: 60_000, onError: vi.fn(),
    }));

    await glirastes.ready();

    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    const [{ url }] = connect.mock.calls[0] as unknown as [{ url: string }];
    expect(url).toBe(`${BASE_URL}/v1/runtime/apps/${APP_ID}/environments/${ENVIRONMENT_ID}/runners/stream?runnerKey=dev-abcdefghijklm`);
  });

  it('gives no production warning to a legacy environment key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const http = platform();
      const glirastes = track(createGlirastes({
        generated: generated(), localLimits: limits, push: false, pollIntervalMs: 60_000, onError: vi.fn(),
        env: { ...env, NODE_ENV: 'production' }, fetchImpl: http.fetchImpl,
      }));
      await glirastes.ready();

      expect(glirastes.connection()?.mode).toBe('environment');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a not-bound code again after a successful bind', async () => {
    const http = platform();
    let lookups = 0;
    let syncs = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/runtime/connection')) {
        lookups += 1;
        if (lookups === 2 || lookups === 4) return json({ code: 'environment_pending_approval' }, 409);
      }
      if (url.includes('/sync?') && ++syncs <= 2) return json({ code: 'environment_place_required' }, 409);
      return (http.fetchImpl as typeof fetch)(input, init);
    }) as unknown as typeof fetch;
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, push: false, pollIntervalMs: 20, onError,
      env: { ...env, GLIRASTES_ENVIRONMENT: 'staging' }, fetchImpl,
    }));

    await glirastes.ready();

    await vi.waitFor(() => expect(lookups).toBeGreaterThanOrEqual(5), { timeout: 2_000 });
    const hints = onError.mock.calls.filter(([error]) => String((error as Error).message).includes('waiting for approval'));
    expect(hints).toHaveLength(2);
  });

  it('drops to local tools and looks up again when the sync needs a place', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let placeWithdrawn = false;
    const base = platform({ deployments: [activeDeployment(privateKey)], publicKey });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/sync?') && !placeWithdrawn) {
        placeWithdrawn = true;
        return json({ code: 'environment_place_required' }, 409);
      }
      return (base.fetchImpl as typeof fetch)(input, init);
    }) as unknown as typeof fetch;
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 20,
      onError,
    }));

    await glirastes.ready();

    await vi.waitFor(
      () => expect(base.calls.filter(({ url }) => url.includes('/v1/runtime/connection')).length).toBeGreaterThanOrEqual(2),
      { timeout: 1_000 },
    );
    await vi.waitFor(() => expect(glirastes.accepted()).toBeDefined(), { timeout: 1_000 });
  });

  it('looks up again when a development connection is read-only rejected and binds to the new reference', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const NEW_ENVIRONMENT_ID = id('3902');
    const dev = (environmentId: string) => () => json({
      schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId, runnerKey: 'dev-abcdefghijklm',
    });
    const base = platform({
      deployments: [activeDeployment(privateKey)], publicKey,
      lookup: [dev(ENVIRONMENT_ID), dev(NEW_ENVIRONMENT_ID)],
    });
    let rejected = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/sync?') && !rejected) {
        rejected = true;
        return json({ code: 'development_connection_read_only' }, 403);
      }
      return (base.fetchImpl as typeof fetch)(input, init);
    }) as unknown as typeof fetch;
    const onError = vi.fn();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 20, onError,
    }));

    await glirastes.ready();

    await vi.waitFor(
      () => expect(glirastes.currentSource().identity).toMatchObject({ environmentId: NEW_ENVIRONMENT_ID }),
      { timeout: 1_000 },
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never waits longer than the first-sync timeout', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, firstSyncTimeoutMs: 10,
    }));

    const started = Date.now();
    await glirastes.ready();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(glirastes.currentSource().mode).toBe('standalone');
  });
});

describe('createGlirastes with a privacy policy', () => {
  const env = { GLIRASTES_API_KEY: API_KEY, GLIRASTES_CONTROL_PLANE_URL: BASE_URL, GLIRASTES_STATE_ENVIRONMENT_ID: ENVIRONMENT_ID };
  const block: PrivacyPolicyBlock = {
    schemaVersion: 1,
    profile: 'protected-text/v1',
    screenshots: { mode: 'blocked' },
    providers: { allowed: [{ entryId: 'main', bindingDigest: digest('A') }], defaultEntryId: 'main', userChoice: false },
    mapping: { idleTtlSeconds: 1800, absoluteTtlSeconds: 7200 },
    speech: { localOnly: true, maxDurationSeconds: 45 },
  };
  const privacy = (bindingDigest = digest('A')): GlirastesPrivacyOptions => ({
    managed: true,
    shield: { profile: 'protected-text/v1' } as GlirastesPrivacyOptions['shield'],
    providers: { bindings: () => ({ main: bindingDigest }), defaultEntryId: 'main' } as GlirastesPrivacyOptions['providers'],
  });
  const codeOf = (run: () => unknown) => {
    try {
      run();
      return undefined;
    } catch (error) {
      return isPrivacyError(error) ? error.code : `not-privacy:${String(error)}`;
    }
  };

  it('names provider entries whose binding drifted from the setup artifact, content-free', () => {
    const module = generated();
    (module.setupArtifact as Record<string, unknown>).privacyProviders = [
      { id: 'main', label: 'Main', adapter: 'openrouter', bindingDigest: digest('A') },
      { id: 'gone', label: 'Gone', adapter: 'openrouter', bindingDigest: digest('A') },
    ];
    const onError = vi.fn();
    track(createGlirastes({
      generated: module, env: {}, onError,
      privacy: {
        managed: true,
        shield: { profile: 'protected-text/v1' } as GlirastesPrivacyOptions['shield'],
        providers: { bindings: () => ({ main: digest('B'), extra: digest('C') }), defaultEntryId: 'main' } as GlirastesPrivacyOptions['providers'],
      },
    }));
    expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      '[glirastes] Privacy provider "main" differs from the setup artifact; run setup again so the Platform can approve it.',
      '[glirastes] Privacy provider "gone" is in the setup artifact but not in the provider registry.',
      '[glirastes] Privacy provider "extra" is not in the setup artifact; the Platform cannot approve it.',
    ]);
  });

  it('is off in standalone without a local requirement', () => {
    const glirastes = track(createGlirastes({ generated: generated(), env: {} }));
    expect(glirastes.privacyPolicy()).toBeNull();
  });

  it('does not fall open with explicit managed activation but no connection configuration', () => {
    const instance = track(createGlirastes({generated: generated(), env: {}, privacy: {managed: true}, onError: vi.fn()}));
    expect(codeOf(() => instance.privacyPolicy())).toBe('privacy_policy_unavailable');
    expect(codeOf(() => instance.speechPolicy())).toBe('privacy_policy_unavailable');
  });

  it('blocks a managed connection with no authenticated reference environment', async () => {
    const http = platform({lookup:[() => json({schemaVersion:1,appId:APP_ID,environmentId:null,runnerKey:'runner-1',mode:'development'})]});
    const instance = track(createGlirastes({generated:generated(),env,privacy:{managed:true},stateStore:()=>new SharedDurableTestStore(),fetchImpl:http.fetchImpl,push:false,onError:vi.fn(),pollIntervalMs:60000}));
    await instance.ready(); expect(codeOf(()=>instance.privacyPolicy())).toBe('privacy_state_binding_mismatch');
    expect(instance.accepted()).toBeUndefined();
  });
  it('blocks a managed signed off policy with memory-only state', async () => {
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    const http=platform({deployments:[activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'})],publicKey});
    const instance=track(createGlirastes({generated:generated(),env,privacy:{managed:true},stateStore:()=>new MemoryRuntimeStateStore(),fetchImpl:http.fetchImpl,push:false,onError:vi.fn(),pollIntervalMs:60000}));
    await instance.ready();expect(codeOf(()=>instance.privacyPolicy())).toBe('privacy_policy_unavailable');expect(instance.accepted()).toBeUndefined();
  });
  it('does not adopt a live environment differing from the fixed persisted binding', async () => {
    const http=platform();
    const instance=track(createGlirastes({generated:generated(),env,privacy:{managed:true},stateEnvironmentId:id('3999'),stateStore:()=>new SharedDurableTestStore(),fetchImpl:http.fetchImpl,push:false,onError:vi.fn(),pollIntervalMs:60000}));
    await instance.ready();expect(codeOf(()=>instance.privacyPolicy())).toBe('privacy_state_binding_mismatch');
    expect(http.calls.some(({url})=>url.includes('/sync?'))).toBe(false);
  });
  it('keeps an explicit binding blocked with a fresh empty store offline', async () => {
    const instance=track(createGlirastes({generated:generated(),env,stateStore:()=>new SharedDurableTestStore(),fetchImpl:(async()=>{throw new Error('offline')}) as typeof fetch,push:false,onError:vi.fn(),pollIntervalMs:60000}));
    await instance.ready();expect(codeOf(()=>instance.privacyPolicy())).toBe('privacy_policy_unavailable');
  });

  it('review residual: retained store without binding fails with a fixed binding diagnostic', async()=>{
    const instance=track(createGlirastes({generated:generated(),env:{},stateStore:()=>new SharedDurableTestStore(),onError:vi.fn()}));
    expect(codeOf(()=>instance.privacyPolicy())).toBe('privacy_state_binding_mismatch');
  });
  it('review residual: retained binding alone blocks without privacy or stateStore', async () => {
    const instance=track(createGlirastes({generated:generated(),env,push:false,fetchImpl:(async()=>{throw new Error('offline')}) as typeof fetch,onError:vi.fn(),firstSyncTimeoutMs:5,pollIntervalMs:60000}));
    await instance.ready();expect(codeOf(()=>instance.privacyPolicy())).toBe('privacy_policy_unavailable');
    expect(codeOf(()=>instance.speechPolicy())).toBe('privacy_policy_unavailable');
  });
  it.each(['rejected','incomplete'] as const)('review residual: cached off cannot bootstrap on %s active snapshot', async (mode) => {
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    const stateStore=new SharedDurableTestStore();
    const valid=activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'});
    const http=platform({deployments:[valid],publicKey});
    const before=track(createGlirastes({generated:generated(),env,stateStore:()=>stateStore,fetchImpl:http.fetchImpl,push:false,onError:vi.fn(),pollIntervalMs:60000}));
    await before.ready();expect(before.privacyPolicy()).toBeNull();await before.stop();
    const changed=structuredClone(valid);changed.policyRevision.signature.value='invalid';
    const next=platform({deployments:mode==='rejected'?[changed]:[],publicKey});
    const fetchImpl=(async (...args:Parameters<typeof fetch>)=>{
      const response=await next.fetchImpl(...args);
      if(String(args[0]).includes('/sync?')&&mode==='incomplete') return Response.json({...await response.json(),activeSnapshotComplete:false});
      return response;
    }) as typeof fetch;
    const after=track(createGlirastes({generated:generated(),env,stateStore:()=>stateStore,fetchImpl,push:false,onError:vi.fn(),pollIntervalMs:60000}));
    await after.ready();expect(codeOf(()=>after.privacyPolicy())).toBe('privacy_policy_unavailable');
  });

  it('enforces the local profile in standalone when required', () => {
    const glirastes = track(createGlirastes({ generated: generated(), env: {}, privacy: { ...privacy(), managed: false, local: { required: true } } }));
    expect(glirastes.privacyPolicy()).toMatchObject({ source: 'local', profile: 'protected-text/v1' });
  });

  it('blocks managed bootstrap without infrastructure when live sync has no active deployment', async () => {
    const http = platform();
    const instance = track(createGlirastes({ generated: generated(), privacy: { managed: true }, env, fetchImpl: http.fetchImpl,
      push: false, pollIntervalMs: 60_000, onError: vi.fn(), stateStore: () => new SharedDurableTestStore() }));
    await instance.ready();
    expect(codeOf(() => instance.speechPolicy())).toBe('privacy_policy_unavailable');
    const turn = await instance.chatTurn(principal);
    expect(codeOf(() => turn.managedRuntime.privacyGate({ request: new Request('https://app.example/chat'),
      snapshot: { policyRevision: { revisionId: id('3908') } } as never }))).toBe('privacy_policy_unavailable');
  });

  it('blocks a connected runtime with privacy until a verified deployment arrived', async () => {
    const http = platform();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError: vi.fn(), privacy: privacy(),
    }));
    await glirastes.ready();
    expect(glirastes.accepted()).toBeUndefined();
    expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_policy_unavailable');
    const turn = await glirastes.chatTurn(principal);
    expect(codeOf(() => turn.managedRuntime.privacyGate({
      request: new Request('https://app.example/api/chat'),
      snapshot: { policyRevision: { revisionId: id('3908') } } as never,
    }))).toBe('privacy_policy_unavailable');
  });

  it.each(['stream','classifier'] as const)('temporal review: handler %s transport does not retry after a signed off revocation',async(mode)=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');const revocations:SecurityRevocation[]=[];
    const http=platform({deployments:[activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'})],publicKey,revocations});
    const runtime=track(createGlirastes({generated:generated(),env,stateStore:()=>new SharedDurableTestStore(),fetchImpl:http.fetchImpl,push:false,pollIntervalMs:10,onError:vi.fn()}));
    await runtime.ready();const pinned=runtime.accepted()!.policyRevision;const turn=await runtime.chatTurn(principal);const requests:unknown[]=[];
    const provider=createOpenAI({apiKey:'synthetic-only',baseURL:'https://retry.fixture.invalid/v1',fetch:async(_url,init)=>{
      requests.push(JSON.parse(String(init?.body)));
      const unsigned={revocationId:id('3997'),environmentId:ENVIRONMENT_ID,effectiveAt:'2026-07-29T00:02:00.000Z',reasonCode:'privacy-off-revoked',toolIds:[],agentRevisionIds:[],policyRevisionIds:[pinned.revisionId]};
      revocations.push({...unsigned,signature:{algorithm:'Ed25519',keyId:'runtime-key',value:sign(null,Buffer.from(canonicalRuntimeJson(unsigned)),privateKey).toString('base64url')}});
      await vi.waitFor(()=>expect(runtime.revocations()).toHaveLength(1));
      return Response.json({error:{message:'synthetic retry',type:'server_error'}},{status:503});
    }});
    const model=provider.chat('fixture');const modules=[{id:'mail',name:'Mail',description:'Mail',tools:[],classification:{hint:'Mail',examples:['send a mail']}}];
    const pipeline=createLocalAiPipeline({modules,classifier:{modules,model},generateText:generateText as never});
    const handler=createAiChatHandler({model,tools:{},...(mode==='classifier'?{pipeline}:{}),systemPrompt:'Assistant',managedRuntime:turn.managedRuntime,onError:()=>{}});
    const response=await handler(new Request('https://app.example/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{id:'u1',role:'user',parts:[{type:'text',text:'Investigate retry.canary@example.invalid carefully please'}]}]})}));
    await response.text();expect(requests).toHaveLength(1);expect(JSON.stringify(requests)).toContain('retry.canary@example.invalid');
  },15000);

  it.each(['heartbeat','storage'] as const)('temporal review: known protected refusal blocks before pending %s completes',async(phase)=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');const deployments=[activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'})];
    const http=platform({deployments,publicKey});const stateStore=new SharedDurableTestStore();
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let waiting=false;
    const save=stateStore.saveAtomic.bind(stateStore);
    if(phase==='storage') stateStore.saveAtomic=async state=>{if(state.privacyFloor?.profile==='protected-text/v1'){waiting=true;await held;}await save(state);};
    const fetchImpl=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      if(phase==='heartbeat'&&String(input).endsWith('/heartbeat')&&String(init?.body).includes('privacy_refused')){waiting=true;await held;}
      return http.fetchImpl(input,init);
    }) as typeof fetch;
    const runtime=track(createGlirastes({generated:generated(),env,stateStore:()=>stateStore,fetchImpl,push:false,pollIntervalMs:10,onError:vi.fn()}));
    try{
      await runtime.ready();expect(runtime.privacyPolicy()).toBeNull();deployments.splice(0,1,activeDeployment(privateKey,[],block));
      await vi.waitFor(()=>expect(waiting).toBe(true));expect(codeOf(()=>runtime.privacyPolicy())).toBe('privacy_not_configured');
      const turn=await runtime.chatTurn(principal);const adapter=providerAdapters().openrouter;
      const handler=createAiChatHandler({tools:{},model:adapter.model,systemPrompt:'Assistant',managedRuntime:turn.managedRuntime,onError:()=>{}});
      const response=await handler(new Request('https://app.example/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{id:'u1',role:'user',parts:[{type:'text',text:'refusal.canary@example.invalid'}]}]})}));
      expect(response.status).toBe(503);await response.text();expect(adapter.requests).toHaveLength(0);
    }finally{release();await runtime.stop();}
  });
  it('temporal review: a verified off revocation blocks while its durable save is pending', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const revocations: SecurityRevocation[] = [];
    const http = platform({ deployments: [activeDeployment(privateKey, [], {schemaVersion: 1, profile: 'off'})], publicKey, revocations });
    const stateStore = new SharedDurableTestStore();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    const save = stateStore.saveAtomic.bind(stateStore);
    stateStore.saveAtomic = async state => { if (state.revocations.length) { waiting = true; await held; } await save(state); };
    const runtime = track(createGlirastes({generated: generated(), env, stateStore: () => stateStore, fetchImpl: http.fetchImpl, push: false, pollIntervalMs: 10, onError: vi.fn()}));
    try {
      await runtime.ready();
      const turn = await runtime.chatTurn(principal);
      const unsigned = {revocationId: id('3996'), environmentId: ENVIRONMENT_ID, effectiveAt: '2026-07-29T00:02:00.000Z', reasonCode: 'privacy-off-revoked', toolIds: [], agentRevisionIds: [], policyRevisionIds: [runtime.accepted()!.policyRevision.revisionId]};
      revocations.push({...unsigned, signature: {algorithm: 'Ed25519', keyId: 'runtime-key', value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url')}});
      await vi.waitFor(() => expect(waiting).toBe(true));
      const adapter = providerAdapters().openrouter;
      const handler = createAiChatHandler({tools: {}, model: adapter.model, systemPrompt: 'Assistant', managedRuntime: turn.managedRuntime, onError: () => {}});
      const response = await handler(new Request('https://app.example/chat', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages: [{id: 'u1', role: 'user', parts: [{type: 'text', text: 'pending.canary@example.invalid'}]}]})}));
      await response.text();
      expect(adapter.requests).toHaveLength(0);
      expect(response.status).toBe(503);
      expect(codeOf(() => runtime.privacyPolicy())).toBe('privacy_policy_revoked');
    } finally { release(); await runtime.stop(); }
  });

  it('drains durable writes before allowing stop/recreate on the same app', async () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const deployment = activeDeployment(privateKey, [], {schemaVersion: 1, profile: 'off'});
    const durable = new SharedDurableTestStore();
    const save = durable.saveAtomic.bind(durable);
    let held = false, waiting = false, stopped = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {release = resolve;});
    durable.saveAtomic = async state => {if (held) {waiting = true; await barrier;} await save(state);};
    const options = {generated: generated(), env, stateStore: () => durable, fetchImpl: platform({deployments: [deployment], publicKey}).fetchImpl, push: false as const, pollIntervalMs: 10, onError: vi.fn()};
    const first = track(createGlirastes(options));
    await first.ready(); held = true;
    await vi.waitFor(() => expect(waiting).toBe(true));
    const stopping = first.stop().then(() => {stopped = true;});
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
      expect(() => createGlirastes(options)).toThrow('runtime_stopping');
    } finally {release(); await stopping;}
    const next = {...deployment, deploymentId: id('3988')};
    const second = track(createGlirastes({...options, fetchImpl: platform({deployments: [next], publicKey}).fetchImpl, pollIntervalMs: 60000}));
    await second.ready(); await second.stop();
    expect((await durable.load())?.stable?.deploymentId).toBe(next.deploymentId);
  });

  it('carries a failed protected floor through graceful replacement and only newer signed off clears it', async () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const ordinary = activeDeployment(privateKey);
    const protectedDeployment = activeDeployment(privateKey, [], block);
    const {signature: _signature, contentHash: _hash, ...fields} = protectedDeployment.policyRevision;
    protectedDeployment.policyRevision = revision(privateKey, {...fields, revision: 2, revisionId: id('3967')});
    protectedDeployment.deploymentId = id('3966');
    const deployments = [ordinary]; const durable = new SharedDurableTestStore();
    const save = durable.saveAtomic.bind(durable); let fail = true, refusedSave = false;
    durable.saveAtomic = async state => {if (fail && state.privacyFloor?.profile === 'protected-text/v1') {refusedSave = true; throw new Error('fixture unavailable');} await save(state);};
    const options = {generated: generated(), env, stateStore: () => durable, fetchImpl: platform({deployments, publicKey}).fetchImpl, push: false as const, pollIntervalMs: 10, onError: vi.fn()};
    const first = track(createGlirastes(options)); await first.ready();
    deployments.splice(0, 1, protectedDeployment); await vi.waitFor(() => expect(refusedSave).toBe(true));
    await first.stop(); fail = false; deployments.splice(0, 1, ordinary);
    const second = track(createGlirastes(options)); await second.ready();
    await vi.waitFor(async () => expect((await durable.load())?.privacyFloor).toMatchObject({profile: 'protected-text/v1', policyRevision: 2}));
    const turn = await second.chatTurn(principal); const adapter = providerAdapters().openrouter;
    const handler = createAiChatHandler({tools: {}, model: adapter.model, systemPrompt: 'Assistant', managedRuntime: turn.managedRuntime, onError: () => {}});
    const response = await handler(new Request('https://app.example/chat', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages: [{id: 'u1', role: 'user', parts: [{type: 'text', text: 'handoff.canary@example.invalid'}]}]})}));
    await response.text(); expect(response.status).toBe(503); expect(adapter.requests).toHaveLength(0);
    const off = activeDeployment(privateKey, [], {schemaVersion: 1, profile: 'off'});
    const {signature: _offSignature, contentHash: _offHash, ...offFields} = off.policyRevision;
    off.policyRevision = revision(privateKey, {...offFields, revision: 3, revisionId: id('3969')}); off.deploymentId = id('3968');
    deployments.splice(0, 1, off);
    await vi.waitFor(() => expect(second.accepted()?.policyRevision.revision).toBe(3));
    expect(second.privacyPolicy()).toBeNull();
  });

  it('retains an unpersisted verified revocation through a graceful handoff', async () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const revocations: SecurityRevocation[] = [];
    const durable = new SharedDurableTestStore();
    const options = {generated: generated(), env, stateStore: () => durable,
      fetchImpl: platform({deployments: [activeDeployment(privateKey, [], {schemaVersion: 1, profile: 'off'})], publicKey, revocations}).fetchImpl,
      push: false as const, pollIntervalMs: 10, onError: vi.fn()};
    const first = track(createGlirastes(options)); await first.ready(); durable.failSave = true;
    const unsigned = {revocationId: id('3975'), environmentId: ENVIRONMENT_ID, effectiveAt: '2026-07-29T00:02:00.000Z', reasonCode: 'privacy-off-revoked', toolIds: [], agentRevisionIds: [], policyRevisionIds: [first.accepted()!.policyRevision.revisionId]};
    revocations.push({...unsigned, signature: {algorithm: 'Ed25519', keyId: 'runtime-key', value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url')}});
    await vi.waitFor(() => expect(first.revocations()).toHaveLength(1)); await first.stop();
    durable.failSave = false; revocations.splice(0);
    const second = track(createGlirastes(options)); await second.ready();
    expect(second.revocations()).toHaveLength(1);
    expect((await durable.load())?.revocations).toHaveLength(1);
    // The replacement cannot finish fresh bootstrap from a revoked snapshot.
    expect(codeOf(() => second.privacyPolicy())).toBe('privacy_policy_unavailable');
  });

  it('does not reopen a stopped managed turn when its replacement reconciles', async () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const durable = new SharedDurableTestStore();
    const options = {generated: generated(), env, stateStore: () => durable,
      fetchImpl: platform({deployments: [activeDeployment(privateKey, [], {schemaVersion: 1, profile: 'off'})], publicKey}).fetchImpl,
      push: false as const, pollIntervalMs: 60000, onError: vi.fn()};
    const first = track(createGlirastes(options)); await first.ready(); const oldTurn = await first.chatTurn(principal); await first.stop();
    const second = track(createGlirastes(options)); await second.ready(); expect(second.privacyPolicy()).toBeNull();
    const adapter = providerAdapters().openrouter;
    const handler = createAiChatHandler({tools: {}, model: adapter.model, systemPrompt: 'Assistant', managedRuntime: oldTurn.managedRuntime, onError: () => {}});
    const response = await handler(new Request('https://app.example/chat', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages: [{id: 'u1', role: 'user', parts: [{type: 'text', text: 'stopped.canary@example.invalid'}]}]})}));
    await response.text(); expect(response.status).toBe(503); expect(adapter.requests).toHaveLength(0);
  });

  it.each([Object.seal, Object.freeze])('stops an immutable public runtime handle without mutation', async immutable => {
    const first = track(createGlirastes({generated: generated(), env: {}}));
    immutable(first); await first.stop();
    const second = track(createGlirastes({generated: generated(), env: {}}));
    expect(second).not.toBe(first); await second.stop();
  });

  it('temporal review: bound-only off cannot report applied from volatile state',async()=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');const http=platform({deployments:[activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'})],publicKey});
    const runtime=track(createGlirastes({generated:generated(),env,stateStore:()=>new MemoryRuntimeStateStore(),fetchImpl:http.fetchImpl,push:false,pollIntervalMs:60000,onError:vi.fn()}));
    await runtime.ready();expect(runtime.accepted()).toBeUndefined();
    const reports=http.calls.filter(c=>c.url.endsWith('/heartbeat')).map(c=>JSON.parse(String(c.init.body)));
    expect(reports).toHaveLength(1);expect(reports[0]).toMatchObject({health:'unhealthy',technicalMetadata:{privacy:{state:'refused',reasons:['accepted_state_missing']}}});
    expect(reports[0]).not.toHaveProperty('lastAppliedDeploymentId');
  });
  it('temporal review: an obsolete push response cannot reconcile the replacement connection',async()=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');const valid=activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'});
    const http=platform({deployments:[valid],publicKey});
    let event:(()=>Promise<void>)|undefined;let delayNext=false,held=false,disconnect=false,reconnected=false;let release!:(value:Response)=>void;
    const oldResponse=new Promise<Response>(resolve=>{release=resolve;});let lookups=0;
    const fetchImpl=(async(input:RequestInfo|URL,init?:RequestInit)=>{
      if(String(input).includes('/v1/runtime/connection')){lookups++;if(lookups>1)reconnected=true;}
      if(String(input).includes('/sync?')){
        if(delayNext){delayNext=false;held=true;return oldResponse;}
        if(disconnect&&!reconnected)return json({code:'environment_place_required'},409);
        if(reconnected){const bad=structuredClone(valid);bad.policyRevision.signature.value='invalid';return json({cursor:new Date().toISOString(),activeSnapshotComplete:true,deployments:[bad],revocations:[]});}
      }
      return http.fetchImpl(input,init);
    }) as typeof fetch;
    const push={connect:async({onEvent,signal}:{onEvent:()=>Promise<void>;signal:AbortSignal})=>{event=onEvent;await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}};
    const runtime=track(createGlirastes({generated:generated(),env,stateStore:()=>new SharedDurableTestStore(),fetchImpl,push:push as never,pollIntervalMs:10,onError:vi.fn()}));
    try{
      await runtime.ready();await vi.waitFor(()=>expect(event).toBeDefined());expect(runtime.privacyPolicy()).toBeNull();
      delayNext=true;const pending=event!();await vi.waitFor(()=>expect(held).toBe(true));disconnect=true;
      await vi.waitFor(()=>expect(reconnected).toBe(true));await vi.waitFor(()=>expect(codeOf(()=>runtime.privacyPolicy())).toBe('privacy_policy_unavailable'));
      release(json({cursor:new Date().toISOString(),activeSnapshotComplete:true,deployments:[valid],revocations:[]}));await pending;
      expect(codeOf(()=>runtime.privacyPolicy())).toBe('privacy_policy_unavailable');expect(codeOf(()=>runtime.speechPolicy())).toBe('privacy_policy_unavailable');
    }finally{release(json({cursor:new Date().toISOString(),activeSnapshotComplete:true,deployments:[],revocations:[]}));await runtime.stop();}
  });

  it.each(['classifier','router'] as const)('review residual: signed off %s revocation during tool loading yields zero serialized HTTP requests',async(mode)=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');const revocations:SecurityRevocation[]=[];
    const http=platform({deployments:[activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'})],publicKey,revocations});
    const runtime=track(createGlirastes({generated:generated(),env,stateStore:()=>new SharedDurableTestStore(),fetchImpl:http.fetchImpl,push:false,pollIntervalMs:10,onError:vi.fn()}));
    await runtime.ready();const pinned=runtime.accepted()!.policyRevision;const turn=await runtime.chatTurn(principal);
    const adapter=providerAdapters().openrouter;
    const modules=[{id:'mail',name:'Mail',description:'Mail',tools:[],classification:{hint:'Mail',examples:['send a mail']}}];
    const pipeline=createLocalAiPipeline({modules,classifier:{modules,model:adapter.model},generateText:generateText as never});
    const intentRouter=vi.fn(async(text:string)=>{await generateText({model:adapter.model,prompt:text});return{toolNames:[]};});
    const handler=createAiChatHandler({model:adapter.model,...(mode==='classifier'?{pipeline}:{intentRouter}),systemPrompt:'Assistant',managedRuntime:turn.managedRuntime,onError:()=>{},loadTools:async()=>{
      const unsigned={revocationId:id('3997'),environmentId:ENVIRONMENT_ID,effectiveAt:'2026-07-29T00:02:00.000Z',reasonCode:'privacy-off-revoked',toolIds:[],agentRevisionIds:[],policyRevisionIds:[pinned.revisionId]};
      revocations.push({...unsigned,signature:{algorithm:'Ed25519',keyId:'runtime-key',value:sign(null,Buffer.from(canonicalRuntimeJson(unsigned)),privateKey).toString('base64url')}});
      await vi.waitFor(()=>expect(runtime.revocations()).toHaveLength(1));return {};
    }});
    const response=await handler(new Request('https://app.example/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{id:'u1',role:'user',parts:[{type:'text',text:'Investigate classifier canary@example.invalid carefully please'}]}]})}));
    await response.text();expect(adapter.requests).toHaveLength(0);if(mode==='router')expect(intentRouter).not.toHaveBeenCalled();
  });

  it.each(['openrouter','anthropic'] as const)('%s: signed off revocation blocks memory before provider HTTP', async (kind) => {
    const {privateKey,publicKey} = generateKeyPairSync('ed25519');
    const revocations: SecurityRevocation[] = [];
    const http = platform({deployments:[activeDeployment(privateKey,[],{schemaVersion:1,profile:'off'})],publicKey,revocations});
    const runtime = track(createGlirastes({generated:generated(),localLimits:limits,env,fetchImpl:http.fetchImpl,push:false,
      pollIntervalMs:10,onError:vi.fn(),stateStore:()=>new SharedDurableTestStore()}));
    await runtime.ready();
    const pinned = runtime.accepted()!.policyRevision;
    const turn = await runtime.chatTurn(principal);
    const provider = providerAdapters()[kind];
    const handler = createAiChatHandler({tools:{},model:provider.model,systemPrompt:'Assistant',onError:()=>{},managedRuntime:turn.managedRuntime,
      memory:{model:provider.model,chat:{autoCompact:10,keepTurns:0},scope:async()=>{
        const unsigned={revocationId:id('3997'),environmentId:ENVIRONMENT_ID,effectiveAt:'2026-07-29T00:02:00.000Z',
          reasonCode:'privacy-off-revoked',toolIds:[],agentRevisionIds:[],policyRevisionIds:[pinned.revisionId]};
        revocations.push({...unsigned,signature:{algorithm:'Ed25519',keyId:'runtime-key',
          value:sign(null,Buffer.from(canonicalRuntimeJson(unsigned)),privateKey).toString('base64url')}});
        await vi.waitFor(()=>expect(runtime.revocations()).toHaveLength(1));
        return {};
      }},
    });
    const response=await handler(new Request('https://app.example/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[
      {id:'u1',role:'user',parts:[{type:'text',text:'private-memory-canary@example.invalid '.repeat(30)}]},
      {id:'a1',role:'assistant',parts:[{type:'text',text:'Previous answer'}]},
      {id:'u2',role:'user',parts:[{type:'text',text:'Continue'}]},
    ]})}));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('privacy_policy_revoked');
    expect(provider.requests).toEqual([]);
    expect(JSON.stringify(http.calls)).not.toContain('private-memory-canary');
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])('blocks revoked off (local infrastructure: %s, deployment withdrawn: %s)', async (configured, withdrawn) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const revocations: SecurityRevocation[] = [];
    const deployments = [activeDeployment(privateKey, [], { schemaVersion: 1, profile: 'off' })];
    const http = platform({ deployments, publicKey, revocations });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 10, onError: vi.fn(), stateStore: () => new SharedDurableTestStore(),
      ...(configured ? { privacy: { ...privacy(), local: { required: false } } } : {}),
    }));
    await glirastes.ready();
    expect(glirastes.speechPolicy()).toBe('off');
    const pinned = glirastes.accepted()!.policyRevision;
    const turn = await glirastes.chatTurn(principal);
    const unsigned = {
      revocationId: id('3998'), environmentId: ENVIRONMENT_ID, effectiveAt: '2026-07-29T00:02:00.000Z',
      reasonCode: 'privacy-off-revoked', toolIds: [], agentRevisionIds: [], policyRevisionIds: [pinned.revisionId],
    };
    revocations.push({ ...unsigned, signature: { algorithm: 'Ed25519', keyId: 'runtime-key',
      value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url') } });
    if (withdrawn) deployments.splice(0);
    await vi.waitFor(() => expect(glirastes.revocations()).toHaveLength(1));
    const expected = withdrawn ? 'privacy_policy_unavailable' : 'privacy_policy_revoked';
    expect(codeOf(() => glirastes.speechPolicy())).toBe(expected);
    expect(codeOf(() => turn.managedRuntime.privacyGate({
      request: new Request('https://app.example/api/chat'), snapshot: { policyRevision: pinned } as never,
    }))).toBe(expected);
  });

  it('enforces the signed block of the accepted deployment and reports it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
    const onError = vi.fn();
    const stateStore = new SharedDurableTestStore();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError, privacy: privacy(), stateStore: () => stateStore,
    }));
    await glirastes.ready();
    expect(onError).not.toHaveBeenCalled();
    // Privacy and a durable store: the runner claims the capability.
    const registration = http.calls.find(({ url }) => url.endsWith('/register'));
    expect(JSON.parse(String(registration?.init.body)).capabilities).toMatchObject({ privacyPolicyVersions: [1] });
    expect((await stateStore.inner.load())?.privacyFloor).toMatchObject({ profile: 'protected-text/v1' });
    expect(glirastes.privacyPolicy()).toMatchObject({
      source: 'platform', mapping: { idleTtlSeconds: 1800, absoluteTtlSeconds: 7200 }, speech: { maxDurationSeconds: 45 },
    });
    const beat = http.calls.find(({ url }) => url.includes('/heartbeat'));
    const reported = JSON.parse(String(beat?.init.body));
    expect(reported).toMatchObject({
      health: 'healthy', lastAppliedDeploymentId: id('3904'),
      technicalMetadata: { privacy: { state: 'enforced', policyRevisionId: id('3908'), reasons: [] } },
    });
    // The handler is held to the effective policy the heartbeat reports.
    const turn = await glirastes.chatTurn(principal);
    expect(turn.managedRuntime.privacyEffectiveDigest({
      request: new Request('https://app.example/api/chat'),
      snapshot: { policyRevision: glirastes.accepted()!.policyRevision } as never,
    })).toBe(reported.technicalMetadata.privacy.effectivePolicyDigest);
  });

  it('refuses and reports a signed block whose approved binding does not match', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError: vi.fn(), privacy: privacy(digest('B')),
      stateStore: () => new SharedDurableTestStore(),
    }));
    await glirastes.ready();
    expect(glirastes.accepted()).toBeUndefined();
    expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_not_configured');
    const beat = http.calls.find(({ url }) => url.includes('/heartbeat'));
    expect(JSON.parse(String(beat?.init.body))).toMatchObject({
      health: 'unhealthy',
      technicalMetadata: { validationStage: 'privacy_refused', privacy: { state: 'refused', reasons: ['provider_binding_missing', 'provider_default_unusable'] } },
    });
  });

  describe('after a refused protected revision (K2/K3: no silent way out)', () => {
    const request = new Request('https://app.example/api/chat');
    /** Starts a runner on a shared persistent state, as a restart of the same process would. */
    async function runner(stateStore: RuntimeStateStore, deployments: RuntimeDeploymentBundle[], publicKey: KeyObject, options: { privacy?: GlirastesPrivacyOptions } = {}) {
      const http = platform({ deployments, publicKey });
      const glirastes = track(createGlirastes({
        generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
        pollIntervalMs: 60_000, onError: vi.fn(), stateStore: () => stateStore,
        ...(options.privacy ? { privacy: options.privacy } : {}),
      }));
      await glirastes.ready();
      return glirastes;
    }

    it('stays blocked after a restart when the Platform withdraws the refused revision and offers an unprotected one', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const stateStore = new SharedDurableTestStore();
      const before = await runner(stateStore, [activeDeployment(privateKey, [], block)], publicKey);
      expect(codeOf(() => before.privacyPolicy())).toBe('privacy_not_configured');
      expect((await stateStore.load())?.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 1 });
      await before.stop();

      const after = await runner(stateStore, [activeDeployment(privateKey)], publicKey);
      // The unprotected revision is a downgrade below the persisted floor.
      expect(after.accepted()).toBeUndefined();
      expect(codeOf(() => after.privacyPolicy())).toBe('privacy_not_configured');
      const turn = await after.chatTurn(principal);
      expect(codeOf(() => turn.managedRuntime.privacyGate({
        request, snapshot: { policyRevision: { revisionId: id('3908') } } as never,
      }))).toBe('privacy_not_configured');
    });

    it('resumes only once a protected revision it can enforce is accepted', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const stateStore = new SharedDurableTestStore();
      const before = await runner(stateStore, [activeDeployment(privateKey, [], block)], publicKey, { privacy: privacy(digest('B')) });
      expect(codeOf(() => before.privacyPolicy())).toBe('privacy_not_configured');
      await before.stop();

      const after = await runner(stateStore, [activeDeployment(privateKey, [], block)], publicKey, { privacy: privacy(digest('A')) });
      expect(after.accepted()?.policyRevision.privacy).toEqual(block);
      expect(after.privacyPolicy()).toMatchObject({ source: 'platform', profile: 'protected-text/v1' });
    });

    it('a candidate with an invalid signature does not lock the runner', async () => {
      const { publicKey } = generateKeyPairSync('ed25519');
      const attacker = generateKeyPairSync('ed25519');
      const stateStore = new SharedDurableTestStore();
      const glirastes = await runner(stateStore, [activeDeployment(attacker.privateKey, [], block)], publicKey);
      expect(glirastes.accepted()).toBeUndefined();
      expect((await stateStore.load())?.privacyFloor ?? null).toBeNull();
      expect((await stateStore.load())?.privacyRefusedDeploymentIds ?? []).toEqual([]);
      // The explicit binding opted in; bad material cannot establish current bootstrap.
      expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_policy_unavailable');
    });
  });

  describe('managed privacy needs a durable, reconciled state', () => {
    const request = new Request('https://app.example/api/chat');
    const anySnapshot = { policyRevision: { revisionId: id('3908') } } as never;
    const gateCode = async (glirastes: Glirastes) => {
      const turn = await glirastes.chatTurn(principal);
      return codeOf(() => turn.managedRuntime.privacyGate({ request, snapshot: anySnapshot }));
    };
    const heartbeats = (http: ReturnType<typeof platform>) => http.calls
      .filter(({ url }) => url.includes('/heartbeat'))
      .map(({ init }) => JSON.parse(String(init.body)));
    const capabilities = (http: ReturnType<typeof platform>) => JSON.parse(String(
      http.calls.find(({ url }) => url.endsWith('/register'))?.init.body,
    )).capabilities;

    it('refuses a protected policy without a durable store, confirms nothing and claims no capability', async () => {
      for (const stateStore of [undefined, () => new MemoryRuntimeStateStore()]) {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const http = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
        const onError = vi.fn();
        const glirastes = createGlirastes({
          generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
          pollIntervalMs: 60_000, onError, privacy: privacy(), ...(stateStore ? { stateStore } : {}),
        });
        await glirastes.ready();
        expect(onError.mock.calls.map(([error]) => (error as Error).message).join()).toContain('accepted_state_missing');
        expect(capabilities(http)).not.toHaveProperty('privacyPolicyVersions');
        expect(heartbeats(http)).toEqual([expect.objectContaining({
          health: 'unhealthy',
          technicalMetadata: expect.objectContaining({ privacy: expect.objectContaining({ state: 'refused', reasons: ['accepted_state_missing'] }) }),
        })]);
        expect(heartbeats(http).some((beat) => 'lastAppliedDeploymentId' in beat)).toBe(false);
        expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_policy_unavailable');
        expect(await gateCode(glirastes)).toBe('privacy_policy_unavailable');
        await glirastes.stop();
      }
    });

    it('leaves legacy operation unchanged: no capability, and a protected policy is refused, never applied', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const unprotected = platform({ deployments: [activeDeployment(privateKey)], publicKey });
      const legacy = createGlirastes({
        generated: generated(), localLimits: limits, env: {...env, GLIRASTES_STATE_ENVIRONMENT_ID: undefined}, fetchImpl: unprotected.fetchImpl, push: false,
        pollIntervalMs: 60_000, onError: vi.fn(),
      });
      await legacy.ready();
      expect(capabilities(unprotected)).not.toHaveProperty('privacyPolicyVersions');
      expect(legacy.privacyPolicy()).toBeNull();
      expect(await gateCode(legacy)).toBeUndefined();
      await legacy.stop();

      const protectedHttp = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
      const refusing = track(createGlirastes({
        generated: generated(), localLimits: limits, env: {...env, GLIRASTES_STATE_ENVIRONMENT_ID: undefined}, fetchImpl: protectedHttp.fetchImpl, push: false,
        pollIntervalMs: 60_000, onError: vi.fn(),
      }));
      await refusing.ready();
      expect(capabilities(protectedHttp)).not.toHaveProperty('privacyPolicyVersions');
      expect(heartbeats(protectedHttp).some((beat) => 'lastAppliedDeploymentId' in beat)).toBe(false);
      expect(heartbeats(protectedHttp)[0]).toMatchObject({ health: 'unhealthy', technicalMetadata: { validationStage: 'privacy_refused' } });
    });

    it('blocks a lost state while the Platform is unreachable; the ready() timeout releases nothing', async () => {
      const providers = generated();
      (providers.setupArtifact as Record<string, unknown>).privacyProviders = [
        { id: 'main', label: 'Main', adapter: 'openrouter', bindingDigest: digest('A') },
      ];
      const variants: Array<Parameters<typeof createGlirastes>[0]> = [
        { generated: generated(), privacy: privacy(), stateStore: () => new SharedDurableTestStore() },
        // Bootstrap protection is explicit even before the runner has privacy infrastructure.
        { generated: generated(), privacy: { managed: true }, stateStore: () => new SharedDurableTestStore() },
        { generated: providers, privacy: { managed: true } },
      ];
      for (const variant of variants) {
        const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
        const glirastes = createGlirastes({
          ...variant, localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 60_000,
          firstSyncTimeoutMs: 10, onError: vi.fn(),
        });
        await glirastes.ready();
        expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_policy_unavailable');
        expect(codeOf(() => glirastes.speechPolicy())).toBe('privacy_policy_unavailable');
        expect(await gateCode(glirastes)).toBe('privacy_policy_unavailable');
        await glirastes.stop();
      }
    });

    it('never overwrites an unreadable state and stays blocked until it can be read', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const http = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
      const stateStore = new SharedDurableTestStore();
      stateStore.failLoad = true;
      const onError = vi.fn();
      const glirastes = track(createGlirastes({
        generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
        pollIntervalMs: 20, firstSyncTimeoutMs: 10, onError, privacy: privacy(), stateStore: () => stateStore,
      }));
      await glirastes.ready();
      await vi.waitFor(() => expect(onError.mock.calls.filter(([error]) => (error as Error).name === 'RuntimeStateUnreadable').length).toBeGreaterThanOrEqual(2));
      expect(await gateCode(glirastes)).toBe('privacy_policy_unavailable');
      expect(http.calls.some(({ url }) => url.includes('/sync?') || url.endsWith('/register'))).toBe(false);
      expect(stateStore.saves).toBe(0);
      // The cause stays out of the report.
      expect(JSON.stringify(onError.mock.calls.map(([error]) => (error as Error).message))).not.toContain('EIO');

      stateStore.failLoad = false;
      await vi.waitFor(() => expect(glirastes.accepted()).toBeDefined());
      expect(glirastes.privacyPolicy()).toMatchObject({ source: 'platform' });
    });

    it('confirms nothing after a failed save and resumes only once a verified state was saved', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const http = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
      const stateStore = new SharedDurableTestStore();
      stateStore.failSave = true;
      const glirastes = track(createGlirastes({
        generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
        pollIntervalMs: 20, firstSyncTimeoutMs: 10, onError: vi.fn(), privacy: privacy(), stateStore: () => stateStore,
      }));
      await glirastes.ready();
      await vi.waitFor(() => expect(http.calls.filter(({ url }) => url.includes('/sync?')).length).toBeGreaterThanOrEqual(2));
      expect(glirastes.accepted()).toBeUndefined();
      expect(await gateCode(glirastes)).toBe('privacy_policy_unavailable');
      expect(heartbeats(http).some((beat) => 'lastAppliedDeploymentId' in beat)).toBe(false);

      stateStore.failSave = false;
      await vi.waitFor(() => expect(glirastes.accepted()).toBeDefined());
      expect(glirastes.privacyPolicy()).toMatchObject({ source: 'platform' });
      expect(heartbeats(http).some((beat) => beat.lastAppliedDeploymentId === id('3904'))).toBe(true);
    });

    it('keeps a floor whose save failed when a later save of an unprotected snapshot succeeds', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const unprotected = activeDeployment(privateKey);
      const deployments = [unprotected];
      const http = platform({ deployments, publicKey });
      const stateStore = new SharedDurableTestStore();
      const glirastes = track(createGlirastes({
        generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
        pollIntervalMs: 20, onError: vi.fn(), stateStore: () => stateStore,
      }));
      await glirastes.ready();
      expect(await gateCode(glirastes)).toBeUndefined();

      // A protected requirement this runner cannot enforce, whose save fails.
      const syncs = () => http.calls.filter(({ url }) => url.includes('/sync?')).length;
      stateStore.failSave = true;
      deployments.splice(0, 1, { ...activeDeployment(privateKey, [], block), deploymentId: id('3910') });
      const failedAt = syncs();
      await vi.waitFor(() => expect(syncs()).toBeGreaterThan(failedAt + 1));
      expect(await gateCode(glirastes)).toBe('privacy_policy_unavailable');

      // Withdrawn, and the next save succeeds: still no way back to unprotected.
      deployments.splice(0, 1, unprotected);
      stateStore.failSave = false;
      const savedAt = stateStore.saves;
      await vi.waitFor(() => expect(stateStore.saves).toBeGreaterThan(savedAt));
      expect(await gateCode(glirastes)).toBe('privacy_not_configured');
      expect((await stateStore.inner.load())?.privacyFloor).toMatchObject({ profile: 'protected-text/v1' });
    });

    it('keeps the floor when an unsigned signal drops the connection and no environment follows (M1)', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const base = platform({
        deployments: [activeDeployment(privateKey, [], block)], publicKey,
        lookup: [
          () => json({ schemaVersion: 1, appId: APP_ID, environmentId: ENVIRONMENT_ID, runnerKey: 'runner-1' }),
          () => json({ schemaVersion: 1, mode: 'development', appId: APP_ID, environmentId: null, runnerKey: 'dev-abcdefghijklm' }),
        ],
      });
      let syncs = 0;
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/sync?') && ++syncs > 1) return json({ code: 'environment_place_required' }, 409);
        return (base.fetchImpl as typeof fetch)(input, init);
      }) as unknown as typeof fetch;
      // A legacy runner: no privacy, no store.
      const glirastes = track(createGlirastes({
        generated: generated(), localLimits: limits, env: {...env, GLIRASTES_STATE_ENVIRONMENT_ID: undefined}, fetchImpl, push: false, pollIntervalMs: 20, onError: vi.fn(),
      }));
      await glirastes.ready();
      expect(await gateCode(glirastes)).toBe('privacy_policy_unavailable');
      await vi.waitFor(() => expect(glirastes.connection()?.environmentId).toBeNull());
      expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_policy_unavailable');
      expect(await gateCode(glirastes)).toBe('privacy_policy_unavailable');
    });
  });

  it('refuses a protected block on a connected runtime without privacy', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const http = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError: vi.fn(),
    }));
    await glirastes.ready();
    expect(glirastes.accepted()).toBeUndefined();
    // The refused revision blocks traffic; nothing runs unprotected on the local code.
    expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_policy_unavailable');
    const turn = await glirastes.chatTurn(principal);
    expect(codeOf(() => turn.managedRuntime.privacyGate({
      request: new Request('https://app.example/api/chat'),
      snapshot: { policyRevision: { revisionId: id('3908') } } as never,
    }))).toBe('privacy_policy_unavailable');
    const beat = http.calls.find(({ url }) => url.includes('/heartbeat'));
    expect(JSON.parse(String(beat?.init.body))).toMatchObject({
      technicalMetadata: { privacy: { state: 'refused', reasons: ['accepted_state_missing'] } },
    });
  });
});
