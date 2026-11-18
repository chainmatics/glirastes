import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { z } from 'zod';
import { writeArtifactSetAtomically } from '../../cli/commands/atomic-artifact-write.js';
import { createSetupPlanFromContents } from '../../cli/commands/setup-plan.js';
import { renderManifestContents } from '../../cli/commands/validate-build.js';
import {
  AppSetupArtifactSchema,
  assertAppSetupSemanticParity,
  type AppSetupArtifact,
  type ToolRiskClass,
} from '../../contracts/index.js';
import {
  confirmationFloor,
  deriveToolPolicyDefaults,
  intersectAllowedRoles,
  resolveToolPolicy,
  riskTier,
  type EffectiveToolPolicy,
  type ToolPolicyDefaults,
  type ToolPolicyEntry,
} from '../../contracts/tool-policy.js';
import type { AppSetupToolProvenance } from '../../contracts/index.js';
import { FoundationDiagnosticError, isFoundationDiagnosticError } from '../../diagnostics/index.js';
import { modelFacingToolName } from '../../runtime/local-tool-bindings.js';
import {
  discoverFoundationExecutions,
  FoundationExecutionInventorySchema,
  type FoundationExecutionDiscovery,
  type FoundationExecutionInventory,
} from '../execution-inventory.js';
import { reconcileExecutionInventory, type ExecutionGenerationResult } from '../inventory-generation.js';
import {
  buildSetupArtifact,
  renderToolContracts,
  renderToolReport,
  schemaQualityOf,
  ToolReportFileSchema,
  type ArtifactToolInput,
  type SchemaQuality,
  type ToolReportTool,
} from './artifact.js';
import { compareCodeUnits } from './canonical.js';
import {
  generatedModulePath,
  loadToolsConfig,
  normalizeSources,
  TOOLS_PATHS,
  type ToolsConfig,
} from './config.js';
import { renderGeneratedModule } from './emit-module.js';
import { ToolContractsFileSchema, ToolTombstonesFileSchema, toToolContractsEntry } from './files.js';
import { sortFindings, toolFinding, TRANSIENT_FINDING_CODES } from './findings.js';
import { readPromptBundle, readToolInputs, type PromptBundleInput } from './inputs.js';
import { checkMcpNames } from './mcp-names.js';
import type { ToolsMode } from './mode.js';
import { lookupSemantics, resolveToolProse, type DescriptionOrigin, type ToolSemantics } from './prose.js';
import { resolutionOrigin } from './resolutions.js';
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import {
  requiredLanguages,
  semanticsFacts,
  semanticsSearch,
  semanticsTitle,
  validateSemanticsEntry,
  type SemanticsCheck,
  type SemanticsFacts,
  type ToolSemanticsEntry,
} from './semantics.js';
import { createNestEndpointSource } from './sources/nest-endpoints.js';
import { createOpenapiEndpointSource } from './sources/openapi-endpoints.js';
import { createReactRouterSource, createVueRouterSource } from './sources/route-config.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import { createNextPagesSource } from './sources/next-pages.js';
import { createReactActionSource } from './sources/react-actions.js';
import { createUrlFilterSource } from './sources/url-filters.js';
import {
  readPreviousToolState,
  renderInventory,
  renderTombstones,
  ToolStateError,
  type PreviousToolState,
} from './state.js';
import type {
  ExcludedTool,
  ObservedTool,
  ToolContract,
  ToolContractsEntry,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
} from './types.js';

/**
 * What the generator knows about one tool, in memory only: the work lists of
 * `tools resolve --print` and `tools describe --print` are built from it.
 */
export interface ToolsPipelineTool {
  toolId: string;
  stableKey: string;
  definitionId: string;
  modelName: string;
  executionKind: 'endpoint' | 'ui';
  /** `POST /api/tasks` or `UI tasks.highlight`. */
  route: string;
  files: string[];
  contract: ToolContract | null;
  interfaceDigest: string | null;
  params: ToolContract['params'] | null;
  defaults: ToolPolicyDefaults;
  enabled: boolean;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  /** `.glirastes/tool-policy.json` has an entry for this tool. */
  localPolicy: boolean;
  module: string;
  description: string;
  descriptionOrigin: DescriptionOrigin;
  schemaQuality: SchemaQuality;
  semantics: SemanticsFacts & { stale: boolean; rejected: boolean };
  findings: ToolFinding[];
}

export interface ToolsPipelineResult {
  mode: ToolsMode;
  changes: { added: string[]; changed: string[]; removed: string[]; unchanged: string[] };
  findings: ToolFinding[];
  excluded: Array<{ stableKey: string; reason: string; origin: string }>;
  outputs: Record<string, string>;
  driftPaths: string[];
  wrote: boolean;
  /** Every tool of the refreshed inventory; empty when the refresh stopped early or verified integrity. */
  tools?: ToolsPipelineTool[];
}

export interface ToolsPipelineOptions {
  root: string;
  mode: ToolsMode;
  keepGoing?: boolean;
  adoptInventoryPath?: string;
}

export interface ToolsPipelineDependencies {
  probe?: SchemaProbe;
  now?: () => Date;
  sources?: ReadonlyArray<ToolSource>;
}

export class ToolsPipelineFailure extends FoundationDiagnosticError {
  readonly result: ToolsPipelineResult;

  constructor(result: ToolsPipelineResult) {
    const first = result.findings.find((finding) => finding.severity === 'error');
    super({
      code: 'E-TOOLS-010',
      operation: `tools.${result.mode}`,
      message: 'Glirastes tools found errors; no outputs were written.',
      remediation: first?.nextAction ?? 'inspect-tool-findings',
      ...(first ? { identifier: first.code } : {}),
    });
    this.name = 'ToolsPipelineFailure';
    this.result = result;
  }
}

