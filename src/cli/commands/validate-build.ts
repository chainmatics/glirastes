import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { findForbiddenPlatformContentPath } from '../../contracts/content-boundary.js';
import {
  FoundationExecutionInventorySchema,
  discoverFoundationExecutions,
} from '../../codegen/execution-inventory.js';

const identifier = z.string().trim().min(1).max(200);

const LocalPromptBundleSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  artifactRef: z.string().trim().min(1).max(2_048),
  sections: z.object({
    planner: z.string().trim().min(1).max(100_000),
    appBehavior: z.string().trim().min(1).max(100_000),
    responseStyle: z.string().trim().min(1).max(100_000),
    capabilityFragments: z.record(identifier, z.string().trim().min(1))
      .default({}),
  }).strict(),
}).strict();

export type LocalPromptBundle = z.infer<typeof LocalPromptBundleSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(canonicalValue(value)))
    .digest('base64url')}`;
}

export interface ValidatedWorkspace {
  appId: string;
  inventory: z.infer<typeof FoundationExecutionInventorySchema>;
  executions: Awaited<
    ReturnType<typeof discoverFoundationExecutions>
  >['executions'];
  inventoryDigest: string;
  promptBundle: LocalPromptBundle;
}

/**
 * Local-only validation. It reads the inventory, verifies every execution
 * against its real source, checks app identity and local artifact references,
 * and enforces the content boundary. It performs no network access at all.
 */
export async function validateWorkspace(options: {
  rootDir: string;
  appId: string;
  inventoryPath?: string;
  promptBundlePath?: string;
}): Promise<ValidatedWorkspace> {
  const inventoryPath = resolve(
    options.rootDir,
    options.inventoryPath ?? '.glirastes/foundation-execution-inventory.json',
  );
  const inventory = FoundationExecutionInventorySchema.parse(
    JSON.parse(readFileSync(inventoryPath, 'utf8')),
  );
  const discovery = await discoverFoundationExecutions({
    rootDir: options.rootDir,
    inventory,
  });

  const promptBundlePath = resolve(
    options.rootDir,
    options.promptBundlePath ?? '.glirastes/prompt-bundle.json',
  );
  const promptBundle = LocalPromptBundleSchema.parse(
    JSON.parse(readFileSync(promptBundlePath, 'utf8')),
  );
  if (promptBundle.appId !== options.appId) {
    throw new Error('Local prompt bundle targets a different app');
  }

  const forbidden = findForbiddenPlatformContentPath({
    sections: promptBundle.sections,
  });
  if (forbidden) {
    throw new Error(
      `Prompt bundle violates the content boundary at ${forbidden.join('.')}`,
    );
  }

  return {
    appId: options.appId,
    inventory,
    executions: discovery.executions,
    inventoryDigest: discovery.inventoryDigest,
    promptBundle,
  };
}

export interface BuiltManifests {
  runtimeManifestPath: string;
  promptManifestPath: string;
  runtimeDigest: string;
  promptDigest: string;
}

/**
 * Emits content-addressed runtime and prompt manifests. Manifests carry
 * identities and digests only: never prompt text, source, schemas, or secrets.
 * Building never publishes and never deploys.
 */
export async function buildManifests(options: {
  rootDir: string;
  appId: string;
  outputDir?: string;
  inventoryPath?: string;
  promptBundlePath?: string;
}): Promise<BuiltManifests> {
  const workspace = await validateWorkspace(options);
  const outputDir = resolve(
    options.rootDir,
    options.outputDir ?? '.glirastes/build',
  );

  const executions = [...workspace.executions]
    .map((execution) => ({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      executionKind: execution.executionKind,
      sourceFingerprint: execution.sourceFingerprint,
      inputSchemaDigest: execution.inputSchemaDigest,
      outputSchemaDigest: execution.outputSchemaDigest,
    }))
    .sort((left, right) => left.toolId.localeCompare(right.toolId));
  const runtimeBody = {
    schemaVersion: 1 as const,
    appId: workspace.appId,
    targetAppKey: workspace.inventory.targetAppKey,
    inventoryDigest: workspace.inventoryDigest,
    executions,
  };
  const runtimeManifest = {
    ...runtimeBody,
    runtimeDigest: digestOf(runtimeBody),
  };

  const { sections } = workspace.promptBundle;
  const groupDigests: Record<string, string> = {
    planner: digestOf(sections.planner),
    appBehavior: digestOf(sections.appBehavior),
    responseStyle: digestOf(sections.responseStyle),
    ...Object.fromEntries(
      Object.entries(sections.capabilityFragments)
        .map(([name, content]) => [name, digestOf(content)]),
    ),
  };
  const promptBody = {
    schemaVersion: 1 as const,
    appId: workspace.appId,
    artifactRef: workspace.promptBundle.artifactRef,
    groupDigests,
  };
  const promptManifest = {
    ...promptBody,
    promptDigest: digestOf(promptBody),
  };

  const runtimeManifestPath = resolve(outputDir, 'runtime-manifest.json');
  const promptManifestPath = resolve(outputDir, 'prompt-manifest.json');
  mkdirSync(dirname(runtimeManifestPath), { recursive: true });
  writeFileSync(
    runtimeManifestPath,
    `${JSON.stringify(canonicalValue(runtimeManifest), null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    promptManifestPath,
    `${JSON.stringify(canonicalValue(promptManifest), null, 2)}\n`,
    'utf8',
  );

  return {
    runtimeManifestPath,
    promptManifestPath,
    runtimeDigest: runtimeManifest.runtimeDigest,
    promptDigest: promptManifest.promptDigest,
  };
}
