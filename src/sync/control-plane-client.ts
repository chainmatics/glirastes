import { findForbiddenContentPath } from '../contracts/content-boundary.js';
import {
  ENVIRONMENT_CONTROL_CAPABILITY,
  ENVIRONMENT_CONTROL_SYNC_VERSION,
} from '../contracts/environment-control.js';
import {
  CANARY_SELECTION_CAPABILITY,
  CANARY_SELECTION_SYNC_VERSION,
} from '../contracts/rollout-binding.js';
import type { CanaryState } from './deployment-selector.js';
import {
  DISCOVERY_DIGEST_PATTERN,
  POLICY_RELAXATIONS_VERSION,
} from './capability-report.js';
import type { RuntimeControlState } from './state-store.js';
import type { RuntimeSyncApplyResult, RuntimeSyncManager } from './sync-manager.js';

const SETUP_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RuntimePushConnector {
  connect(options: {
    url: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    onEvent: () => void | Promise<void>;
    /** Called once the stream is open, before any event. */
    onOpen?: () => void | Promise<void>;
  }): Promise<void>;
}

const CONTROL_HEARTBEAT_INTERVAL_MS = 60_000;

/** Content-free status of the environment control a runner applies. */
interface ControlHeartbeatStatus {
  controlSequence: number;
  assistantState: 'enabled' | 'halted';
}

interface HeartbeatInput {
  health: 'healthy' | 'degraded' | 'unhealthy';
  validatedDeploymentId?: string;
  lastAppliedDeploymentId?: string;
  technicalMetadata?: Record<string, unknown>;
}

function controlStatusOf(control: RuntimeControlState | undefined): ControlHeartbeatStatus {
  return {
    controlSequence: control?.accepted?.sequence ?? 0,
    assistantState: control?.localHalt || control?.accepted?.assistant === 'halted' ? 'halted' : 'enabled',
  };
}

const PUSH_RECONNECT_BASE_MS = 1_000;
const PUSH_RECONNECT_MAX_MS = 60_000;

// Only short, machine-readable codes are surfaced; anything else is dropped.
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { code?: unknown } | null;
    return typeof body?.code === 'string' && ERROR_CODE_PATTERN.test(body.code)
      ? body.code
      : undefined;
  } catch {
    return undefined;
  }
}

export class RuntimeControlPlaneRequestError extends Error {
  readonly operation: string;
  readonly status: number;
  /** A content-free error code the Platform answered with, e.g. `connection_key_unbound`. */
  readonly code?: string;

