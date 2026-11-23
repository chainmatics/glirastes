import { z } from 'zod';
import {
  AppSetupArtifactSchema,
  isProtectedPolicy,
  type EffectivePrivacyPolicy,
  type Principal,
  type SecurityRevocation,
} from '../contracts/index.js';
import { PrivacyError } from '../server/pii-shield/detection-result.js';
import type { ToolRegistry } from '../types.js';
import {
  lookupRuntimeConnection,
  type ResolvedRuntimeConnection,
} from '../sync/connection-lookup.js';
import {
  RuntimeControlPlaneRequestError,
  type RuntimePushConnector,
} from '../sync/control-plane-client.js';
import { validateLocalDeploymentBindings } from '../sync/local-deployment-validator.js';
import { createManagedRuntimeSync } from '../sync/managed-sync.js';
import { effectivePrivacyPolicyDigest } from '../sync/privacy-digest.js';
import {
  materializeDeploymentRevisions,
  type MaterializedDeploymentRevisions,
} from '../sync/materialize-deployment.js';
import {
  parseRuntimeSyncState,
  type RuntimePrivacyFloor,
  type RuntimeStateStore,
  type RuntimeSyncState,
} from '../sync/state-store.js';
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
import {
  assertPrivacyTurn,
  effectivePrivacyPolicyFor,
  privacyRuntimeStatus,
  type GlirastesPrivacyOptions,
  type PinnedPrivacyPolicy,
} from './privacy-runtime.js';
import { resolveRuntimeConnectionConfig } from './runtime-mode.js';
import { resolveLocalLimits, type LocalLimits } from './local-limits.js';
import { SDK_VERSION } from './sdk-version.js';
import { assertMaxResultChars } from './result-limit.js';
import type { ToolSearchSemanticsMap } from './tool-discovery.js';
import type { ToolTextsMap } from './tool-texts.js';
import type { ToolFailureClassifier } from './tool-failure.js';
import type { TurnSnapshot } from './turn-snapshot.js';

const DEFAULT_FIRST_SYNC_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;

