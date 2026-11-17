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
});

// The turn helper spreads straight into the chat handler config.
type SpreadsIntoChatHandler = GlirastesChatTurn extends Partial<AiChatHandlerConfig> ? true : never;
const spreadsIntoChatHandler: SpreadsIntoChatHandler = true;

describe('createGlirastes in standalone', () => {
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
  const env = { GLIRASTES_API_KEY: API_KEY, GLIRASTES_CONTROL_PLANE_URL: BASE_URL };
  const block: PrivacyPolicyBlock = {
    schemaVersion: 1,
    profile: 'protected-text/v1',
    screenshots: { mode: 'blocked' },
    providers: { allowed: [{ entryId: 'main', bindingDigest: digest('A') }], defaultEntryId: 'main', userChoice: false },
    mapping: { idleTtlSeconds: 1800, absoluteTtlSeconds: 7200 },
    speech: { localOnly: true, maxDurationSeconds: 45 },
  };
  const privacy = (bindingDigest = digest('A')): GlirastesPrivacyOptions => ({
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

  it('enforces the local profile in standalone when required', () => {
    const glirastes = track(createGlirastes({ generated: generated(), env: {}, privacy: { ...privacy(), local: { required: true } } }));
    expect(glirastes.privacyPolicy()).toMatchObject({ source: 'local', profile: 'protected-text/v1' });
  });

  it('blocks managed bootstrap without infrastructure when live sync has no active deployment', async () => {
    const http = platform();
    const instance = track(createGlirastes({ generated: generated(), env, fetchImpl: http.fetchImpl,
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

  it.each([false, true])('blocks chat and speech when accepted off is revoked (local infrastructure: %s)', async (configured) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const revocations: SecurityRevocation[] = [];
    const http = platform({ deployments: [activeDeployment(privateKey, [], { schemaVersion: 1, profile: 'off' })], publicKey, revocations });
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
    await vi.waitFor(() => expect(glirastes.revocations()).toHaveLength(1));
    expect(codeOf(() => glirastes.speechPolicy())).toBe('privacy_policy_revoked');
    expect(codeOf(() => turn.managedRuntime.privacyGate({
      request: new Request('https://app.example/api/chat'), snapshot: { policyRevision: pinned } as never,
    }))).toBe('privacy_policy_revoked');
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
      // No attacker-controlled floor was persisted. A managed runner still
      // awaits a verified active policy; missing infrastructure is no bypass.
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
        expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_not_configured');
        expect(await gateCode(glirastes)).toBe('privacy_not_configured');
        await glirastes.stop();
      }
    });

    it('leaves legacy operation unchanged: no capability, and a protected policy is refused, never applied', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const unprotected = platform({ deployments: [activeDeployment(privateKey)], publicKey });
      const legacy = createGlirastes({
        generated: generated(), localLimits: limits, env, fetchImpl: unprotected.fetchImpl, push: false,
        pollIntervalMs: 60_000, onError: vi.fn(),
      });
      await legacy.ready();
      expect(capabilities(unprotected)).not.toHaveProperty('privacyPolicyVersions');
      expect(legacy.privacyPolicy()).toBeNull();
      expect(await gateCode(legacy)).toBeUndefined();
      await legacy.stop();

      const protectedHttp = platform({ deployments: [activeDeployment(privateKey, [], block)], publicKey });
      const refusing = track(createGlirastes({
        generated: generated(), localLimits: limits, env, fetchImpl: protectedHttp.fetchImpl, push: false,
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
        // Without `privacy`: a store or privacy providers in the artifact mark the deployment as managed.
        { generated: generated(), stateStore: () => new SharedDurableTestStore() },
        { generated: providers },
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
        generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 20, onError: vi.fn(),
      }));
      await glirastes.ready();
      expect(await gateCode(glirastes)).toBe('privacy_not_configured');
      await vi.waitFor(() => expect(glirastes.connection()?.environmentId).toBeNull());
      expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_not_configured');
      expect(await gateCode(glirastes)).toBe('privacy_not_configured');
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
    expect(codeOf(() => glirastes.privacyPolicy())).toBe('privacy_not_configured');
    const turn = await glirastes.chatTurn(principal);
    expect(codeOf(() => turn.managedRuntime.privacyGate({
      request: new Request('https://app.example/api/chat'),
      snapshot: { policyRevision: { revisionId: id('3908') } } as never,
    }))).toBe('privacy_not_configured');
    const beat = http.calls.find(({ url }) => url.includes('/heartbeat'));
    expect(JSON.parse(String(beat?.init.body))).toMatchObject({
      technicalMetadata: { privacy: { state: 'refused', reasons: ['store_missing'] } },
    });
  });
});
