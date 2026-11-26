import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, join, resolve } from 'node:path';
import {
  EVAL_ATTESTATION_KEY_SCOPE,
  EVAL_ATTESTATION_SECRET_PATTERNS,
} from '../../../contracts/eval-attestation.js';
import {
  EVAL_ATTESTATION_MAX_TOTAL,
  EVAL_ATTESTATION_SCHEMA_VERSION,
  EvalAttestationRequestSchema,
  EvalAttestationResponseSchema,
  RUNTIME_METRIC_LABEL_PATTERN,
  type EvalAttestationRequest,
} from '../../../contracts/index.js';
import { isUuidLike } from '../../../contracts/entity-identity.js';
import { DEFAULT_CONTROL_PLANE_URL, RUNTIME_API_KEY_PATTERN } from '../../../runtime/runtime-mode.js';
import { errorCode } from '../../../sync/control-plane-client.js';
import { canonicalRuntimeJson } from '../../../sync/signature-verifier.js';
import { parseToolArgs, ToolsUsageError, type ToolArgsSpec } from '../tools/args.js';

/** Every `glirastes evals` subcommand with its flags and values; the shipped skills are linted against it. */
export const EVALS_SUBCOMMANDS: Readonly<Record<string, ToolArgsSpec>> = {
  attest: { flags: ['--json'], values: ['--suite', '--total', '--failed', '--run-ref', '--root'] },
};

export const EVALS_USAGE = [
  'Usage: glirastes evals attest --suite <file|dir> --total <n> --failed <n> [--run-ref <label>] [--root <dir>] [--json]',
  '         report the result of your own eval suite to the Platform: digests and counts only, never cases or outputs;',
  '         pass when --failed is 0 (exit 0), otherwise fail (exit 1); needs GLIRASTES_EVAL_ATTEST_KEY (the app\'s eval attestation key, scope evals:attest) and .glirastes/setup-artifact.json',
].join('\n');

const SETUP_ARTIFACT_PATH = '.glirastes/setup-artifact.json';
const REQUEST_TIMEOUT_MS = 30_000;
const DIGEST_PATTERN = /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/;
/** OS metadata files left out of the suite digest; everything else counts, hidden files included. */
export const EVAL_SUITE_IGNORED_FILES: ReadonlyArray<string> = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);

