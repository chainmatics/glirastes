import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';
import type { SttModelFile } from '../../../server/stt-local/models.js';
import { runSttCommand, STT_SUBCOMMANDS, STT_USAGE } from './index.js';
import { pullSttModels } from './pull.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ONE = 'encoder-bytes';
const TWO = 'vad';
const files: SttModelFile[] = [
  { path: 'parakeet-tdt-0.6b-v3-int8/x', bytes: ONE.length, sha256: sha(ONE), url: 'https://hf.test/x?download=1' },
  { path: 'silero-vad/y.onnx', bytes: TWO.length, sha256: sha(TWO), url: 'https://gh.test/y.onnx' },
];

function server(bodies: Record<string, string | Response>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const body = bodies[url];
    if (body === undefined) return new Response('missing', { status: 404 });
    return typeof body === 'string' ? new Response(body) : body;
  });
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort();
}

async function failure(promise: Promise<unknown>): Promise<FoundationDiagnosticError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoundationDiagnosticError);
  return error as FoundationDiagnosticError;
}

describe('pullSttModels', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-pull-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads, verifies and renames each file into its relative path', async () => {
    const fetch = server({ [files[0]!.url]: ONE, [files[1]!.url]: TWO });
    const result = await pullSttModels({ dir }, { fetch, files });
    expect(result).toEqual({
      dir,
      files: [
        { path: files[0]!.path, status: 'downloaded', bytes: ONE.length },
        { path: files[1]!.path, status: 'downloaded', bytes: TWO.length },
      ],
    });
    expect(await readFile(join(dir, files[0]!.path), 'utf8')).toBe(ONE);
    expect(await readFile(join(dir, files[1]!.path), 'utf8')).toBe(TWO);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'follow' });
    expect(await walk(dir)).toEqual(['ATTRIBUTION.txt', files[0]!.path, files[1]!.path].sort());
  });

  it('skips a file that is already present and verified', async () => {
    await mkdir(join(dir, 'silero-vad'), { recursive: true });
    await writeFile(join(dir, files[1]!.path), TWO);
    const fetch = server({ [files[0]!.url]: ONE });
    const result = await pullSttModels({ dir }, { fetch, files });
    expect(result.files[1]).toEqual({ path: files[1]!.path, status: 'verified', bytes: TWO.length });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('replaces a present file whose checksum does not match', async () => {
    await mkdir(join(dir, 'silero-vad'), { recursive: true });
    await writeFile(join(dir, files[1]!.path), 'bad');
    const fetch = server({ [files[0]!.url]: ONE, [files[1]!.url]: TWO });
    const result = await pullSttModels({ dir }, { fetch, files });
    expect(result.files[1]!.status).toBe('downloaded');
    expect(await readFile(join(dir, files[1]!.path), 'utf8')).toBe(TWO);
  });

  it('fails closed on a checksum mismatch and leaves no partial or final file', async () => {
    await mkdir(join(dir, 'parakeet-tdt-0.6b-v3-int8'), { recursive: true });
    await writeFile(join(dir, files[0]!.path), ONE);
    const fetch = server({ [files[1]!.url]: 'VAD' });
    const error = await failure(pullSttModels({ dir }, { fetch, files }));
    expect(error.code).toBe('E-STT-001');
    expect(error.message).toContain(files[1]!.path);
    expect(error.message).toContain(sha(TWO));
    expect(error.message).toContain(sha('VAD'));
    expect(error.remediation).toBe('Check the mirror or network and run glirastes stt pull again.');
    expect(await walk(dir)).toEqual([files[0]!.path]);
    expect(await readFile(join(dir, files[0]!.path), 'utf8')).toBe(ONE);
  });

  it('fails closed when the server sends more bytes than pinned', async () => {
    const fetch = server({ [files[0]!.url]: `${ONE}-and-more` });
    const error = await failure(pullSttModels({ dir }, { fetch, files }));
    expect(error.code).toBe('E-STT-001');
    expect(error.message).toContain(files[0]!.path);
    expect(await walk(dir)).toEqual([]);
  });

  it('fails closed when the server sends fewer bytes than pinned', async () => {
    const fetch = server({ [files[0]!.url]: ONE.slice(0, 3) });
    expect((await failure(pullSttModels({ dir }, { fetch, files }))).code).toBe('E-STT-001');
    expect(await walk(dir)).toEqual([]);
  });

  it('fails closed on an HTTP error', async () => {
    const fetch = server({ [files[0]!.url]: new Response('nope', { status: 503 }) });
    const error = await failure(pullSttModels({ dir }, { fetch, files }));
    expect(error.code).toBe('E-STT-002');
    expect(error.message).toContain('503');
    expect(error.message).toContain('https://hf.test/x');
    expect(error.message).not.toContain('download=1');
    expect(await walk(dir)).toEqual([]);
  });

  it('fails closed on a network error', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect((await failure(pullSttModels({ dir }, { fetch, files }))).code).toBe('E-STT-002');
    expect(await walk(dir)).toEqual([]);
  });

  it('maps a connection lost mid-download to E-STT-002 and leaves no partial file', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('enc'));
        controller.error(new TypeError('terminated'));
      },
    });
    const fetch = server({ [files[0]!.url]: new Response(body) });
    const error = await failure(pullSttModels({ dir }, { fetch, files }));
    expect(error.code).toBe('E-STT-002');
    expect(error.message).toBe(`Download of ${files[0]!.path} from https://hf.test/x was interrupted: terminated.`);
    expect(error.remediation).toBe('Check the mirror or network and run glirastes stt pull again.');
    expect(await walk(dir)).toEqual([]);
  });

  it('uses the mirror with the same relative paths', async () => {
    const fetch = server({
      'https://mirror.local/models/parakeet-tdt-0.6b-v3-int8/x': ONE,
      'https://mirror.local/models/silero-vad/y.onnx': TWO,
    });
    await pullSttModels({ dir, mirror: 'https://mirror.local/models//' }, { fetch, files });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://mirror.local/models/parakeet-tdt-0.6b-v3-int8/x',
      'https://mirror.local/models/silero-vad/y.onnx',
    ]);
  });

  it('keeps mirror credentials out of the error message', async () => {
    const fetch = server({});
    const error = await failure(pullSttModels({ dir, mirror: 'https://user:secret@mirror.local/m' }, { fetch, files }));
    expect(error.code).toBe('E-STT-002');
    expect(error.message).not.toContain('secret');
  });

  it('refuses a non-http mirror', async () => {
    const fetch = server({});
    expect((await failure(pullSttModels({ dir, mirror: 'file:///x' }, { fetch, files }))).code).toBe('E-STT-003');
    expect((await failure(pullSttModels({ dir, mirror: 'not a url' }, { fetch, files }))).code).toBe('E-STT-003');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('writes ATTRIBUTION.txt', async () => {
    const fetch = server({ [files[0]!.url]: ONE, [files[1]!.url]: TWO });
    await pullSttModels({ dir }, { fetch, files });
    const text = await readFile(join(dir, 'ATTRIBUTION.txt'), 'utf8');
    expect(text).toContain('CC BY 4.0');
    expect(text).toContain('NVIDIA does not endorse this package');
    expect(text).toContain('MIT License');
  });
});