/**
 * One source per configured entry of `tools.json` `sources`. URL filters read
 * the same page tree as navigation, so they inherit its folder options.
 */
export function createConfiguredSources(config: ToolsConfig): ToolSource[] {
  const sources = normalizeSources(config);
  const pages = sources.find((source) => source.kind === 'next-pages');
  const routes = sources.find((source) => source.kind === 'react-router' || source.kind === 'vue-router');
  return sources.map((source) => {
    switch (source.kind) {
      case 'next-app':
        return createNextEndpointSource({
          ...(source.apiDir ? { apiDir: source.apiDir } : {}),
          ...(source.tsconfig ? { tsconfig: source.tsconfig } : {}),
        });
      case 'nest':
        return createNestEndpointSource({
          ...(source.srcDir ? { srcDir: source.srcDir } : {}),
          ...(source.tsconfig ? { tsconfig: source.tsconfig } : {}),
        });
      case 'openapi':
        return createOpenapiEndpointSource({
          ...(source.document ? { document: source.document } : {}),
          ...(source.fastapi ? { fastapi: source.fastapi } : {}),
          ...(source.selection ? { selection: source.selection } : {}),
        });
      case 'next-pages':
        return createNextPagesSource(source);
      case 'react-router':
        return createReactRouterSource(source);
      case 'vue-router':
        return createVueRouterSource(source);
      case 'url-filters':
        return createUrlFilterSource({
          ...(pages && pages.kind === 'next-pages' ? pages : {}),
          ...(routes && (routes.kind === 'react-router' || routes.kind === 'vue-router')
            ? {
              pages: routes.kind,
              ...(routes.srcDir ? { srcDir: routes.srcDir } : {}),
              ...(routes.tsconfig ? { tsconfig: routes.tsconfig } : {}),
            }
            : {}),
          ...source,
        });
      case 'react-actions':
        return createReactActionSource(source);
    }
  });
}

const SETUP_PATHS = {
  inventory: TOOLS_PATHS.inventory,
  setupArtifact: TOOLS_PATHS.setupArtifact,
  canonicalSetupArtifact: TOOLS_PATHS.setupArtifact,
  previousSetupArtifact: TOOLS_PATHS.previousSetupArtifact,
  promptBundle: TOOLS_PATHS.promptBundle,
  buildDir: '.glirastes/build',
  receipt: TOOLS_PATHS.receipt,
};

function emptyChanges(): ToolsPipelineResult['changes'] {
  return { added: [], changed: [], removed: [], unchanged: [] };
}

/**
 * An app-wide pattern (`output.deniedFields` of tools.json) whose key no
 * endpoint tool's declared output schema names: probably misspelt. One
 * warning per pattern, on tools.json; a pattern one tool lacks is no finding.
 */
function unmatchedAppDeniedFindings(patterns: ReadonlyArray<string>, tools: ReadonlyArray<ObservedTool>): ToolFinding[] {
  const endpoints = tools.filter((tool) => tool.execution.executionKind === 'endpoint');
  return patterns.filter((path) => !endpoints.some((tool) => tool.appDeniedHits?.includes(path))).map((path) => {
    const key = path.slice(3).toLowerCase();
    const near = [...new Set(endpoints.flatMap((tool) => tool.appDeniedNearKeys ?? []))]
      .filter((candidate) => candidate.toLowerCase() === key).sort(compareCodeUnits);
    return toolFinding('output-denied-key-unmatched', 'warning', TOOLS_PATHS.config,
      `${TOOLS_PATHS.config} output.deniedFields has ${path}, whose key is not found in the declared response schema of any tool`
      + (near.length > 0 ? ` (the schemas have ${near.join(', ')}; names match exactly, case included)` : '')
      + '; if the field only occurs in undeclared parts, ignore this. A misspelt pattern excludes nothing.');
  });
}

function isError(finding: ToolFinding): boolean {
  return finding.severity === 'error';
}

/**
 * Error findings that fail the run (exit 1, unless --keep-going) but still let
 * every other tool be generated and written: the one affected route has no
 * enabled tool, nothing else depends on it.
 */
const NON_BLOCKING_ERROR_CODES: ReadonlySet<string> = new Set(['route-declared-twice']);

function isBlocking(finding: ToolFinding): boolean {
  return isError(finding) && !NON_BLOCKING_ERROR_CODES.has(finding.code);
}

function sortExcluded(excluded: ReadonlyArray<ExcludedTool>): ExcludedTool[] {
  return [...excluded].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
}

type PolicyField = keyof EffectiveToolPolicy['origin'];
const POLICY_FIELDS: ReadonlyArray<PolicyField> = ['enabled', 'requiresApproval', 'riskClass', 'allowedRoles', 'description'];

/**
 * A local report knows code defaults and local policy only, never a Platform
 * origin. An explicit `requiresApproval: true` in tool-policy.json is a local
 * lock even where the code default asks anyway: the report names it
 * `local-policy`, so the Platform can tell a lock from a default and never
 * offers to relax it (D16); the runtime keeps it either way.
 */
function localPolicyOrigin(
  origin: EffectiveToolPolicy['origin'],
  local: ToolPolicyEntry | undefined,
): NonNullable<AppSetupToolProvenance['policyOrigin']> {
  const reported: NonNullable<AppSetupToolProvenance['policyOrigin']> = {};
  for (const field of POLICY_FIELDS) {
    const value = origin[field];
    if (value === 'code-default' || value === 'local-policy') reported[field] = value;
  }
  if (local?.requiresApproval === true) reported.requiresApproval = 'local-policy';
  return reported;
}

