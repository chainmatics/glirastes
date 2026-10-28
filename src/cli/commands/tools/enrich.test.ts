import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BOT_MARKER, BOT_NAME, execFileRunner, type Exec } from '../../../agent/git.js';
import type { ToolJobLedger, ToolJobRequest } from '../../../agent/platform-jobs.js';
import { createAppFixture, FIXTURE_APP_ID, removeAppFixtures, SDK_ROOT, type AppFixture } from '../../../codegen/tools/__tests__/app-fixture.js';
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
  await git(fixture, 'init', '--quiet', `--initial-branch=${branch}`);
  await git(fixture, 'config', 'user.name', 'Developer');
  await git(fixture, 'config', 'user.email', 'developer@example.com');
  await git(fixture, 'remote', 'add', 'origin', join(fixture.root, '.origin.git'));
  await git(fixture, 'add', '.');
  await git(fixture, 'commit', '--quiet', '-m', 'feat: tasks api');
  return fixture;
}

interface Platform {
  fetchImpl: typeof fetch;
  requests: ToolJobRequest[];
  ledgers: ToolJobLedger[];
  urls: string[];
}

function platform(options: { refuse?: { status: number; code: string } } = {}): Platform {
  const requests: ToolJobRequest[] = [];
  const ledgers: ToolJobLedger[] = [];
  const urls: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(`${init?.method ?? 'GET'} ${url}`);
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
function writingModel(sideEffect?: () => Promise<void>) {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      step += 1;
      if (step === 1) await sideEffect?.();
      const write = step === 1;
      return {
        content: write
          ? [{
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'write_file',
            input: JSON.stringify({ path: '.glirastes/tool-semantics.json', content: SEMANTICS }),
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

function run(fixture: AppFixture, env: Record<string, string>, options: {
  platform: Platform;
  model?: MockLanguageModelV3;
  pullRequests?: string[][];
  out?: string[];
}) {
  const loadOpenAI = vi.fn(async () => (() => ({ chat: () => options.model ?? writingModel() })) as never);
  const out = options.out ?? [];
  const code = runToolsCommand(['enrich', '--managed', '--json'], {
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
      exec: execWith(options.pullRequests ?? []),
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

    const result = run(fixture, { GITHUB_REF_NAME: 'main' }, { platform: api, pullRequests });

    expect(await result.code).toBe(0);
    const head = await git(fixture, 'rev-parse', 'HEAD');
    const branch = `glirastes/tools-${(await git(fixture, 'rev-parse', 'HEAD~1')).slice(0, 12)}`;
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
