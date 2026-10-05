import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  AppSetupArtifactSchema,
  PlatformConnectionDescriptorSchema,
  type AppSetupArtifact,
  type PlatformConnectionDescriptor,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  AppSetupClient,
  type AppSetupRun,
} from '../../sync/app-setup-client.js';
import { connectionDescriptorPath } from './connection-descriptor.js';
import { preflightConnectionEnvironment } from './connection-environment.js';
import { renderCurrentSetupManifests } from './current-setup-manifests.js';
import {
  acceptsReceiptPlanDigest,
  createSelfSetupPlan,
  createSetupPlan,
  type SetupPlan,
} from './setup-plan.js';

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

const connectionVariableNames = [
  'GLIRASTES_CONTROL_PLANE_URL',
  'GLIRASTES_APP_ID',
  'GLIRASTES_ENVIRONMENT_ID',
  'GLIRASTES_RUNNER_KEY',
  'GLIRASTES_API_KEY',
] as const;
type ConnectionVariableName = typeof connectionVariableNames[number];

const connectionCredentialsSchema = z.object({
  GLIRASTES_CONTROL_PLANE_URL: z.string().trim().min(1).max(2_048),
  GLIRASTES_APP_ID: z.uuid(),
  GLIRASTES_ENVIRONMENT_ID: z.uuid(),
  GLIRASTES_RUNNER_KEY: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  GLIRASTES_API_KEY: z.string().regex(/^gl_[A-Za-z0-9]{32,128}$/),
}).strict();

export type ConnectionCredentials = z.infer<
  typeof connectionCredentialsSchema
>;

export interface SyncCommandOptions {
  rootDir: string;
  json?: boolean;
  quiet?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface AppSetupSyncClient {
  syncArtifact(
    artifact: AppSetupArtifact,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AppSetupRun>;
}

export interface SyncCommandDependencies {
  env?: NodeJS.ProcessEnv;
  createPlan?: (options: {
    rootDir: string;
    managed: boolean;
  }) => Promise<SetupPlan>;
  createSelfPlan?: (options: {
    rootDir: string;
    managed: boolean;
  }) => Promise<SetupPlan>;
  currentManifestDigests?: typeof renderCurrentSetupManifests;
  isGitIgnored?: (path: string, root: string) => Promise<boolean>;
  clientFactory?: (options: {
    baseUrl: string;
    setupApiKey: string;
    appId: string;
  }) => AppSetupSyncClient;
  log?: (message: string) => void;
}

function syncError(
  code: `E-SYNC-${string}`,
  message: string,
  remediation: string,
): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code,
    operation: 'sync',
    message,
    remediation,
  });
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw syncError(
      'E-SYNC-LOCAL-INVALID',
      'A required local Connected artifact is missing or invalid.',
      'rerun-connect-or-setup',
    );
  }
}

async function readRequiredText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw syncError(
      'E-SYNC-LOCAL-INVALID',
      'A required local Connected artifact is missing or invalid.',
      'rerun-connect-or-setup',
    );
  }
}

export async function readPlatformConnectionDescriptor(
  rootDir: string,
): Promise<PlatformConnectionDescriptor> {
  const parsed = PlatformConnectionDescriptorSchema.safeParse(await readJson(
    connectionDescriptorPath(rootDir),
  ));
  if (!parsed.success) {
    throw syncError(
      'E-SYNC-CONNECTION-INVALID',
      'The local Platform connection descriptor is invalid.',
      'rerun-connect',
    );
  }
  return parsed.data;
}

function parseEnvironment(
  raw: string,
): Partial<Record<ConnectionVariableName, string>> {
  const values: Partial<Record<ConnectionVariableName, string>> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/,
    );
    if (
      !match
      || !connectionVariableNames.includes(
        match[1] as ConnectionVariableName,
      )
    ) {
      continue;
    }
    const name = match[1] as ConnectionVariableName;
    if (values[name] !== undefined) {
      throw syncError(
        'E-SYNC-CREDENTIAL-INVALID',
        'The local secret file contains duplicate connection variables.',
        'rerun-connect',
      );
    }
    const rawValue = match[2] ?? '';
    values[name] = (
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) ? rawValue.slice(1, -1) : rawValue;
  }
  return values;
}

