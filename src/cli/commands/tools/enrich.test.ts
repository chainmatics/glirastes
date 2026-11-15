import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BOT_MARKER, BOT_NAME, execFileRunner, type Exec } from '../../../agent/git.js';
import type { ToolJobLedger, ToolJobRequest } from '../../../agent/platform-jobs.js';
import { createAppFixture, FIXTURE_APP_ID, removeAppFixtures, SDK_ROOT, type AppFixture } from '../../../codegen/tools/__tests__/app-fixture.js';
import { enrichScope, jobDeadline } from './enrich.js';
import { runToolsCommand, TOOLS_SUBCOMMANDS } from './index.js';

const ROUTE = "declare function getSession(): Promise<unknown>;\n"
  + 'export async function GET() { await getSession(); return Response.json({ tasks: [] as string[] }); }\n'
  + 'export async function POST(request: Request) { await getSession(); const body = await request.json();\n'
  + '  return Response.json({ id: String(body.title) }); }\n';
const JOB_ID = '019fba30-0000-7000-8000-000000000004';
const CI_KEY = `gl_${'c'.repeat(32)}`;
const JOB_KEY = 'sk-or-v1-job-secret-never-logged-000000';
const APP_CHAT_KEY = 'sk-or-v1-app-chat-key-must-stay-unused-00';
const MODEL = 'anthropic/claude-sonnet-5.5';
const SEMANTICS = `${JSON.stringify({
  schemaVersion: 1,
  tools: [
    {
      stableKey: 'GET /api/tasks',
      description: 'Lists the tasks of the signed-in user. Use it to show or count tasks; use tasks.create to add one.',
      synonyms: { en: ['todos', 'to-dos'] },
      examples: { en: ['list my tasks', 'which tasks do I have', 'show all my tasks'] },
    },
    {
      stableKey: 'POST /api/tasks',
      description: 'Creates a task with a title. Use it when the user wants to add a task; use tasks.list to read them.',
      synonyms: { en: ['add', 'new todo'] },
      examples: { en: ['create a task', 'add a task called report', 'make a new task for Monday'] },
    },
  ],
})}`;

afterAll(async () => {
  await removeAppFixtures();
});

/** Real git, isolated from the machine's configuration; the GitHub CLI is faked. */
function execWith(pullRequests: string[][]): Exec {
  return async (file, args, options) => {
    if (file === 'gh') {
      pullRequests.push([...args]);
      return { code: 0, stdout: 'https://github.com/acme/app/pull/12\n', stderr: '' };
    }
    return execFileRunner(file, args, {
      ...options,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
  };
}

async function git(fixture: AppFixture, ...args: string[]): Promise<string> {
  const result = await execWith([])('git', args, { cwd: fixture.root });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** A refreshed fixture app committed on `branch`, with a bare origin to push to. */
async function committedApp(branch: string): Promise<AppFixture> {
  const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
  expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
  await git(fixture, 'init', '--quiet', '--bare', '.origin.git');
  await fixture.write('.gitignore', '.origin.git/\n');
  await git(fixture, 'init', '--quiet', '--initial-branch=main');
  await git(fixture, 'config', 'user.name', 'Developer');
  await git(fixture, 'config', 'user.email', 'developer@example.com');
  await git(fixture, 'remote', 'add', 'origin', join(fixture.root, '.origin.git'));
  await git(fixture, 'add', '.gitignore');
  await git(fixture, 'commit', '--quiet', '-m', 'chore: init');
  if (branch !== 'main') {
    // The base branch exists on origin and has no tool outputs yet: the pull request adopts Glirastes.
    await git(fixture, 'push', '--quiet', 'origin', 'main');
    await git(fixture, 'switch', '--quiet', '-c', branch);
  }
  await git(fixture, 'add', '.');
  await git(fixture, 'commit', '--quiet', '-m', 'feat: tasks api');
  return fixture;
}

/** `glirastes tools check --json`, exactly as the CI job after a bot commit runs it. */
async function check(fixture: AppFixture): Promise<number> {
  return runToolsCommand(['check', '--json', '--no-skills'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined });
}

/** Commits agent entries for the tasks tools, current for their interface; returns the stored file. */
async function describeCurrent(fixture: AppFixture): Promise<{ tools: Array<Record<string, unknown>> }> {
  const contracts = JSON.parse(await fixture.read('.glirastes/tool-contracts.json')) as {
    tools: Array<{ stableKey: string; contract: { interfaceDigest: string } | null }>;
  };
  const digest = new Map(contracts.tools.map((tool) => [tool.stableKey, tool.contract?.interfaceDigest]));
  const semantics = JSON.parse(SEMANTICS) as { tools: Array<Record<string, unknown> & { stableKey: string }> };
  for (const entry of semantics.tools) {
    entry.origin = { description: 'agent', synonyms: 'agent', examples: 'agent' };
    entry.agent = { model: 'claude-code', interfaceDigest: digest.get(entry.stableKey) };
  }
  await fixture.write('.glirastes/tool-semantics.json', `${JSON.stringify(semantics, null, 2)}\n`);
  expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
  await git(fixture, 'add', '.');
  await git(fixture, 'commit', '--quiet', '-m', 'docs: describe tasks');
  return semantics;
}

interface Platform {
  fetchImpl: typeof fetch;
  requests: ToolJobRequest[];
  ledgers: ToolJobLedger[];
  urls: string[];
}

function platform(options: { refuse?: { status: number; code: string }; byokKeyStatus?: number } = {}): Platform {
  const requests: ToolJobRequest[] = [];
  const ledgers: ToolJobLedger[] = [];
  const urls: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === 'https://openrouter.ai/api/v1/key' && options.byokKeyStatus) {
      return json(options.byokKeyStatus, options.byokKeyStatus === 200 ? { data: { label: 'sk-or-v1-abc...' } } : { error: { code: 401 } });
    }
    if (url === 'https://openrouter.ai/api/v1/models') {
      return json(200, { data: [{ id: MODEL, supported_parameters: ['tools', 'structured_outputs'] }] });
    }
    if (url === `https://control.example/v2/apps/${FIXTURE_APP_ID}/tool-jobs`) {
      requests.push(JSON.parse(String(init?.body)) as ToolJobRequest);
      if (options.refuse) return json(options.refuse.status, { statusCode: options.refuse.status, code: options.refuse.code });
      return json(201, {
        jobId: JOB_ID,
        mode: 'managed',
        model: MODEL,
        fallbackModel: 'openai/gpt-6.1-sol',
        budgetUsd: 2,
        expiresAt: '2026-10-22T13:00:00.000Z',
        routing: { provider: { data_collection: 'deny', zdr: true, require_parameters: true }, usage: { include: true } },
        openrouter: { apiKey: JOB_KEY, baseUrl: 'https://openrouter.ai/api/v1' },
      });
    }
    if (url === `https://control.example/v2/apps/${FIXTURE_APP_ID}/tool-jobs/${JOB_ID}/ledger`) {
      ledgers.push(JSON.parse(String(init?.body)) as ToolJobLedger);
      return json(200, { jobId: JOB_ID, status: 'completed', costUsd: 0.37, keyRevoked: true });
    }
    return json(404, { code: 'not_found' });
  }) as typeof fetch;
  return { fetchImpl, requests, ledgers, urls };
}

