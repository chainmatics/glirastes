import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  writeArtifactSetAtomically,
  type AtomicArtifactWriteHooks,
  type ArtifactWrite,
} from './atomic-artifact-write.js';
import { renderManifests } from './validate-build.js';
import { detectSetupProfile } from './setup-profile.js';
import { createSetupPlan, type SetupPlan } from './setup-plan.js';

export interface ApplySetupPlanOptions {
  rootDir: string;
  plan: SetupPlan;
  hooks?: AtomicArtifactWriteHooks;
}

export interface AppliedSetupPlan {
  planDigest: string;
  mode: 'standalone' | 'managed';
  appId: string;
  toolCount: number;
  runtimeDigest: string;
  promptDigest: string;
  restartRequired: true;
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

function digestOf(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('base64url')}`;
}

export async function applySetupPlan(
  options: ApplySetupPlanOptions,
): Promise<AppliedSetupPlan> {
  const rootDir = resolve(options.rootDir);
  const profile = await detectSetupProfile({
    rootDir,
    managed: options.plan.mode === 'managed',
  });
  const currentPlan = await createSetupPlan({
    rootDir,
    managed: options.plan.mode === 'managed',
  });
  if (currentPlan.planDigest !== options.plan.planDigest) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-006',
      operation: 'setup.apply',
      message: 'The local setup plan changed before it could be applied.',
      remediation: 'rerun-setup-dry-run',
    });
  }

  const proposedPath = resolve(rootDir, profile.paths.setupArtifact);
  const proposedContent = await readFile(proposedPath, 'utf8');
  const adopt = options.plan.operations.find(({ kind }) => kind === 'adopt');
  if (!adopt || adopt.digest !== digestOf(proposedContent)) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-006',
      operation: 'setup.apply',
      message: 'The proposed setup artifact no longer matches the plan.',
      remediation: 'rerun-setup-dry-run',
    });
  }

  const rendered = await renderManifests({
    rootDir,
    appId: profile.appId,
    inventoryPath: profile.paths.inventory,
    promptBundlePath: profile.paths.promptBundle,
    setupArtifactPath: profile.paths.setupArtifact,
  });
  const canonicalPath = resolve(rootDir, profile.paths.canonicalSetupArtifact);
  const writes: ArtifactWrite[] = [];
  if (await exists(canonicalPath)) {
    writes.push({
      path: resolve(rootDir, profile.paths.previousSetupArtifact),
      content: await readFile(canonicalPath),
    });
  }
  writes.push(
    { path: canonicalPath, content: proposedContent },
    {
      path: resolve(rootDir, profile.paths.buildDir, 'runtime-manifest.json'),
      content: rendered.runtimeContent,
    },
    {
      path: resolve(rootDir, profile.paths.buildDir, 'prompt-manifest.json'),
      content: rendered.promptContent,
    },
  );
  const result: AppliedSetupPlan = {
    planDigest: options.plan.planDigest,
    mode: profile.mode,
    appId: profile.appId,
    toolCount: profile.toolCount,
    runtimeDigest: rendered.runtimeDigest,
    promptDigest: rendered.promptDigest,
    restartRequired: true,
  };
  writes.push({
    path: resolve(rootDir, profile.paths.receipt),
    content: `${JSON.stringify({ schemaVersion: 1, ...result }, null, 2)}\n`,
  });

  for (const directory of new Set(writes.map(({ path }) => dirname(path)))) {
    await mkdir(directory, { recursive: true });
  }
  await writeArtifactSetAtomically(writes, options.hooks);
  return result;
}