export interface EvalsCommandDependencies {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

class EvalsStop extends Error {
  constructor(message: string, readonly exitCode: 1 | 2) {
    super(message);
    this.name = 'EvalsStop';
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('base64url')}`;
}

async function hashFile(full: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(full), hash);
  return `sha256:${hash.digest('base64url')}`;
}

// Sequential on purpose: one open file at a time, only (path, hash) kept.
async function hashSuiteDir(dir: string, prefix: string, out: Array<{ path: string; sha256: string }>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await hashSuiteDir(full, path, out);
    else if (entry.isFile()) {
      if (!EVAL_SUITE_IGNORED_FILES.includes(entry.name)) out.push({ path, sha256: await hashFile(full) });
    } else throw new EvalsStop('An entry in the suite is a link or neither a file nor a directory; links are not followed.', 2);
  }
}

/**
 * The suite digest over (relative path, file digest) pairs: paths in NFC with
 * `/` separators, sorted by their UTF-8 bytes. Paths equal after NFC are refused.
 */
export function suiteDigestOf(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  const files = entries.map((entry) => ({ path: entry.path.normalize('NFC'), sha256: entry.sha256 }));
  if (files.length === 0) throw new EvalsStop('The suite contains no files.', 2);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
  for (let index = 1; index < files.length; index += 1) {
    if (files[index]!.path === files[index - 1]!.path) {
      throw new EvalsStop('An entry in the suite has the same name as another one after Unicode normalisation.', 2);
    }
  }
  return sha256(canonicalRuntimeJson({ schemaVersion: EVAL_ATTESTATION_SCHEMA_VERSION, files }));
}

/** `--suite` as a file (listed under its base name) or a directory; contents never leave this function. */
export async function computeSuiteDigest(suitePath: string): Promise<string> {
  const stat = await lstat(suitePath);
  const entries: Array<{ path: string; sha256: string }> = [];
  if (stat.isFile()) entries.push({ path: basename(suitePath), sha256: await hashFile(suitePath) });
  else if (stat.isDirectory()) await hashSuiteDir(suitePath, '', entries);
  else throw new EvalsStop('--suite must name a file or a directory; links are not followed.', 2);
  return suiteDigestOf(entries);
}

function count(values: Map<string, string>, flag: string): number {
  const raw = values.get(flag);
  if (raw === undefined) throw new EvalsStop(`${flag} is required.`, 2);
  if (!/^\d+$/.test(raw) || Number(raw) > EVAL_ATTESTATION_MAX_TOTAL) {
    throw new EvalsStop(`${flag} must be a whole number from 0 to ${EVAL_ATTESTATION_MAX_TOTAL}.`, 2);
  }
  return Number(raw);
}

async function readSetupDigests(root: string): Promise<{ appId: string; setupArtifactDigest: string; promptDigest: string }> {
  let artifact: { appId?: unknown; discoveryDigest?: unknown; prompts?: { bundleDigest?: unknown } };
  try {
    artifact = JSON.parse(await readFile(join(root, SETUP_ARTIFACT_PATH), 'utf8')) as typeof artifact;
  } catch {
    throw new EvalsStop(`${SETUP_ARTIFACT_PATH} is missing or not JSON. Run glirastes tools refresh and commit .glirastes first.`, 2);
  }
  const { appId, discoveryDigest } = artifact;
  const bundleDigest = artifact.prompts?.bundleDigest;
  if (typeof appId !== 'string' || !isUuidLike(appId)) {
    throw new EvalsStop(`${SETUP_ARTIFACT_PATH} names no appId.`, 2);
  }
  if (typeof discoveryDigest !== 'string' || !DIGEST_PATTERN.test(discoveryDigest)) {
    throw new EvalsStop(`${SETUP_ARTIFACT_PATH} has no discoveryDigest.`, 2);
  }
  if (typeof bundleDigest !== 'string' || !DIGEST_PATTERN.test(bundleDigest)) {
    throw new EvalsStop(`${SETUP_ARTIFACT_PATH} has no prompts.bundleDigest.`, 2);
  }
  return { appId, setupArtifactDigest: discoveryDigest, promptDigest: bundleDigest };
}

function connection(env: Record<string, string | undefined>): { baseUrl: string; apiKey: string } {
  const apiKey = env.GLIRASTES_EVAL_ATTEST_KEY?.trim();
  if (!apiKey) {
    throw new EvalsStop(
      `GLIRASTES_EVAL_ATTEST_KEY is not set. Use the app's eval attestation key (scope ${EVAL_ATTESTATION_KEY_SCOPE}), issued by an owner or admin in the dashboard; runtime and connect keys cannot attest. Nothing was sent.`,
      2,
    );
  }
  if (!RUNTIME_API_KEY_PATTERN.test(apiKey)) throw new EvalsStop('GLIRASTES_EVAL_ATTEST_KEY is malformed; nothing was sent.', 2);
  const configured = env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  let baseUrl = DEFAULT_CONTROL_PLANE_URL;
  if (configured) {
    let url: URL | undefined;
    try { url = new URL(configured); } catch { url = undefined; }
    const loopback = url !== undefined
      && (LOOPBACK_HOSTS.has(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
    if (url?.protocol !== 'https:' && !(url?.protocol === 'http:' && loopback)) {
      throw new EvalsStop('GLIRASTES_CONTROL_PLANE_URL must be an https URL (http only for localhost); nothing was sent.', 2);
    }
    baseUrl = configured;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

async function attest(argv: readonly string[], deps: Required<EvalsCommandDependencies>, json: boolean): Promise<number> {
  const args = parseToolArgs(argv, EVALS_SUBCOMMANDS.attest!);
  const suite = args.values.get('--suite');
  if (suite === undefined) throw new EvalsStop('--suite is required.', 2);
  const total = count(args.values, '--total');
  const failed = count(args.values, '--failed');
  if (total < 1) throw new EvalsStop('--total must be at least 1.', 2);
  if (failed > total) throw new EvalsStop('--failed must not exceed --total.', 2);
  const runRef = args.values.get('--run-ref');
  if (runRef !== undefined && !RUNTIME_METRIC_LABEL_PATTERN.test(runRef)) {
    throw new EvalsStop('--run-ref takes a technical label (no whitespace or quotes, at most 200 characters).', 2);
  }
  if (runRef !== undefined && EVAL_ATTESTATION_SECRET_PATTERNS.some((pattern) => pattern.test(runRef))) {
    throw new EvalsStop('--run-ref looks like a token or key; nothing was sent.', 2);
  }

  const root = resolve(deps.cwd, args.values.get('--root') ?? '.');
  const digests = await readSetupDigests(root);
  const { baseUrl, apiKey } = connection(deps.env);
  let suiteDigest: string;
  try {
    suiteDigest = await computeSuiteDigest(resolve(deps.cwd, suite));
  } catch (caught) {
    if (caught instanceof EvalsStop) throw caught;
    throw new EvalsStop('--suite or an entry in the suite cannot be read.', 2);
  }

  const body: EvalAttestationRequest = EvalAttestationRequestSchema.parse({
    schemaVersion: EVAL_ATTESTATION_SCHEMA_VERSION,
    setupArtifactDigest: digests.setupArtifactDigest,
    promptDigest: digests.promptDigest,
    suiteDigest,
    result: failed === 0 ? 'pass' : 'fail',
    total,
    failed,
    ranAt: deps.now().toISOString(),
    ...(runRef !== undefined ? { ciRunRef: runRef } : {}),
  });

  let response: Response;
  try {
    response = await deps.fetch(`${baseUrl}/v1/apps/${encodeURIComponent(digests.appId)}/eval-attestations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      // The key must never follow a redirect to another origin.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new EvalsStop('The Platform could not be reached; no attest was recorded.', 1);
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new EvalsStop(`The Platform answered with a redirect (HTTP ${response.status}); it was not followed and nothing was recorded.`, 1);
  }
  if (!response.ok) {
    const code = await errorCode(response);
    const hint = response.status === 403
      ? ` Only the app's eval attestation key (scope ${EVAL_ATTESTATION_KEY_SCOPE}) can attest; runtime, connect and CI keys cannot. An owner or admin issues it in the dashboard; set it as GLIRASTES_EVAL_ATTEST_KEY.`
      : '';
    throw new EvalsStop(`The Platform refused the attest (HTTP ${response.status}${code ? `, ${code}` : ''}).${hint}`, 1);
  }
  let recorded;
  try {
    recorded = EvalAttestationResponseSchema.parse(await response.json());
  } catch {
    throw new EvalsStop(`The Platform answered HTTP ${response.status} without a readable body: result unknown, the attestation may have been recorded.`, 1);
  }

  const summary = {
    attestationId: recorded.attestationId,
    recordedAt: recorded.recordedAt,
    result: body.result,
    total,
    failed,
    setupArtifactDigest: body.setupArtifactDigest,
    promptDigest: body.promptDigest,
    suiteDigest,
  };
  if (json) deps.log(JSON.stringify(summary));
  else {
    deps.log(`Eval attest recorded: ${body.result} (${failed} of ${total} failed), attestation ${recorded.attestationId}`);
    deps.log(`setup ${body.setupArtifactDigest}  prompt ${body.promptDigest}  suite ${suiteDigest}`);
  }
  return body.result === 'pass' ? 0 : 1;
}

/** `glirastes evals`: reports results of the customer's own eval suite; never runs evals or calls a model. */
export async function runEvalsCommand(argv: readonly string[], d: EvalsCommandDependencies = {}): Promise<number> {
  const deps: Required<EvalsCommandDependencies> = {
    cwd: d.cwd ?? process.cwd(),
    env: d.env ?? process.env,
    fetch: d.fetch ?? fetch,
    now: d.now ?? (() => new Date()),
    log: d.log ?? ((line) => { console.log(line); }),
    error: d.error ?? ((line) => { console.error(line); }),
  };
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'attest') {
    deps.error(EVALS_USAGE);
    return 2;
  }
  const json = rest.includes('--json');
  try {
    return await attest(rest, deps, json);
  } catch (caught) {
    if (caught instanceof ToolsUsageError) {
      deps.error(`${caught.message}\n${EVALS_USAGE}`);
      return 2;
    }
    if (caught instanceof EvalsStop) {
      if (json) deps.log(JSON.stringify({ error: caught.message, exitCode: caught.exitCode }));
      else deps.error(caught.message);
      return caught.exitCode;
    }
    const message = `glirastes evals attest stopped unexpectedly (${caught instanceof Error ? caught.name : 'error'}).`;
    if (json) deps.log(JSON.stringify({ error: message, exitCode: 2 }));
    else deps.error(message);
    return 2;
  }
}