/**
 * tool-semantics.json entries no tool used: their stableKey or name matches no
 * tool, so their title, usage hints, synonyms, examples and presentation are
 * dropped. An entry for an excluded operation is not reported. Names the key,
 * never the entry's text; for a stableKey the name the operation had before,
 * when a current tool holds that name.
 */
function orphanedSemanticsFindings(
  semantics: ToolSemantics,
  used: ReadonlySet<ToolSemanticsEntry>,
  excluded: ReadonlyMap<string, ExcludedTool>,
  previous: PreviousToolState['state'],
  executions: ReadonlyArray<{ stableKey: string; definitionId: string }>,
): ToolFinding[] {
  const earlierName = new Map([...previous?.tombstones ?? [], ...previous?.inventory.executions ?? []]
    .map((entry) => [entry.stableKey, entry.definitionId] as const));
  const keyByName = new Map(executions.map((execution) => [execution.definitionId, execution.stableKey] as const));
  const findings: ToolFinding[] = [];
  for (const entry of new Set([...semantics.byStableKey.values(), ...semantics.byName.values()])) {
    if (used.has(entry) || (entry.stableKey !== undefined && excluded.has(entry.stableKey))) continue;
    if (entry.stableKey !== undefined) {
      const name = earlierName.get(entry.stableKey);
      const now = name === undefined ? undefined : keyByName.get(name);
      findings.push(toolFinding('semantics-entry-orphaned', 'warning', entry.stableKey,
        `The tool-semantics.json entry with stableKey "${entry.stableKey}" matches no tool, so its texts are not used.`
        + (now ? ` The tool named ${name} is now "${now}".` : '')));
    } else {
      findings.push(toolFinding('semantics-entry-orphaned', 'warning', `${TOOLS_PATHS.semantics}#${entry.name!}`,
        `The tool-semantics.json entry with name "${entry.name!}" matches no tool, so its texts are not used.`));
    }
  }
  return findings;
}

function policyWarningMessage(code: string, field: string | undefined): string {
  switch (code) {
    case 'override-lapsed-risk-raised':
      return 'A relaxation in tool-policy.json no longer applies because the risk was raised.';
    case 'risk-lower-available':
      return 'The code now implies a lower risk; the previous risk is kept until it is accepted.';
    case 'policy-entry-orphaned':
      return 'The tool-policy.json entry belongs to an earlier identity of this tool.';
    default:
      return field ? `Policy warning for ${field}.` : 'Policy warning.';
  }
}

/**
 * Roles the code declares (OpenAPI `x-glirastes-roles`) as the code default
 * of `allowedRoles`. Applied after the shared `resolveToolPolicy`, whose
 * inputs and vectors stay unchanged: the result is the intersection of the
 * code roles with what tool-policy.json resolved, where an empty side means
 * no restriction. Local policy therefore only narrows the code roles, and a
 * disjoint intersection means nobody: the tool is disabled. The Platform
 * overlay intersects again at runtime and can only narrow further.
 */
export function applyCodeRoles(
  effective: EffectiveToolPolicy,
  codeRoles: ReadonlyArray<string> | undefined,
): EffectiveToolPolicy {
  if (!codeRoles || codeRoles.length === 0) return effective;
  const narrowed = intersectAllowedRoles(codeRoles, effective.allowedRoles);
  if (narrowed.disjoint) {
    return {
      ...effective,
      enabled: false,
      allowedRoles: [],
      origin: {
        ...effective.origin,
        enabled: effective.enabled ? effective.origin.allowedRoles : effective.origin.enabled,
      },
    };
  }
  const code = intersectAllowedRoles(codeRoles, []).roles;
  const narrowedLocally = narrowed.roles.length !== code.length;
  return {
    ...effective,
    allowedRoles: narrowed.roles,
    origin: { ...effective.origin, allowedRoles: narrowedLocally ? effective.origin.allowedRoles : 'code-default' },
  };
}

/**
 * The warning for a tool `applyCodeRoles` disables because the roles
 * tool-policy.json resolved share nothing with the code roles. Disabling is
 * right (fail closed), but it must be visible. A tool the resolved policy
 * already disabled (`enabled: false`, or the code side) is not reported: the
 * roles are not what turns it off. Role names are configuration, not
 * business data; the committed report keeps code and subject only.
 */
export function disjointCodeRolesFinding(
  execution: { stableKey: string; definitionId: string },
  resolved: EffectiveToolPolicy,
  codeRoles: ReadonlyArray<string> | undefined,
): ToolFinding | undefined {
  if (!resolved.enabled || !codeRoles || codeRoles.length === 0) return undefined;
  if (!intersectAllowedRoles(codeRoles, resolved.allowedRoles).disjoint) return undefined;
  const sorted = (roles: ReadonlyArray<string>) => JSON.stringify(intersectAllowedRoles(roles, []).roles);
  return toolFinding('policy-roles-disjoint', 'warning', execution.stableKey,
    `${execution.definitionId} is disabled: ${TOOLS_PATHS.policy} allows the roles ${sorted(resolved.allowedRoles)}, `
      + `the code (x-glirastes-roles) allows ${sorted(codeRoles)}, and no role is in both.`);
}

interface DerivedOutputInput {
  config: ToolsConfig;
  inventory: FoundationExecutionInventory;
  inventoryRaw: string;
  discovery: FoundationExecutionDiscovery;
  artifact: AppSetupArtifact;
  artifactRaw: string;
  contracts: ReadonlyArray<ToolContractsEntry>;
  promptBundle: PromptBundleInput;
  receiptMode: 'standalone' | 'managed';
}