/** The module `glirastes tools refresh` emits (`tools.generated.ts`). */
export interface GlirastesGeneratedModule extends GeneratedToolModule {
  readonly toolSearchSemantics?: ToolSearchSemanticsMap;
  /** Labels per language; emitted only when tools.json names `languages`. */
  readonly toolTexts?: ToolTextsMap;
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
  /** Defaults to `process.env`. Reads `GLIRASTES_API_KEY`, `GLIRASTES_ENVIRONMENT` and an optional `GLIRASTES_CONTROL_PLANE_URL`. */
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
  /**
   * Classifies failed backend calls of endpoint tools as `'error'` or
   * `'expected'`; `chatTurn()` hands it to `createAiChatHandler` (see
   * `AiChatHandlerConfig.classifyToolFailure`). Expected failures are
   * counted locally only and never sent to the Platform.
   */
  classifyToolFailure?: ToolFailureClassifier;
  /**
   * The protected-text profile of this runtime: the strict shield (persistent
   * mapping store and keyring), the provider registry and the local policy.
   * Pseudonymization is off unless local.required is explicitly true or a
   * verified signed policy requires it. managed:true explicitly opts into
   * fail-closed Platform bootstrap before the first verified policy arrives. Without it, a deployment with a protected block is
   * refused and reported (`privacy_refused`).
   */
  privacy?: GlirastesPrivacyOptions;
  /**
   * Keeps the accepted sync state of an environment, privacy floor included,
   * across restarts, e.g. `(id) => new FileRuntimeStateStore(`/var/lib/app/glirastes-${id}.json`)`
   * on a persistent volume, or a database-backed store with `durable: true`.
   *
   * Configuring this factory explicitly opts into managed privacy bootstrap;
   * a fixed stateEnvironmentId is required even without a privacy object.
   * Managed privacy requires it: connected with `privacy`, a protected
   * policy is enforced, confirmed and claimed as a capability only with a
   * durable store; without one it is refused (`accepted_state_missing`).
   * Explicit managed/local-required activation or retained signed privacy
   * authority keeps traffic blocked (`privacy_policy_unavailable`) until
   * the store was read and the state came from a verified sync: a lost or
   * new state needs a sync of this process, an unreadable one is never
   * overwritten, and after a failed save until a verified state was saved.
   * The `ready()` timeout releases none of this.
   */
  stateStore?: (environmentId: string) => RuntimeStateStore;
  /** Explicit managed-bootstrap opt-in and stable nonsecret binding. Also GLIRASTES_STATE_ENVIRONMENT_ID.
   * Loads retained authority before network discovery; must match the authenticated
   * live connection. Keep this and the durable store across restarts/downgrades. */
  stateEnvironmentId?: string;
  /**
   * Upper bound of a serialized successful tool result in characters
   * (integer from 1,000 to 200,000, default 16,000); `chatTurn()` hands it to
   * `createAiChatHandler` (see `AiChatHandlerConfig.maxResultChars`). A
   * tool's own `maxResultChars` wins. An invalid value throws here.
   */
  maxResultChars?: number;
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
    /** Throws a `PrivacyError` when a turn cannot run under its privacy policy. */
    privacyGate: (context: { request: Request; snapshot: TurnSnapshot }) => void;
    /** The digest of the effective privacy policy this runtime reports for a snapshot. */
    privacyEffectiveDigest: (context: { request: Request; snapshot: TurnSnapshot }) => string | null;
  };
  loadTools: (context: { turnSnapshot?: TurnSnapshot }) => ToolRegistry;
  toolSemantics?: ToolSearchSemanticsMap;
  /** Present when the generated module has labels per language (tools.json `languages`). */
  toolTexts?: ToolTextsMap;
  metrics?: RuntimeMetricsSink;
  classifyToolFailure?: ToolFailureClassifier;
  maxResultChars?: number;
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
  /**
   * The effective privacy policy of the accepted deployment (signed block
   * merged with the local policy), or `null` when the profile is off. Throws
   * `privacy_policy_unavailable` while a connected runtime waits for its
   * first verified deployment, `privacy_policy_revoked` and
   * `privacy_not_configured` like a chat turn would. For paths outside the
   * chat handler, e.g. local speech.
   */
  privacyPolicy(): EffectivePrivacyPolicy | null;
  /**
   * The speech part of `privacyPolicy()` for a transcription route:
   * `'off'` when no protected policy applies, otherwise its limits (local
   * service only, maximum duration). Throws like `privacyPolicy()`, so a
   * route answers 503 instead of falling back to a cloud service. Pass it
   * as `policy` to `createRecordingTranscriptionHandler`.
   */
  speechPolicy(): EffectivePrivacyPolicy['speech'] | 'off';
  /** Waits for `ready()`, then returns what `createAiChatHandler` needs for one turn. */
  chatTurn(principal: GlirastesPrincipalFactory): Promise<GlirastesChatTurn>;
  /** Stops sync, drains durable writes, flushes metrics, then releases this instance. */
  stop(): Promise<void>;
}

/** The stricter of two floors: protected beats unprotected, a higher protected revision beats a lower one. */
function stricterFloor(
  current: RuntimePrivacyFloor | null | undefined,
  candidate: RuntimePrivacyFloor | null | undefined,
): RuntimePrivacyFloor | null {
  if (candidate?.profile !== 'protected-text/v1') return current ?? null;
  if (current?.profile === 'protected-text/v1' && current.policyRevision >= candidate.policyRevision) return current;
  return candidate;
}

/**
 * Keeps the sync state in memory and the accepted deployment materialized
 * for the turns, backed by the consumer's persistent store when one is
 * attached. Memory never accepts more than the persistent store holds; it
 * may only be stricter (a floor whose save failed).
 */
class AcceptedStateStore implements RuntimeStateStore {
  private state: RuntimeSyncState | null = null;
  private stable: MaterializedDeploymentRevisions | undefined;
  private persistent: RuntimeStateStore | undefined;
  /** The environment the state belongs to; undefined while no connection is bound. */
  private environmentId: string | undefined;
  /** The persistent state could not be read: nothing is synced over it. */
  private unreadable = false;
  /**
   * The last save failed. Survives `clear()`: only a later verified state
   * that was saved durably, derived under the floor rules from the state
   * kept here, resumes traffic.
   */
  private saveFailed = false;
  /**
   * Protected floors known in this process that the persisted state may not
   * hold (a save failed, or the connection was dropped), per environment.
   * Neither a later load, an unsigned connection signal nor a rebinding
   * lowers them; only a durably saved state derived from them does.
   */
  private readonly held = new Map<string, RuntimePrivacyFloor>();
  /** The state came from a verified sync: a persisted one with a cursor, or one saved in this process. */
  private reconciled = false;
  private pendingPrivacyRefusal = false;
  /** Verified revocations take effect before a potentially slow durable write. */
  private readonly heldRevocations = new Map<string, Map<string, SecurityRevocation>>();
  private storageEpoch = 0;
  private writes: Promise<void> = Promise.resolve();

