import { findForbiddenContentPath } from '../contracts/content-boundary.js';
import type { RuntimeSyncManager } from './sync-manager.js';

export interface RuntimePushConnector {
  connect(options: {
    url: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    onEvent: () => void | Promise<void>;
  }): Promise<void>;
}

export class RuntimeControlPlaneRequestError extends Error {
  readonly operation: string;
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`Glirastes Control Plane ${operation} request failed (${status})`);
    this.name = 'RuntimeControlPlaneRequestError';
    this.operation = operation;
    this.status = status;
  }
}

export class RuntimeControlPlaneClient {
  private abortController: AbortController | null = null;
  private cursor: string | null = null;

  constructor(private readonly options: {
    baseUrl: string;
    apiKey: string;
    appId: string;
    environmentId: string;
    runnerKey: string;
    version: string;
    manager: RuntimeSyncManager;
    fetchImpl?: typeof fetch;
    push?: RuntimePushConnector;
    pollIntervalMs?: number;
    onError?: (error: unknown) => void;
  }) {}

  async register(input: {
    capabilities?: Record<string, unknown>;
    technicalMetadata?: Record<string, unknown>;
  } = {}) {
    this.assertTechnicalMetadata(input.capabilities ?? {});
    this.assertTechnicalMetadata(input.technicalMetadata ?? {});
    return this.request('register', {
      method: 'POST',
      body: JSON.stringify({
        runnerKey: this.options.runnerKey,
        version: this.options.version,
        capabilities: input.capabilities ?? {},
        technicalMetadata: input.technicalMetadata ?? {},
      }),
    });
  }

  async heartbeat(input: {
    health: 'healthy' | 'degraded' | 'unhealthy';
    validatedDeploymentId?: string;
    lastAppliedDeploymentId?: string;
    technicalMetadata?: Record<string, unknown>;
  }) {
    this.assertTechnicalMetadata(input.technicalMetadata ?? {});
    return this.request('heartbeat', {
      method: 'PATCH',
      body: JSON.stringify({
        runnerKey: this.options.runnerKey,
        ...input,
        technicalMetadata: input.technicalMetadata ?? {},
      }),
    });
  }

  async syncOnce() {
    const query = new URLSearchParams({ runnerKey: this.options.runnerKey });
    if (this.cursor) query.set('cursor', this.cursor);
    const bundle = await this.request(`sync?${query.toString()}`, {
      method: 'GET',
    });
    const result = await this.options.manager.apply(bundle);
    if (
      bundle
      && typeof bundle === 'object'
      && 'cursor' in bundle
      && typeof bundle.cursor === 'string'
    ) {
      this.cursor = bundle.cursor;
    }
    return result;
  }

  async start(): Promise<void> {
    if (this.abortController) {
      throw new Error('Runtime Control Plane client is already running');
    }
    const controller = new AbortController();
    this.abortController = controller;
    if (this.options.push) {
      void this.options.push.connect({
        url: `${this.runnerBaseUrl()}/stream`,
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        signal: controller.signal,
        onEvent: async () => {
          try {
            await this.syncOnce();
          } catch (error) {
            this.options.onError?.(error);
          }
        },
      }).catch((error) => {
        if (!controller.signal.aborted) this.options.onError?.(error);
      });
    }

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

  stop(): void {
    this.abortController?.abort();
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.runnerBaseUrl()}/${path}`,
      {
        ...init,
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
      );
    }
    return response.json();
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