/** Manifests, receipt and generated module: a pure function of the primary outputs. */
function renderDerivedOutputs(input: DerivedOutputInput): Record<string, string> {
  const manifests = renderManifestContents({
    appId: input.config.appId,
    targetAppKey: input.inventory.targetAppKey,
    inventoryDigest: input.discovery.inventoryDigest,
    executions: input.discovery.executions,
    promptBundle: input.promptBundle.bundle,
    setupArtifact: input.artifact,
  });
  // Committed outputs only: the plan compares the artifact with itself, so CI and
  // Docker recompute the same digest without any file left behind by `glirastes setup`.
  const planDigest = createSetupPlanFromContents({
    mode: input.receiptMode,
    paths: SETUP_PATHS,
    proposed: { path: TOOLS_PATHS.setupArtifact, raw: input.artifactRaw },
    previousRaw: input.artifactRaw,
    inventoryRaw: input.inventoryRaw,
    promptBundleRaw: input.promptBundle.raw,
  }).planDigest;
  const receipt = {
    schemaVersion: 1,
    planDigest,
    mode: input.receiptMode,
    appId: input.config.appId,
    toolCount: input.inventory.executions.length,
    runtimeDigest: manifests.runtimeDigest,
    promptDigest: manifests.promptDigest,
    restartRequired: true,
  };
  const modulePath = generatedModulePath(input.config);
  return {
    [TOOLS_PATHS.runtimeManifest]: manifests.runtimeContent,
    [TOOLS_PATHS.promptManifest]: manifests.promptContent,
    [TOOLS_PATHS.receipt]: `${JSON.stringify(receipt, null, 2)}\n`,
    [modulePath]: renderGeneratedModule({
      modulePath,
      artifact: input.artifact,
      contracts: input.contracts,
      mcpCatalog: input.config.emit.mcpCatalog === true,
      ...(input.config.emit.moduleResolution ? { moduleResolution: input.config.emit.moduleResolution } : {}),
    }),
  };
}

/**
 * Every primary output with the schema its reader applies (the next refresh,
 * the integrity check, `tools status`). A rendered file that its reader would
 * reject is never written, so refresh cannot lock itself out.
 */
const OUTPUT_SCHEMAS: ReadonlyArray<readonly [string, z.ZodType]> = [
  [TOOLS_PATHS.inventory, FoundationExecutionInventorySchema],
  [TOOLS_PATHS.tombstones, ToolTombstonesFileSchema],
  [TOOLS_PATHS.contracts, ToolContractsFileSchema],
  [TOOLS_PATHS.report, ToolReportFileSchema],
  [TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema],
];

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `tools.3.contract.uiAction.keys (UI filter /wide)`: the field and the tool it belongs to. */
function issueLocation(value: unknown, path: ReadonlyArray<PropertyKey>): string {
  let current = value;
  let subject: string | undefined;
  for (const segment of path) {
    if (!isRecord(current)) break;
    current = current[segment];
    if (isRecord(current) && typeof current.stableKey === 'string') subject = current.stableKey;
  }
  const at = path.map(String).join('.') || 'the top level';
  if (subject === undefined) return at;
  return `${at} (${subject.length <= 200 ? subject : `${subject.slice(0, 199)}…`})`;
}

function unreadableOutputs(outputs: Readonly<Record<string, string>>): ToolFinding[] {
  const findings: ToolFinding[] = [];
  for (const [path, schema] of OUTPUT_SCHEMAS) {
    const value: unknown = JSON.parse(outputs[path]!);
    const parsed = schema.safeParse(value);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0]!;
    findings.push(toolFinding('generated-output-invalid', 'error', path,
      `${path} would not match its own schema at ${issueLocation(value, issue.path)}: ${issue.message}.`));
  }
  return findings;
}

async function diffOutputs(root: string, outputs: Readonly<Record<string, string>>): Promise<string[]> {
  const drift: string[] = [];
  for (const path of Object.keys(outputs).sort(compareCodeUnits)) {
    const current = await readFile(resolve(root, path), 'utf8').catch(() => undefined);
    if (current !== outputs[path]) drift.push(path);
  }
  return drift;
}

async function linkedOutputPath(root: string, paths: ReadonlyArray<string>): Promise<string | undefined> {
  for (const path of paths) {
    const target = resolve(root, path);
    let directory = dirname(target);
    while (!existsSync(directory)) directory = dirname(directory);
    const local = relative(root, await realpath(directory));
    if (local.startsWith('..') || isAbsolute(local)) return path;
    if (existsSync(target) && (await lstat(target)).isSymbolicLink()) return path;
  }
  return undefined;
}

/** A leftover from `glirastes setup`; the generator's receipt is computed without it. */
async function staleSetupArtifactPath(root: string): Promise<string | undefined> {
  const stats = await lstat(resolve(root, TOOLS_PATHS.previousSetupArtifact)).catch(() => undefined);
  return stats?.isFile() ? TOOLS_PATHS.previousSetupArtifact : undefined;
}

async function writeOutputs(
  root: string,
  outputs: Readonly<Record<string, string>>,
  paths: ReadonlyArray<string>,
): Promise<void> {
  for (const directory of new Set(paths.map((path) => dirname(resolve(root, path))))) {
    await mkdir(directory, { recursive: true });
  }
  await writeArtifactSetAtomically(paths.map((path) => ({ path: resolve(root, path), content: outputs[path]! })));
}