  /** Binds the store to an environment without a persistent store. */
  bind(environmentId: string): void {
    this.clear();
    this.environmentId = environmentId;
  }

  /**
   * Loads the persisted state of an environment. An unreadable or invalid
   * state throws and stays unreadable: it is neither replaced by defaults
   * nor overwritten by a sync until a later attach reads it.
   */
  async attach(environmentId: string, persistent: RuntimeStateStore, targetAppId: string): Promise<void> {
    this.bind(environmentId);
    this.persistent = persistent;
    const epoch = this.storageEpoch;
    await this.writes.catch(() => undefined);
    let loaded: RuntimeSyncState | null;
    try {
      const raw = await persistent.load();
      if (epoch !== this.storageEpoch) throw new Error('runtime_state_generation_changed');
      loaded = raw === null ? null : parseRuntimeSyncState(raw);
      if (loaded && ((loaded.scope && (loaded.scope.environmentId !== environmentId || loaded.scope.targetAppId !== targetAppId))
        || [loaded.stable, loaded.canary, ...loaded.pending].some(deployment => deployment && (
          deployment.environmentId !== environmentId || [deployment.agentRevision, deployment.manifestRevision, deployment.policyRevision,
            ...(deployment.configRevision ? [deployment.configRevision] : [])].some(revision => revision.targetAppId !== targetAppId)
          || (deployment.promptBinding && deployment.promptBinding.appId !== targetAppId))))) {
        throw new PrivacyError('privacy_state_binding_mismatch');
      }
    } catch (error) {
      if (epoch === this.storageEpoch) this.unreadable = true;
      throw error;
    }
    if (loaded) {
      this.remember(loaded);
      // Disk is a retained floor, not current authenticated bootstrap.
      this.reconciled = false;
    }
  }

  /** The state the sync continues from; a floor held for this environment is part of it. */
  async load(): Promise<RuntimeSyncState | null> {
    if (this.unreadable) throw new Error('[glirastes] The persisted runtime state is unreadable');
    const held = this.environmentId ? this.held.get(this.environmentId) ?? null : null;
    if (!this.state && !held && this.revocations().length === 0) return null;
    const state: RuntimeSyncState = this.state
      ? structuredClone(this.state)
      : { cursor: null, stable: null, canary: null, pending: [], revocations: [], updatedAt: new Date(0).toISOString() };
    return { ...state, privacyFloor: stricterFloor(state.privacyFloor, held), revocations: this.revocations() };
  }

  private hold(floor: RuntimePrivacyFloor | null | undefined): void {
    if (!this.environmentId || floor?.profile !== 'protected-text/v1') return;
    this.held.set(this.environmentId, stricterFloor(this.held.get(this.environmentId), floor)!);
  }

  /** The held floor that applies now: the bound environment's, or without one every held floor. */
  private heldFloor(): RuntimePrivacyFloor | null {
    if (this.environmentId) return this.held.get(this.environmentId) ?? null;
    let strictest: RuntimePrivacyFloor | null = null;
    for (const floor of this.held.values()) strictest = stricterFloor(strictest, floor);
    return strictest;
  }

