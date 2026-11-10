import { describe, expect, it, vi } from 'vitest';
import { PlatformToolJobs, ToolJobRequestError, type ToolJobLedger, type ToolJobRequest } from '../platform-jobs.js';

const APP_ID = '019fba30-0000-7000-8000-000000000002';
const JOB_ID = '019fba30-0000-7000-8000-000000000004';
const CI_KEY = `gl_${'a'.repeat(32)}`;
const JOB_KEY = 'sk-or-v1-job-secret-never-logged-0000';

const request: ToolJobRequest = {
  schemaVersion: 1,
  discoveryDigest: `sha256:${'A'.repeat(43)}`,
  commitSha: 'c'.repeat(40),
  branch: 'feature/tasks',
  firstRun: false,
  items: [{ stableKey: 'GET /api/tasks', gaps: ['description-templated'] }],
};

const grant = {
  jobId: JOB_ID,
  mode: 'managed',
  model: 'anthropic/claude-sonnet-5.5',
  fallbackModel: 'openai/gpt-6.1-sol',
  budgetUsd: 2,
  expiresAt: '2026-10-22T13:00:00.000Z',
  routing: { provider: { data_collection: 'deny', zdr: true, require_parameters: true }, usage: { include: true } },
  openrouter: { apiKey: JOB_KEY, baseUrl: 'https://openrouter.ai/api/v1' },
};

const ledger: ToolJobLedger = {
  schemaVersion: 1,
  outcome: 'committed',
  model: 'anthropic/claude-sonnet-5.5',
  repairRounds: 0,
  durationMs: 1200,
  changedFiles: 2,
  commitSha: 'd'.repeat(40),
  usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
  items: [{ stableKey: 'GET /api/tasks', state: 'described' }],
};

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

function jobs(fetchImpl: ReturnType<typeof vi.fn>) {
  return new PlatformToolJobs({
    baseUrl: 'https://control.example/',
    appId: APP_ID,
    ciKey: CI_KEY,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('Platform tool jobs', () => {
  it('asks for a job with the CI key and the content-free work list', async () => {
    const fetchImpl = respond(201, grant);

    await expect(jobs(fetchImpl).create(request)).resolves.toEqual(grant);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://control.example/v2/apps/${APP_ID}/tool-jobs`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Bearer ${CI_KEY}`, 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it('reports the ledger and reads the receipt', async () => {
    const fetchImpl = respond(200, { jobId: JOB_ID, status: 'completed', costUsd: 0.37, keyRevoked: true });

    await expect(jobs(fetchImpl).reportLedger(JOB_ID, ledger))
      .resolves.toEqual({ jobId: JOB_ID, status: 'completed', costUsd: 0.37, keyRevoked: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://control.example/v2/apps/${APP_ID}/tool-jobs/${JOB_ID}/ledger`);
    expect(JSON.parse(String(init.body))).toEqual(ledger);
  });

  it('names Platform refusals by their code and marks the product states', async () => {
    const refusal = async (status: number, body: unknown) => {
      try {
        await jobs(respond(status, body)).create(request);
      } catch (error) {
        return error as ToolJobRequestError;
      }
      throw new Error('expected a refusal');
    };

    const pro = await refusal(402, { statusCode: 402, code: 'tool_generation_requires_pro', message: 'Managed tool generation is part of Glirastes Pro' });
    const invalid = await refusal(400, { statusCode: 400, code: 'tool_job_invalid' });
    const opaque = await refusal(500, { message: 'Internal server error' });

    expect([pro.code, pro.status, pro.productRefusal]).toEqual(['tool_generation_requires_pro', 402, true]);
    expect([invalid.code, invalid.productRefusal]).toEqual(['tool_job_invalid', false]);
    expect([opaque.code, opaque.productRefusal]).toEqual(['platform_http_500', false]);
    for (const code of ['tool_generation_not_enabled', 'tool_job_already_running', 'tool_jobs_monthly_budget_exhausted']) {
      expect((await refusal(409, { code })).productRefusal).toBe(true);
    }
  });

  it('never repeats a key or a malformed grant in its errors', async () => {
    const leaked = respond(201, { ...grant, openrouter: { apiKey: JOB_KEY, baseUrl: 'http://openrouter.ai/api/v1' } });
    const unreachable = vi.fn(async () => {
      throw new Error(`connect failed for ${CI_KEY}`);
    });

    const failure = (pending: Promise<unknown>) =>
      pending.then(() => new Error('resolved'), (error: unknown) => error as Error);
    const errors = await Promise.all([failure(jobs(leaked).create(request)), failure(jobs(unreachable).create(request))]);

    expect(errors.map((error) => error.message)).toEqual(['tool_job_grant_invalid', 'platform_unreachable']);
    expect(JSON.stringify(errors.map((error) => [error.message, error.stack]))).not.toMatch(/sk-or-v1|gl_a{32}/);
    expect(() => new PlatformToolJobs({ baseUrl: 'https://control.example', appId: APP_ID, ciKey: 'sk-or-v1-x' }))
      .toThrow('ci_key_invalid');
  });
});
