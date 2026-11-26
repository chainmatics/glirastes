import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalAttestationRequestSchema } from '../../../contracts/index.js';
import { runCli } from '../../index.js';
import { computeSuiteDigest, EVAL_SUITE_IGNORED_FILES, runEvalsCommand, suiteDigestOf, type EvalsCommandDependencies } from './index.js';

const APP_ID = '019fbd00-0000-7000-8000-0000000000a1';
const API_KEY = `gl_${'k'.repeat(40)}`;
const DISCOVERY_DIGEST = 'sha256:j7bV836AVc5yC9Cx1WWH-IwAcfKFlmuhfnKysSZyqnM';
const BUNDLE_DIGEST = 'sha256:zwcZTuIy61MeFfaQAA0ZhG3qac8FUEeCZYr8-suSKKI';
const SECRET_CASE = 'the customer asked for a refund of invoice 4711';

interface SuiteCase { name: string; files: Array<{ path: string; utf8: string }>; canonical: string; suiteDigest: string }
interface EvalAttestationVectors {
  suiteDigest: { policy: { ignored: string[] }; cases: SuiteCase[] };
}
const vectors = JSON.parse(readFileSync(
  new URL('../../../contracts/__vectors__/eval-attestation.v1.json', import.meta.url),
  'utf8',
)) as EvalAttestationVectors;

let root: string;

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function writeSetupArtifact(overrides: Record<string, unknown> = {}): void {
  write('.glirastes/setup-artifact.json', `${JSON.stringify({
    schemaVersion: 1,
    appId: APP_ID,
    discoveryDigest: DISCOVERY_DIGEST,
    prompts: { bundleDigest: BUNDLE_DIGEST, artifactRef: 'prompts/main' },
    ...overrides,
  }, null, 2)}\n`);
}

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
    JSON.stringify({ attestationId: '019fbd00-0000-7000-8000-0000000000f1', recordedAt: '2026-11-26T09:00:01.000Z' }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  ));
}