  saveAtomic(state: RuntimeSyncState): Promise<void> {
    const epoch = this.storageEpoch;
    this.hold(state.privacyFloor);
    if (this.environmentId) {
      const held = this.heldRevocations.get(this.environmentId) ?? new Map<string, SecurityRevocation>();
      for (const revocation of state.revocations) held.set(revocation.revocationId, revocation);
      this.heldRevocations.set(this.environmentId, held);
    }
    if (state.privacyRefusedDeploymentIds?.length) this.pendingPrivacyRefusal = true;
    const persistent = this.persistent;
    const run = this.writes.then(async () => {
      if (epoch !== this.storageEpoch) throw new Error('runtime_state_generation_changed');
      if (this.unreadable) throw new Error('[glirastes] The persisted runtime state is unreadable');
      try {
        await persistent?.saveAtomic(state);
      } catch (error) {
        if (epoch === this.storageEpoch) { this.saveFailed = true; this.hold(state.privacyFloor); }
        throw error;
      }
      // An old connection may finish a disk write, but cannot mutate a new
      // connection's memory. Attach waits for these writes before reading disk.
      if (epoch !== this.storageEpoch) throw new Error('runtime_state_generation_changed');
      this.remember(state);
      this.pendingPrivacyRefusal = false;
      this.saveFailed = false;
      const held = this.environmentId ? this.held.get(this.environmentId) : undefined;
      if (held && (state.privacyFloor?.policyRevision ?? 0) >= held.policyRevision) this.held.delete(this.environmentId!);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  invalidateReconciliation(): void { this.storageEpoch += 1; this.reconciled = false; }
  drain(): Promise<void> { return this.writes; }

  markReconciled(): void { this.reconciled = true; }

  private remember(state: RuntimeSyncState): void {
    this.state = structuredClone(state);
    this.stable = state.stable ? materializeDeploymentRevisions(state.stable) : undefined;
  }

  accepted(): MaterializedDeploymentRevisions | undefined {
    return this.stable;
  }

  /**
   * Forgets the environment's state, e.g. when the connection is dropped.
   * Its protected floor is held, and a failed save stays failed.
   */
  clear(): void {
    this.storageEpoch += 1;
    this.hold(this.state?.privacyFloor);
    this.environmentId = undefined;
    this.state = null;
    this.stable = undefined;
    this.persistent = undefined;
    this.unreadable = false;
    this.reconciled = false;
  }

  /** A persistent store that survives a restart is attached and readable. */
  persistsDurably(): boolean {
    return this.persistent?.durable === true && !this.unreadable;
  }

  /**
   * The state cannot back a managed privacy decision: unreadable, the last
   * save failed, or no verified sync yet (lost or new state).
   */
  stateFailed(): boolean { return this.unreadable || this.saveFailed; }

  unavailable(): boolean {
    return this.unreadable || this.saveFailed || !this.reconciled;
  }

  hasPrivacyAuthority(): boolean {
    return Boolean(this.state?.privacyFloor || this.heldFloor() || this.stable?.policyRevision.privacy);
  }

  revocations(): SecurityRevocation[] {
    const revocations = new Map((this.state?.revocations ?? []).map(value => [value.revocationId, value]));
    if (this.environmentId) for (const [id, value] of this.heldRevocations.get(this.environmentId) ?? []) revocations.set(id, value);
    return [...revocations.values()];
  }

  /** A verified deployment's protected block this runner cannot enforce is outstanding. */
  privacyRefused(): boolean {
    return this.pendingPrivacyRefusal || (this.state?.privacyRefusedDeploymentIds?.length ?? 0) > 0;
  }

  /**
   * The floor demands protection the pinned policy does not carry: a
   * refused, withdrawn or revoked protected revision never leads back to an
   * unprotected one. Only a newer signed `off` lowers the floor.
   */
  privacyFloorUnmet(pinned: PinnedPrivacyPolicy | undefined): boolean {
    const floor = stricterFloor(this.state?.privacyFloor, this.heldFloor());
    return floor?.profile === 'protected-text/v1' && !isProtectedPolicy(pinned?.privacy);
  }
}

/**
 * Content-free notices for provider entries whose binding differs between
 * the registry and the setup artifact: the Platform approves the reported
 * digest, so such an entry would be refused under a signed policy.
 */
function privacyProviderDrift(
  reported: ReadonlyArray<{ id: string; bindingDigest: string }>,
  bindings: Readonly<Record<string, string>>,
): string[] {
  const notices: string[] = [];
  const reportedIds = new Set(reported.map((provider) => provider.id));
  for (const provider of reported) {
    if (!Object.hasOwn(bindings, provider.id)) {
      notices.push(`[glirastes] Privacy provider "${provider.id}" is in the setup artifact but not in the provider registry.`);
    } else if (bindings[provider.id] !== provider.bindingDigest) {
      notices.push(`[glirastes] Privacy provider "${provider.id}" differs from the setup artifact; run setup again so the Platform can approve it.`);
    }
  }
  for (const id of Object.keys(bindings)) {
    if (reported.length > 0 && !reportedIds.has(id)) {
      notices.push(`[glirastes] Privacy provider "${id}" is not in the setup artifact; the Platform cannot approve it.`);
    }
  }
  return notices;
}

function pinnedOf(revision: { revisionId: string; privacy?: PinnedPrivacyPolicy['privacy'] }): PinnedPrivacyPolicy {
  return { revisionId: revision.revisionId, ...(revision.privacy ? { privacy: revision.privacy } : {}) };
}

function logError(error: unknown): void {
  // The SDK's request errors name the operation and the status only.
  console.error('[Glirastes]', error instanceof Error ? error.message : 'connection failed');
}

function notBoundHint(code: string, environment: string | undefined): string | undefined {
  const name = environment ? `Environment '${environment}'` : 'This environment';
  switch (code) {
    case 'environment_pending_approval':
      return `${name} is waiting for approval in Glirastes Citadel (App → Environments). Serving local tools until then.`;
    case 'environment_waiting_for_place':
      return `${name} is waiting for a place in Glirastes Citadel (App → Environments). Serving local tools until then.`;
    case 'connection_environment_mismatch':
      return `${name} does not match the environment this key is bound to. Fix GLIRASTES_ENVIRONMENT or check App → Environments in Glirastes Citadel. Serving local tools until then.`;
    default:
      return undefined;
  }
}

function isPlaceRequired(error: unknown): boolean {
  return error instanceof RuntimeControlPlaneRequestError
    && error.status === 409
    && error.code === 'environment_place_required';
}

function isReferenceChanged(error: unknown): boolean {
  return error instanceof RuntimeControlPlaneRequestError
    && error.status === 403
    && error.code === 'development_connection_read_only';
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
const STOPPING_INSTANCE = Symbol.for('glirastes.runtime.stopping');
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
  assertMaxResultChars(options.maxResultChars, 'createGlirastes');
  const appId = AppSetupArtifactSchema.parse(options.generated.setupArtifact).appId;
  const existing = instances().get(appId);
  if (existing) {
    if ((existing as Glirastes & {[STOPPING_INSTANCE]?: boolean})[STOPPING_INSTANCE]) throw new Error('runtime_stopping');
    return existing;
  }
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
  if (options.privacy?.providers && (options.privacy.managed === true || options.privacy.local?.required === true)) {
    for (const message of privacyProviderDrift(bound.setupArtifact.privacyProviders ?? [], options.privacy.providers.bindings())) {
      onError(new Error(message));
    }
  }
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
  const configuredStateEnvironmentId = options.stateEnvironmentId ?? env.GLIRASTES_STATE_ENVIRONMENT_ID?.trim();
  const stateEnvironmentId = configuredStateEnvironmentId;
  const validStateBinding = z.uuid().safeParse(stateEnvironmentId).success;
  let stateBindingLoaded = !stateEnvironmentId;
  let stateBindingMismatch = Boolean(stateEnvironmentId && !validStateBinding);
  const loadBoundState = async () => {
    if (!stateEnvironmentId || stateBindingLoaded || !validStateBinding || !options.stateStore) return;
    await store.attach(stateEnvironmentId, options.stateStore(stateEnvironmentId), appId);
    stateBindingLoaded = true;
  };
  const abort = new AbortController();
  const retryMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
  let resolved: ResolvedRuntimeConnection | undefined;
  let connectedBase: LocalRuntimeSource | undefined;
  let managed: { tenantId: string; source: LocalRuntimeSource } | undefined;
  let metrics: RuntimeMetricsSink | undefined;
  let stopping: Promise<void> | undefined;
  let stopSync: (() => void) | undefined;
  let connectionGeneration = 0;
  let started = false;
  // Settles after the first attempt, successful or not: a turn waits for the
  // first sync at most once, not on every turn while the Platform is away.
  let settleFirstAttempt!: () => void;
  const firstAttempt = new Promise<void>((resolve) => {
    settleFirstAttempt = resolve;
  });

  const reportedNotBound = new Set<string>();
  let warnedNoEnvironment = false;
  let notedNoReference = false;

  const lookupConnection = async (): Promise<ResolvedRuntimeConnection | undefined> => {
    if (!config) return undefined;
    const nodeEnv = env.NODE_ENV?.trim();
    const digest = bound.setupArtifact.discoveryDigest;
    while (!abort.signal.aborted) {
      try {
        return await lookupRuntimeConnection({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          ...(config.environment ? { environment: config.environment } : {}),
          ...(nodeEnv ? { nodeEnv } : {}),
          ...(digest ? { digest } : {}),
          signal: abort.signal,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
      } catch (error) {
        if (abort.signal.aborted) return undefined;
        const code = error instanceof RuntimeControlPlaneRequestError ? error.code : undefined;
        const hint = code ? notBoundHint(code, config.environment) : undefined;
        if (code && hint) {
          if (!reportedNotBound.has(code)) {
            reportedNotBound.add(code);
            onError(new Error(hint));
          }
        } else {
          onError(error);
        }
        settleFirstAttempt();
        await delay(retryMs, abort.signal);
      }
    }
    return undefined;
  };

  const dropManagedConnection = async (): Promise<void> => {
    stopSync?.();
    stopSync = undefined;
    const closing = metrics;
    resolved = undefined;
    connectedBase = undefined;
    managed = undefined;
    metrics = undefined;
    store.clear();
    reportedNotBound.clear();
    await closing?.close().catch(onError);
  };

  // The same rejected reference is logged once, however often the lookup returns it.
  let loggedReadOnlyFor: string | undefined;
  const reportConnectionLoss = (error: unknown, environmentId: string): void => {
    if (isReferenceChanged(error)) {
      if (loggedReadOnlyFor === environmentId) return;
      loggedReadOnlyFor = environmentId;
    }
    onError(error);
  };

  /** Returns true when the lookup must start over: the Platform withdrew the place, or no reference environment exists yet. */
  const runConnection = async (connection: ResolvedRuntimeConnection): Promise<boolean> => {
    if (!config) return false;
    if (connection.appId !== appId) {
      // A key of another app: report once and stay on the local code.
      onError(new Error('The Glirastes runtime key belongs to a different app than this code'));
      return false;
    }
    const environmentId = connection.environmentId;
    if (options.stateStore && !validStateBinding) {
      stateBindingMismatch = true;
      onError(new PrivacyError('privacy_state_binding_mismatch'));
      return true;
    }
    if (stateEnvironmentId && environmentId !== stateEnvironmentId) {
      stateBindingMismatch = true;
      onError(new PrivacyError('privacy_state_binding_mismatch'));
      return true;
    }
    stateBindingMismatch = Boolean(stateEnvironmentId && !validStateBinding);
    const readOnly = connection.mode === 'development';
    if (environmentId === null) {
      resolved = connection;
      connectedBase = localSource({ targetAppId: connection.appId });
      if (!notedNoReference) {
        notedNoReference = true;
        console.info('[glirastes] No reference environment yet; running on local code and checking again.');
      }
      return true;
    }
    notedNoReference = false;

    if (options.stateStore) {
      // Nothing syncs before the persisted state was read. An unreadable one
      // is retried, never replaced by defaults, and keeps managed privacy
      // blocked (`privacy_policy_unavailable`).
      let persistent: RuntimeStateStore;
      try {
        persistent = options.stateStore(environmentId);
      } catch (error) {
        onError(error);
        return false;
      }
      if (options.privacy && persistent.durable !== true) {
        onError(new Error('[glirastes] The state store does not declare itself durable; a protected privacy policy is refused (accepted_state_missing).'));
      }
      while (!abort.signal.aborted) {
        try {
          await store.attach(environmentId, persistent, appId);
          stateBindingLoaded = true;
          break;
        } catch {
          onError(Object.assign(
            new Error('[glirastes] The persisted runtime state cannot be read; managed privacy stays blocked until it is readable or removed.'),
            { name: 'RuntimeStateUnreadable' },
          ));
          settleFirstAttempt();
          await delay(retryMs, abort.signal);
        }
      }
      if (abort.signal.aborted) return false;
    } else {
      store.bind(environmentId);
    }

    let placeLost = false;
    const generation = ++connectionGeneration;
    const assertCurrentConnection = () => {
      if (generation !== connectionGeneration || abort.signal.aborted) throw new Error('runtime_connection_generation_changed');
    };
    const scopedStateStore: RuntimeStateStore = {
      load: async () => { assertCurrentConnection(); const state = await store.load(); assertCurrentConnection(); return state; },
      saveAtomic: async (state) => { assertCurrentConnection(); await store.saveAtomic(state); assertCurrentConnection(); },
    };
    let sync: ReturnType<typeof createManagedRuntimeSync>;
    try {
      sync = createManagedRuntimeSync({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        appId: connection.appId,
        environmentId,
        runnerKey: connection.runnerKey,
        ...(readOnly ? { readOnly } : {}),
        version: options.version?.trim() || env.GLIRASTES_BUILD_ID?.trim() || `glirastes@${SDK_VERSION}`,
        stateStore: scopedStateStore,
        onReconciled: () => { assertCurrentConnection(); store.markReconciled(); },
        setupArtifact: options.generated.setupArtifact,
        privacyStatus: (revisions) => {
          assertCurrentConnection();
          return privacyRuntimeStatus(
            pinnedOf(revisions.policyRevision),
            managedPrivacy() ? { ...options.privacy, managed: true } : options.privacy,
            store.revocations(),
            store.persistsDurably() && validStateBinding,
          );
        },
        // Only a runner that can enforce and durably keep a protected policy claims the capability.
        privacyCapable: options.privacy?.shield?.profile === 'protected-text/v1' && store.persistsDurably() && validStateBinding,
        // A deployment that names a tool this code lacks, or has changed, keeps running on the local tool.
        validateDeployment: (_deployment, revisions) => {
          validateLocalDeploymentBindings({ revisions, bindings: bound.bindings });
        },
        onError: (error) => {
          if (generation !== connectionGeneration) return;
          if (isPlaceRequired(error) || isReferenceChanged(error)) {
            placeLost = true;
            stopSync?.();
          }
          reportConnectionLoss(error, environmentId);
        },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.push !== undefined ? { push: options.push } : {}),
        pollIntervalMs: retryMs,
      });
    } catch (error) {
      onError(error);
      return false;
    }
    resolved = connection;
    connectedBase = localSource({
      targetAppId: connection.appId,
      environmentId,
    });
    if (options.metrics !== false && !readOnly) {
      metrics = createRuntimeMetricsSinkFromEnv(env, {
        ...options.metrics,
        connection: { appId: connection.appId, environmentId },
        ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
      });
    }
    stopSync = () => {
      if (generation === connectionGeneration) { connectionGeneration += 1; store.invalidateReconciliation(); }
      sync.client.stop();
    };

    while (!abort.signal.aborted && !placeLost) {
      try {
        if (!readOnly) {
          await sync.client.register({
            capabilities: { aiSdk: true },
            technicalMetadata: { runtime: options.runtime ?? 'node' },
          });
          await sync.reportCapabilities().catch(onError);
        }
        await sync.client.syncOnce();
        break;
      } catch (error) {
        if (isPlaceRequired(error) || isReferenceChanged(error)) {
          placeLost = true;
          stopSync?.();
          reportConnectionLoss(error, environmentId);
          break;
        }
        onError(error);
        settleFirstAttempt();
        await delay(retryMs, abort.signal);
      }
    }
    settleFirstAttempt();
    if (!abort.signal.aborted && !placeLost) await sync.client.start();
    if (placeLost && !abort.signal.aborted) {
      await dropManagedConnection();
      return true;
    }
    return false;
  };

  const connect = async (): Promise<void> => {
    if (!config) return;
    while (!abort.signal.aborted) {
      try { await loadBoundState(); }
      catch { onError(Object.assign(new Error('The persisted runtime state cannot be read.'), {name: 'RuntimeStateUnreadable'})); settleFirstAttempt(); await delay(retryMs, abort.signal); continue; }
      const connection = await lookupConnection();
      if (!connection || abort.signal.aborted) return;
      reportedNotBound.clear();
      if (
        connection.mode === 'development'
        && env.NODE_ENV?.trim() === 'production'
        && !warnedNoEnvironment
      ) {
        warnedNoEnvironment = true;
        console.warn(
          "[glirastes] No GLIRASTES_ENVIRONMENT set; running as a development connection. Set it to the environment's key for deployments.",
        );
      }
      if (!(await runConnection(connection))) return;
      settleFirstAttempt();
      await delay(retryMs, abort.signal);
    }
  };

  /**
   * Connected with privacy: until a verified deployment arrived, the policy
   * of the environment is unknown. A connection without a reference
   * environment runs on the local code.
   */
  const withoutEnvironment = () => Boolean(resolved && resolved.environmentId === null);
  const awaitingPolicy = () => Boolean(config) && !store.accepted() && !withoutEnvironment();
  /** Explicit managed activation is fail-closed even with no connection/reference. */
  const managedPrivacy = () => Boolean(options.stateStore) || Boolean(stateEnvironmentId) || options.privacy?.managed === true
    || (Boolean(config) && options.privacy?.local?.required === true) || store.hasPrivacyAuthority();
  if (config && (options.privacy?.managed || options.privacy?.local?.required) && !options.stateStore) {
    onError(new Error('[glirastes] Managed privacy requires durable bound state (accepted_state_missing).'));
  }
  const privacyGate = (pinned: PinnedPrivacyPolicy | undefined) => {
    if (stateBindingMismatch || (options.stateStore && !validStateBinding)) throw new PrivacyError('privacy_state_binding_mismatch');
    if (stateEnvironmentId && !stateBindingLoaded) throw new PrivacyError('privacy_policy_unavailable');
    // Lost, unreadable or unsaved state: no verified, durable decision yet.
    if (managedPrivacy() && (!config || !validStateBinding || !resolved?.environmentId || !store.persistsDurably() || store.stateFailed())) {
      throw new PrivacyError('privacy_policy_unavailable');
    }
    // A refused protected revision blocks traffic; the old revision does not
    // keep running unprotected (K3).
    if (store.privacyRefused()) throw new PrivacyError('privacy_not_configured');
    if (store.privacyFloorUnmet(pinned)) throw new PrivacyError('privacy_not_configured');
    if (managedPrivacy() && (store.unavailable() || awaitingPolicy())) throw new PrivacyError('privacy_policy_unavailable');
    assertPrivacyTurn({
      pinned,
      privacy: options.privacy,
      revocations: store.revocations(),
      awaitingPolicy: awaitingPolicy(),
      ...(config ? { acceptedStateDurable: store.persistsDurably() && validStateBinding } : {}),
    });
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
            {
              tenantId,
              targetAppId: resolved.appId,
              ...(resolved.environmentId ? { environmentId: resolved.environmentId } : {}),
            },
            { accepted: () => store.accepted() },
          ),
        };
      }
      return managed.source;
    },
    accepted: () => store.accepted(),
    revocations: () => store.revocations(),
    privacyPolicy() {
      const accepted = store.accepted();
      const pinned = accepted ? pinnedOf(accepted.policyRevision) : undefined;
      privacyGate(pinned);
      return options.privacy ? effectivePrivacyPolicyFor(pinned, options.privacy) : null;
    },
    speechPolicy() {
      return instance.privacyPolicy()?.speech ?? 'off';
    },
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
          privacyGate: ({ snapshot }) => privacyGate(pinnedOf(snapshot.policyRevision)),
          privacyEffectiveDigest: ({ snapshot }) => {
            const effective = options.privacy ? effectivePrivacyPolicyFor(pinnedOf(snapshot.policyRevision), options.privacy) : null;
            return effective ? effectivePrivacyPolicyDigest(effective) : null;
          },
        },
        loadTools: ({ turnSnapshot }) => (turnSnapshot
          ? materializeManifestToolRegistry({ snapshot: turnSnapshot, bindings: bound.bindings })
          : {}),
        ...(options.generated.toolTexts ? { toolTexts: options.generated.toolTexts } : {}),
        ...(options.generated.toolSearchSemantics
          ? { toolSemantics: options.generated.toolSearchSemantics }
          : {}),
        ...(currentMetrics ? { metrics: currentMetrics } : {}),
        ...(options.classifyToolFailure ? { classifyToolFailure: options.classifyToolFailure } : {}),
        ...(options.maxResultChars !== undefined ? { maxResultChars: options.maxResultChars } : {}),
      };
    },
    async stop() {
      if (stopping) return stopping;
      Object.defineProperty(instance, STOPPING_INSTANCE, {value: true});
      // Keep ownership while writes drain. A replacement cannot attach to the
      // same backend until the old writer has finished, even during stop().
      stopping = Promise.resolve().then(async () => {
        await store.drain();
        try { await metrics?.close(); }
        finally { if (instances().get(appId) === instance) instances().delete(appId); }
      });
      abort.abort();
      stopSync?.();
      return stopping;
    },
  };
  return instance;
}
