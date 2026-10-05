import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';

/** Every file the tools generator reads (inputs) or owns (outputs), app-relative. */
export const TOOLS_PATHS = {
  config: '.glirastes/tools.json',
  policy: '.glirastes/tool-policy.json',
  resolutions: '.glirastes/tool-resolutions.json',
  semantics: '.glirastes/tool-semantics.json',
  promptBundle: '.glirastes/prompt-bundle.json',
  inventory: '.glirastes/foundation-execution-inventory.json',
  tombstones: '.glirastes/tool-tombstones.json',
  contracts: '.glirastes/tool-contracts.json',
  report: '.glirastes/tool-report.json',
  setupArtifact: '.glirastes/setup-artifact.json',
  previousSetupArtifact: '.glirastes/previous-setup-artifact.json',
  runtimeManifest: '.glirastes/build/runtime-manifest.json',
  promptManifest: '.glirastes/build/prompt-manifest.json',
  receipt: '.glirastes/setup-receipt.json',
} as const;

export const DEFAULT_GENERATED_MODULE = 'src/generated/glirastes/tools.generated.ts';

function insideApp(value: string): boolean {
  return !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.split(/[\\/]/).includes('..');
}

const appPath = z.string().trim().min(1).max(512)
  .refine(insideApp, 'Path must stay inside the app');
const modulePath = z.string().trim().min(1).max(512)
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app', 'next-pages']);

/** A folder name such as `[locale]`, never a path. */
const folderName = z.string().trim().min(1).max(200)
  .refine((value) => !/[\\/]/.test(value), 'A folder name, not a path');

const SourceSchema = z.union([
  ToolSourceKindSchema,
  z.object({ kind: z.literal('next-app'), apiDir: appPath.optional() }).strict(),
  z.object({
    kind: z.literal('next-pages'),
    appDir: appPath.optional(),
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
]);

/** Sources that each produce app-wide UI tools; a second copy would duplicate them. */
const SINGLETON_SOURCES: ReadonlyArray<string> = ['next-pages'];

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  targetAppKey: z.string().trim().min(1).max(200),
  locale: z.string().trim().min(2).max(35)
    .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/),
  sources: z.array(SourceSchema).min(1).max(20),
  emit: z.object({
    module: modulePath.optional(),
    /** Accepted now; emitted by the MCP catalogue work in P11. */
    mcpCatalog: z.boolean().optional(),
  }).strict().default({}),
  /** Accepted now; consumed by the agentic plans P05 and P10. */
  enrich: z.object({
    managed: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    writeContracts: z.boolean().optional(),
  }).strict().default({}),
  ci: z.object({
    strict: z.boolean().optional(),
    /** Accepted now; enforced by P05. */
    requireEnrichment: z.boolean().optional(),
  }).strict().default({}),
}).strict().superRefine((config, context) => {
  const kinds = config.sources.map((source) => (typeof source === 'string' ? source : source.kind));
  for (const kind of SINGLETON_SOURCES) {
    if (kinds.filter((candidate) => candidate === kind).length > 1) {
      context.addIssue({ code: 'custom', path: ['sources'], message: `The ${kind} source may appear only once` });
    }
  }
  const sensitive = findSensitiveStringPath(config);
  if (sensitive) {
    context.addIssue({
      code: 'custom',
      path: sensitive,
      message: 'tools.json must never contain a key or secret',
    });
  }
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ToolSourceConfig =
  | { kind: 'next-app'; apiDir?: string }
  | { kind: 'next-pages'; appDir?: string; srcDir?: string; stripSegments?: string[] };

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-TOOLS-002',
    operation: 'tools.config',
    message: 'The Glirastes tools configuration is invalid.',
    remediation: 'repair-tools-config',
    path: TOOLS_PATHS.config,
  });
}

export function loadToolsConfig(root: string): ToolsConfig {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, TOOLS_PATHS.config), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FoundationDiagnosticError({
        code: 'E-TOOLS-001',
        operation: 'tools.config',
        message: 'Glirastes tools are not configured for this app.',
        remediation: 'create-tools-config',
        path: TOOLS_PATHS.config,
      });
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalidConfig();
  }
  const parsed = ToolsConfigSchema.safeParse(json);
  if (!parsed.success) throw invalidConfig();
  return parsed.data;
}

export function normalizeSources(config: ToolsConfig): ToolSourceConfig[] {
  return config.sources.map((source) => (
    typeof source === 'string' ? { kind: source } : { ...source }
  ));
}

export function generatedModulePath(config: ToolsConfig): string {
  return config.emit.module ?? DEFAULT_GENERATED_MODULE;
}