export async function loadConnectionCredentials(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  isGitIgnored?: (path: string, root: string) => Promise<boolean>;
  requireLocalSecretFile?: boolean;
}): Promise<ConnectionCredentials> {
  const rootDir = resolve(options.rootDir);
  const env = options.env ?? process.env;
  const processValues = Object.fromEntries(connectionVariableNames.map(
    (name) => [name, env[name]?.trim() || undefined],
  ));
  const hasCompleteProcessSet = connectionVariableNames.every(
    (name) => processValues[name],
  );
  if (hasCompleteProcessSet && !options.requireLocalSecretFile) {
    const parsed = connectionCredentialsSchema.safeParse(processValues);
    if (!parsed.success) {
      throw syncError(
        'E-SYNC-CREDENTIAL-INVALID',
        'The process Connected credential set is invalid.',
        'repair-process-connection-environment',
      );
    }
    return parsed.data;
  }

  const targets = await preflightConnectionEnvironment({
    projectRoot: rootDir,
    framework: 'nextjs',
    isGitIgnored: options.isGitIgnored,
  });
  let fileValues: Partial<Record<ConnectionVariableName, string>>;
  try {
    fileValues = parseEnvironment(await readFile(
      targets.environmentPath,
      'utf8',
    ));
  } catch (error) {
    if (error instanceof FoundationDiagnosticError) throw error;
    throw syncError(
      'E-SYNC-CREDENTIAL-INVALID',
      'The verified local connection secret is unavailable.',
      'rerun-connect',
    );
  }
  const selected = Object.fromEntries(connectionVariableNames.map((name) => [
    name,
    processValues[name] || fileValues[name],
  ]));
  const parsed = connectionCredentialsSchema.safeParse(selected);
  if (!parsed.success) {
    throw syncError(
      'E-SYNC-CREDENTIAL-INVALID',
      'The local Connected credential set is incomplete or invalid.',
      'rerun-connect',
    );
  }
  return parsed.data;
}

export function assertConnectionScope(options: {
  descriptor: PlatformConnectionDescriptor;
  credentials: ConnectionCredentials;
  appId: string;
}): void {
  const { descriptor, credentials, appId } = options;
  if (
    descriptor.appId !== appId
    || credentials.GLIRASTES_APP_ID !== appId
    || credentials.GLIRASTES_ENVIRONMENT_ID !== descriptor.environmentId
    || credentials.GLIRASTES_CONTROL_PLANE_URL !== descriptor.baseUrl
    || credentials.GLIRASTES_RUNNER_KEY !== descriptor.runnerKey
  ) {
    throw syncError(
      'E-SYNC-SCOPE-MISMATCH',
      'The local Connected app or environment scope does not agree.',
      'rerun-connect',
    );
  }
}

