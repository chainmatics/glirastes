import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  AppSetupArtifactSchema,
  assertAppSetupSemanticParity,
  classifyToolSemanticChange,
  type AppSetupArtifact,
  type SemanticChange,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { detectSetupProfile } from './setup-profile.js';

export interface SetupPlanOperation {
  kind: 'validate' | 'adopt' | 'build' | 'receipt' | 'sync';
  path: string;
  digest: string;
}

export interface SetupPlan {
  schemaVersion: 1;
  mode: 'standalone' | 'managed';
  planDigest: string;
  operations: SetupPlanOperation[];
  counts: { tools: number; semanticChanges: number };
  semanticChanges: SemanticChange[];
  diagnostics: Array<{ code: string; operation: string }>;
  requiresConfirmation: boolean;
}

export interface CreateSetupPlanOptions {
  rootDir: string;
  artifactPath?: string;
  previousArtifactPath?: string;
  inventoryPath?: string;
  promptBundlePath?: string;
  managed?: boolean;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('base64url')}`;
}

function boundedPath(rootDir: string, path: string): {
  absolute: string;
  relative: string;
} {
  const absolute = resolve(rootDir, path);
  const local = relative(resolve(rootDir), absolute);
  if (
    local === ''
    || local.startsWith('..')
    || isAbsolute(local)
    || local.length > 2_048
  ) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-003',
      operation: 'setup.plan',
      message: 'A setup artifact path is outside the workspace.',
      remediation: 'choose-workspace-artifact-path',
    });
  }
  return { absolute, relative: local };
}

async function readArtifact(
  rootDir: string,
  path: string,
  required: boolean,
): Promise<{ artifact: AppSetupArtifact; path: string; digest: string } | undefined> {
  const bounded = boundedPath(rootDir, path);
  let raw: string;
  try {
    raw = await readFile(bounded.absolute, 'utf8');
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const artifact = AppSetupArtifactSchema.parse(JSON.parse(raw));
  return { artifact, path: bounded.relative, digest: sha256(raw) };
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

async function resolvePreviousArtifactPath(
  rootDir: string,
  proposedPath: string,
  canonicalPath: string,
  configuredPath: string | undefined,
  defaultPreviousPath: string,
): Promise<string | undefined> {
  if (configuredPath) return configuredPath;
  const previous = boundedPath(rootDir, defaultPreviousPath);
  if (await exists(previous.absolute)) return previous.relative;
  if (proposedPath === canonicalPath) return proposedPath;
  const canonical = boundedPath(rootDir, canonicalPath);
  if (await exists(canonical.absolute)) return canonical.relative;
  return undefined;
}

function compareArtifacts(
  previous: AppSetupArtifact | undefined,
  proposed: AppSetupArtifact,
): SemanticChange[] {
  if (!previous) {
    return proposed.tools.map((tool) => ({
      toolId: tool.toolId,
      classification: 'loosening' as const,
      fields: ['toolId'],
      requiresConfirmation: true,
    }));
  }
  const proposedById = new Map(proposed.tools.map((tool) => [tool.toolId, tool]));
  const previousById = new Map(previous.tools.map((tool) => [tool.toolId, tool]));
  const changes: SemanticChange[] = [];
  for (const tool of proposed.tools) {
    const before = previousById.get(tool.toolId);
    changes.push(before
      ? classifyToolSemanticChange(before, tool)
      : {
        toolId: tool.toolId,
        classification: 'loosening',
        fields: ['toolId'],
        requiresConfirmation: true,
      });
  }
  for (const tool of previous.tools) {
    if (!proposedById.has(tool.toolId)) {
      changes.push({
        toolId: tool.toolId,
        classification: 'hardening',
        fields: ['toolId'],
        requiresConfirmation: false,
      });
    }
  }
  return changes.sort((left, right) => left.toolId.localeCompare(right.toolId));
}

export async function createSetupPlan(
  options: CreateSetupPlanOptions,
): Promise<SetupPlan> {
  const profile = await detectSetupProfile({
    rootDir: options.rootDir,
    managed: options.managed,
    artifactPath: options.artifactPath,
    inventoryPath: options.inventoryPath,
    promptBundlePath: options.promptBundlePath,
  });
  const proposed = await readArtifact(
    options.rootDir,
    profile.paths.setupArtifact,
    true,
  );
  if (!proposed) throw new Error('unreachable');
  const previousPath = await resolvePreviousArtifactPath(
    options.rootDir,
    proposed.path,
    profile.paths.canonicalSetupArtifact,
    options.previousArtifactPath,
    profile.paths.previousSetupArtifact,
  );
  const previous = await readArtifact(
    options.rootDir,
    previousPath ?? profile.paths.previousSetupArtifact,
    false,
  );
  assertAppSetupSemanticParity(
    proposed.artifact,
    proposed.artifact.tools.map((tool) => tool.name),
  );
  if (previous) {
    assertAppSetupSemanticParity(
      previous.artifact,
      previous.artifact.tools.map((tool) => tool.name),
    );
  }
  const semanticChanges = compareArtifacts(
    previous?.artifact,
    proposed.artifact,
  );
  const body = {
    schemaVersion: 1 as const,
    mode: profile.mode,
    operations: [
      { kind: 'validate' as const, path: proposed.path, digest: proposed.digest },
      {
        kind: 'adopt' as const,
        path: profile.paths.canonicalSetupArtifact,
        digest: proposed.digest,
      },
      {
        kind: 'build' as const,
        path: profile.paths.buildDir,
        digest: proposed.digest,
      },
      {
        kind: 'receipt' as const,
        path: profile.paths.receipt,
        digest: proposed.digest,
      },
      ...(profile.mode === 'managed' ? [{
        kind: 'sync' as const,
        path: proposed.path,
        digest: proposed.digest,
      }] : []),
    ],
    counts: {
      tools: proposed.artifact.tools.length,
      semanticChanges: semanticChanges.length,
    },
    semanticChanges,
    diagnostics: [] as Array<{ code: string; operation: string }>,
    requiresConfirmation: semanticChanges.some(
      (change) => change.requiresConfirmation,
    ),
  };
  return {
    ...body,
    planDigest: sha256(JSON.stringify(body)),
  };
}

export function assertSetupPlanConfirmation(
  plan: SetupPlan,
  confirmation: { confirmLoosening?: boolean; planDigest?: string },
): void {
  if (!plan.requiresConfirmation) return;
  if (
    !confirmation.confirmLoosening
    || confirmation.planDigest !== plan.planDigest
  ) {
    throw new FoundationDiagnosticError({
      code: 'E-SEMANTICS-004',
      operation: 'setup.plan-confirmation',
      message: 'A semantic loosening requires confirmation of this exact plan.',
      remediation: 'confirm-plan-digest',
      identifier: plan.planDigest,
    });
  }
}
