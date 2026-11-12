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
import { SDK_VERSION } from '../sdk-version.js';
import { createLocalSchemaDigest } from '../local-tool-bindings.js';

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

function generated(appId = APP_ID): GeneratedToolModule & { toolSearchSemantics: Record<string, { synonyms: string[] }> } {
  return {
    setupArtifact: setupArtifact(appId),
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

function activeDeployment(privateKey: KeyObject): RuntimeDeploymentBundle {
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
      payload: { budget: limits, toolPolicies: [] },
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
        revocations: [],
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
