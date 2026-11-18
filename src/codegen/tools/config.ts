import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { LANGUAGE_TAG_PATTERN, MAX_TEXT_LANGUAGES } from '../../contracts/localized-text.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { MAX_OUTPUT_FIELDS, normalizeOutputFields, parseAnyDepthKey } from '../../server/core/output-fields.js';

/** Every file the tools generator reads (inputs) or owns (outputs), app-relative. */
export const TOOLS_PATHS = {
  config: '.glirastes/tools.json',
  policy: '.glirastes/tool-policy.json',
  resolutions: '.glirastes/tool-resolutions.json',
  semantics: '.glirastes/tool-semantics.json',
  promptBundle: '.glirastes/prompt-bundle.json',
  /** MCP only: the names and grant ids an app's MCP server keeps (spec 5.2). */
  mcpToolNames: '.glirastes/mcp-tool-names.json',
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

const APP_DENIED_MESSAGE = 'output.deniedFields takes only any-depth patterns such as "**.fileUrl" (at most 200, one field name after "**.", no whitespace); an exact path belongs to one tool';

function insideApp(value: string): boolean {
  return !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.split(/[\\/]/).includes('..');
}

const appPath = z.string().trim().min(1).max(512)
  .refine(insideApp, 'Path must stay inside the app');
/**
 * The tsconfig of a source's files, app-relative. Optional: by default the
 * nearest tsconfig.json from the scanned folder up to the app root is used.
 */
const tsconfigPath = appPath.regex(/\.json$/, 'The tsconfig must be a .json file');
const modulePath = z.string().trim().min(1).max(512)
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum([
  'next-app', 'nest', 'openapi', 'next-pages', 'react-router', 'vue-router', 'url-filters', 'react-actions',
]);

/** A folder name such as `[locale]`, never a path. */
const folderName = z.string().trim().min(1).max(200)
  .refine((value) => !/[\\/]/.test(value), 'A folder name, not a path');

const SourceSchema = z.union([
  ToolSourceKindSchema,
  z.object({ kind: z.literal('next-app'), apiDir: appPath.optional(), tsconfig: tsconfigPath.optional() }).strict(),
  z.object({ kind: z.literal('nest'), srcDir: appPath.optional(), tsconfig: tsconfigPath.optional() }).strict(),
  z.object({
    kind: z.literal('openapi'),
    /** The exported OpenAPI 3.0 or 3.1 JSON document, app-relative; `openapi.json` by default. */
    document: appPath.regex(/\.json$/, 'The OpenAPI document must be a .json export').optional(),
    /** The folder of the FastAPI code; its routes are counted against the export. */
    fastapi: appPath.optional(),
    /**
     * `all` (the default): every supported operation becomes a tool unless it is
     * excluded. `opt-in`: only operations marked `x-glirastes-tool: true` do.
     */
    selection: z.enum(['all', 'opt-in']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('next-pages'),
    appDir: appPath.optional(),
    srcDir: appPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
  z.object({
    kind: z.literal('url-filters'),
    appDir: appPath.optional(),
    srcDir: appPath.optional(),
    tsconfig: tsconfigPath.optional(),
    stripSegments: z.array(folderName).max(20).optional(),
  }).strict(),
  z.object({ kind: z.literal('react-router'), srcDir: appPath.optional(), tsconfig: tsconfigPath.optional() }).strict(),
  z.object({ kind: z.literal('vue-router'), srcDir: appPath.optional(), tsconfig: tsconfigPath.optional() }).strict(),
  z.object({ kind: z.literal('react-actions'), srcDir: appPath.optional(), tsconfig: tsconfigPath.optional() }).strict(),
]);

/** Sources that each produce app-wide UI tools; a second copy would duplicate them. */
const SINGLETON_SOURCES: ReadonlyArray<string> = ['next-pages', 'react-router', 'vue-router', 'url-filters', 'react-actions'];
/** Page sources each own the one `ui.navigate` tool and the pages URL filters attach to. */
const PAGE_SOURCES: ReadonlyArray<string> = ['next-pages', 'react-router', 'vue-router'];

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  targetAppKey: z.string().trim().min(1).max(200),
  locale: z.string().trim().min(2).max(35)
    .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/),
  /**
   * The languages of the app's UI as BCP-47 tags (e.g. `["en", "de", "pl"]`).
   * Optional; with it, every tool gets its chat labels per language (from
   * its presentation, else its title, else the English or German template)
   * in the generated module, `describe` asks for texts in these languages,
   * and a language without an own label is reported. Local only: the setup
   * artifact keeps one presentation in `locale`.
   */
  languages: z.array(z.string().regex(LANGUAGE_TAG_PATTERN).max(35)).min(1).max(MAX_TEXT_LANGUAGES)
    .refine((tags) => new Set(tags.map((tag) => tag.toLowerCase())).size === tags.length, { message: 'Each language once' })
    .optional(),
  sources: z.array(SourceSchema).min(1).max(20),
  emit: z.object({
    module: modulePath.optional(),
    /** Also emit `createMcpEndpointCatalog()` for the app's MCP server (names from mcp-tool-names.json). */
    mcpCatalog: z.boolean().optional(),
    /**
     * How the app resolves the imports of a generated `.ts` module: `bundler`
     * (the default) leaves the extension off, `nodenext` writes the runtime
     * extension (`./schemas.js` for `schemas.ts`), as TypeScript's
     * `moduleResolution: NodeNext` and Node's ESM loader require.
     */
    moduleResolution: z.enum(['bundler', 'nodenext']).optional(),
  }).strict().default({}),
  /** Accepted now; consumed by the agentic plans P05 and P10. */
  enrich: z.object({
    managed: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    writeContracts: z.boolean().optional(),
    /** The environment chain, lowest first (e.g. `["dev", "staging", "main"]`); a promotion between them is never enriched. */
    environments: z.array(z.string().regex(/^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/)).max(20).optional(),
  }).strict().default({}),
  ci: z.object({
    strict: z.boolean().optional(),
    /** `tools check` fails while an enabled tool has only a template description or field names. */
    requireEnrichment: z.boolean().optional(),
  }).strict().default({}),
  /**
   * Local CLI settings of `glirastes connect`, `sync` and `doctor`; never part
   * of a generated artifact. `envFile`: the app-relative, Git-ignored file
   * that holds `GLIRASTES_API_KEY` (e.g. `apps/backend/.env`); `--dotenv`
   * wins. Without it Next.js uses `.env.local` and other stacks the process
   * environment. Only shape-checked here: `connect`, `sync` and `doctor`
   * validate the path itself (inside the project, Git-ignored) and report
   * `E-CONNECT-PATH-OUTSIDE` and friends, so a wrong path never breaks the
   * tools commands.
   */
  connection: z.object({
    envFile: z.string().trim().min(1).max(512).optional(),
  }).strict().optional(),
  /**
   * Output fields for every generated endpoint tool. `deniedFields`: only
   * any-depth patterns `**.<key>` (e.g. `**.fileUrl`), joined with each
   * tool's own `outputDeniedFields`. Local: written into the generated tool
   * contracts, never sent to the Platform. Not for hand-written tools.
   */
  /**
   * App-wide object identity: `entities` by type (`{ "channel": { "id":
   * "key", "name": "title", "idKind": "speaking" } }`, applied to the
   * response schemas of that type, else to the read routes of that
   * resource), `tools` by definition id or model name (`{ output, input }`
   * lists as `outputEntities` / `inputEntities`). The lowest level: code,
   * OpenAPI operation and schema win. Entries are checked by the refresh
   * (a finding, never a failure). Local only, never sent to the Platform.
   */
  identity: z.object({
    entities: z.record(z.string().min(1).max(64), z.unknown()).optional(),
    tools: z.record(z.string().min(1).max(200), z.object({
      output: z.array(z.unknown()).max(20).optional(),
      input: z.array(z.unknown()).max(20).optional(),
    }).strict()).optional(),
  }).strict().optional(),
  output: z.object({
    deniedFields: z.array(z.string()).max(MAX_OUTPUT_FIELDS)
      .refine((paths) => paths.every((path) => parseAnyDepthKey(path) !== undefined)
        && normalizeOutputFields(paths, 'outputDeniedFields') !== undefined, { message: APP_DENIED_MESSAGE }),
  }).strict().optional(),
}).strict().superRefine((config, context) => {
  const kinds = config.sources.map((source) => (typeof source === 'string' ? source : source.kind));
  for (const kind of SINGLETON_SOURCES) {
    if (kinds.filter((candidate) => candidate === kind).length > 1) {
      context.addIssue({ code: 'custom', path: ['sources'], message: `The ${kind} source may appear only once` });
    }
  }
  if (PAGE_SOURCES.filter((kind) => (kinds as ReadonlyArray<string>).includes(kind)).length > 1) {
    context.addIssue({ code: 'custom', path: ['sources'], message: `Use one page source: ${PAGE_SOURCES.join(' or ')}` });
  }
  if (config.emit.moduleResolution === 'nodenext' && !(config.emit.module ?? DEFAULT_GENERATED_MODULE).endsWith('.ts')) {
    context.addIssue({
      code: 'custom',
      path: ['emit', 'moduleResolution'],
      message: 'emit.moduleResolution applies to a .ts module; a JavaScript module keeps its import extensions',
    });
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
  | { kind: 'next-app'; apiDir?: string; tsconfig?: string }
  | { kind: 'nest'; srcDir?: string; tsconfig?: string }
  | { kind: 'openapi'; document?: string; fastapi?: string; selection?: 'all' | 'opt-in' }
  | { kind: 'next-pages'; appDir?: string; srcDir?: string; stripSegments?: string[] }
  | { kind: 'url-filters'; appDir?: string; srcDir?: string; stripSegments?: string[]; tsconfig?: string }
  | { kind: 'react-router' | 'vue-router' | 'react-actions'; srcDir?: string; tsconfig?: string };

function invalidConfig(detail?: string): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-TOOLS-002',
    operation: 'tools.config',
    message: detail ? `The Glirastes tools configuration is invalid: ${detail}.` : 'The Glirastes tools configuration is invalid.',
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
  if (!parsed.success) {
    // An app-wide deny-list that cannot be read fails closed: no tools are generated without it.
    if (parsed.error.issues.some((issue) => issue.path[0] === 'output')) throw invalidConfig(APP_DENIED_MESSAGE);
    throw invalidConfig();
  }
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