async function generate(
  root: string,
  config: ToolsConfig,
  options: ToolsPipelineOptions,
  dependencies: ToolsPipelineDependencies,
): Promise<ToolsPipelineResult> {
  const findings: ToolFinding[] = [];
  const excluded: ExcludedTool[] = [];
  const toolViews: ToolsPipelineTool[] = [];
  const result = (extra: Partial<ToolsPipelineResult> = {}): ToolsPipelineResult => ({
    mode: options.mode,
    changes: emptyChanges(),
    findings,
    excluded: sortExcluded(excluded),
    outputs: {},
    driftPaths: [],
    wrote: false,
    tools: toolViews,
    ...extra,
  });

  const { inputs, findings: inputFindings } = await readToolInputs(root, config);
  findings.push(...inputFindings);
  let previous: PreviousToolState;
  try {
    previous = await readPreviousToolState(root, config,
      options.adoptInventoryPath ? { adoptInventoryPath: options.adoptInventoryPath } : {});
  } catch (error) {
    if (error instanceof ToolStateError) {
      findings.push(toolFinding('generation-state-invalid', 'error', error.path, error.message));
      return result();
    }
    throw error;
  }
  const promptBundle = inputs.promptBundle;
  if (!promptBundle || findings.some(isError)) return result();

  const context: ToolSourceContext = {
    root,
    config,
    resolutions: inputs.resolutions,
    policy: inputs.policy,
    ...(previous.state ? { previous: previous.state } : {}),
    previousContracts: previous.contracts,
    probe: dependencies.probe ?? createSchemaProbe(),
  };
  const sources = dependencies.sources ?? createConfiguredSources(config);
  const observed: ObservedTool[] = [];
  let complete = true;
  for (const source of sources) {
    const observation = await source.observe(context);
    observed.push(...observation.observations);
    findings.push(...observation.findings);
    excluded.push(...observation.excluded ?? []);
    complete &&= observation.complete;
  }
  if (!complete || findings.some(isBlocking)) return result();
  const definitionOwners = new Map<string, string>();
  for (const tool of observed) {
    const owner = definitionOwners.get(tool.execution.definitionId);
    if (owner !== undefined && owner !== tool.execution.stableKey) {
      findings.push(toolFinding('definition-id-conflict', 'error', tool.execution.stableKey,
        `${tool.execution.definitionId} is also used by ${owner}.`));
    }
    definitionOwners.set(tool.execution.definitionId, tool.execution.stableKey);
  }
  if (findings.some(isBlocking)) return result();

  let generation: ExecutionGenerationResult;
  try {
    generation = reconcileExecutionInventory({
      appId: config.appId,
      targetAppKey: config.targetAppKey,
      observed: { complete: true, executions: observed.map((tool) => tool.execution) },
      ...(previous.state ? { previous: previous.state } : {}),
    });
  } catch (error) {
    if (isFoundationDiagnosticError(error)) {
      findings.push(toolFinding(error.code, 'error', 'inventory', error.message));
      return result();
    }
    throw error;
  }
  const inventory = generation.state.inventory;
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  const observedByKey = new Map(observed.map((tool) => [tool.execution.stableKey, tool] as const));
  const toolIdByKey = new Map(inventory.executions.map((execution) => [execution.stableKey, execution.toolId] as const));
  const artifactTools: ArtifactToolInput[] = [];
  const contractEntries: ToolContractsEntry[] = [];
  const reportTools: ToolReportTool[] = [];
  const languages = requiredLanguages(config.locale, config.languages);
  const usedSemantics = new Set<ToolSemanticsEntry>();
  const missingLabels = new Map<string, string[]>();

  for (const execution of inventory.executions) {
    const tool = observedByKey.get(execution.stableKey);
    if (!tool) throw new Error(`No observation for ${execution.stableKey}`);
    const reportedAttention = tool.findings.some((finding) => (
      finding.severity === 'needs_attention' || NON_BLOCKING_ERROR_CODES.has(finding.code)
    ));
    // A tool without a contract can never be bound by the generated module.
    if (!reportedAttention && !tool.contract) {
      findings.push(toolFinding('input-contract-unresolved', 'needs_attention', execution.stableKey,
        'The source reported no input contract for this tool.'));
    }
    // Function calling needs an object at the root of the input schema; a union there fails every turn.
    const rootNotObject = tool.contract !== undefined && tool.contract.input.type !== 'object';
    if (rootNotObject) {
      findings.push(toolFinding('input-schema-not-object', 'needs_attention', execution.stableKey,
        'The input schema is not an object at its root (for example a union), so models cannot call this tool.'));
    }
    const needsAttention = reportedAttention || !tool.contract || rootNotObject;
    const defaults = deriveToolPolicyDefaults({
      executionKind: execution.executionKind,
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      definitionId: execution.definitionId,
      ...(tool.evidence.declaredEffect ? { declaredEffect: tool.evidence.declaredEffect } : {}),
      evidence: {
        externalCall: tool.evidence.externalCall,
        ...(tool.evidence.uiMutation ? { uiMutation: true } : {}),
      },
    });
    const local = (inputs.policy.tools ?? {})[execution.stableKey];
    const acceptedRisk = (inputs.policy.acceptedRisk ?? {})[execution.stableKey];
    const previousRisk = previous.artifact?.riskByToolId.get(execution.toolId);
    const resolved = resolveToolPolicy({
      toolId: execution.toolId,
      defaults,
      codeEnabled: !needsAttention,
      ...(local ? { local } : {}),
      ...(acceptedRisk ? { acceptedRisk } : {}),
      ...(previousRisk ? { previousEffectiveRiskClass: previousRisk } : {}),
    });
    const effective = applyCodeRoles(resolved.effective, tool.codeRoles);
    const disjointRoles = disjointCodeRolesFinding(execution, resolved.effective, tool.codeRoles);
    if (disjointRoles) findings.push(disjointRoles);
    for (const warning of resolved.warnings) {
      findings.push(toolFinding(warning.code, 'warning', execution.stableKey, policyWarningMessage(warning.code, warning.field)));
    }
    for (const error of resolved.errors) {
      findings.push(toolFinding(error.code, 'error', execution.stableKey, `${error.field}: ${error.reason}`, error.reason));
    }
    if (previousRisk && riskTier(effective.riskClass) > riskTier(previousRisk)) {
      findings.push(toolFinding('risk-raised', 'warning', execution.stableKey,
        `Risk raised from ${previousRisk} to ${effective.riskClass}; confirmation follows automatically.`));
    }
    findings.push(...tool.findings);
    const semanticsEntry = lookupSemantics(inputs.semantics, execution.stableKey, execution.definitionId);
    if (semanticsEntry) usedSemantics.add(semanticsEntry);
    const semantics: SemanticsCheck = semanticsEntry
      ? validateSemanticsEntry(semanticsEntry, {
        stableKey: execution.stableKey,
        ...(tool.interface ? { interfaceDigest: tool.interface.digest } : {}),
        ...(tool.contract ? { input: tool.contract.input } : {}),
      })
      : { findings: [], stale: false };
    findings.push(...semantics.findings);
    if (semantics.stale) {
      const dropped = semantics.droppedExampleCalls
        ? ` Example calls left out until then, because the input schema no longer accepts them: ${semantics.droppedExampleCalls}.`
        : '';
      findings.push(toolFinding('semantics-stale', 'warning', execution.stableKey,
        `The handler interface changed after an agent described this tool; the description stays in use until it is renewed.${dropped}`));
    }
    const prose = resolveToolProse({
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      operationGroup: defaults.operationGroup,
      locale: config.locale,
      ...(config.languages ? { languages: config.languages } : {}),
      ...(tool.evidence.jsDoc ? { jsDoc: tool.evidence.jsDoc } : {}),
      ...(tool.prose ? { hints: tool.prose } : {}),
      semantics: inputs.semantics,
      entry: semantics.entry ?? null,
      ...(effective.description && effective.origin.description !== 'code-default'
        ? { policyDescription: effective.description }
        : {}),
    });
    findings.push(...prose.findings);
    const schemaQuality = schemaQualityOf(tool.contract, resolutionOrigin(inputs.resolutions, execution.stableKey));
    artifactTools.push({
      execution,
      prose,
      effective,
      operationGroup: needsAttention ? 'needs_attention' : defaults.operationGroup,
      provenance: {
        policyOrigin: localPolicyOrigin(effective.origin, local),
        ...(tool.contract ? { contractSource: tool.contract.source } : {}),
        descriptionSource: prose.descriptionOrigin,
        schemaSource: schemaQuality,
      },
    });
    for (const language of prose.missingLabelLanguages ?? []) {
      const list = missingLabels.get(language) ?? [];
      list.push(execution.definitionId);
      missingLabels.set(language, list);
    }
    const search = semanticsSearch(semantics.entry, tool.prose);
    const title = semanticsTitle(semantics.entry, tool.prose?.title, languages);
    const mcp = execution.executionKind === 'endpoint' ? inputs.mcpNames?.get(execution.stableKey) : undefined;
    contractEntries.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      contract: tool.contract ?? null,
      defaults,
      ...(mcp ? { mcp: [...mcp] } : {}),
      ...(search.synonyms.length > 0 || search.examples.length > 0
        ? {
          search: {
            ...(search.synonyms.length > 0 ? { synonyms: search.synonyms } : {}),
            ...(search.examples.length > 0 ? { examples: search.examples } : {}),
          },
        }
        : {}),
      ...(title ? { title } : {}),
      ...(prose.labels ? { labels: prose.labels } : {}),
      ...(tool.maxResultChars !== undefined ? { maxResultChars: tool.maxResultChars } : {}),
      ...(tool.outputAllowedFields ? { outputAllowedFields: tool.outputAllowedFields } : {}),
      ...(tool.outputDeniedFields ? { outputDeniedFields: tool.outputDeniedFields } : {}),
      ...(tool.outputDefaultFields ? { outputDefaultFields: tool.outputDefaultFields } : {}),
    });
    const requiresApproval = confirmationFloor(effective.riskClass, effective.requiresApproval);
    toolViews.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      modelName: modelFacingToolName(execution.definitionId),
      executionKind: execution.executionKind,
      route: execution.executionKind === 'endpoint'
        ? `${execution.method} ${execution.path}`
        : `UI ${execution.actionBindingRef}`,
      files: tool.files ?? (execution.executionKind === 'endpoint' ? [execution.sourceFile] : []),
      contract: tool.contract ?? null,
      interfaceDigest: tool.interface?.digest ?? null,
      params: tool.interface?.params ?? null,
      defaults,
      enabled: effective.enabled,
      riskClass: effective.riskClass,
      requiresApproval,
      localPolicy: local !== undefined,
      module: prose.module,
      description: prose.description,
      descriptionOrigin: prose.descriptionOrigin,
      schemaQuality,
      semantics: {
        ...semanticsFacts(semantics.entry, languages),
        stale: semantics.stale,
        rejected: semanticsEntry !== undefined && semantics.entry === undefined,
      },
      findings: [],
    });
    reportTools.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      enabled: effective.enabled,
      riskClass: effective.riskClass,
      requiresApproval,
      contractSource: tool.contract?.source ?? null,
      quality: {
        description: prose.descriptionOrigin,
        schema: schemaQuality,
      },
    });
  }
  // An entry for an excluded route never applies either: say why (roadmap, P05).
  const excludedByKey = new Map(excluded.map((entry) => [entry.stableKey, entry] as const));
  const orphaned = (key: string, section: string) => {
    if (observedByKey.has(key)) return;
    const exclusion = excludedByKey.get(key);
    findings.push(toolFinding('policy-entry-orphaned', 'warning', key, exclusion
      ? `This tool-policy.json ${section} entry has no effect: the route is excluded (${exclusion.reason}, ${exclusion.origin}).`
      : `This tool-policy.json ${section} entry matches no tool in the current code.`));
  };
  for (const key of Object.keys(inputs.policy.tools ?? {})) orphaned(key, 'tools');
  for (const key of Object.keys(inputs.policy.acceptedRisk ?? {})) orphaned(key, 'acceptedRisk');
  findings.push(...orphanedSemanticsFindings(inputs.semantics, usedSemantics, excludedByKey, previous.state, inventory.executions));
  for (const [language, names] of [...missingLabels].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const shown = [...names].sort(compareCodeUnits);
    findings.push(toolFinding('label-translation-missing', 'warning', `${TOOLS_PATHS.config}#languages.${language}`,
      `${shown.length} tool${shown.length === 1 ? ' has' : 's have'} no label in ${language} and show${shown.length === 1 ? 's' : ''} the fallback language: `
      + `${shown.slice(0, 5).join(', ')}${shown.length > 5 ? `, and ${shown.length - 5} more` : ''}.`));
  }
  for (const key of inputs.mcpNames?.keys() ?? []) {
    if (observedByKey.get(key)?.execution.executionKind === 'endpoint') continue;
    findings.push(toolFinding('mcp-tool-names-invalid', 'warning', key,
      'This mcp-tool-names.json entry names no endpoint tool in the current code and is ignored.'));
  }
  if (config.emit.mcpCatalog === true) {
    // The catalog lists every id and name once; a kept name that another tool already uses falls back to the generated ones.
    const mcpNames = checkMcpNames(toolViews
      .filter((view) => view.executionKind === 'endpoint' && view.enabled)
      .map((view) => ({
        stableKey: view.stableKey,
        definitionId: view.definitionId,
        modelName: view.modelName,
        ...(inputs.mcpNames?.has(view.stableKey) ? { kept: inputs.mcpNames.get(view.stableKey)! } : {}),
      })));
    findings.push(...mcpNames.findings);
    for (const entry of contractEntries) {
      if (mcpNames.fallback.has(entry.stableKey)) delete entry.mcp;
    }
  }
  findings.push(...unmatchedAppDeniedFindings(config.output?.deniedFields ?? [], [...observedByKey.values()]));
  for (const view of toolViews) {
    view.findings = sortFindings(findings.filter((finding) => finding.subjectRef === view.stableKey));
  }
  if (findings.some(isBlocking)) return result({ changes: generation.changes });

  const stableFindings = findings.filter((finding) => !TRANSIENT_FINDING_CODES.has(finding.code));
  const built = buildSetupArtifact({
    appId: config.appId,
    targetAppKey: config.targetAppKey,
    discoveryDigest: discovery.inventoryDigest,
    tools: artifactTools,
    promptBundle: promptBundle.bundle,
    warnings: stableFindings
      .filter((finding) => toolIdByKey.has(finding.subjectRef))
      .map((finding) => ({ code: finding.code, subjectRef: toolIdByKey.get(finding.subjectRef)! })),
    ...(previous.artifact ? { previous: previous.artifact } : {}),
    now: options.mode === 'write' ? dependencies.now ?? (() => new Date()) : null,
    exclusions: excluded,
  });
  assertAppSetupSemanticParity(built.artifact, inventory.executions.map((execution) => execution.definitionId));
  const inventoryRaw = renderInventory(generation.state);
  const derived = renderDerivedOutputs({
    config,
    inventory,
    inventoryRaw,
    discovery,
    artifact: built.artifact,
    artifactRaw: built.raw,
    contracts: contractEntries,
    promptBundle,
    receiptMode: previous.receiptMode ?? 'standalone',
  });
  const outputs: Record<string, string> = {
    [TOOLS_PATHS.inventory]: inventoryRaw,
    [TOOLS_PATHS.tombstones]: renderTombstones(generation.state),
    [TOOLS_PATHS.contracts]: renderToolContracts(config.appId, contractEntries),
    [TOOLS_PATHS.report]: renderToolReport({
      appId: config.appId,
      discoveryDigest: discovery.inventoryDigest,
      tools: reportTools,
      findings: stableFindings,
      excluded,
    }),
    [TOOLS_PATHS.setupArtifact]: built.raw,
    ...derived,
  };
  const unreadable = unreadableOutputs(outputs);
  if (unreadable.length > 0) {
    findings.push(...unreadable);
    return result({ changes: generation.changes });
  }
  const driftPaths = await diffOutputs(root, outputs);
  if (options.mode !== 'write') {
    for (const path of driftPaths) {
      findings.push(toolFinding('tool-outputs-drift', 'error', path, `${path} is out of date with the code.`));
    }
    return result({ changes: generation.changes, outputs, driftPaths });
  }
  const stale = await staleSetupArtifactPath(root);
  if (driftPaths.length === 0 && !stale) return result({ changes: generation.changes, outputs, driftPaths });
  const linked = await linkedOutputPath(root, stale ? [...driftPaths, stale] : driftPaths);
  if (linked) {
    findings.push(toolFinding('output-path-linked', 'error', linked, `${linked} resolves outside the app.`));
    return result({ changes: generation.changes, outputs, driftPaths });
  }
  if (driftPaths.length > 0) await writeOutputs(root, outputs, driftPaths);
  if (stale) await rm(resolve(root, stale));
  return result({ changes: generation.changes, outputs, driftPaths, wrote: driftPaths.length > 0 });
}

