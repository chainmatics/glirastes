import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  AppSetupArtifactSchema,
  assertAppSetupSemanticParity,
  classifyToolSemanticChange,
  deriveToolPolicyDefaults,
  riskTier,
  type AppSetupArtifact,
  type AppSetupToolCandidate,
  type SemanticChange,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { detectSetupProfile, type SetupProfile } from './setup-profile.js';

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

export interface SetupPlanContents {
  mode: 'standalone' | 'managed';
  paths: SetupProfile['paths'];
  proposed: { path: string; raw: string };
  /** Undefined when no previous artifact exists. */
  previousRaw?: string;
  inventoryRaw: string;
  promptBundleRaw: string;
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

async function readRaw(
  rootDir: string,
  path: string,
  required: boolean,
): Promise<{ raw: string; path: string } | undefined> {
  const bounded = boundedPath(rootDir, path);
  try {
    return { raw: await readFile(bounded.absolute, 'utf8'), path: bounded.relative };
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
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

/**
 * A tool that is new in the proposal needs no confirmation when its policy is
 * at least as strict as the deterministic defaults for its route. Only a
 * committed relaxation below those defaults stays a confirmable loosening.
 */
function classifyNewTool(tool: AppSetupToolCandidate): SemanticChange {
  const defaults = deriveToolPolicyDefaults({
    executionKind: tool.executionKind,
    ...(tool.method ? { method: tool.method } : {}),
    ...(tool.path ? { path: tool.path } : {}),
    definitionId: tool.name,
  });
  const relaxedFields: string[] = [];
  if (riskTier(tool.riskClass) < riskTier(defaults.riskClass)) {
    relaxedFields.push('riskClass');
  }
  const approvalExpected = defaults.requiresApproval
    || riskTier(tool.riskClass) >= 2;
  if (approvalExpected && !tool.requiresApproval) {
    relaxedFields.push('requiresApproval');
  }
  if (relaxedFields.length === 0) {
    return {
      toolId: tool.toolId,
      classification: 'added',
      fields: ['toolId'],
      requiresConfirmation: false,
    };
  }
  return {
    toolId: tool.toolId,
    classification: 'loosening',
    fields: ['toolId', ...relaxedFields],
    requiresConfirmation: true,
  };
}

/** P02's classification, exported for the tools generator and the corpus tests. */
export function compareArtifacts(
  previous: AppSetupArtifact | undefined,
  proposed: AppSetupArtifact,
): SemanticChange[] {
  const previousTools = previous?.tools ?? [];
  const proposedById = new Map(proposed.tools.map((tool) => [tool.toolId, tool]));
  const previousById = new Map(previousTools.map((tool) => [tool.toolId, tool]));
  const changes: SemanticChange[] = proposed.tools.map((tool) => {
    const before = previousById.get(tool.toolId);
    return before
      ? classifyToolSemanticChange(before, tool)
      : classifyNewTool(tool);
  });
  for (const tool of previousTools) {
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

/** Pure plan core shared by file-based setup and the tools generator. */
export function createSetupPlanFromContents(input: SetupPlanContents): SetupPlan {
  const proposed = AppSetupArtifactSchema.parse(JSON.parse(input.proposed.raw));
  const previous = input.previousRaw === undefined
    ? undefined
    : AppSetupArtifactSchema.parse(JSON.parse(input.previousRaw));
  assertAppSetupSemanticParity(proposed, proposed.tools.map((tool) => tool.name));
  if (previous) {
    assertAppSetupSemanticParity(previous, previous.tools.map((tool) => tool.name));
  }
  const semanticChanges = compareArtifacts(previous, proposed);
  const proposedDigest = sha256(input.proposed.raw);
  const buildInputDigest = sha256(JSON.stringify({
    setup: proposedDigest,
    inventory: sha256(input.inventoryRaw),
    promptBundle: sha256(input.promptBundleRaw),
  }));
  const body = {
    schemaVersion: 1 as const,
    mode: input.mode,
    operations: [
      { kind: 'validate' as const, path: input.proposed.path, digest: proposedDigest },
      { kind: 'adopt' as const, path: input.paths.canonicalSetupArtifact, digest: proposedDigest },
      { kind: 'build' as const, path: input.paths.buildDir, digest: buildInputDigest },
      { kind: 'receipt' as const, path: input.paths.receipt, digest: proposedDigest },
      ...(input.mode === 'managed' ? [{
        kind: 'sync' as const,
        path: input.proposed.path,
        digest: proposedDigest,
      }] : []),
    ],
    counts: {
      tools: proposed.tools.length,
      semanticChanges: semanticChanges.length,
    },
    semanticChanges,
    diagnostics: [] as Array<{ code: string; operation: string }>,
    requiresConfirmation: semanticChanges.some((change) => change.requiresConfirmation),
  };
  return { ...body, planDigest: sha256(JSON.stringify(body)) };
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
  const proposed = await readRaw(options.rootDir, profile.paths.setupArtifact, true);
  if (!proposed) throw new Error('unreachable');
  const previousPath = await resolvePreviousArtifactPath(
    options.rootDir,
    proposed.path,
    profile.paths.canonicalSetupArtifact,
    options.previousArtifactPath,
    profile.paths.previousSetupArtifact,
  );
  const previous = await readRaw(
    options.rootDir,
    previousPath ?? profile.paths.previousSetupArtifact,
    false,
  );
  const inventory = await readRaw(options.rootDir, profile.paths.inventory, true);
  const promptBundle = await readRaw(options.rootDir, profile.paths.promptBundle, true);
  return createSetupPlanFromContents({
    mode: profile.mode,
    paths: profile.paths,
    proposed,
    ...(previous ? { previousRaw: previous.raw } : {}),
    inventoryRaw: inventory!.raw,
    promptBundleRaw: promptBundle!.raw,
  });
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