/** Writes the semantics through the sandbox, then stops; `sideEffect` simulates a misbehaving step. */
function writingModel(sideEffect?: () => Promise<void>, content: (prompt: unknown) => string = () => SEMANTICS) {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      step += 1;
      if (step === 1) await sideEffect?.();
      const write = step === 1;
      return {
        content: write
          ? [{
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'write_file',
            input: JSON.stringify({ path: '.glirastes/tool-semantics.json', content: content(prompt) }),
          }]
          : [{ type: 'text' as const, text: 'Done.' }],
        finishReason: { unified: write ? 'tool-calls' as const : 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 200, text: 200, reasoning: undefined },
        },
        warnings: [],
        response: { id: `gen-${step}`, modelId: MODEL, timestamp: new Date('2026-10-22T12:00:00.000Z'), body: { usage: { cost: 0.125 } } },
      };
    },
  });
}

const TEAMS_ROUTE = "declare function getSession(): Promise<unknown>;\n"
  + 'export async function GET() { await getSession(); return Response.json({ teams: [] as string[] }); }\n';

type PromptMessage = { role: string; content: Array<{ type: string; text?: string }> | string };

/** The stable keys of the describe items in a task's user message. */
function describeKeys(prompt: unknown): string[] {
  const user = (prompt as PromptMessage[]).find((message) => message.role === 'user')!;
  const text = typeof user.content === 'string' ? user.content : user.content[0]!.text!;
  const { worklists } = JSON.parse(text) as { worklists: { describe?: { items: Array<{ stableKey: string }> } } };
  return (worklists.describe?.items ?? []).map((item) => item.stableKey);
}

/** Describes the tools of each task through upsert_semantics; `only` leaves the other tools untouched. */
function upsertingModel(only: (stableKey: string) => boolean = () => true) {
  let id = 0;
  const tasks: string[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      id += 1;
      const answered = (prompt as PromptMessage[]).some((message) => message.role === 'tool');
      const keys = describeKeys(prompt);
      if (!answered) tasks.push(keys);
      const entries = keys.filter(only).map((stableKey) => ({
        stableKey,
        description: `Handles ${stableKey} for the signed-in user. Use it when the user asks for exactly this; no other tool fits.`,
        synonyms: { en: ['items', 'entries'] },
        examples: { en: [`run ${stableKey}`, `please do ${stableKey}`, `I need ${stableKey} now`] },
      }));
      const call = !answered && entries.length > 0;
      return {
        content: call
          ? [{ type: 'tool-call' as const, toolCallId: `call-${id}`, toolName: 'upsert_semantics', input: JSON.stringify({ entries }) }]
          : [{ type: 'text' as const, text: 'Done.' }],
        finishReason: { unified: call ? 'tool-calls' as const : 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
        response: { id: `gen-${id}`, modelId: MODEL, timestamp: new Date('2026-10-22T12:00:00.000Z'), body: { usage: { cost: 0.01 } } },
      };
    },
  });
  return { model, tasks };
}

