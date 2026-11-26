import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { MockLanguageModelV3 } from 'ai/test';
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
import { rolloutCohortBucket } from '../../sync/deployment-selector.js';
import { RuntimeControlPlaneRequestError } from '../../sync/control-plane-client.js';
import { RuntimeEnvironmentControlError } from '../../sync/sync-manager.js';
import type {
  GeneratedEndpointToolBinding,
  GeneratedToolBinding,
  GeneratedToolModule,
} from '../contract-bindings.js';
import type { AiChatHandlerConfig } from '../../server/adapters/nextjs/types.js';
import { createGlirastes, type Glirastes, type GlirastesChatTurn } from '../glirastes.js';
import { createAiChatHandler } from '../../server/adapters/nextjs/create-ai-chat-handler.js';
import { SDK_VERSION } from '../sdk-version.js';
import { createTurnMetricsRecorder } from '../metrics/turn-recorder.js';
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
      payload: { budget: limits, toolPolicies: [], ...(toolOverrides.length ? { toolOverrides } : {}) },
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
  control?: unknown;
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
        ...('control' in options ? { control: options.control } : {}),
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

  it('exposes no environment control in Standalone or from a Platform without it', async () => {
    const standalone = track(createGlirastes({ generated: generated(), localLimits: limits, env: {} }));
    await standalone.ready();
    expect(standalone.control()).toBeUndefined();
    await standalone.stop();

    const http = platform();
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 60_000, onError: vi.fn(),
    }));
    await glirastes.ready();
    expect(glirastes.control()).toBeUndefined();
    const sync = http.calls.find(({ url }) => url.includes('/sync?'));
    expect(new URL(sync!.url).searchParams.get('controlVersion')).toBe('1');
    const register = http.calls.find(({ url }) => url.endsWith('/register'));
    expect(JSON.parse(String(register?.init.body)).capabilities).toMatchObject({ environmentControl: 1 });
  });

  it('exposes the accepted environment control, or a local halt when it cannot be verified', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const unsigned = {
      kind: 'environment-control' as const, schemaVersion: 1 as const, tenantId: TENANT_ID, targetAppId: APP_ID, environmentId: ENVIRONMENT_ID,
      sequence: 1, assistant: 'halted' as const, reasonCode: 'operator-halt',
      issuedAt: '2026-11-26T09:00:00.000Z',
    };
    const control = {
      ...unsigned,
      signature: {
        algorithm: 'Ed25519' as const, keyId: 'runtime-key',
        value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url'),
      },
    };
    const accepted = track(createGlirastes({
      generated: generated(), localLimits: limits, env, push: false, pollIntervalMs: 60_000,
      fetchImpl: platform({ publicKey, control }).fetchImpl, onError: vi.fn(),
    }));
    await accepted.ready();
    expect(accepted.control()).toEqual(control);
    await accepted.stop();

    const onError = vi.fn();
    const forged = track(createGlirastes({
      generated: generated(), localLimits: limits, env, push: false, pollIntervalMs: 60_000,
      fetchImpl: platform({ publicKey, control: { ...control, assistant: 'enabled' } }).fetchImpl, onError,
    }));
    await forged.ready();
    expect(forged.control()).toMatchObject({
      kind: 'local', assistant: 'halted', reasonCode: 'control_unverifiable', sequence: 0,
    });
    expect(onError).toHaveBeenCalledWith(expect.any(RuntimeEnvironmentControlError));
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

  function signedControl(privateKey: KeyObject, environmentId: string, sequence: number, assistant: 'enabled' | 'halted') {
    const unsigned = {
      kind: 'environment-control' as const, schemaVersion: 1 as const, tenantId: TENANT_ID, targetAppId: APP_ID,
      environmentId, sequence, assistant, reasonCode: 'operator-halt', issuedAt: '2026-11-26T09:00:00.000Z',
    };
    return {
      ...unsigned,
      signature: {
        algorithm: 'Ed25519' as const, keyId: 'runtime-key',
        value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url'),
      },
    };
  }

  function controlPlatform(options: {
    publicKey: KeyObject;
    environments: string[];
    sync: (environmentId: string, call: number) => Response;
  }) {
    const lookups: string[] = [];
    const syncCalls = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/runtime/connection')) {
        const environmentId = options.environments[Math.min(lookups.length, options.environments.length - 1)]!;
        lookups.push(environmentId);
        return json({ schemaVersion: 1, appId: APP_ID, environmentId, runnerKey: 'runner-1' });
      }
      if (url.includes('jwks')) {
        return json({ keys: [{ ...options.publicKey.export({ format: 'jwk' }), kid: 'runtime-key', alg: 'EdDSA', use: 'sig' }] });
      }
      if (url.includes('/sync?')) {
        const environmentId = /environments\/([^/]+)\//.exec(url)![1]!;
        const call = (syncCalls.get(environmentId) ?? 0) + 1;
        syncCalls.set(environmentId, call);
        return options.sync(environmentId, call);
      }
      if (url.includes('/metrics/events')) return new Response(null, { status: 202 });
      return json({ ok: true });
    }) as unknown as typeof fetch;
    return { fetchImpl, lookups, syncCalls };
  }

  const syncBody = (control?: unknown) => json({
    cursor: '2026-11-26T09:00:00.000Z', activeSnapshotComplete: true, deployments: [], revocations: [],
    ...(control !== undefined ? { control } : {}),
  });

  it('keeps an accepted halt when an unsigned place error drops the connection', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const halt = signedControl(privateKey, ENVIRONMENT_ID, 1, 'halted');
    const http = controlPlatform({
      publicKey,
      environments: [ENVIRONMENT_ID],
      sync: (_environmentId, call) => {
        if (call === 1) return syncBody(halt);
        if (call === 2) return json({ code: 'environment_place_required' }, 409);
        return syncBody(null);
      },
    });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 20, onError: vi.fn(),
    }));

    await glirastes.ready();
    expect(glirastes.control()).toEqual(halt);
    await vi.waitFor(() => expect(http.syncCalls.get(ENVIRONMENT_ID)).toBeGreaterThanOrEqual(4), { timeout: 1_000 });
    expect(http.lookups.length).toBeGreaterThanOrEqual(2);
    expect(glirastes.control()).toEqual(halt);
  });

  it('keeps a dropped halt until the next environment completes its first sync', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const NEXT_ENVIRONMENT_ID = id('3990');
    const halt = signedControl(privateKey, ENVIRONMENT_ID, 1, 'halted');
    let nextMaySync = false;
    const http = controlPlatform({
      publicKey,
      environments: [ENVIRONMENT_ID, NEXT_ENVIRONMENT_ID],
      sync: (environmentId, call) => {
        if (environmentId === ENVIRONMENT_ID) {
          return call === 1 ? syncBody(halt) : json({ code: 'environment_place_required' }, 409);
        }
        return nextMaySync ? syncBody() : json({ code: 'unavailable' }, 503);
      },
    });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 20, onError: vi.fn(),
    }));

    await glirastes.ready();
    await vi.waitFor(() => expect(http.syncCalls.get(NEXT_ENVIRONMENT_ID)).toBeGreaterThanOrEqual(2), { timeout: 1_000 });
    expect(glirastes.control()).toEqual(halt);

    nextMaySync = true;
    await vi.waitFor(() => expect(glirastes.control()).toBeUndefined(), { timeout: 1_000 });
  });

  it('refuses turns with control_unknown under required once a rebound environment has not synced yet', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const NEXT_ENVIRONMENT_ID = id('3991');
    const http = controlPlatform({
      publicKey,
      environments: [ENVIRONMENT_ID, NEXT_ENVIRONMENT_ID],
      sync: (environmentId, call) => {
        if (environmentId === ENVIRONMENT_ID) {
          return call === 1 ? syncBody() : json({ code: 'environment_place_required' }, 409);
        }
        return json({ code: 'unavailable' }, 503);
      },
    });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl: http.fetchImpl, push: false,
      pollIntervalMs: 20, onError: vi.fn(), controlFreshness: 'required',
    }));
    const request = new Request('https://app.example/api/chat', { method: 'POST' });
    const turn = await glirastes.chatTurn(principal);
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'enabled' });

    await vi.waitFor(() => expect(http.syncCalls.get(NEXT_ENVIRONMENT_ID)).toBeGreaterThanOrEqual(1), { timeout: 1_000 });
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'halted', code: 'control_unknown' });
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

