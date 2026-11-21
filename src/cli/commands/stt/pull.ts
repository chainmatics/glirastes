import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { trimTrailingSlashes } from '../../../contracts/url.js';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';
import { STT_ATTRIBUTION_TEXT, STT_MODEL_FILES, type SttModelFile } from '../../../server/stt-local/models.js';

export interface SttPullDependencies {
  fetch?: typeof globalThis.fetch;
  files?: readonly SttModelFile[];
  env?: NodeJS.ProcessEnv;
}

export interface SttPullResult {
  dir: string;
  files: { path: string; status: 'verified' | 'downloaded'; bytes: number }[];
}

const OPERATION = 'stt pull';
const RETRY = 'Check the mirror or network and run glirastes stt pull again.';

/** The URL as it may appear in a message: no credentials, query or fragment. */
function printable(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '(invalid URL)';
  }
}

function checkMirror(mirror: string): void {
  let protocol: string | undefined;
  try {
    protocol = new URL(mirror).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new FoundationDiagnosticError({
      code: 'E-STT-003',
      operation: OPERATION,
      message: '--mirror must be an http: or https: URL.',
      remediation: 'Pass the base URL that serves the model files under their relative paths, for example https://models.example.com/glirastes.',
    });
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function isVerified(path: string, file: SttModelFile): Promise<boolean> {
  const size = await stat(path).then((s) => (s.isFile() ? s.size : -1), () => -1);
  return size === file.bytes && (await sha256Of(path)) === file.sha256;
}

function mismatch(file: SttModelFile, detail: string): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-STT-001',
    operation: OPERATION,
    message: `${file.path} does not match its pin: ${detail}.`,
    remediation: RETRY,
    path: file.path,
  });
}

function cancelled(file: SttModelFile): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-STT-002',
    operation: OPERATION,
    message: `Download of ${file.path} was cancelled; its partial file was removed.`,
    remediation: 'Run glirastes stt pull again to finish the download.',
    path: file.path,
  });
}

/** Removes `<name>.partial-*` files that a killed earlier pull left beside `target` (up to 652 MB each). */
async function removeStalePartials(target: string): Promise<void> {
  const prefix = `${basename(target)}.partial-`;
  const names = await readdir(dirname(target)).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) => rm(join(dirname(target), name), { force: true })));
}

async function download(
  file: SttModelFile,
  url: string,
  target: string,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) throw cancelled(file);
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'follow', ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted) throw cancelled(file);
    throw new FoundationDiagnosticError({
      code: 'E-STT-002',
      operation: OPERATION,
      message: `Download of ${file.path} from ${printable(url)} failed: ${error instanceof Error ? error.message : 'network error'}.`,
      remediation: RETRY,
      path: file.path,
    });
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new FoundationDiagnosticError({
      code: 'E-STT-002',
      operation: OPERATION,
      message: `Download of ${file.path} failed: HTTP ${response.status} from ${printable(url)}.`,
      remediation: RETRY,
      path: file.path,
    });
  }

  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial-${randomBytes(6).toString('hex')}`;
  let renamed = false;
  try {
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > file.bytes) {
          callback(mismatch(file, `the server sent more than the pinned ${file.bytes} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), meter, createWriteStream(partial));
    } catch (error) {
      if (error instanceof FoundationDiagnosticError) throw error;
      if (signal?.aborted) throw cancelled(file);
      // A reset socket, a full disk: a diagnostic with the remediation, not a raw stack.
      throw new FoundationDiagnosticError({
        code: 'E-STT-002',
        operation: OPERATION,
        message: `Download of ${file.path} from ${printable(url)} was interrupted: ${error instanceof Error ? error.message : 'stream error'}.`,
        remediation: RETRY,
        path: file.path,
      });
    }
    if (received !== file.bytes) throw mismatch(file, `received ${received} bytes, expected ${file.bytes}`);
    const actual = hash.digest('hex');
    if (actual !== file.sha256) throw mismatch(file, `sha256 ${actual}, expected ${file.sha256}`);
    await rename(partial, target);
    renamed = true;
  } finally {
    if (!renamed) await rm(partial, { force: true });
  }
}

/**
 * Downloads the pinned local speech models into `dir`, each through a
 * `.partial-*` file that is hashed while streaming and renamed only after its
 * size and sha256 match. Sends only GET requests for the pinned files.
 */
export async function pullSttModels(
  o: { dir: string; mirror?: string; signal?: AbortSignal },
  d: SttPullDependencies = {},
): Promise<SttPullResult> {
  if (o.mirror !== undefined) checkMirror(o.mirror);
  const fetch = d.fetch ?? globalThis.fetch;
  const files = d.files ?? STT_MODEL_FILES;
  await mkdir(o.dir, { recursive: true });
  const result: SttPullResult = { dir: o.dir, files: [] };
  for (const file of files) {
    const target = join(o.dir, file.path);
    if (await isVerified(target, file)) {
      result.files.push({ path: file.path, status: 'verified', bytes: file.bytes });
      continue;
    }
    // An unverified file never stays under the final name, even if the download fails.
    await rm(target, { force: true });
    await removeStalePartials(target);
    const url = o.mirror !== undefined ? `${trimTrailingSlashes(o.mirror)}/${file.path}` : file.url;
    await download(file, url, target, fetch, o.signal);
    result.files.push({ path: file.path, status: 'downloaded', bytes: file.bytes });
  }
  await writeFile(join(o.dir, 'ATTRIBUTION.txt'), `${STT_ATTRIBUTION_TEXT}\n`);
  return result;
}
