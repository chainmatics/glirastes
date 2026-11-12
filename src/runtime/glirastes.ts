import {
  AppSetupArtifactSchema,
  type Principal,
  type SecurityRevocation,
} from '../contracts/index.js';
import type { ToolRegistry } from '../types.js';
import {
  lookupRuntimeConnection,
  type ResolvedRuntimeConnection,
} from '../sync/connection-lookup.js';
import type { RuntimePushConnector } from '../sync/control-plane-client.js';
import { validateLocalDeploymentBindings } from '../sync/local-deployment-validator.js';
import { createManagedRuntimeSync } from '../sync/managed-sync.js';
import {
  materializeDeploymentRevisions,
  type MaterializedDeploymentRevisions,
} from '../sync/materialize-deployment.js';
import type { RuntimeStateStore, RuntimeSyncState } from '../sync/state-store.js';
import {
  createContractBindings,
  type ContractBindingsResult,
  type GeneratedToolBinding,
  type GeneratedToolModule,
} from './contract-bindings.js';
import {
  createLocalRuntimeSource,
  type LocalRuntimeSource,
} from './local-runtime-source.js';
import {
  materializeManifestToolRegistry,
  type LocalToolBinding,
} from './local-tool-bindings.js';
import {
  createRuntimeMetricsSinkFromEnv,
  type RuntimeMetricsSinkOptions,
} from './metrics/sink.js';
import type { RuntimeMetricsSink } from './metrics/turn-recorder.js';
import { policyOverlayFromRevision } from './policy-overlay.js';
import { resolveRuntimeConnectionConfig } from './runtime-mode.js';
import { resolveLocalLimits, type LocalLimits } from './local-limits.js';
import { SDK_VERSION } from './sdk-version.js';
import type { ToolSearchSemanticsMap } from './tool-discovery.js';
import type { TurnSnapshot } from './turn-snapshot.js';

const DEFAULT_FIRST_SYNC_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;

/** The module `glirastes tools refresh` emits (`tools.generated.ts`). */
export interface GlirastesGeneratedModule extends GeneratedToolModule {
  readonly toolSearchSemantics?: ToolSearchSemanticsMap;
}

export interface CreateGlirastesOptions {
  /** The generated module, e.g. `import * as generated from '@/generated/glirastes/tools.generated'`. */
  generated: GlirastesGeneratedModule;
  /** Local turn limits; the runtime never exceeds them, whatever a Platform revision allows. Unset fields use `DEFAULT_LOCAL_LIMITS`. */
  localLimits?: LocalLimits;
  /**
   * Wraps the generated bindings before they are bound, e.g. to add write
   * feedback to the endpoint tools. Called once per process.
   */
  wrapBindings?: (
    bindings: ReadonlyArray<GeneratedToolBinding>,
  ) => ReadonlyArray<GeneratedToolBinding>;
  /** Defaults to `process.env`. Only `GLIRASTES_API_KEY` (and an optional `GLIRASTES_CONTROL_PLANE_URL`) are read. */
  env?: Record<string, string | undefined>;
  /**
   * Content-free connection and sync errors (operation and status only).
   * Defaults to one `console.error` line. The app keeps running on the local
   * code whatever is reported here.
   */
  onError?: (error: unknown) => void;
  /** The app version reported at runner registration. Defaults to `GLIRASTES_BUILD_ID`, else `glirastes@<sdk version>`. */
  version?: string;
  /** A technical runtime label reported at registration, e.g. `nextjs`. */
  runtime?: string;
  fetchImpl?: typeof fetch;
  /** Push connector for revision updates; false polls only. */
  push?: RuntimePushConnector | false;
  /** Poll interval of the sync, and the retry interval of the lookup and registration (default 30 s). */
  pollIntervalMs?: number;
  /** How long `ready()` waits for the first sync (default 5 s). */
  firstSyncTimeoutMs?: number;
  /** Options for the metrics sink, or false to send no metrics. */
  metrics?: Omit<
    RuntimeMetricsSinkOptions,
    'controlPlaneUrl' | 'apiKey' | 'appId' | 'environmentId' | 'buildId' | 'fetch'
  > | false;
}

/** Builds the principal of a turn in the runtime tenant from the verified server session. */
export type GlirastesPrincipalFactory = (
  runtimeTenantId: string,
  request: Request,
) => Principal | undefined | Promise<Principal | undefined>;

/** What `createAiChatHandler` needs for one turn; spread it into the handler config. */
export interface GlirastesChatTurn {
  managedRuntime: {
    resolvePrincipal: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
    resolveTurnSnapshot: (context: { turnId: string; principal: Principal }) => TurnSnapshot;
    loadRevocations: (context: { request: Request; snapshot: TurnSnapshot }) => SecurityRevocation[];
  };
  loadTools: (context: { turnSnapshot?: TurnSnapshot }) => ToolRegistry;
  toolSemantics?: ToolSearchSemanticsMap;
  metrics?: RuntimeMetricsSink;
}

