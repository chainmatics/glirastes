import { z } from 'zod';

/**
 * The Platform side of a managed tool job (spec 4.6, Platform P10): a job is
 * asked for with a content-free work list and ends with a content-free ledger.
 * Only the CI key of the app authenticates; the OpenRouter key of the grant is
 * handed to the runner and never written, logged or repeated in an error.
 */

/** Largest work list the Platform accepts for one job. */
export const TOOL_JOB_ITEM_LIMIT = 500;

export const TOOL_JOB_OUTCOMES = [
  'committed',
  'pull_request',
  'no_change',
  'failed',
  'budget_stopped',
  'timed_out',
] as const;
export type ToolJobOutcome = (typeof TOOL_JOB_OUTCOMES)[number];

export type ToolJobItemState = 'resolved' | 'described' | 'unchanged' | 'failed';

export interface ToolJobItem {
  stableKey: string;
  /** Finding or gap codes, e.g. `input-contract-unresolved`, `description-templated`. */
  gaps: string[];
}

export interface ToolJobRequest {
  schemaVersion: 1;
  discoveryDigest: string;
  commitSha: string;
  branch: string;
  firstRun: boolean;
  items: ToolJobItem[];
}

export interface ToolJobLedger {
  schemaVersion: 1;
  outcome: ToolJobOutcome;
  reasonCode?: string;
  /** The model that served the job. */
  model: string;
  repairRounds: 0 | 1;
  durationMs: number;
  changedFiles: number;
  commitSha?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  items: Array<{ stableKey: string; state: ToolJobItemState; reasonCode?: string }>;
}

const MODEL_ID = z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i).max(120);

export const ToolJobGrantSchema = z.object({
  jobId: z.uuid(),
  mode: z.enum(['managed', 'byok']),
  model: MODEL_ID,
  fallbackModel: MODEL_ID,
  budgetUsd: z.number().positive().max(100),
  expiresAt: z.iso.datetime(),
  routing: z.record(z.string(), z.unknown()),
  openrouter: z.object({
    apiKey: z.string().min(16).max(512),
    baseUrl: z.url({ protocol: /^https$/ }),
  }).nullable(),
});
export type ToolJobGrant = z.infer<typeof ToolJobGrantSchema>;

const LedgerReceiptSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(['completed', 'failed', 'expired']),
  costUsd: z.number().min(0).nullable(),
  keyRevoked: z.boolean(),
});
export type ToolJobLedgerReceipt = z.infer<typeof LedgerReceiptSchema>;

/**
 * Refusals that describe the product state rather than a fault: the CI job
 * reports them and ends green, so a Free tenant or a spent month never blocks
 * a pull request.
 */
export const PRODUCT_REFUSALS: ReadonlySet<string> = new Set([
  'tool_generation_requires_pro',
  'tool_generation_not_enabled',
  'tool_job_already_running',
  'tool_jobs_monthly_budget_exhausted',
]);

const CODE = /^[a-z][a-z0-9_.-]{1,63}$/;

export class ToolJobRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | undefined,
  ) {
    super(code);
    this.name = 'ToolJobRequestError';
  }

  get productRefusal(): boolean {
    return PRODUCT_REFUSALS.has(this.code);
  }
}

export class PlatformToolJobs {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: {
    baseUrl: string;
    appId: string;
    ciKey: string;
    fetchImpl?: typeof fetch;
  }) {
    if (!/^gl_[A-Za-z0-9]{32}$/.test(options.ciKey)) {
      throw new ToolJobRequestError('ci_key_invalid', undefined);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async create(request: ToolJobRequest, signal?: AbortSignal): Promise<ToolJobGrant> {
    const body = await this.post('', request, signal);
    const grant = ToolJobGrantSchema.safeParse(body);
    if (!grant.success) throw new ToolJobRequestError('tool_job_grant_invalid', undefined);
    return grant.data;
  }

  async reportLedger(jobId: string, ledger: ToolJobLedger, signal?: AbortSignal): Promise<ToolJobLedgerReceipt> {
    const body = await this.post(`/${encodeURIComponent(jobId)}/ledger`, ledger, signal);
    const receipt = LedgerReceiptSchema.safeParse(body);
    if (!receipt.success) throw new ToolJobRequestError('tool_job_receipt_invalid', undefined);
    return receipt.data;
  }

  private async post(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/v2/apps/${encodeURIComponent(this.options.appId)}/tool-jobs${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.ciKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new ToolJobRequestError('platform_unreachable', undefined);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const code = (body as { code?: unknown } | undefined)?.code;
      throw new ToolJobRequestError(
        typeof code === 'string' && CODE.test(code) ? code : `platform_http_${response.status}`,
        response.status,
      );
    }
    return body;
  }
}