describe('createGlirastes environment control enforcement', () => {
  const env = { GLIRASTES_API_KEY: API_KEY, GLIRASTES_CONTROL_PLANE_URL: BASE_URL };

  function signed(privateKey: KeyObject, patch: Record<string, unknown>) {
    const unsigned = {
      kind: 'environment-control' as const, schemaVersion: 1 as const, tenantId: TENANT_ID, targetAppId: APP_ID,
      environmentId: ENVIRONMENT_ID, sequence: 1, assistant: 'enabled', reasonCode: 'operator-tighten',
      issuedAt: '2026-11-26T09:00:00.000Z', ...patch,
    };
    return {
      ...unsigned,
      signature: {
        algorithm: 'Ed25519' as const, keyId: 'runtime-key',
        value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url'),
      },
    };
  }

  const request = new Request('https://app.example/api/chat', { method: 'POST' });

  it('adds no control or rate limit in Standalone', async () => {
    const glirastes = track(createGlirastes({ generated: generated(), localLimits: limits, env: {}, controlFreshness: 'required' }));
    const turn = await glirastes.chatTurn(principal);
    expect(turn.managedRuntime.loadControl).toBeUndefined();
    expect(turn.managedRuntime.admitTurn).toBeUndefined();
  });

  it('hands the accepted halt to the turn, also after the connection dropped', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let syncs = 0;
    const halt = signed(privateKey, { assistant: 'halted', reasonCode: 'operator-halt' });
    const http = platform({ publicKey, control: halt });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/sync?') && ++syncs > 1) return json({ code: 'environment_place_required' }, 409);
      return http.fetchImpl(input, init);
    }) as typeof fetch;
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 20, onError: vi.fn(),
    }));
    const turn = await glirastes.chatTurn(principal);
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'halted', code: 'assistant_halted' });
    await vi.waitFor(() => expect(syncs).toBeGreaterThanOrEqual(3), { timeout: 1_000 });
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'halted', code: 'assistant_halted' });
  });

  it('limits turns per principal in this process with the rate limit of the control', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const control = signed(privateKey, { rateLimit: { maxTurnsPerMinutePerPrincipal: 1 }, budgetCeiling: { maxToolCalls: 2 } });
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, push: false, pollIntervalMs: 60_000, onError: vi.fn(),
      fetchImpl: platform({ publicKey, control }).fetchImpl,
    }));
    const turn = await glirastes.chatTurn(principal);
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({
      assistant: 'enabled', budgetCeiling: { maxToolCalls: 2 }, rateLimit: { maxTurnsPerMinutePerPrincipal: 1 },
    });
    const alice = principal(TENANT_ID);
    expect(await turn.managedRuntime.admitTurn!({ request, principal: alice })).toEqual({ admitted: true });
    expect(await turn.managedRuntime.admitTurn!({ request, principal: alice })).toMatchObject({ admitted: false });
    expect(await turn.managedRuntime.admitTurn!({ request, principal: { ...alice, subjectId: 'bob' } }))
      .toEqual({ admitted: true });
  });

  it('runs turns on the local code before the first sync by default (best-effort)', async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => (
      String(input).includes('/sync?') ? json({ code: 'unavailable' }, 503) : platform().fetchImpl(input, init)
    )) as typeof fetch;
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 60_000, onError: vi.fn(),
    }));
    const turn = await glirastes.chatTurn(principal);
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'enabled' });
  });

  it('refuses turns with control_unknown until the first sync succeeded (required)', async () => {
    let available = false;
    const http = platform();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => (
      String(input).includes('/sync?') && !available ? json({ code: 'unavailable' }, 503) : http.fetchImpl(input, init)
    )) as typeof fetch;
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 20, onError: vi.fn(),
      controlFreshness: 'required',
    }));
    const turn = await glirastes.chatTurn(principal);
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'halted', code: 'control_unknown' });
    available = true;
    await vi.waitFor(async () => {
      expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'enabled' });
    }, { timeout: 1_000 });
  });

  it('raises a cached instance to required on a later stricter call, never lowers it', async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => (
      String(input).includes('/sync?') ? json({ code: 'unavailable' }, 503) : platform().fetchImpl(input, init)
    )) as typeof fetch;
    const create = (controlFreshness?: 'best-effort' | 'required') => createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 60_000, onError: vi.fn(),
      ...(controlFreshness ? { controlFreshness } : {}),
    });
    const glirastes = track(create());
    expect(create('required')).toBe(glirastes);
    expect(create('best-effort')).toBe(glirastes);
    const turn = await glirastes.chatTurn(principal);
    expect(await turn.managedRuntime.loadControl!({ request })).toEqual({ assistant: 'halted', code: 'control_unknown' });
  });

  it('rejects an unknown control freshness', () => {
    expect(() => createGlirastes({
      generated: generated(id('3998')), localLimits: limits, env: {}, controlFreshness: 'strict' as never,
    })).toThrow(/controlFreshness/);
  });
});

