import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { FoundationExecutionInventorySchema } from '../../codegen/index.js';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { detectStack, type DetectedStack } from './installer-parts.js';

const relativePath = z.string().trim().min(1).max(2_048);
const PackageGlirastesSchema = z.object({
  principal: z.literal('server-verified').optional(),
  setupArtifact: relativePath.optional(),
  inventory: relativePath.optional(),
  promptBundle: relativePath.optional(),
}).passthrough();

const PackageSchema = z.object({
  name: z.string().trim().min(1).max(214).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  glirastes: PackageGlirastesSchema.optional(),
}).passthrough();

const PromptIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
}).passthrough();

const AUTH_MARKERS = [
  ['@auth0/nextjs-auth0', 'auth0'],
  ['@clerk/nextjs', 'clerk'],
  ['@supabase/ssr', 'supabase'],
  ['@auth/core', 'authjs'],
  ['next-auth', 'authjs'],
  ['better-auth', 'better-auth'],
] as const;

export interface SetupProfile {
  schemaVersion: 1;
  projectName: string | null;
  framework: DetectedStack | null;
  authProviders: string[];
  principal: 'server-verified' | null;
  mode: 'standalone' | 'managed';
  appId: string;
  toolCount: number;
  paths: {
    inventory: string;
    setupArtifact: string;
    canonicalSetupArtifact: string;
    previousSetupArtifact: string;
    promptBundle: string;
    buildDir: string;
    receipt: string;
  };
}

export interface DetectSetupProfileOptions {
  rootDir: string;
  managed?: boolean;
  artifactPath?: string;
  inventoryPath?: string;
  promptBundlePath?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function boundedPath(rootDir: string, path: string): {
  absolute: string;
  relative: string;
} {
  const absolute = resolve(rootDir, path);
  const local = relative(resolve(rootDir), absolute);
  if (
    !local
    || local.startsWith('..')
    || isAbsolute(local)
    || local.length > 2_048
  ) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-003',
      operation: 'setup.profile',
      message: 'A configured setup path is outside the workspace.',
      remediation: 'choose-workspace-artifact-path',
    });
  }
  return { absolute, relative: local };
}

async function requiredJson<T>(
  rootDir: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const bounded = boundedPath(rootDir, path);
  try {
    return schema.parse(JSON.parse(await readFile(bounded.absolute, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FoundationDiagnosticError({
        code: 'E-SETUP-005',
        operation: 'setup.profile',
        message: 'A required local setup artifact is missing.',
        remediation: 'create-required-setup-artifact',
        path: bounded.relative,
      });
    }
    throw error;
  }
}

async function resolveCandidate(
  rootDir: string,
  configured: string | undefined,
  candidates: readonly string[],
): Promise<string> {
  if (configured) return boundedPath(rootDir, configured).relative;
  const found: string[] = [];
  for (const candidate of candidates) {
    const bounded = boundedPath(rootDir, candidate);
    if (await exists(bounded.absolute)) found.push(bounded.relative);
  }
  if (found.length > 1) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-004',
      operation: 'setup.profile',
      message: 'Several local setup artifacts match the same purpose.',
      remediation: 'configure-canonical-artifact-path',
    });
  }
  return found[0] ?? boundedPath(rootDir, candidates[0]!).relative;
}

export async function detectSetupProfile(
  options: DetectSetupProfileOptions,
): Promise<SetupProfile> {
  const rootDir = resolve(options.rootDir);
  const packageJson = PackageSchema.parse(JSON.parse(
    await readFile(resolve(rootDir, 'package.json'), 'utf8'),
  ));
  const configured = packageJson.glirastes;
  const setupArtifactPath = await resolveCandidate(
    rootDir,
    options.artifactPath ?? configured?.setupArtifact,
    [
      '.glirastes/setup-artifact.json',
      '.glirastes/app-setup-artifact.json',
    ],
  );
  const inventoryPath = await resolveCandidate(
    rootDir,
    options.inventoryPath ?? configured?.inventory,
    [
      '.glirastes/foundation-execution-inventory.json',
      '.glirastes/local-execution-inventory.v2.json',
    ],
  );
  const promptBundlePath = await resolveCandidate(
    rootDir,
    options.promptBundlePath ?? configured?.promptBundle,
    ['.glirastes/prompt-bundle.json'],
  );

  const [setupArtifact, inventory, promptIdentity] = await Promise.all([
    requiredJson(rootDir, setupArtifactPath, AppSetupArtifactSchema),
    requiredJson(rootDir, inventoryPath, FoundationExecutionInventorySchema),
    requiredJson(rootDir, promptBundlePath, PromptIdentitySchema),
  ]);
  if (setupArtifact.appId !== promptIdentity.appId) {
    throw new FoundationDiagnosticError({
      code: 'E-SCOPE-002',
      operation: 'setup.profile',
      message: 'Local setup artifacts disagree on the application identity.',
      remediation: 'align-local-app-identity',
    });
  }

  const declaredDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  const authProviders = [...new Set(AUTH_MARKERS
    .filter(([dependency]) => dependency in declaredDependencies)
    .map(([, provider]) => provider))]
    .sort((left, right) => left.localeCompare(right));

  return {
    schemaVersion: 1,
    projectName: packageJson.name ?? null,
    framework: await detectStack(rootDir),
    authProviders,
    principal: configured?.principal ?? null,
    mode: options.managed ? 'managed' : 'standalone',
    appId: setupArtifact.appId,
    toolCount: inventory.executions.length,
    paths: {
      inventory: inventoryPath,
      setupArtifact: setupArtifactPath,
      canonicalSetupArtifact: '.glirastes/setup-artifact.json',
      previousSetupArtifact: '.glirastes/previous-setup-artifact.json',
      promptBundle: promptBundlePath,
      buildDir: '.glirastes/build',
      receipt: '.glirastes/setup-receipt.json',
    },
  };
}