export async function runSync(
  options: SyncCommandOptions,
  dependencies: SyncCommandDependencies = {},
): Promise<void> {
  const rootDir = resolve(options.rootDir);
  const [
    artifactRaw,
    receiptValue,
    descriptor,
    credentials,
  ] = await Promise.all([
    readRequiredText(resolve(rootDir, '.glirastes/setup-artifact.json')),
    readJson(resolve(rootDir, '.glirastes/setup-receipt.json')),
    readPlatformConnectionDescriptor(rootDir),
    loadConnectionCredentials({
      rootDir,
      env: dependencies.env,
      isGitIgnored: dependencies.isGitIgnored,
    }),
  ]);
  let artifactValue: unknown;
  try {
    artifactValue = JSON.parse(artifactRaw) as unknown;
  } catch {
    throw syncError(
      'E-SYNC-LOCAL-INVALID',
      'The canonical setup artifact or receipt is invalid.',
      'rerun-local-setup',
    );
  }
  const artifact = AppSetupArtifactSchema.safeParse(artifactValue);
  const receipt = receiptSchema.safeParse(receiptValue);
  if (!artifact.success || !receipt.success) {
    throw syncError(
      'E-SYNC-LOCAL-INVALID',
      'The canonical setup artifact or receipt is invalid.',
      'rerun-local-setup',
    );
  }
  assertConnectionScope({
    descriptor,
    credentials,
    appId: artifact.data.appId,
  });
  if (
    receipt.data.appId !== artifact.data.appId
    || receipt.data.toolCount !== artifact.data.tools.length
  ) {
    throw syncError(
      'E-SYNC-SCOPE-MISMATCH',
      'The local setup receipt targets a different app scope.',
      'rerun-local-setup',
    );
  }

  const managed = receipt.data.mode === 'managed';
  const createPlan = dependencies.createPlan ?? createSetupPlan;
  const createSelfPlan = dependencies.createSelfPlan ?? createSelfSetupPlan;
  const currentManifestDigests = dependencies.currentManifestDigests
    ?? renderCurrentSetupManifests;
  const [currentPlan, rendered] = await Promise.all([
    createPlan({ rootDir, managed }),
    currentManifestDigests({ rootDir, managed }),
  ]);
  const adopt = currentPlan.operations.find(({ kind }) => kind === 'adopt');
  const currentArtifactDigest = `sha256:${createHash('sha256')
    .update(artifactRaw).digest('base64url')}`;
  const planCurrent = await acceptsReceiptPlanDigest(
    receipt.data.planDigest,
    currentPlan,
    () => createSelfPlan({ rootDir, managed }),
  );
  if (
    currentPlan.diagnostics.length > 0
    || !planCurrent
    || !adopt
    || adopt.digest !== currentArtifactDigest
    || receipt.data.runtimeDigest !== rendered.runtimeDigest
    || receipt.data.promptDigest !== rendered.promptDigest
  ) {
    throw syncError(
      'E-SYNC-SETUP-STALE',
      'The setup receipt does not match the exact current local plan.',
      'rerun-local-setup',
    );
  }

  // The uploaded object must come from the exact byte snapshot validated
  // above. An atomic replacement during preflight is stale local state, even
  // if a concurrently computed plan happens to describe the replacement.
  const artifactPath = resolve(rootDir, '.glirastes/setup-artifact.json');
  if (await readRequiredText(artifactPath) !== artifactRaw) {
    throw syncError(
      'E-SYNC-SETUP-STALE',
      'The canonical setup artifact changed during sync preflight.',
      'rerun-sync',
    );
  }

  const client = (dependencies.clientFactory ?? (
    (clientOptions) => new AppSetupClient(clientOptions)
  ))({
    baseUrl: descriptor.baseUrl,
    setupApiKey: credentials.GLIRASTES_API_KEY,
    appId: descriptor.appId,
  });
  const run = await client.syncArtifact(artifact.data, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const result = {
    schemaVersion: 1 as const,
    status: run.status,
    appId: descriptor.appId,
    environmentId: descriptor.environmentId,
    counts: {
      tools: artifact.data.tools.length,
      warnings: artifact.data.warnings.length,
    },
    digests: {
      plan: currentPlan.planDigest,
      discovery: artifact.data.discoveryDigest,
      artifact: run.artifactDigest ?? currentArtifactDigest,
    },
  };
  if (options.quiet) return;
  const log = dependencies.log ?? console.log;
  if (options.json) {
    log(JSON.stringify(result));
  } else {
    log(
      `Synced ${result.counts.tools} tools for app ${result.appId} `
      + `and environment ${result.environmentId}: ${result.status}.`,
    );
  }
}