describe('createGlirastes canary cohorts', () => {
  const env = { GLIRASTES_API_KEY: API_KEY, GLIRASTES_CONTROL_PLANE_URL: BASE_URL };
  const SALT = 'q3Zr8Kc1VtW0xYbHnL5pJg';
  const CANARY_ID = id('3914');
  const CANARY_POLICY_ID = id('3918');

  function signedBinding(privateKey: KeyObject, deployment: RuntimeDeploymentBundle) {
    const unsigned = {
      kind: 'rollout-binding' as const, schemaVersion: 1 as const, deploymentId: deployment.deploymentId,
      environmentId: ENVIRONMENT_ID, rolloutMode: deployment.rolloutMode, targetPercentage: deployment.targetPercentage,
      cohortSalt: SALT, issuedAt: '2026-11-26T09:00:00.000Z',
    };
    return {
      ...unsigned,
      signature: {
        algorithm: 'Ed25519' as const, keyId: 'runtime-key',
        value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url'),
      },
    };
  }

  function deployments(privateKey: KeyObject, options: { bound?: boolean; canary?: boolean; stableBound?: boolean } = {}) {
    const stable = activeDeployment(privateKey);
    const base = activeDeployment(privateKey);
    const canary: RuntimeDeploymentBundle = {
      ...base, deploymentId: CANARY_ID, rolloutMode: 'canary', targetPercentage: 50,
      policyRevision: revision(privateKey, {
        schemaVersion: 1, revision: 2, tenantId: TENANT_ID, targetAppId: APP_ID, publishedAt: '2026-07-29T00:00:00.000Z',
        revisionId: CANARY_POLICY_ID, revisionType: 'policy', environmentId: ENVIRONMENT_ID,
        payload: { budget: limits, toolPolicies: [] },
      }),
    };
    const bind = (deployment: RuntimeDeploymentBundle) => (options.bound === false
      ? deployment
      : { ...deployment, rolloutBinding: signedBinding(privateKey, deployment) });
    const first = options.stableBound === false ? stable : bind(stable);
    return options.canary === false ? [first] : [first, bind(canary)];
  }

  const subjects = Array.from({ length: 200 }, (_, index) => `user-${index}`);
  const inCanary = subjects.find((subject) => rolloutCohortBucket(SALT, subject) < 50)!;
  const inStable = subjects.find((subject) => rolloutCohortBucket(SALT, subject) >= 50)!;
  const as = (subjectId: string) => ({ ...principal(TENANT_ID), subjectId });

  async function connected(
    sync: () => RuntimeDeploymentBundle[],
    publicKey: KeyObject,
    control?: () => unknown,
    extra: Partial<Parameters<typeof createGlirastes>[0]> & { syncFails?: () => boolean } = {},
  ) {
    const { syncFails, ...overrides } = extra;
    const http = platform({ publicKey });
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (!String(input).includes('/sync?')) return http.fetchImpl(input, init);
      http.calls.push({ url: String(input), init });
      if (syncFails?.()) return new Response('{}', { status: 503 });
      return json({
        cursor: '2026-07-29T00:02:00.000Z', activeSnapshotComplete: true, deployments: sync(), revocations: [],
        ...(control ? { control: control() } : {}),
      });
    }) as typeof fetch;
    const glirastes = track(createGlirastes({
      generated: generated(), localLimits: limits, env, fetchImpl, push: false, pollIntervalMs: 20, onError: vi.fn(),
      ...overrides,
    }));
    await glirastes.ready();
    return { glirastes, calls: http.calls };
  }

  async function turn(glirastes: Glirastes, subjectId: string, turnId: string, conversationId = turnId) {
    const chat = await glirastes.chatTurn(principal);
    const snapshot = await chat.managedRuntime.resolveTurnSnapshot({ turnId, conversationId, principal: as(subjectId) });
    return { snapshot, rollout: chat.managedRuntime.turnRollout?.({ turnId }) };
  }

  it('negotiates canary selection at registration and sync', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { calls } = await connected(() => deployments(privateKey), publicKey);
    const sync = calls.find(({ url }) => url.includes('/sync?'));
    expect(new URL(sync!.url).searchParams.get('canaryVersion')).toBe('1');
    const register = calls.find(({ url }) => url.endsWith('/register'));
    expect(JSON.parse(String(register?.init.body)).capabilities).toMatchObject({ canarySelection: 1 });
  });

  it('runs a bound canary for its cohort and the stable deployment for the rest, reported per turn', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { glirastes } = await connected(() => deployments(privateKey), publicKey);

    const canary = await turn(glirastes, inCanary, 'ai-t1');
    expect(canary.snapshot.policyRevision.revisionId).toBe(CANARY_POLICY_ID);
    expect(canary.rollout).toEqual({ deploymentId: CANARY_ID, cohort: 'canary' });

    const stable = await turn(glirastes, inStable, 'ai-t2');
    expect(stable.snapshot.policyRevision.revisionId).toBe(id('3908'));
    expect(stable.rollout).toEqual({ deploymentId: id('3904'), cohort: 'stable' });
    expect(glirastes.accepted()?.policyRevision.revisionId).toBe(id('3908'));
  });

  it('keeps a continuation on the snapshot of its turn', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { glirastes } = await connected(() => deployments(privateKey), publicKey);
    const first = await turn(glirastes, inCanary, 'ai-t1', 'chat-1');
    const continued = await turn(glirastes, inCanary, 'ai-t1', 'chat-1');
    expect(continued.snapshot).toBe(first.snapshot);
    expect(continued.rollout).toEqual(first.rollout);
  });

  it('keeps a conversation on stable when another user would be canary, and moves it after a withdrawal', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let withCanary = true;
    const { glirastes } = await connected(() => deployments(privateKey, { canary: withCanary }), publicKey);
    expect((await turn(glirastes, inCanary, 'ai-t1', 'chat-1')).rollout?.cohort).toBe('canary');
    expect((await turn(glirastes, inStable, 'ai-t2', 'chat-1')).rollout?.cohort).toBe('stable');
    expect((await turn(glirastes, inCanary, 'ai-t3', 'chat-1')).rollout?.cohort).toBe('canary');

    withCanary = false;
    await vi.waitFor(async () => {
      expect((await turn(glirastes, inCanary, `ai-t${Date.now()}`, 'chat-1')).rollout).toEqual({ deploymentId: id('3904'), cohort: 'stable' });
    }, { timeout: 1_000 });
  });

  it('never runs an unbound canary, reports it in the heartbeat and no cohort without negotiated bindings', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { glirastes, calls } = await connected(() => deployments(privateKey, { bound: false }), publicKey);
    const result = await turn(glirastes, inCanary, 'ai-t1');
    expect(result.snapshot.policyRevision.revisionId).toBe(id('3908'));
    expect(result.rollout).toBeUndefined();
    const heartbeat = calls.find(({ url }) => url.endsWith('/heartbeat'));
    expect(JSON.parse(String(heartbeat?.init.body)).technicalMetadata).toMatchObject({ canaryState: 'unbound' });
  });

  it('never runs a bound canary while the stable deployment is unbound, and reports turns as v2', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { glirastes } = await connected(() => deployments(privateKey, { stableBound: false }), publicKey);
    for (const [index, subjectId] of subjects.slice(0, 40).entries()) {
      const result = await turn(glirastes, subjectId, `ai-t${index}`);
      expect(result.snapshot.policyRevision.revisionId).toBe(id('3908'));
      expect(result.rollout).toBeUndefined();
    }
  });

  it('applies a budget ceiling and a halt to canary turns', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signedControl = (patch: Record<string, unknown>) => {
      const unsigned = {
        kind: 'environment-control' as const, schemaVersion: 1 as const, tenantId: TENANT_ID, targetAppId: APP_ID,
        environmentId: ENVIRONMENT_ID, sequence: 1, assistant: 'enabled', reasonCode: 'operator-tighten',
        issuedAt: '2026-11-26T09:00:00.000Z', ...patch,
      };
      return {
        ...unsigned,
        signature: {
          algorithm: 'Ed25519' as const, keyId: 'runtime-key',
          value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), privateKey).toString('base64url'),
        },
      };
    };
    let control = signedControl({ budgetCeiling: { maxToolCalls: 2 } });
    const { glirastes } = await connected(() => deployments(privateKey), publicKey, () => control);
    const snapshots: unknown[] = [];
    const run = async (turnId: string) => {
      const chat = await glirastes.chatTurn((tenantId) => ({ ...as(inCanary), tenantId }));
      const handler = createAiChatHandler({
        ...chat, model: new MockLanguageModelV3(), systemPrompt: 'Assistant',
        streamHandler: async (context) => {
          snapshots.push(context.managedTurn?.snapshot);
          return new Response('ok');
        },
      });
      return handler(new Request('https://app.example/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: turnId, role: 'user', parts: [{ type: 'text', text: 'Show tasks' }] }] }),
      }));
    };

    expect((await run('u1')).status).toBe(200);
    expect(snapshots[0]).toMatchObject({
      policyRevision: { revisionId: CANARY_POLICY_ID }, budget: { ...limits, maxToolCalls: 2 },
    });

    control = signedControl({ sequence: 2, assistant: 'halted', reasonCode: 'operator-halt' });
    await vi.waitFor(() => expect(glirastes.control()).toMatchObject({ assistant: 'halted' }), { timeout: 1_000 });
    const halted = await run('u2');
    expect(halted.status).toBe(503);
    expect(await halted.json()).toEqual({ error: 'assistant_halted' });
    expect(snapshots).toHaveLength(1);
  });

  it('neither negotiates nor selects a canary without a metrics sink', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { glirastes, calls } = await connected(() => deployments(privateKey), publicKey, undefined, { metrics: false });
    const sync = calls.find(({ url }) => url.includes('/sync?'));
    expect(new URL(sync!.url).searchParams.has('canaryVersion')).toBe(false);
    const register = calls.find(({ url }) => url.endsWith('/register'));
    expect(JSON.parse(String(register?.init.body)).capabilities).not.toHaveProperty('canarySelection');
    for (const [index, subjectId] of subjects.slice(0, 40).entries()) {
      const result = await turn(glirastes, subjectId, `ai-t${index}`);
      expect(result.snapshot.policyRevision.revisionId).toBe(id('3908'));
      expect(result.rollout).toBeUndefined();
    }
    for (const heartbeat of calls.filter(({ url }) => url.endsWith('/heartbeat'))) {
      expect(JSON.parse(String(heartbeat.init.body)).technicalMetadata).not.toHaveProperty('canaryState');
    }
  });

  it('stops selecting the canary once the last sync is stale and selects it again after a fresh one', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let unreachable = false;
    const { glirastes } = await connected(() => deployments(privateKey), publicKey, undefined, {
      canaryMaxStalenessMs: 100, syncFails: () => unreachable,
    });
    expect((await turn(glirastes, inCanary, 'ai-t1')).rollout?.cohort).toBe('canary');

    unreachable = true;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stale = await turn(glirastes, inCanary, 'ai-t2');
    expect(stale.snapshot.policyRevision.revisionId).toBe(id('3908'));
    expect(stale.rollout).toEqual({ deploymentId: id('3904'), cohort: 'stable' });

    unreachable = false;
    await vi.waitFor(async () => {
      expect((await turn(glirastes, inCanary, `ai-t${Date.now()}`)).rollout?.cohort).toBe('canary');
    }, { timeout: 1_000 });
  });

  it('reports a canary turn as v3 to a custom recorder that passes only the snapshot', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { glirastes } = await connected(() => deployments(privateKey), publicKey);
    const sink = { identity: glirastes.metrics!.identity, record: vi.fn(), flush: vi.fn(), close: vi.fn() };
    for (const [subjectId, cohort, deploymentId] of [[inCanary, 'canary', CANARY_ID], [inStable, 'stable', id('3904')]] as const) {
      const { snapshot } = await turn(glirastes, subjectId, `ai-${cohort}`);
      const event = createTurnMetricsRecorder({ sink, snapshot, startedAtMs: Date.now() })
        .finish({ status: 'completed', errorCode: null });
      expect(event).toMatchObject({ schemaVersion: 3, cohort, deploymentId });
    }
  });

  it('adds no rollout in Standalone', async () => {
    const glirastes = track(createGlirastes({ generated: generated(id('3997')), localLimits: limits, env: {} }));
    const chat = await glirastes.chatTurn(principal);
    expect(chat.managedRuntime.turnRollout?.({ turnId: 'ai-t1' })).toBeUndefined();
  });
});