function run(fixture: AppFixture, env: Record<string, string>, options: {
  platform: Platform;
  model?: MockLanguageModelV3;
  pullRequests?: string[][];
  out?: string[];
  exec?: Exec;
  args?: string[];
}) {
  const loadOpenAI = vi.fn(async () => (() => ({ chat: () => options.model ?? writingModel() })) as never);
  const out = options.out ?? [];
  const code = runToolsCommand(['enrich', '--managed', '--json', ...(options.args ?? [])], {
    cwd: fixture.root,
    env: {
      GLIRASTES_CI_KEY: CI_KEY,
      GLIRASTES_CONTROL_PLANE_URL: 'https://control.example',
      OPENROUTER_API_KEY: APP_CHAT_KEY,
      ...env,
    },
    log: (line) => { out.push(line); },
    error: (line) => { out.push(line); },
    enrich: {
      exec: options.exec ?? execWith(options.pullRequests ?? []),
      fetchImpl: options.platform.fetchImpl,
      loadOpenAI,
      now: () => new Date('2026-10-22T12:00:00.000Z'),
    },
  });
  return { code, out, loadOpenAI };
}

describe('glirastes tools enrich --managed', () => {
  it('describes the open tools, commits them as the bot and never loops', async () => {
    const fixture = await committedApp('feature/tasks');
    const api = platform();
    const first = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api });

    expect(await first.code).toBe(0);
    const summary = JSON.parse(first.out.at(-1)!) as Record<string, unknown>;
    expect(summary).toMatchObject({ status: 'finished', jobId: JOB_ID, outcome: 'committed', costUsd: 0.37 });
    expect(await git(fixture, 'log', '-1', '--format=%an|%s')).toBe(`${BOT_NAME}|chore(glirastes): describe tools ${BOT_MARKER}`);
    expect(await git(fixture, 'rev-parse', 'HEAD')).toBe(summary.commitSha);
    expect(await git(fixture, '--git-dir', '.origin.git', 'rev-parse', 'refs/heads/feature/tasks')).toBe(summary.commitSha);
    const committed = (await git(fixture, 'show', '--name-only', '--format=', 'HEAD')).split('\n');
    expect(await git(fixture, 'status', '--porcelain')).toBe('');

    // Content-free on the Platform side: digest, commit, branch, keys and codes only.
    const [request] = api.requests;
    expect(Object.keys(request!).sort()).toEqual(['branch', 'commitSha', 'discoveryDigest', 'firstRun', 'items', 'schemaVersion']);
    expect(request!.items.map((item) => item.stableKey)).toEqual(['GET /api/tasks', 'POST /api/tasks']);
    expect(request!.items.every((item) => Object.keys(item).join() === 'stableKey,gaps')).toBe(true);
    const [ledger] = api.ledgers;
    expect(ledger).toMatchObject({
      schemaVersion: 1,
      outcome: 'committed',
      model: MODEL,
      repairRounds: 0,
      changedFiles: committed.length,
      commitSha: summary.commitSha,
      usage: { inputTokens: 2000, outputTokens: 400, costUsd: 0.25 },
    });
    // The job wrote descriptions, synonyms and examples, no schema: contract-derived stays open.
    expect(request!.items.map((item) => item.gaps)).toEqual([
      ['contract-derived', 'description-templated', 'examples-missing', 'synonyms-missing'],
      ['contract-derived', 'description-templated', 'examples-missing', 'synonyms-missing'],
    ]);
    expect(ledger!.items).toEqual([
      { stableKey: 'GET /api/tasks', state: 'described', reasonCode: 'gaps-remaining' },
      { stableKey: 'POST /api/tasks', state: 'described', reasonCode: 'gaps-remaining' },
    ]);
    expect(committed).toEqual([
      '.glirastes/setup-artifact.json',
      '.glirastes/setup-receipt.json',
      '.glirastes/tool-contracts.json',
      '.glirastes/tool-report.json',
      '.glirastes/tool-semantics.json',
      'src/generated/glirastes/tools.generated.ts',
    ]);
    expect(JSON.stringify([api.requests, api.ledgers, first.out])).not.toMatch(/sk-or-v1|gl_c{32}/);
    // The CI check on the bot commit passes.
    expect(await check(fixture)).toBe(0);

    // The bot commit is the last commit now: the next run stops before any request.
    const second = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api });
    expect(await second.code).toBe(0);
    expect(JSON.parse(second.out.at(-1)!)).toEqual({ schemaVersion: 1, status: 'skipped', code: 'last_commit_by_bot' });
    expect([api.requests.length, second.loadOpenAI.mock.calls.length]).toEqual([1, 0]);
  }, 240_000);

  it('opens a pull request instead of pushing to the base branch', async () => {
    const fixture = await committedApp('main');
    const api = platform();
    const pullRequests: string[][] = [];

    const result = run(fixture, { GITHUB_REF_NAME: 'main' }, { platform: api, pullRequests, args: ['--first-run'] });

    expect(await result.code).toBe(0);
    const head = await git(fixture, 'rev-parse', 'HEAD');
    const branch = `glirastes/tools-${(await git(fixture, 'rev-parse', 'HEAD~1')).slice(0, 12)}`;
    expect(api.requests[0]!.firstRun).toBe(true);
    expect(JSON.parse(result.out.at(-1)!)).toMatchObject({
      status: 'finished', outcome: 'pull_request', commitSha: head, pullRequest: 'https://github.com/acme/app/pull/12',
    });
    expect(await git(fixture, '--git-dir', '.origin.git', 'rev-parse', `refs/heads/${branch}`)).toBe(head);
    expect(await execWith([])('git', ['--git-dir', '.origin.git', 'rev-parse', '--verify', '--quiet', 'refs/heads/main'], { cwd: fixture.root }))
      .toMatchObject({ code: 1 });
    expect(pullRequests[0]?.slice(0, 6)).toEqual(['pr', 'create', '--base', 'main', '--head', branch]);
    expect(api.ledgers[0]).toMatchObject({ outcome: 'pull_request', commitSha: head });
  }, 240_000);

  it('fails without a commit when anything outside the allowed paths changed', async () => {
    const fixture = await committedApp('feature/tasks');
    const api = platform();
    const before = await git(fixture, 'rev-parse', 'HEAD');
    const model = writingModel(() => fixture.write('src/app/api/tasks/route.ts', `${ROUTE}// changed\n`));

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model });

    expect(await result.code).toBe(1);
    expect(JSON.parse(result.out.at(-1)!)).toMatchObject({ status: 'failed', code: 'path_violation', outcome: 'failed' });
    expect(await git(fixture, 'rev-parse', 'HEAD')).toBe(before);
    expect(api.ledgers[0]).toMatchObject({ outcome: 'failed', reasonCode: 'path_violation', changedFiles: 0 });
    expect(api.ledgers[0]!.items.every((item) => item.state === 'unchanged')).toBe(true);
  }, 240_000);

  it('records the model that ran, not the name the model gives itself', async () => {
    const fixture = await committedApp('feature/tasks');
    // Like a real model, it copies the skill's example label and the digest the work list printed.
    const selfNamed = (prompt: unknown) => {
      const user = (prompt as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .find((message) => message.role === 'user')!;
      const { worklists } = JSON.parse(user.content[0]!.text!) as {
        worklists: { describe: { items: Array<{ targets: { semantics: { expected: { stableKey: string; agent: { interfaceDigest: string } } } } }> } };
      };
      const digests = new Map(worklists.describe.items.map((item) => [
        item.targets.semantics.expected.stableKey,
        item.targets.semantics.expected.agent.interfaceDigest,
      ]));
      const semantics = JSON.parse(SEMANTICS) as { tools: Array<Record<string, unknown> & { stableKey: string }> };
      for (const entry of semantics.tools) {
        entry.origin = { description: 'agent', synonyms: 'agent', examples: 'agent' };
        entry.agent = { model: 'claude-code', interfaceDigest: digests.get(entry.stableKey) };
      }
      return JSON.stringify(semantics);
    };
    const api = platform();

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model: writingModel(undefined, selfNamed) });

    expect(await result.code).toBe(0);
    const committed = JSON.parse(await git(fixture, 'show', 'HEAD:.glirastes/tool-semantics.json')) as {
      tools: Array<{ agent: { model: string } }>;
    };
    expect(committed.tools.map((entry) => entry.agent.model)).toEqual([MODEL, MODEL]);
    expect(await git(fixture, 'status', '--porcelain')).toBe('');
  }, 240_000);

  it('reports a runner_error ledger when an unexpected error follows the grant', async () => {
    const fixture = await committedApp('feature/tasks');
    const api = platform();
    const real = execWith([]);
    let broken = false;
    const exec: Exec = async (file, args, options) => {
      if (broken) throw new Error('disk gone');
      return real(file, args, options);
    };
    const model = writingModel(async () => { broken = true; });

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model, exec });

    expect(await result.code).toBe(1);
    expect(JSON.parse(result.out.at(-1)!)).toMatchObject({ status: 'failed', code: 'runner_error', outcome: 'failed' });
    expect(api.ledgers).toHaveLength(1);
    expect(api.ledgers[0]).toMatchObject({ outcome: 'failed', reasonCode: 'runner_error', changedFiles: 0 });
    // The cause reaches the CI log, so a failed run can be explained.
    expect(result.out.some((line) => line.includes('disk gone'))).toBe(true);
  }, 240_000);

  it('ends green with the named code when the Platform refuses for the plan, and never loads the provider', async () => {
    const fixture = await committedApp('feature/tasks');
    const api = platform({ refuse: { status: 402, code: 'tool_generation_requires_pro' } });

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api });

    expect(await result.code).toBe(0);
    expect(JSON.parse(result.out.at(-1)!)).toEqual({ schemaVersion: 1, status: 'skipped', code: 'tool_generation_requires_pro' });
    expect([api.ledgers.length, result.loadOpenAI.mock.calls.length]).toEqual([0, 0]);
    expect(api.urls.some((url) => url.includes('openrouter.ai'))).toBe(false);
  }, 240_000);

  it('runs only as the managed job and needs the CI configuration', async () => {
    const fixture = await createAppFixture();
    const out: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: (line: string) => { out.push(line); } };

    expect(await runToolsCommand(['enrich'], deps)).toBe(2);
    expect(out.join('\n')).toContain('tools enrich runs the managed Pro job in CI');
    out.length = 0;
    expect(await runToolsCommand(['enrich', '--managed', '--json'], deps)).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({ schemaVersion: 1, status: 'failed', code: 'managed_config_missing' });
    expect(Object.keys(TOOLS_SUBCOMMANDS)).toContain('enrich');
  });

  it('works every tool whose semantics are missing, however far the branch is from its base', async () => {
    const fixture = await committedApp('main');
    await git(fixture, 'push', '--quiet', 'origin', 'main');
    await git(fixture, 'switch', '--quiet', '-c', 'feature/teams');
    await fixture.write('src/app/api/teams/route.ts', TEAMS_ROUTE);
    await git(fixture, 'add', '.');
    await git(fixture, 'commit', '--quiet', '-m', 'feat: teams api');
    // The workflow refreshes before the job; the outputs are not committed yet.
    expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
    const api = platform();
    const { model } = upsertingModel();

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/teams' }, { platform: api, model });

    expect(await result.code).toBe(0);
    // The base has no semantics either: missing is missing, whatever the diff to the base is.
    expect(api.requests[0]!.items.map((item) => item.stableKey)).toEqual(['GET /api/tasks', 'GET /api/teams', 'POST /api/tasks']);
    expect(api.requests[0]!.firstRun).toBe(false);
    expect(result.out).toContain('glirastes tools enrich: scope=stale items=3');
    expect(await check(fixture)).toBe(0);
  }, 240_000);

  it('does nothing, quickly, on a base whose tools are all described', async () => {
    const fixture = await committedApp('feature/tasks');
    await describeCurrent(fixture);
    await git(fixture, 'push', '--quiet', 'origin', 'feature/tasks:master');
    await fixture.write('README.md', 'hotfix\n');
    await git(fixture, 'add', 'README.md');
    await git(fixture, 'commit', '--quiet', '-m', 'fix: readme');
    const api = platform();

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, args: ['--base', 'master'] });

    expect(await result.code).toBe(0);
    expect(JSON.parse(result.out.at(-1)!)).toEqual({ schemaVersion: 1, status: 'skipped', code: 'no_gaps' });
    expect([api.requests.length, result.loadOpenAI.mock.calls.length]).toEqual([0, 0]);
  }, 240_000);

  it('keeps current entries byte for byte and takes only the allowed part of what the model writes', async () => {
    const fixture = await committedApp('feature/tasks');
    const stored = await describeCurrent(fixture);
    await fixture.write('src/app/api/teams/route.ts', TEAMS_ROUTE);
    await git(fixture, 'add', '.');
    await git(fixture, 'commit', '--quiet', '-m', 'feat: teams api');
    expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
    const contractsBefore = JSON.parse(await fixture.read('.glirastes/tool-contracts.json')) as { tools: Array<{ stableKey: string }> };
    // A careless model: rewrites the whole file, drops one curated entry, replaces the
    // synonyms of another, and invents an origin and a field for the new tool.
    const careless = () => JSON.stringify({
      schemaVersion: 1,
      tools: [
        { ...stored.tools[0], synonyms: { en: ['worse'] }, examples: { en: ['a', 'b', 'c'] } },
        {
          stableKey: 'GET /api/teams',
          description: 'Lists the teams of the signed-in user. Use it to show teams; use tasks.list for tasks.',
          module: 'teams',
          synonyms: { en: ['groups', 'squads'] },
          examples: { en: ['list my teams', 'which teams am I in', 'show all teams'] },
          origin: { module: 'teams', synonyms: 'human' },
          locked: { description: `sha256:${'a'.repeat(43)}` },
          invented: true,
        },
      ],
    });
    const api = platform();

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model: writingModel(undefined, careless) });

    expect(await result.code).toBe(0);
    expect(api.requests[0]!.items.map((item) => item.stableKey)).toEqual(['GET /api/teams']);
    const committed = JSON.parse(await git(fixture, 'show', 'HEAD:.glirastes/tool-semantics.json')) as { tools: Array<Record<string, unknown>> };
    expect(committed.tools.slice(0, 2)).toEqual(stored.tools);
    expect(committed.tools[2]).toEqual({
      stableKey: 'GET /api/teams',
      description: 'Lists the teams of the signed-in user. Use it to show teams; use tasks.list for tasks.',
      module: 'teams',
      synonyms: { en: ['groups', 'squads'] },
      examples: { en: ['list my teams', 'which teams am I in', 'show all teams'] },
      origin: { description: 'agent', module: 'agent', synonyms: 'agent', examples: 'agent' },
      agent: { model: MODEL, interfaceDigest: expect.stringMatching(/^sha256:/) },
    });
    // tool-contracts.json changes only for the tool in scope; the bot commit passes the check.
    const contractsAfter = JSON.parse(await git(fixture, 'show', 'HEAD:.glirastes/tool-contracts.json')) as { tools: Array<{ stableKey: string }> };
    expect(contractsAfter.tools.filter((tool) => tool.stableKey !== 'GET /api/teams'))
      .toEqual(contractsBefore.tools.filter((tool) => tool.stableKey !== 'GET /api/teams'));
    expect(await check(fixture)).toBe(0);
  }, 240_000);

  it('takes back an entry the generator rejects and commits nothing when nothing is left', async () => {
    const fixture = await committedApp('feature/tasks');
    await describeCurrent(fixture);
    await fixture.write('src/app/api/teams/route.ts', TEAMS_ROUTE);
    await git(fixture, 'add', '.');
    await git(fixture, 'commit', '--quiet', '-m', 'feat: teams api');
    const before = await git(fixture, 'rev-parse', 'HEAD');
    const stored = await fixture.read('.glirastes/tool-semantics.json');
    const tooLong = () => JSON.stringify({
      schemaVersion: 1,
      tools: [...(JSON.parse(stored) as { tools: unknown[] }).tools, {
        stableKey: 'GET /api/teams',
        description: 'Lists teams. '.repeat(100),
        synonyms: { en: ['groups'] },
        examples: { en: ['list my teams', 'which teams am I in', 'show all teams'] },
      }],
    });
    const api = platform();

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model: writingModel(undefined, tooLong) });

    expect(await result.code).toBe(1);
    expect(result.out).toContain('glirastes tools enrich: 1 rejected entry taken back');
    expect(api.ledgers[0]!.items).toEqual([{ stableKey: 'GET /api/teams', state: 'failed', reasonCode: 'resolution-rejected' }]);
    expect(await git(fixture, 'rev-parse', 'HEAD')).toBe(before);
    expect(await fixture.read('.glirastes/tool-semantics.json')).toBe(stored);
  }, 240_000);
  it('describes module by module and reports a job that leaves tools untouched as partial', async () => {
    const fixture = await committedApp('feature/tasks');
    await fixture.write('src/app/api/teams/route.ts', TEAMS_ROUTE);
    await git(fixture, 'add', '.');
    await git(fixture, 'commit', '--quiet', '-m', 'feat: teams api');
    expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
    const api = platform();
    const { model, tasks } = upsertingModel((stableKey) => stableKey.includes('/api/tasks'));

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model });

    expect(await result.code).toBe(0);
    // One task per module, each with only its own tools; the untouched module gets exactly one more task.
    expect(tasks.map((keys) => [...keys].sort().join()).sort()).toEqual(['GET /api/tasks,POST /api/tasks', 'GET /api/teams', 'GET /api/teams']);
    expect(JSON.parse(result.out.at(-1)!)).toMatchObject({
      status: 'partial', code: 'items_remaining', outcome: 'committed', items: { total: 3, described: 2, unchanged: 1 },
    });
    expect(api.ledgers[0]).toMatchObject({ outcome: 'committed', reasonCode: 'items_remaining' });
    expect(result.out).toContain('glirastes tools enrich: 1 of 3 items are still open');
    // The modules run side by side, so the order of the lines is not fixed.
    expect(result.out.filter((line) => line.startsWith('glirastes tools enrich: task ')).sort()).toEqual([
      'glirastes tools enrich: task describe:tasks items=2 steps=2 finish=stop',
      'glirastes tools enrich: task describe:teams items=1 steps=1 finish=stop',
      'glirastes tools enrich: task describe:teams items=1 steps=1 finish=stop',
    ]);
  }, 240_000);

  it('fails a job that closes no item, whatever the model says', async () => {
    const fixture = await committedApp('feature/tasks');
    const api = platform();
    const before = await git(fixture, 'rev-parse', 'HEAD');
    const { model, tasks } = upsertingModel(() => false);

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model });

    expect(await result.code).toBe(1);
    expect(JSON.parse(result.out.at(-1)!)).toMatchObject({ status: 'failed', code: 'no_progress', outcome: 'failed' });
    expect(api.ledgers[0]).toMatchObject({ outcome: 'failed', reasonCode: 'no_progress', changedFiles: 0 });
    expect(tasks).toHaveLength(2);
    expect(await git(fixture, 'rev-parse', 'HEAD')).toBe(before);
  }, 240_000);

  it('commits nothing and opens no pull request when the job closes no item but the refresh rewrote outputs', async () => {
    const fixture = await committedApp('feature/tasks');
    // Stale generated output on the branch: the job's refresh rewrites it, the model closes nothing.
    await fixture.write('src/generated/glirastes/tools.generated.ts', '// stale\n');
    await git(fixture, 'commit', '--quiet', '-am', 'chore: stale output');
    const before = await git(fixture, 'rev-parse', 'HEAD');
    const api = platform();
    const { model } = upsertingModel(() => false);

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model });

    expect(await result.code).toBe(1);
    expect(JSON.parse(result.out.at(-1)!)).toMatchObject({ status: 'failed', code: 'no_progress', outcome: 'failed' });
    expect(JSON.parse(result.out.at(-1)!).pullRequest).toBeUndefined();
    expect(api.ledgers[0]).toMatchObject({ outcome: 'failed', reasonCode: 'no_progress', changedFiles: 0 });
    expect(await git(fixture, 'rev-parse', 'HEAD')).toBe(before);
  }, 240_000);

  it('commits once per job, after all tasks, and the commit passes tools check', async () => {
    const fixture = await committedApp('feature/tasks');
    await fixture.write('src/app/api/teams/route.ts', TEAMS_ROUTE);
    await git(fixture, 'add', '.');
    await git(fixture, 'commit', '--quiet', '-m', 'feat: teams api');
    expect(await runToolsCommand(['refresh'], { cwd: fixture.root, env: {}, log: () => undefined, error: () => undefined })).toBe(0);
    const start = await git(fixture, 'rev-parse', 'HEAD');
    const api = platform();
    const { model, tasks } = upsertingModel();

    const result = run(fixture, { GITHUB_HEAD_REF: 'feature/tasks' }, { platform: api, model });

    expect(await result.code).toBe(0);
    expect(tasks).toHaveLength(2);
    expect((await git(fixture, 'log', '--format=%an', `${start}..HEAD`)).split('\n')).toEqual([BOT_NAME]);
    expect(await git(fixture, '--git-dir', '.origin.git', 'rev-parse', 'refs/heads/feature/tasks')).toBe(await git(fixture, 'rev-parse', 'HEAD'));
    expect(await check(fixture)).toBe(0);
  }, 240_000);

  describe('environment chains', () => {
    /** An app on every branch of `chain` at origin, with tools whose semantics are missing. */
    async function chainApp(chain: string[]): Promise<AppFixture> {
      const fixture = await committedApp('main');
      for (const environment of chain) await git(fixture, 'push', '--quiet', 'origin', `HEAD:refs/heads/${environment}`);
      return fixture;
    }
    const refused = () => platform({ refuse: { status: 402, code: 'tool_generation_requires_pro' } });
    async function enrich(fixture: AppFixture, head: string, base: string, env: Record<string, string> = {}) {
      const api = refused();
      const result = run(fixture, { GITHUB_HEAD_REF: head, ...env }, { platform: api, args: ['--base', base] });
      const code = await result.code;
      return { code, summary: JSON.parse(result.out.at(-1)!) as Record<string, unknown>, out: result.out, requests: api.requests.length };
    }
    const FOUR = 'pre-dev,dev,staging,master';

    it('never enriches a promotion across any hop of a four-stage chain', async () => {
      const fixture = await chainApp(['pre-dev', 'dev', 'staging', 'master']);
      for (const [head, base] of [['pre-dev', 'dev'], ['dev', 'staging'], ['staging', 'master']]) {
        await git(fixture, 'switch', '--quiet', '-C', head!);
        const promoted = await enrich(fixture, head!, base!, { GLIRASTES_ENVIRONMENT_BRANCHES: FOUR });
        expect(promoted).toMatchObject({ code: 0, requests: 0, summary: { status: 'skipped', code: 'promotion' } });
        expect(promoted.out).toContain(`glirastes tools enrich: promotion from ${head}, nothing to enrich`);
      }
    }, 240_000);

    it('treats a release branch cut from an environment as a promotion and a hotfix as new code', async () => {
      const fixture = await chainApp(['pre-dev', 'dev', 'staging', 'master']);
      // The chain comes from the config this time.
      const config = JSON.parse(await fixture.read('.glirastes/tools.json')) as Record<string, unknown>;
      await fixture.write('.glirastes/tools.json', `${JSON.stringify({ ...config, enrich: { environments: FOUR.split(',') } })}\n`);
      await git(fixture, 'commit', '--quiet', '-am', 'chore: environments');
      await git(fixture, 'push', '--quiet', 'origin', 'HEAD:refs/heads/staging');
      await git(fixture, 'switch', '--quiet', '-c', 'release/1.0');
      const release = await enrich(fixture, 'release/1.0', 'master');
      expect(release).toMatchObject({ requests: 0, summary: { status: 'skipped', code: 'promotion' } });
      expect(release.out).toContain('glirastes tools enrich: promotion from staging, nothing to enrich');

      for (const [hotfix, base] of [['hotfix/middle', 'dev'], ['hotfix/top', 'master']]) {
        await git(fixture, 'switch', '--quiet', '-c', hotfix!, 'release/1.0');
        await fixture.write('README.md', `${hotfix}\n`);
        await git(fixture, 'add', 'README.md');
        await git(fixture, 'commit', '--quiet', '-m', `fix: ${hotfix}`);
        // New code reaches the Platform with its open items (here refused for the plan).
        expect(await enrich(fixture, hotfix!, base!)).toMatchObject({
          code: 0, requests: 1, summary: { status: 'skipped', code: 'tool_generation_requires_pro' },
        });
      }
    }, 240_000);

    it('enriches a feature into the only environment of a two-stage chain and a push there', async () => {
      const fixture = await chainApp(['main']);
      await git(fixture, 'switch', '--quiet', '-c', 'feature/x');
      await fixture.write('README.md', 'feature\n');
      await git(fixture, 'add', 'README.md');
      await git(fixture, 'commit', '--quiet', '-m', 'feat: x');
      // No chain configured: the environments are detected on origin.
      expect(await enrich(fixture, 'feature/x', 'main')).toMatchObject({ requests: 1, summary: { code: 'tool_generation_requires_pro' } });
      await git(fixture, 'switch', '--quiet', 'main');
      await git(fixture, 'merge', '--quiet', '--no-ff', '-m', 'merge feature/x', 'feature/x');
      expect(await enrich(fixture, 'main', 'main')).toMatchObject({ requests: 1, summary: { code: 'tool_generation_requires_pro' } });
    }, 240_000);

    it('skips a push whose commit a lower environment already holds', async () => {
      const fixture = await chainApp(['dev', 'staging']);
      await git(fixture, 'switch', '--quiet', '-C', 'staging');
      const pushed = await enrich(fixture, 'staging', 'staging', { GLIRASTES_ENVIRONMENT_BRANCHES: 'dev,staging' });
      expect(pushed).toMatchObject({ requests: 0, summary: { code: 'promotion' } });
      expect(pushed.out).toContain('glirastes tools enrich: promotion from dev, nothing to enrich');
    }, 240_000);
  });

  it('scopes stale and missing semantics always, schema gaps only on a first run, routing never', () => {
    const resolve = [
      { stableKey: 'GET /api/r', toolId: 't-r', owner: 'agent' as const, code: 'input-contract-unresolved', target: { kind: 'file' as const, file: '.glirastes/tool-resolutions.json', key: 'x' } },
      { stableKey: 'GET /api/app', toolId: 't-a', owner: 'agent' as const, code: 'handler-unresolved', target: { kind: 'app-code' as const, files: [] } },
      { stableKey: 'GET /api/dev', toolId: 't-d', owner: 'developer' as const, code: 'risk-lower-available', target: { kind: 'developer' as const, command: 'x' } },
    ];
    const describe = [
      { stableKey: 'GET /api/new', gaps: ['description-templated', 'contract-derived'] as never },
      { stableKey: 'GET /api/stale', gaps: ['semantics-stale'] as never },
      { stableKey: 'GET /api/schema', gaps: ['contract-derived'] as never },
      { stableKey: 'GET /api/routing', gaps: ['routing-ambiguous'] as never },
    ];

    const automatic = enrichScope(resolve, describe, false);
    expect([...automatic.semantics].sort()).toEqual(['GET /api/new', 'GET /api/stale']);
    expect([...automatic.resolutions].sort()).toEqual(['GET /api/new', 'GET /api/r']);
    const first = enrichScope(resolve, describe, true);
    expect([...first.semantics].sort()).toEqual(['GET /api/new', 'GET /api/schema', 'GET /api/stale']);
    expect([...first.resolutions].sort()).toEqual(['GET /api/new', 'GET /api/r', 'GET /api/schema']);
  });

  it('ends its work well before the CI job is cancelled and before the job key expires', () => {
    const started = new Date('2026-10-22T12:00:00.000Z').getTime();
    expect(jobDeadline(started, '2026-10-22T13:00:00.000Z').toISOString()).toBe('2026-10-22T12:40:00.000Z');
    expect(jobDeadline(started, '2026-10-22T12:20:00.000Z').toISOString()).toBe('2026-10-22T12:20:00.000Z');
  });

  it('refuses a BYOK key OpenRouter rejects before the Platform reserves a job', async () => {
    const fixture = await createAppFixture();
    const api = platform({ byokKeyStatus: 401 });
    const result = run(fixture, { GLIRASTES_TOOLS_OPENROUTER_KEY: 'sk-or-v1-revoked' }, { platform: api });

    expect(await result.code).toBe(1);
    expect(JSON.parse(result.out.at(-1)!)).toEqual({ schemaVersion: 1, status: 'failed', code: 'byok_key_invalid' });
    expect([api.requests.length, api.ledgers.length, result.loadOpenAI.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it('names a CI secret that is not a CI key instead of failing generically', async () => {
    const fixture = await createAppFixture();
    const out: string[] = [];
    const env = { GLIRASTES_CI_KEY: 'sk-or-v1-not-a-ci-key', GLIRASTES_CONTROL_PLANE_URL: 'https://platform.example' };
    const deps = { cwd: fixture.root, env, log: (line: string) => { out.push(line); }, error: (line: string) => { out.push(line); } };

    expect(await runToolsCommand(['enrich', '--managed', '--json'], deps)).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({ schemaVersion: 1, status: 'failed', code: 'ci_key_invalid' });
  });

  it('keeps @ai-sdk/openai out of every module but the lazy loader of tools enrich', async () => {
    const sources: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') await walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
          sources.push(path);
        }
      }
    };
    await walk(join(SDK_ROOT, 'src'));

    // Doc comments may name the package (`import { openai } from ...` examples
    // start with ` * `); code lines never import it.
    const importing: string[] = [];
    for (const path of sources) {
      const code = (await readFile(path, 'utf8')).split('\n').filter((line) => !/^\s*(?:\*|\/\/)/.test(line));
      if (code.some((line) => /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@ai-sdk\/openai['"]/.test(line))) {
        importing.push(relative(SDK_ROOT, path));
      }
    }

    expect(importing).toEqual([]);
    const enrich = await readFile(join(SDK_ROOT, 'src/cli/commands/tools/enrich.ts'), 'utf8');
    expect(enrich).toContain("const specifier = '@ai-sdk/openai';");
  });
});