function receiptModeOf(raw: string | undefined): 'standalone' | 'managed' {
  try {
    const parsed = JSON.parse(raw ?? '') as { mode?: unknown };
    return parsed.mode === 'managed' ? 'managed' : 'standalone';
  } catch {
    return 'standalone';
  }
}

/**
 * Deploy-time check: re-renders manifests, receipt and generated module from
 * the committed primary outputs and verifies the inventory against the route
 * files. Never observes sources, never imports app modules, never writes.
 */
async function verifyIntegrity(root: string, config: ToolsConfig): Promise<ToolsPipelineResult> {
  const findings: ToolFinding[] = [];
  const result = (outputs: Record<string, string> = {}, driftPaths: string[] = []): ToolsPipelineResult => ({
    mode: 'integrity',
    changes: emptyChanges(),
    findings,
    excluded: [],
    outputs,
    driftPaths,
    wrote: false,
  });
  const read = (path: string): Promise<string | undefined> => (
    readFile(resolve(root, path), 'utf8').catch(() => undefined)
  );
  const parse = <T>(path: string, raw: string | undefined, schema: z.ZodType<T>): T | undefined => {
    if (raw === undefined) {
      findings.push(toolFinding('tool-output-invalid', 'error', path, `${path} is missing.`));
      return undefined;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Reported below like any other schema violation.
    }
    findings.push(toolFinding('tool-output-invalid', 'error', path, `${path} is not a valid generated file.`));
    return undefined;
  };
  const broken = (path: string, message: string) => {
    findings.push(toolFinding('integrity-chain-broken', 'error', path, message));
  };

  const inventoryRaw = await read(TOOLS_PATHS.inventory);
  const artifactRaw = await read(TOOLS_PATHS.setupArtifact);
  const inventory = parse(TOOLS_PATHS.inventory, inventoryRaw, FoundationExecutionInventorySchema);
  const tombstones = parse(TOOLS_PATHS.tombstones, await read(TOOLS_PATHS.tombstones), ToolTombstonesFileSchema);
  const contracts = parse(TOOLS_PATHS.contracts, await read(TOOLS_PATHS.contracts), ToolContractsFileSchema);
  const artifact = parse(TOOLS_PATHS.setupArtifact, artifactRaw, AppSetupArtifactSchema);
  const prompt = await readPromptBundle(root, config);
  findings.push(...prompt.findings);
  if (!inventory || !inventoryRaw || !tombstones || !contracts || !artifact || !artifactRaw || !prompt.promptBundle) {
    return result();
  }
  if (tombstones.appId !== config.appId || contracts.appId !== config.appId || artifact.appId !== config.appId) {
    broken(TOOLS_PATHS.setupArtifact, 'The generated files belong to a different app.');
    return result();
  }
  let discovery: FoundationExecutionDiscovery;
  try {
    discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  } catch {
    broken(TOOLS_PATHS.inventory, 'The inventory no longer matches the route sources; run glirastes tools refresh.');
    return result();
  }
  if (artifact.discoveryDigest !== discovery.inventoryDigest) {
    broken(TOOLS_PATHS.setupArtifact, 'The setup artifact was generated from a different inventory.');
  }
  try {
    assertAppSetupSemanticParity(artifact, inventory.executions.map((execution) => execution.definitionId));
  } catch {
    broken(TOOLS_PATHS.setupArtifact, 'The setup artifact does not match the inventory tools.');
  }
  const inventoryIds = inventory.executions.map((execution) => execution.toolId).sort(compareCodeUnits).join(',');
  if (contracts.tools.map((entry) => entry.toolId).sort(compareCodeUnits).join(',') !== inventoryIds) {
    broken(TOOLS_PATHS.contracts, 'Tool contracts do not match the inventory.');
  }
  if (findings.some(isError)) return result();

  let derived: Record<string, string>;
  try {
    derived = renderDerivedOutputs({
      config,
      inventory,
      inventoryRaw,
      discovery,
      artifact,
      artifactRaw,
      contracts: contracts.tools.map(toToolContractsEntry),
      promptBundle: prompt.promptBundle,
      receiptMode: receiptModeOf(await read(TOOLS_PATHS.receipt)),
    });
  } catch (error) {
    if (error instanceof Error) {
      broken(generatedModulePath(config), error.message);
      return result();
    }
    throw error;
  }
  const driftPaths = await diffOutputs(root, derived);
  for (const path of driftPaths) broken(path, `${path} does not match the committed tool outputs.`);
  return result(derived, driftPaths);
}

export async function runToolsPipelineWith(
  options: ToolsPipelineOptions,
  dependencies: ToolsPipelineDependencies,
): Promise<ToolsPipelineResult> {
  const root = await realpath(resolve(options.root));
  const config = loadToolsConfig(root);
  const raw = options.mode === 'integrity'
    ? await verifyIntegrity(root, config)
    : await generate(root, config, options, dependencies);
  const result = { ...raw, findings: sortFindings(raw.findings) };
  if (result.findings.some(isError) && !options.keepGoing) throw new ToolsPipelineFailure(result);
  return result;
}

/** Derives the app's tools from code: write, frozen (check) or integrity (deploy) mode. */
export async function runToolsPipeline(options: ToolsPipelineOptions): Promise<ToolsPipelineResult> {
  return runToolsPipelineWith(options, {});
}