export interface Glirastes {
  /** `connected` when `GLIRASTES_API_KEY` is set, otherwise `standalone` (network-silent). */
  readonly mode: 'standalone' | 'connected';
  /** The local tool bindings of the code, after `wrapBindings`. */
  readonly bindings: ReadonlyArray<LocalToolBinding>;
  /** Tools of the setup artifact the code does not bind (any more). */
  readonly disabled: ContractBindingsResult['disabled'];
  readonly toolSearchSemantics: ToolSearchSemanticsMap | undefined;
  /** The sink for turn metrics; undefined in Standalone and until the connection was looked up. */
  readonly metrics: RuntimeMetricsSink | undefined;
  /** The app, environment and runner the Platform answered for the key; undefined until then. */
  connection(): ResolvedRuntimeConnection | undefined;
  /**
   * Starts the connection in the background (once) and resolves after the
   * first sync or the first-sync timeout. Never rejects; resolves at once in
   * Standalone.
   */
  ready(): Promise<void>;
  /** The source of the next turn: the local code, or the accepted Platform deployment. */
  currentSource(): LocalRuntimeSource;
  /** The deployment the sync accepted; undefined before the first one. */
  accepted(): MaterializedDeploymentRevisions | undefined;
  /** The signed revocations the sync accepted, checked before every tool call. */
  revocations(): SecurityRevocation[];
  /** Waits for `ready()`, then returns what `createAiChatHandler` needs for one turn. */
  chatTurn(principal: GlirastesPrincipalFactory): Promise<GlirastesChatTurn>;
  /** Stops the sync, flushes the metrics and forgets this instance. */
  stop(): Promise<void>;
}

/** Keeps the sync state in memory and the accepted deployment materialized for the turns. */
class AcceptedStateStore implements RuntimeStateStore {
  private state: RuntimeSyncState | null = null;
  private stable: MaterializedDeploymentRevisions | undefined;

  async load(): Promise<RuntimeSyncState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async saveAtomic(state: RuntimeSyncState): Promise<void> {
    this.state = structuredClone(state);
    this.stable = state.stable ? materializeDeploymentRevisions(state.stable) : undefined;
  }

  accepted(): MaterializedDeploymentRevisions | undefined {
    return this.stable;
  }

  revocations(): SecurityRevocation[] {
    return this.state?.revocations ?? [];
  }
}