function run(argv: string[], overrides: Partial<EvalsCommandDependencies> = {}) {
  const log: string[] = [];
  const error: string[] = [];
  const fetchMock = overrides.fetch ?? okFetch();
  const deps: EvalsCommandDependencies = {
    cwd: root,
    env: { GLIRASTES_API_KEY: API_KEY, GLIRASTES_CONTROL_PLANE_URL: 'https://platform.test/' },
    now: () => new Date('2026-11-26T09:00:00.000Z'),
    log: (line) => { log.push(line); },
    error: (line) => { error.push(line); },
    ...overrides,
    fetch: fetchMock,
  };
  return { exit: runEvalsCommand(['attest', ...argv], deps), log, error, fetchMock: fetchMock as ReturnType<typeof okFetch> };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'glirastes-evals-'));
  writeSetupArtifact();
  write('evals/cases/routing.jsonl', `{"input":"${SECRET_CASE}"}\n`);
  write('evals/README.md', 'suite\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('suite digest', () => {
  it.each(vectors.suiteDigest.cases.map((vector) => [vector.name, vector] as const))('matches the golden vector %s', async (name, vector) => {
    for (const file of vector.files) write(join('vector', name, file.path), file.utf8);
    expect(await computeSuiteDigest(join(root, 'vector', name))).toBe(vector.suiteDigest);
  });

  it('counts line endings', () => {
    const digests = new Map(vectors.suiteDigest.cases.map((vector) => [vector.name, vector.suiteDigest]));
    expect(digests.get('crlf')).not.toBe(digests.get('lf'));
  });

  it('lists NFD names as NFC and sorts by UTF-8 bytes', async () => {
    const vector = vectors.suiteDigest.cases.find((entry) => entry.name === 'unicode-nfd-astral-hidden')!;
    write('u/cafe\u0301.jsonl', 'b\n');
    write('u/\u{1F600}.jsonl', 'a\n');
    write('u/\uFF61.jsonl', 'c\n');
    write('u/.hidden/x.jsonl', 'd\n');
    expect(await computeSuiteDigest(join(root, 'u'))).toBe(vector.suiteDigest);
    const sha = 'sha256:jXS-7BvpljIq12gTuvuS1Ag5iV1t1-6AixfKIB6smL4';
    expect(suiteDigestOf([
      { path: '\u{1F600}.jsonl', sha256: sha },
      { path: '\uFF61.jsonl', sha256: sha },
    ])).toBe(suiteDigestOf([
      { path: '\uFF61.jsonl', sha256: sha },
      { path: '\u{1F600}.jsonl', sha256: sha },
    ]));
  });

  it('refuses two paths that are equal after NFC normalisation', () => {
    const sha = 'sha256:jXS-7BvpljIq12gTuvuS1Ag5iV1t1-6AixfKIB6smL4';
    expect(() => suiteDigestOf([
      { path: 'cafe\u0301.jsonl', sha256: sha },
      { path: 'caf\u00e9.jsonl', sha256: sha },
    ])).toThrow(/an entry in the suite/i);
  });

  it('includes hidden files and skips only the documented OS junk', async () => {
    expect(EVAL_SUITE_IGNORED_FILES).toEqual(vectors.suiteDigest.policy.ignored);
    write('h/case.jsonl', 'x\n');
    const plain = await computeSuiteDigest(join(root, 'h'));
    for (const junk of vectors.suiteDigest.policy.ignored) write(join('h', 'sub', junk), 'junk');
    write('h/.DS_Store', 'junk');
    expect(await computeSuiteDigest(join(root, 'h'))).toBe(plain);
    write('h/.env.example', 'x\n');
    expect(await computeSuiteDigest(join(root, 'h'))).not.toBe(plain);
  });

  it.each([
    ['a link to a file', () => { write('l/real.jsonl', 'x\n'); symlinkSync(join(root, 'l/real.jsonl'), join(root, 'l/link.jsonl')); }],
    ['a link to a directory', () => { write('l/dir/real.jsonl', 'x\n'); symlinkSync(join(root, 'l/dir'), join(root, 'l/linked')); }],
    ['a dangling link', () => { write('l/real.jsonl', 'x\n'); symlinkSync(join(root, 'l/missing'), join(root, 'l/dangling')); }],
    ['only an empty directory', () => { mkdirSync(join(root, 'l'), { recursive: true }); }],
    ['only nested empty directories', () => { mkdirSync(join(root, 'l/a/b/c'), { recursive: true }); }],
    ['only OS junk', () => { write('l/.DS_Store', 'junk'); }],
  ])('refuses a suite with %s', async (_name, prepare) => {
    prepare();
    await expect(computeSuiteDigest(join(root, 'l'))).rejects.toThrow();
  });

  it('refuses a suite path that is itself a link', async () => {
    write('real/case.jsonl', 'x\n');
    symlinkSync(join(root, 'real'), join(root, 'linked'));
    await expect(computeSuiteDigest(join(root, 'linked'))).rejects.toThrow();
  });

  it('hashes many files', async () => {
    for (let index = 0; index < 600; index += 1) write(`many/${String(index).padStart(4, '0')}.jsonl`, `${index}\n`);
    expect(await computeSuiteDigest(join(root, 'many'))).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it('ignores the order files were written in and changes with any file', async () => {
    const files = vectors.suiteDigest.cases[0]!.files;
    for (const file of files) write(join('a', file.path), file.utf8);
    for (const file of [...files].reverse()) write(join('b', file.path), file.utf8);
    const digest = await computeSuiteDigest(join(root, 'a'));
    expect(await computeSuiteDigest(join(root, 'b'))).toBe(digest);

    write(join('b', files[0]!.path), `${files[0]!.utf8} `);
    expect(await computeSuiteDigest(join(root, 'b'))).not.toBe(digest);
  });

  it('changes when a file is renamed', async () => {
    write('c/one.jsonl', 'x\n');
    write('d/two.jsonl', 'x\n');
    expect(await computeSuiteDigest(join(root, 'c'))).not.toBe(await computeSuiteDigest(join(root, 'd')));
  });

  it('lists a single file under its base name', async () => {
    write('single/suite.jsonl', 'x\n');
    expect(await computeSuiteDigest(join(root, 'single/suite.jsonl')))
      .toBe(await computeSuiteDigest(join(root, 'single')));
  });
});

describe('glirastes evals attest', () => {
  it('posts only the contract fields with the CI key and never file contents', async () => {
    const { exit, fetchMock } = run(['--suite', 'evals', '--total', '120', '--failed', '0', '--run-ref', 'github/actions/runs/42']);
    expect(await exit).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`https://platform.test/v1/apps/${APP_ID}/eval-attestations`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(API_KEY);
    const raw = String(init?.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'ciRunRef', 'failed', 'promptDigest', 'ranAt', 'result', 'schemaVersion',
      'setupArtifactDigest', 'suiteDigest', 'total',
    ]);
    expect(EvalAttestationRequestSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      schemaVersion: 1,
      setupArtifactDigest: DISCOVERY_DIGEST,
      promptDigest: BUNDLE_DIGEST,
      suiteDigest: await computeSuiteDigest(join(root, 'evals')),
      result: 'pass',
      total: 120,
      failed: 0,
      ranAt: '2026-11-26T09:00:00.000Z',
      ciRunRef: 'github/actions/runs/42',
    });
    expect(raw).not.toContain(SECRET_CASE);
    expect(raw).not.toContain('routing.jsonl');
    expect(raw).not.toContain(API_KEY);
  });

  it('sends fail and exits 1 when cases failed, pass and 0 when none did', async () => {
    const failed = run(['--suite', 'evals', '--total', '120', '--failed', '3']);
    expect(await failed.exit).toBe(1);
    expect(JSON.parse(String(failed.fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ result: 'fail', failed: 3 });

    const passed = run(['--suite', 'evals', '--total', '120', '--failed', '0', '--json']);
    expect(await passed.exit).toBe(0);
    expect(JSON.parse(String(passed.fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ result: 'pass', failed: 0 });
    expect(JSON.parse(passed.log.at(-1)!)).toMatchObject({
      attestationId: '019fbd00-0000-7000-8000-0000000000f1',
      result: 'pass',
    });
  });

  it('stops with exit 2 and no request without an API key', async () => {
    const { exit, fetchMock, error } = run(
      ['--suite', 'evals', '--total', '1', '--failed', '0'],
      { env: { GLIRASTES_CONTROL_PLANE_URL: 'https://platform.test' } },
    );
    expect(await exit).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.join('\n')).toContain('GLIRASTES_API_KEY');
  });

  it.each([
    ['no setup artifact', () => { rmSync(join(root, '.glirastes/setup-artifact.json')); }],
    ['no discoveryDigest', () => { writeSetupArtifact({ discoveryDigest: undefined }); }],
    ['no prompts.bundleDigest', () => { writeSetupArtifact({ prompts: { artifactRef: 'prompts/main' } }); }],
  ])('stops with exit 2 and no request with %s', async (_name, prepare) => {
    prepare();
    const { exit, fetchMock, error } = run(['--suite', 'evals', '--total', '1', '--failed', '0']);
    expect(await exit).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.join('\n')).toContain('.glirastes/setup-artifact.json');
  });

  it.each([
    [['--total', '1', '--failed', '0']],
    [['--suite', 'evals', '--failed', '0']],
    [['--suite', 'evals', '--total', '0', '--failed', '0']],
    [['--suite', 'evals', '--total', '2', '--failed', '3']],
    [['--suite', 'evals', '--total', '1.5', '--failed', '0']],
    [['--suite', 'evals', '--total', '1', '--failed', '0', '--run-ref', 'free text']],
    [['--suite', 'missing', '--total', '1', '--failed', '0']],
  ])('stops with exit 2 and no request on %j', async (argv) => {
    const { exit, fetchMock } = run(argv);
    expect(await exit).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect and never follows it with the key', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 307, headers: { location: 'https://elsewhere.test/collect' },
    }));
    const { exit, error } = run(['--suite', 'evals', '--total', '1', '--failed', '0'], { fetch: fetchMock });
    expect(await exit).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('manual');
    expect(error.join('\n')).toContain('307');
  });

  it.each([
    ['http://platform.test', 2],
    ['ftp://platform.test', 2],
    ['http://localhost:8101', 0],
    ['http://127.0.0.1:8101/', 0],
    ['http://[::1]:8101', 0],
  ])('allows plain http only for loopback: %s', async (url, expected) => {
    const { exit, fetchMock } = run(['--suite', 'evals', '--total', '1', '--failed', '0'], {
      env: { GLIRASTES_API_KEY: API_KEY, GLIRASTES_CONTROL_PLANE_URL: url },
    });
    expect(await exit).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(expected === 0 ? 1 : 0);
  });

  it('says the result is unknown when a 2xx body is unreadable', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 201 }));
    const { exit, error } = run(['--suite', 'evals', '--total', '1', '--failed', '0'], { fetch: fetchMock });
    expect(await exit).toBe(1);
    expect(error.join('\n')).toMatch(/result unknown.*may have been recorded/i);
  });

  it('names no suite file in its errors', async () => {
    symlinkSync(join(root, 'evals/README.md'), join(root, 'evals/secret-name.jsonl'));
    const { exit, error, fetchMock } = run(['--suite', 'evals', '--total', '1', '--failed', '0']);
    expect(await exit).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.join('\n')).not.toContain('secret-name');
    expect(error.join('\n')).toMatch(/an entry in the suite/i);
  });

  it('turns an unreadable suite file into exit 2 without a stack', async () => {
    write('evals/locked.jsonl', 'x\n');
    chmodSync(join(root, 'evals/locked.jsonl'), 0o000);
    const { exit, error } = run(['--suite', 'evals', '--total', '1', '--failed', '0']);
    expect(await exit).toBe(2);
    expect(error.join('\n')).not.toContain('locked');
    expect(error.join('\n')).not.toMatch(/\n\s+at /);
  });

  it('turns an unexpected error into exit 2 without a stack', async () => {
    const { exit, error } = run(['--suite', 'evals', '--total', '1', '--failed', '0'], { now: () => new Date(Number.NaN) });
    expect(await exit).toBe(2);
    expect(error.join('\n')).not.toMatch(/\n\s+at /);
  });

  it('names the status and code of a Platform error, never the key', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 'eval_gate_forbidden', message: `key ${API_KEY} is not allowed` }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));
    const { exit, error, log } = run(['--suite', 'evals', '--total', '1', '--failed', '0'], { fetch: fetchMock });
    expect(await exit).toBe(1);
    const output = [...error, ...log].join('\n');
    expect(output).toContain('403');
    expect(output).toContain('eval_gate_forbidden');
    expect(output).not.toContain(API_KEY);
  });

  it('reports a network failure without the key', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError(`fetch failed for ${API_KEY}`); });
    const { exit, error } = run(['--suite', 'evals', '--total', '1', '--failed', '0'], { fetch: fetchMock });
    expect(await exit).toBe(1);
    expect(error.join('\n')).not.toContain(API_KEY);
  });
});

describe('glirastes evals through the CLI', () => {
  afterEach(() => { process.exitCode = undefined; });

  it('dispatches evals attest and sets the exit code of a failed suite', async () => {
    const fetchMock = okFetch();
    await runCli(['evals', 'attest', '--suite', 'evals', '--total', '4', '--failed', '1', '--root', root], {
      evals: {
        cwd: root,
        env: { GLIRASTES_API_KEY: API_KEY },
        fetch: fetchMock,
        log: () => undefined,
        error: () => undefined,
      },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://api.glirastes.io/v1/apps/${APP_ID}/eval-attestations`);
    expect(process.exitCode).toBe(1);
  });
});
