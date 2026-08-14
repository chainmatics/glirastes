import { z } from 'zod';
import {
  AppSetupArtifactSchema,
  AppSetupAssessmentModeSchema,
  AppSetupStatusSchema,
  type AppSetupArtifact,
  type AppSetupStatus,
} from '../contracts/app-setup.js';

const uuid = z.uuid();
const digest = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);

const progressSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict().refine(
  (progress) => progress.completed <= progress.total,
  'Completed progress cannot exceed total progress',
);

const runResponseSchema = z.object({
  runId: uuid,
  appId: uuid,
  status: AppSetupStatusSchema,
  progress: progressSchema.optional(),
  artifactDigest: digest.optional(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export interface AppSetupRun {
  runId: string;
  appId: string;
  status: AppSetupStatus;
  progress?: {
    completed: number;
    total: number;
  };
  artifactDigest?: string;
  updatedAt: string;
}

export interface CreateAppSetupRun {
  runId: string;
  assessmentMode: z.infer<typeof AppSetupAssessmentModeSchema>;
  discoveryDigest: string;
}

export interface UpdateAppSetupStatus {
  status: AppSetupStatus;
  progress?: {
    completed: number;
    total: number;
  };
}

export interface AppSetupSyncOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class AppSetupClient {
  constructor(private readonly options: {
    baseUrl: string;
    setupApiKey: string;
    appId: string;
    fetchImpl?: typeof fetch;
  }) {}

  async createRun(
    input: CreateAppSetupRun,
    signal?: AbortSignal,
  ): Promise<AppSetupRun> {
    const body = z.object({
      runId: uuid,
      assessmentMode: AppSetupAssessmentModeSchema,
      discoveryDigest: digest,
    }).strict().parse(input);
    return this.request('/runs', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }, body.runId);
  }

  async updateStatus(
    runId: string,
    update: UpdateAppSetupStatus,
  ): Promise<AppSetupRun> {
    const parsedRunId = uuid.parse(runId);
    const body = z.object({
      status: AppSetupStatusSchema,
      progress: progressSchema.optional(),
    }).strict().parse(update);
    return this.request(`/runs/${encodeURIComponent(parsedRunId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }, parsedRunId);
  }

  async uploadArtifact(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<AppSetupRun> {
    const artifact = AppSetupArtifactSchema.parse(value);
    if (artifact.appId !== this.options.appId) {
      throw new Error('App setup artifact targets a different app');
    }
    return this.request(
      `/runs/${encodeURIComponent(artifact.runId)}/artifact`,
      {
        method: 'PUT',
        body: JSON.stringify(artifact),
        signal,
      },
      artifact.runId,
    );
  }

  async syncArtifact(
    value: unknown,
    options: AppSetupSyncOptions = {},
  ): Promise<AppSetupRun> {
    const artifact = AppSetupArtifactSchema.parse(value);
    if (artifact.appId !== this.options.appId) {
      throw new Error('App setup artifact targets a different app');
    }
    const timeoutMs = z.number().int().positive().max(300_000).parse(
      options.timeoutMs ?? 30_000,
    );
    const controller = new AbortController();
    let timedOut = false;
    const cancel = (): void => { controller.abort(); };
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      await this.createRun({
        runId: artifact.runId,
        assessmentMode: artifact.assessmentMode,
        discoveryDigest: artifact.discoveryDigest,
      }, controller.signal);
      return await this.uploadArtifact(artifact, controller.signal);
    } catch (error) {
      if (timedOut) {
        throw new Error('Glirastes app setup request timed out');
      }
      if (options.signal?.aborted) {
        throw new Error('Glirastes app setup request cancelled');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  async getRun(runId: string): Promise<AppSetupRun> {
    const parsedRunId = uuid.parse(runId);
    return this.request(
      `/runs/${encodeURIComponent(parsedRunId)}`,
      { method: 'GET' },
      parsedRunId,
    );
  }

  private async request(
    path: string,
    init: RequestInit,
    expectedRunId: string,
  ): Promise<AppSetupRun> {
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        this.url(path),
        {
          ...init,
          headers: {
            authorization: `Bearer ${this.options.setupApiKey}`,
            ...(init.body ? { 'content-type': 'application/json' } : {}),
          },
        },
      );
    } catch {
      throw new Error('Glirastes app setup request failed (network)');
    }
    if (!response.ok) {
      throw new Error(
        `Glirastes app setup request failed (${response.status})`,
      );
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error('Invalid Glirastes app setup response');
    }
    const parsed = runResponseSchema.safeParse(value);
    if (
      !parsed.success
      || parsed.data.appId !== this.options.appId
      || parsed.data.runId !== expectedRunId
    ) {
      throw new Error('Invalid Glirastes app setup response');
    }
    return parsed.data;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}`
      + `/v2/apps/${encodeURIComponent(this.options.appId)}`
      + `/runtime-setup${path}`;
  }
}

export type { AppSetupArtifact };