function logError(error: unknown): void {
  // The SDK's request errors name the operation and the status only.
  console.error('[Glirastes]', error instanceof Error ? error.message : 'connection failed');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

// Next.js bundles instrumentation and each route separately, so the one
// instance per app and process lives on globalThis, keyed by the app id.
const INSTANCES = Symbol.for('glirastes.runtime.instances');
type InstanceHolder = { [INSTANCES]?: Map<string, Glirastes> };

function instances(): Map<string, Glirastes> {
  const holder = globalThis as InstanceHolder;
  holder[INSTANCES] ??= new Map();
  return holder[INSTANCES];
}

/**
 * The Glirastes runtime of one app: the tools derived from the code, and,
 * connected, the Platform connection behind them. One instance per app and
 * process: a second call with the same generated app returns the first
 * instance (its options are ignored), so route bundles can each call it.
 *
 * Without `GLIRASTES_API_KEY` the app runs Standalone and never touches the
 * network. With it, the first `ready()` (or `chatTurn()`) asks the Platform
 * which app, environment and runner the key belongs to, registers, reports
 * the code and syncs. Until that succeeds the turns run on the local code;
 * failures go to `onError` and are retried. A key of a different app is an
 * error, never a silent switch. A malformed key or URL throws here.
 */
export function createGlirastes(options: CreateGlirastesOptions): Glirastes {
  const appId = AppSetupArtifactSchema.parse(options.generated.setupArtifact).appId;
  const existing = instances().get(appId);
  if (existing) return existing;
  const instance = createInstance(options, appId);
  instances().set(appId, instance);
  return instance;
}

function createInstance(options: CreateGlirastesOptions, appId: string): Glirastes {
  const env = options.env ?? process.env;
  const config = resolveRuntimeConnectionConfig(env);
  const onError = (error: unknown) => {
    try {
      (options.onError ?? logError)(error);
    } catch {
      // Reporting must never break the runtime.
    }
  };
  const generated: GeneratedToolModule = options.wrapBindings
    ? {
        setupArtifact: options.generated.setupArtifact,
        createToolBindings: () => options.wrapBindings!(options.generated.createToolBindings()),
      }
    : options.generated;
  const bound = createContractBindings(generated);
  const localSource = (identity?: { tenantId?: string; targetAppId?: string; environmentId?: string }, managed?: {
    accepted: () => MaterializedDeploymentRevisions | undefined;
  }) => createLocalRuntimeSource({
    setupArtifact: bound.setupArtifact,
    bindings: bound.bindings,
    localLimits: resolveLocalLimits(options.localLimits),
    ...(identity ? { identity } : {}),
    ...(managed
      ? {
          policyOverlay: () => {
            const current = managed.accepted();
            return current && policyOverlayFromRevision(current.policyRevision);
          },
          platformRevisions: managed.accepted,
        }
      : {}),
  });

  const base = localSource();
  const store = new AcceptedStateStore();
  const abort = new AbortController();
  const retryMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
  let resolved: ResolvedRuntimeConnection | undefined;
  let connectedBase: LocalRuntimeSource | undefined;
  let managed: { tenantId: string; source: LocalRuntimeSource } | undefined;
  let metrics: RuntimeMetricsSink | undefined;
  let stopSync: (() => void) | undefined;
  let started = false;
  // Settles after the first attempt, successful or not: a turn waits for the
  // first sync at most once, not on every turn while the Platform is away.
  let settleFirstAttempt!: () => void;
  const firstAttempt = new Promise<void>((resolve) => {
    settleFirstAttempt = resolve;
  });

  const connect = async (): Promise<void> => {
    if (!config) return;
    let connection: ResolvedRuntimeConnection | undefined;
    while (!abort.signal.aborted && !connection) {
      try {
        connection = await lookupRuntimeConnection({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          signal: abort.signal,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        onError(error);
        settleFirstAttempt();
        await delay(retryMs, abort.signal);
      }
    }
    if (!connection || abort.signal.aborted) return;
    if (connection.appId !== appId) {
      // A key of another app: report once and stay on the local code.
      onError(new Error('The Glirastes runtime key belongs to a different app than this code'));
      return;
    }

    let sync: ReturnType<typeof createManagedRuntimeSync>;
    try {
      sync = createManagedRuntimeSync({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        appId: connection.appId,
        environmentId: connection.environmentId,
        runnerKey: connection.runnerKey,
        version: options.version?.trim() || env.GLIRASTES_BUILD_ID?.trim() || `glirastes@${SDK_VERSION}`,
        stateStore: store,
        setupArtifact: options.generated.setupArtifact,
        // A deployment that names a tool this code lacks, or has changed, keeps running on the local tool.
        validateDeployment: (_deployment, revisions) => {
          validateLocalDeploymentBindings({ revisions, bindings: bound.bindings });
        },
        onError,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.push !== undefined ? { push: options.push } : {}),
        pollIntervalMs: retryMs,
      });
    } catch (error) {
      onError(error);
      return;
    }
    resolved = connection;
    connectedBase = localSource({
      targetAppId: connection.appId,
      environmentId: connection.environmentId,
    });
    if (options.metrics !== false) {
      metrics = createRuntimeMetricsSinkFromEnv(env, {
        ...options.metrics,
        connection,
        ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
      });
    }
    stopSync = () => sync.client.stop();

    while (!abort.signal.aborted) {
      try {
        await sync.client.register({
          capabilities: { aiSdk: true },
          technicalMetadata: { runtime: options.runtime ?? 'node' },
        });
        await sync.reportCapabilities().catch(onError);
        await sync.client.syncOnce();
        break;
      } catch (error) {
        onError(error);
        settleFirstAttempt();
        await delay(retryMs, abort.signal);
      }
    }
    if (!abort.signal.aborted) void sync.client.start();
  };

  const instance: Glirastes = {
    mode: config ? 'connected' : 'standalone',
    bindings: bound.bindings,
    disabled: bound.disabled,
    toolSearchSemantics: options.generated.toolSearchSemantics,
    get metrics() {
      return metrics;
    },
    connection: () => resolved && { ...resolved },
    ready() {
      if (!config) return Promise.resolve();
      if (!started) {
        started = true;
        void connect().catch(onError).finally(settleFirstAttempt);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.firstSyncTimeoutMs ?? DEFAULT_FIRST_SYNC_TIMEOUT_MS);
        timer.unref?.();
      });
      return Promise.race([firstAttempt, timeout]).finally(() => clearTimeout(timer));
    },
    currentSource() {
      const accepted = store.accepted();
      if (!resolved || !connectedBase) return base;
      if (!accepted) return connectedBase;
      // Signed Platform decisions restrict the local policy, never widen it.
      const tenantId = accepted.policyRevision.tenantId;
      if (managed?.tenantId !== tenantId) {
        managed = {
          tenantId,
          source: localSource(
            { tenantId, targetAppId: resolved.appId, environmentId: resolved.environmentId },
            { accepted: () => store.accepted() },
          ),
        };
      }
      return managed.source;
    },
    accepted: () => store.accepted(),
    revocations: () => store.revocations(),
    async chatTurn(principal) {
      await instance.ready();
      const source = instance.currentSource();
      const tenantId = source.identity.tenantId;
      const currentMetrics = metrics;
      return {
        managedRuntime: {
          resolvePrincipal: (request) => principal(tenantId, request),
          resolveTurnSnapshot: (context) => source.resolveTurnSnapshot(context),
          loadRevocations: () => store.revocations(),
        },
        loadTools: ({ turnSnapshot }) => (turnSnapshot
          ? materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: bound.bindings })
          : {}),
        ...(options.generated.toolSearchSemantics
          ? { toolSemantics: options.generated.toolSearchSemantics }
          : {}),
        ...(currentMetrics ? { metrics: currentMetrics } : {}),
      };
    },
    async stop() {
      abort.abort();
      stopSync?.();
      if (instances().get(appId) === instance) instances().delete(appId);
      await metrics?.close();
    },
  };
  return instance;
}
