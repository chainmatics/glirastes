import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_CONTROL_PLANE_URL } from '../../runtime/runtime-mode.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { loadToolsConfig, TOOLS_PATHS } from '../../codegen/tools/config.js';
import type {
  PairingStartRequest,
  PairingStartResponse,
  PairingTokenResult,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  RuntimeConnectClient,
  type PollForConnectionOptions,
  type RuntimeConnectClientOptions,
} from '../../sync/runtime-connect-client.js';
import type { AtomicArtifactWriteHooks } from './atomic-artifact-write.js';
import {
  isSelfHostedControlPlane,
  materializeConnectionEnvironment,
  prepareSecretStaging,
  preflightConnectionEnvironment,
  type SecretStagingOptions,
  selectConnectionSecret,
  type ConnectionEnvironmentPreflightOptions,
  type ConnectionEnvironmentTargets,
  type MaterializeConnectionEnvironmentOptions,
} from './connection-environment.js';

export { connectFrameworkOf } from './connection-environment.js';
import {
  acceptsReceiptPlanDigest,
  createSelfSetupPlan,
  createSetupPlan,
  type SetupPlan,
} from './setup-plan.js';

const execFileAsync = promisify(execFile);
const digest = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);
const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  planDigest: digest,
  mode: z.enum(['standalone', 'managed']),
  appId: z.uuid(),
  toolCount: z.number().int().nonnegative(),
  runtimeDigest: digest,
  promptDigest: digest,
  restartRequired: z.literal(true),
}).strict();
const packageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough();
const localArtifactIdentitySchema = z.object({ appId: z.uuid() }).passthrough();

export interface RuntimeConnectClientLike {
  startPairing(
    input: PairingStartRequest,
    signal?: AbortSignal,
  ): Promise<PairingStartResponse>;
  pollForConnection(options: PollForConnectionOptions): Promise<PairingTokenResult>;
}

export interface ConnectCommandOptions {
  rootDir: string;
  baseUrl?: string;
  json?: boolean;
  /**
   * Project-relative file for `GLIRASTES_API_KEY` (must be Git-ignored).
   * Wins over `connection.envFile` of `tools.json` and over `.env.local`.
   */
  envFile?: string;
}

export interface ConnectCommandDependencies {
  createPlan?: (options: { rootDir: string }) => Promise<SetupPlan>;
  createSelfPlan?: (options: { rootDir: string }) => Promise<SetupPlan>;
  preflight?: (
    options: ConnectionEnvironmentPreflightOptions,
  ) => Promise<ConnectionEnvironmentTargets>;
  materialize?: (
    options: MaterializeConnectionEnvironmentOptions,
  ) => Promise<unknown>;
  clientFactory?: (
    options: RuntimeConnectClientOptions,
  ) => RuntimeConnectClientLike;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  isGitIgnored?: (path: string, root: string) => Promise<boolean>;
  atomicWriteHooks?: AtomicArtifactWriteHooks;
  createRunnerKey?: () => string;
  log?: (message: string) => void;
  /** Where the secret is staged while it is written (test seams). */
  staging?: SecretStagingOptions;
  /** Whether stdout is a terminal; defaults to `process.stdout.isTTY`. */
  isTTY?: () => boolean;
}

function connectError(
  code: `E-CONNECT-${string}`,
  message: string,
  remediation: string,
): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code,
    operation: 'connect',
    message,
    remediation,
  });
}

export async function openVerificationUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  launch: (file: string, args: string[]) => Promise<unknown> = execFileAsync,
): Promise<void> {
  if (platform === 'darwin') {
    await launch('open', [url]);
    return;
  }
  if (platform === 'win32') {
    await launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
    return;
  }
  await launch('xdg-open', [url]);
}

function localRunnerKey(): string {
  return `local-${randomBytes(18).toString('base64url')}`;
}

function resolveBaseUrl(flag: string | undefined): string {
  return flag?.trim()
    || process.env.GLIRASTES_CONTROL_PLANE_URL?.trim()
    || DEFAULT_CONTROL_PLANE_URL;
}

async function connectedAppId(rootDir: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(resolve(rootDir, '.glirastes/platform-connection.json'), 'utf8')) as { appId?: unknown };
    return typeof value.appId === 'string' ? value.appId : undefined;
  } catch {
    return undefined;
  }
}

function artifactOperationFrom(plan: SetupPlan): SetupPlan['operations'][number] {
  const operation = plan.operations.find(({ kind }) => kind === 'adopt');
  if (!operation) {
    throw connectError(
      'E-CONNECT-SETUP-INVALID',
      'The local setup plan has no adopted setup artifact.',
      'rerun-local-setup',
    );
  }
  return operation;
}