  constructor(operation: string, status: number, code?: string) {
    super(`Glirastes Control Plane ${operation} request failed (${status})`);
    this.name = 'RuntimeControlPlaneRequestError';
    this.operation = operation;
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export class RuntimeControlPlaneClient {
  private abortController: AbortController | null = null;
  private controlStatus: ControlHeartbeatStatus | undefined;
  private controlReportedAt: number | undefined;
  private deploymentHeartbeat: HeartbeatInput | undefined;
  private cursor: string | null = null;
  private syncedAt: number | undefined;

  constructor(private readonly options: {
    baseUrl: string;
    apiKey: string;
    appId: string;
    environmentId: string;
    runnerKey: string;
    version: string;
    /** A development connection only reads: no register, heartbeat, and the stream carries the runner key. */
    readOnly?: boolean;
    /**
     * Discovery digest of the running code. Sent with every registration so
     * the Platform knows which capability report describes this runner.
     */
    discoveryDigest?: string;
    /**
     * Setup run of the committed artifact this build carries (P10). With it
     * the Platform shows the capability report of exactly this build, also
     * when another build of the same endpoint inventory reported later.
     */
    setupRunId?: string;
    /**
     * True when this runner composes signed Platform decisions with the
     * local code report (`createLocalRuntimeSource`, or `createTurnSnapshot`
     * with `relaxableToolIds`), so a Platform relaxation of confirmation takes
     * effect here (D16). Registration then reports `policyRelaxations`.
     */
    policyRelaxations?: boolean;
    manager: RuntimeSyncManager;
    fetchImpl?: typeof fetch;
    push?: RuntimePushConnector;
    pollIntervalMs?: number;
    /** Abort a hung request after this many milliseconds (default 10 s); syncs run one at a time behind it. */
    requestTimeoutMs?: number;
    /**
     * True when this runner selects a cohort per turn: the sync then asks
     * for rollout bindings (`canaryVersion=1`) and registration reports
     * `canarySelection`.
     */
    canarySelection?: boolean;
    /** Whether the canary is selectable here; added to heartbeats while one is known. */
    canaryState?: () => CanaryState | undefined;
    /** How often a sync repeats the environment control heartbeat when nothing changed (default 60 s). */
    controlHeartbeatIntervalMs?: number;
    onError?: (error: unknown) => void;
  }) {
    if (
      options.discoveryDigest !== undefined
      && !DISCOVERY_DIGEST_PATTERN.test(options.discoveryDigest)
    ) {
      throw new Error('discoveryDigest must be a sha256 digest of the running code');
    }
    if (options.setupRunId !== undefined) {
      if (options.discoveryDigest === undefined) {
        throw new Error('setupRunId names the setup run of a discoveryDigest; pass both');
      }
      if (!SETUP_RUN_ID_PATTERN.test(options.setupRunId)) {
        throw new Error('setupRunId must be the uuid of the committed setup run');
      }
    }
  }

  async register(input: {
    capabilities?: Record<string, unknown>;
    technicalMetadata?: Record<string, unknown>;
  } = {}) {
    const capabilities = { ...input.capabilities ?? {} };
    const digest = this.options.discoveryDigest;
    if (digest !== undefined) {
      if (
        capabilities.discoveryDigest !== undefined
        && capabilities.discoveryDigest !== digest
      ) {
        throw new Error('capabilities.discoveryDigest must name the running code');
      }
      capabilities.discoveryDigest = digest;
    }
    const setupRunId = this.options.setupRunId;
    if (
      capabilities.setupRunId !== undefined
      && capabilities.setupRunId !== setupRunId
    ) {
      throw new Error('capabilities.setupRunId is reported from the committed setup artifact');
    }
    if (setupRunId !== undefined) capabilities.setupRunId = setupRunId;
    const relaxations = this.options.policyRelaxations
      ? POLICY_RELAXATIONS_VERSION
      : undefined;
    if (
      capabilities.policyRelaxations !== undefined
      && capabilities.policyRelaxations !== relaxations
    ) {
      // Claiming D16 without applying it would show relaxations as effective
      // while the chat keeps asking, or the other way round.
      throw new Error('capabilities.policyRelaxations is reported by the runtime');
    }
    if (relaxations !== undefined) capabilities.policyRelaxations = relaxations;
    if (
      capabilities.environmentControl !== undefined
      && capabilities.environmentControl !== ENVIRONMENT_CONTROL_CAPABILITY
    ) {
      throw new Error('capabilities.environmentControl is reported by the runtime');
    }
    capabilities.environmentControl = ENVIRONMENT_CONTROL_CAPABILITY;
    const canarySelection = this.options.canarySelection ? CANARY_SELECTION_CAPABILITY : undefined;
    if (capabilities.canarySelection !== undefined && capabilities.canarySelection !== canarySelection) {
      throw new Error('capabilities.canarySelection is reported by the runtime');
    }
    if (canarySelection !== undefined) capabilities.canarySelection = canarySelection;
    this.assertTechnicalMetadata(capabilities);
    this.assertTechnicalMetadata(input.technicalMetadata ?? {});
    this.assertWritable('register');
    return this.request('register', {
      method: 'POST',
      body: JSON.stringify({
        runnerKey: this.options.runnerKey,
        version: this.options.version,
        capabilities,
        technicalMetadata: input.technicalMetadata ?? {},
      }),
    });
  }

  async heartbeat(input: HeartbeatInput) {
    this.assertTechnicalMetadata(input.technicalMetadata ?? {});
    this.deploymentHeartbeat = input;
    return this.sendHeartbeat(input);
  }

  private async sendHeartbeat(input: HeartbeatInput) {
    this.assertTechnicalMetadata(input.technicalMetadata ?? {});
    this.assertWritable('heartbeat');
    const control = this.controlStatus
      ? { controlSequence: this.controlStatus.controlSequence, assistantState: this.controlStatus.assistantState }
      : {};
    const canaryState = this.options.canarySelection ? this.options.canaryState?.() : undefined;
    return this.request('heartbeat', {
      method: 'PATCH',
      body: JSON.stringify({
        runnerKey: this.options.runnerKey,
        ...input,
        technicalMetadata: { ...input.technicalMetadata, ...control, ...(canaryState ? { canaryState } : {}) },
      }),
    });
  }

  /** Reports the applied control when it changed, and again at the interval, so the Platform sees it is in force. */
  private async reportControl(result: RuntimeSyncApplyResult | undefined): Promise<void> {
    if (this.options.readOnly || !result?.control || result.control === 'absent') return;
    const control = result.state?.control;
    const status = controlStatusOf(control);
    const now = Date.now();
    const changed = this.controlStatus === undefined
      || this.controlStatus.controlSequence !== status.controlSequence
      || this.controlStatus.assistantState !== status.assistantState;
    const due = this.controlReportedAt === undefined
      || now - this.controlReportedAt >= (this.options.controlHeartbeatIntervalMs ?? CONTROL_HEARTBEAT_INTERVAL_MS);
    this.controlStatus = status;
    if (!changed && !due) return;
    try {
      // Control-only reports must not change the deployment health or its metadata.
      await this.sendHeartbeat(this.deploymentHeartbeat ?? { health: 'healthy' });
      this.controlReportedAt = now;
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** Epoch ms when a sync last succeeded without rejecting the active set; undefined before the first. */
  get lastSyncedAt(): number | undefined {
    return this.syncedAt;
  }

  async syncOnce() {
    const query = new URLSearchParams({ runnerKey: this.options.runnerKey });
    if (this.cursor) query.set('cursor', this.cursor);
    query.set('controlVersion', String(ENVIRONMENT_CONTROL_SYNC_VERSION));
    if (this.options.canarySelection) query.set('canaryVersion', String(CANARY_SELECTION_SYNC_VERSION));
    const bundle = await this.request(`sync?${query.toString()}`, {
      method: 'GET',
    });
    const result = await this.options.manager.apply(bundle);
    // A kept active set may hold a canary the Platform already withdrew.
    if (!result?.rejectedActive) this.syncedAt = Date.now();
    if (
      bundle
      && typeof bundle === 'object'
      && 'cursor' in bundle
      && typeof bundle.cursor === 'string'
    ) {
      this.cursor = bundle.cursor;
    }
    await this.reportControl(result);
    return result;
  }

  async start(): Promise<void> {
    if (this.abortController) {
      throw new Error('Runtime Control Plane client is already running');
    }
    const controller = new AbortController();
    this.abortController = controller;
    if (this.options.push) void this.keepPushConnected(this.options.push, controller.signal);

    const interval = Math.max(1, this.options.pollIntervalMs ?? 30_000);
    while (!controller.signal.aborted) {
      try {
        await this.syncOnce();
      } catch (error) {
        this.options.onError?.(error);
      }
      await this.delay(interval, controller.signal);
    }
    if (this.abortController === controller) this.abortController = null;
  }

  private async keepPushConnected(push: RuntimePushConnector, signal: AbortSignal): Promise<void> {
    const sync = async () => {
      try {
        await this.syncOnce();
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    let failures = 0;
    let opened = false;
    while (!signal.aborted) {
      try {
        await push.connect({
          url: this.options.readOnly
            ? `${this.runnerBaseUrl()}/stream?${new URLSearchParams({ runnerKey: this.options.runnerKey })}`
            : `${this.runnerBaseUrl()}/stream`,
          headers: { authorization: `Bearer ${this.options.apiKey}` },
          signal,
          onEvent: sync,
          onOpen: async () => {
            failures = 0;
            // Events sent while disconnected are lost; one sync catches up.
            if (opened) await sync();
            opened = true;
          },
        });
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        this.options.onError?.(error);
      }
      const backoff = PUSH_RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1);
      await this.delay(Math.min(PUSH_RECONNECT_MAX_MS, backoff), signal);
    }
  }

  stop(): void {
    this.abortController?.abort();
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.runnerBaseUrl()}/${path}`,
      {
        ...init,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      },
    );
    if (!response.ok) {
      throw new RuntimeControlPlaneRequestError(
        path.split('?', 1)[0]!,
        response.status,
        await errorCode(response),
      );
    }
    return response.json();
  }

  private assertWritable(operation: string): void {
    if (this.options.readOnly) {
      throw new Error(`A read-only runtime connection cannot ${operation}`);
    }
  }

  private runnerBaseUrl(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}`
      + `/v1/runtime/apps/${encodeURIComponent(this.options.appId)}`
      + `/environments/${encodeURIComponent(this.options.environmentId)}`
      + '/runners';
  }

  private assertTechnicalMetadata(value: unknown): void {
    const forbidden = findForbiddenContentPath(value);
    if (forbidden) {
      throw new Error(
        `Technical runtime metadata contains forbidden content at ${forbidden.join('.')}`,
      );
    }
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