describe('runSttCommand', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, log: (line: string) => { out.push(line); }, error: (line: string) => { err.push(line); } };
  };

  it('prints the attribution and one line per file', async () => {
    const lines = io();
    const fetch = server({ [files[0]!.url]: ONE, [files[1]!.url]: TWO });
    expect(await runSttCommand(['pull', '--dir', dir], { fetch, files, ...lines })).toBe(0);
    const text = lines.out.join('\n');
    expect(text).toContain(`downloaded ${files[0]!.path} (${ONE.length} bytes)`);
    expect(text).toContain(`Model directory: ${dir}`);
    expect(text).toContain('CC BY 4.0');
    expect(text).toContain('NVIDIA does not endorse this package');
    expect(text).toContain('MIT License');
  });

  it('prints JSON with the attribution', async () => {
    const lines = io();
    const fetch = server({ [files[0]!.url]: ONE, [files[1]!.url]: TWO });
    expect(await runSttCommand(['pull', '--dir', dir, '--json'], { fetch, files, ...lines })).toBe(0);
    const json = JSON.parse(lines.out.join('\n')) as { dir: string; files: unknown[]; attribution: string };
    expect(json.dir).toBe(dir);
    expect(json.files).toHaveLength(2);
    expect(json.attribution).toContain('CC BY 4.0');
  });

  it('defaults the directory to GLIRASTES_MODEL_DIR', async () => {
    const lines = io();
    const fetch = server({ [files[0]!.url]: ONE, [files[1]!.url]: TWO });
    const target = join(dir, 'from-env');
    expect(await runSttCommand(['pull'], { fetch, files, env: { GLIRASTES_MODEL_DIR: target }, ...lines })).toBe(0);
    expect(existsSync(join(target, files[0]!.path))).toBe(true);
  });

  it('exits 1 with the diagnostic on a failed download', async () => {
    const lines = io();
    expect(await runSttCommand(['pull', '--dir', dir], { fetch: server({}), files, ...lines })).toBe(1);
    expect(lines.err.join('\n')).toContain('E-STT-002');
  });

  it('answers 2 with the usage for an unknown subcommand or argument', async () => {
    const lines = io();
    expect(await runSttCommand(['push'], lines)).toBe(2);
    expect(await runSttCommand(['pull', '--bogus'], lines)).toBe(2);
    expect(lines.err.join('\n')).toContain(STT_USAGE.split('\n')[0]);
    expect(STT_SUBCOMMANDS).toEqual({ pull: { flags: ['--json'], values: ['--dir', '--mirror'] } });
  });
});
