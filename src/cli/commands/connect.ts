import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
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
  materializeConnectionEnvironment,
  preflightConnectionEnvironment,
  type ConnectionEnvironmentTargets,
  type MaterializeConnectionEnvironmentOptions,
} from './connection-environment.js';
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
}

export interface ConnectCommandDependencies {
  createPlan?: (options: { rootDir: string }) => Promise<SetupPlan>;
  createSelfPlan?: (options: { rootDir: string }) => Promise<SetupPlan>;
  preflight?: (options: {
    projectRoot: string;
    framework: 'nextjs';
    isGitIgnored?: (path: string, root: string) => Promise<boolean>;
  }) => Promise<ConnectionEnvironmentTargets>;
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

function requiredBaseUrl(value: string | undefined): string {
  if (!value) {
    throw connectError(
      'E-CONNECT-URL-REQUIRED',
      '--base-url is required to connect to the Glirastes Platform.',
      'pass-control-plane-url',
    );
  }
  return value;
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
  const baseUrl = requiredBaseUrl(options.baseUrl);
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
  if (
    packageJson.data.dependencies?.next === undefined
    && packageJson.data.devDependencies?.next === undefined
  ) {
    throw connectError(
      'E-CONNECT-FRAMEWORK-UNSUPPORTED',
      'Automatic connection materialization currently requires Next.js.',
      'configure-supported-secret-target',
    );
  }

  const preflight = dependencies.preflight ?? preflightConnectionEnvironment;
  await preflight({
    projectRoot: rootDir,
    framework: 'nextjs',
    isGitIgnored: dependencies.isGitIgnored,
  });

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

  const materialize = dependencies.materialize
    ?? materializeConnectionEnvironment;
  await materialize({
    projectRoot: rootDir,
    framework: 'nextjs',
    connection: {
      ...token.connection,
      runnerKey: (dependencies.createRunnerKey ?? localRunnerKey)(),
    },
    apiKey: token.apiKey,
    isGitIgnored: dependencies.isGitIgnored,
    atomicWriteHooks: dependencies.atomicWriteHooks,
  });

  if (options.json) {
    log(JSON.stringify({
      schemaVersion: 1,
      status: 'connected',
      appId: token.connection.appId,
      environmentId: token.connection.environmentId,
    }));
  } else {
    log('Connected to the Glirastes Platform. Restart the application.');
  }
}