export async function runConnect(
  options: ConnectCommandOptions,
  dependencies: ConnectCommandDependencies = {},
): Promise<void> {
  const rootDir = resolve(options.rootDir);
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const createPlan = dependencies.createPlan ?? createSetupPlan;
  const createSelfPlan = dependencies.createSelfPlan ?? createSelfSetupPlan;
  const plan = await createPlan({ rootDir });
  if (plan.diagnostics.length > 0) {
    throw connectError(
      'E-CONNECT-SETUP-INVALID',
      'The local setup plan is not green.',
      'rerun-local-setup',
    );
  }

  const artifactOperation = artifactOperationFrom(plan);
  let receiptValue: unknown;
  let packageValue: unknown;
  let artifactRaw: string;
  let artifactValue: unknown;
  try {
    const localInputs = await Promise.all([
      readFile(resolve(rootDir, '.glirastes/setup-receipt.json'), 'utf8')
        .then((raw) => JSON.parse(raw)),
      readFile(resolve(rootDir, 'package.json'), 'utf8')
        .then((raw) => JSON.parse(raw)),
      readFile(resolve(rootDir, artifactOperation.path), 'utf8')
        .then((raw) => ({ raw, value: JSON.parse(raw) as unknown })),
    ]);
    [receiptValue, packageValue] = localInputs;
    artifactRaw = localInputs[2].raw;
    artifactValue = localInputs[2].value;
  } catch {
    throw connectError(
      'E-CONNECT-SETUP-STALE',
      'A current local setup receipt and package metadata are required.',
      'rerun-local-setup',
    );
  }
  const receipt = receiptSchema.safeParse(receiptValue);
  const packageJson = packageSchema.safeParse(packageValue);
  const artifactIdentity = localArtifactIdentitySchema.safeParse(
    artifactValue,
  );
  const currentArtifactDigest = `sha256:${createHash('sha256')
    .update(artifactRaw).digest('base64url')}`;
  const receiptCurrent = receipt.success
    && await acceptsReceiptPlanDigest(
      receipt.data.planDigest,
      plan,
      () => createSelfPlan({ rootDir }),
    );
  if (
    !receipt.success
    || !receiptCurrent
    || !packageJson.success
    || !artifactIdentity.success
    || artifactIdentity.data.appId !== receipt.data.appId
    || currentArtifactDigest !== artifactOperation.digest
  ) {
    throw connectError(
      'E-CONNECT-SETUP-STALE',
      'The local setup receipt does not match the current setup plan.',
      'rerun-local-setup',
    );
  }
  // Tool ids derive from the app id: the Platform adopts the local one, and
  // connect refuses when the committed files disagree instead of re-keying.
  const tools = existsSync(resolve(rootDir, TOOLS_PATHS.config)) ? loadToolsConfig(rootDir) : undefined;
  const previouslyConnected = await connectedAppId(rootDir);
  if ((tools && tools.appId !== receipt.data.appId)
    || (previouslyConnected !== undefined && previouslyConnected !== receipt.data.appId)) {
    throw connectError(
      'E-CONNECT-APP-ID-CHANGED',
      'The app id in .glirastes/tools.json, the setup receipt and the existing connection must be the same; tool ids derive from it, so it never changes silently.',
      'restore-tools-app-id',
    );
  }
  const secret = selectConnectionSecret({
    projectRoot: rootDir,
    envFile: options.envFile,
    tools,
    packageJson: packageJson.data,
  });
  const writesSecretFile = secret.environmentPath !== undefined
    || secret.framework === 'nextjs';
  const isTTY = dependencies.isTTY ?? (() => Boolean(process.stdout.isTTY));
  if (!writesSecretFile && !options.json && !isTTY()) {
    // Agents and CI start connect too: a key printed into their logs or
    // transcripts would outlive the session. Refuse before any key exists.
    throw connectError(
      'E-CONNECT-SECRET-OUTPUT-REFUSED',
      'No secret file is configured and the output is not a terminal, so the connection key would land in a log. Pass --dotenv <path> to write it to a Git-ignored file, or --json to receive it as machine-readable output.',
      'choose-connection-secret-target',
    );
  }

  // Every check of the secret target runs before pairing: no key is issued
  // that cannot be stored.
  const preflight = dependencies.preflight ?? preflightConnectionEnvironment;
  const targets = await preflight({
    projectRoot: rootDir,
    ...(secret.framework ? { framework: secret.framework } : {}),
    ...(secret.environmentPath ? { environmentPath: secret.environmentPath } : {}),
    intendedBaseUrl: baseUrl,
    isGitIgnored: dependencies.isGitIgnored,
  });
  if (targets?.environmentPath) {
    // Prove a safe staging place exists (and renames into the target
    // directory) now: an EXDEV after pairing would orphan the key.
    const staging = await prepareSecretStaging(targets, {
      ...dependencies.staging,
      isGitIgnored: dependencies.isGitIgnored,
    });
    await staging.release();
  }

  const client = (dependencies.clientFactory ?? (
    (clientOptions) => new RuntimeConnectClient(clientOptions)
  ))({
    baseUrl,
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
    sleep: dependencies.sleep,
  });
  const started = await client.startPairing({
    schemaVersion: 1,
    localAppId: receipt.data.appId,
    localAppName: packageJson.data.name,
    artifactDigest: artifactOperation.digest,
    capabilities: { appConnection: 1 },
  }, dependencies.signal);

  const log = dependencies.log ?? console.log;
  if (!options.json) {
    log(`Open ${started.verificationUri}`);
    log(`Enter code ${started.userCode}`);
  }
  await (dependencies.openBrowser ?? openVerificationUrl)(
    started.verificationUri,
  );
  const token = await client.pollForConnection({
    deviceCode: started.deviceCode,
    pollIntervalMs: started.pollIntervalMs,
    expiresInSeconds: started.expiresInSeconds,
    signal: dependencies.signal,
  });
  if (token.status === 'denied') {
    throw connectError(
      'E-CONNECT-DENIED',
      'Platform pairing was denied.',
      'restart-browser-pairing',
    );
  }
  if (token.status === 'expired') {
    throw connectError(
      'E-CONNECT-EXPIRED',
      'Platform pairing expired.',
      'restart-browser-pairing',
    );
  }
  if (token.status === 'pending') {
    throw connectError(
      'E-CONNECT-RESPONSE-INVALID',
      'Platform pairing ended in an invalid pending state.',
      'restart-browser-pairing',
    );
  }
  if (token.connection.appId !== receipt.data.appId) {
    throw connectError(
      'E-CONNECT-APP-MISMATCH',
      'The Platform returned a different app identity.',
      'restart-browser-pairing',
    );
  }
  if (new URL(token.connection.baseUrl).origin !== new URL(baseUrl).origin) {
    throw connectError(
      'E-CONNECT-PLANE-MISMATCH',
      'The paired connection targets a different Control Plane.',
      'restart-browser-pairing',
    );
  }

  const { environmentId, ...appConnection } = token.connection;
  const connection = {
    ...appConnection,
    ...(environmentId ? { environmentId } : {}),
  };

  const materialize = dependencies.materialize
    ?? materializeConnectionEnvironment;
  try {
    await materialize({
      projectRoot: rootDir,
      ...(secret.framework ? { framework: secret.framework } : {}),
      ...(secret.environmentPath ? { environmentPath: secret.environmentPath } : {}),
      connection: {
        ...connection,
        runnerKey: (dependencies.createRunnerKey ?? localRunnerKey)(),
      },
      apiKey: token.apiKey,
      isGitIgnored: dependencies.isGitIgnored,
      ...dependencies.staging,
      atomicWriteHooks: dependencies.atomicWriteHooks,
    });
  } catch (error) {
    // The key exists on the Platform now; say so, never print it.
    const reason = error instanceof FoundationDiagnosticError
      ? ` (${error.code}: ${error.message})`
      : error instanceof Error ? ` (${error.message})` : '';
    throw connectError(
      'E-CONNECT-SECRET-NOT-STORED',
      `The Platform issued a connection key, but it could not be stored${reason}. Fix the cause, run glirastes connect again, and revoke the unused key on the Platform.`,
      'rerun-connect-and-revoke-unused-key',
    );
  }

  const envFile = writesSecretFile
    ? relative(rootDir, secret.environmentPath ?? resolve(rootDir, '.env.local'))
    : undefined;
  const selfHostedUrl = isSelfHostedControlPlane(connection.baseUrl)
    ? connection.baseUrl
    : undefined;
  if (options.json) {
    log(JSON.stringify({
      schemaVersion: 1,
      status: 'connected',
      appId: token.connection.appId,
      environmentId: environmentId ?? null,
      ...(envFile !== undefined
        ? { secretTarget: 'file', envFile }
        : {
            secretTarget: 'output',
            apiKey: token.apiKey,
            ...(selfHostedUrl ? { controlPlaneUrl: selfHostedUrl } : {}),
          }),
    }));
  } else if (envFile === undefined) {
    log('Connected to the Glirastes Platform.');
    log(`GLIRASTES_API_KEY=${token.apiKey}`);
    log('Set this value as GLIRASTES_API_KEY in the environment of the server process. It was not stored anywhere and cannot be shown again.');
    if (selfHostedUrl) {
      log(`Also set GLIRASTES_CONTROL_PLANE_URL=${selfHostedUrl}.`);
    }
    log('Then restart the application.');
  } else if (secret.environmentPath !== undefined) {
    log(`Connected to the Glirastes Platform. GLIRASTES_API_KEY was written to ${envFile}. Restart the application.`);
  } else {
    log('Connected to the Glirastes Platform. Restart the application.');
  }
}
