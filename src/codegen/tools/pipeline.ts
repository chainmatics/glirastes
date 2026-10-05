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
} from '../../contracts/index.js';
import {
  confirmationFloor,
  deriveToolPolicyDefaults,
  resolveToolPolicy,
  riskTier,
  type EffectiveToolPolicy,
} from '../../contracts/tool-policy.js';
import type { AppSetupToolProvenance } from '../../contracts/index.js';
import { FoundationDiagnosticError, isFoundationDiagnosticError } from '../../diagnostics/index.js';
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
  type ArtifactToolInput,
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
import type { ToolsMode } from './mode.js';
import { resolveToolProse } from './prose.js';
import { resolutionOrigin } from './resolutions.js';
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
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
  ToolContractsEntry,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
} from './types.js';

export interface ToolsPipelineResult {
  mode: ToolsMode;
  changes: { added: string[]; changed: string[]; removed: string[]; unchanged: string[] };
  findings: ToolFinding[];
  excluded: Array<{ stableKey: string; reason: string; origin: string }>;
  outputs: Record<string, string>;
  driftPaths: string[];
  wrote: boolean;
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

function isError(finding: ToolFinding): boolean {
  return finding.severity === 'error';
}

function sortExcluded(excluded: ReadonlyArray<ExcludedTool>): ExcludedTool[] {
  return [...excluded].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
}

type PolicyField = keyof EffectiveToolPolicy['origin'];
const POLICY_FIELDS: ReadonlyArray<PolicyField> = ['enabled', 'requiresApproval', 'riskClass', 'allowedRoles', 'description'];

/** A local report knows code defaults and local policy only, never a Platform origin. */
function localPolicyOrigin(origin: EffectiveToolPolicy['origin']): NonNullable<AppSetupToolProvenance['policyOrigin']> {
  const local: NonNullable<AppSetupToolProvenance['policyOrigin']> = {};
  for (const field of POLICY_FIELDS) {
    const value = origin[field];
    if (value === 'code-default' || value === 'local-policy') local[field] = value;
  }
  return local;
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
    [modulePath]: renderGeneratedModule({ modulePath, artifact: input.artifact, contracts: input.contracts }),
  };
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
  const result = (extra: Partial<ToolsPipelineResult> = {}): ToolsPipelineResult => ({
    mode: options.mode,
    changes: emptyChanges(),
    findings,
    excluded: sortExcluded(excluded),
    outputs: {},
    driftPaths: [],
    wrote: false,
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
  const sources = dependencies.sources ?? normalizeSources(config).map((source) => (
    createNextEndpointSource(source.apiDir ? { apiDir: source.apiDir } : {})
  ));
  const observed: ObservedTool[] = [];
  let complete = true;
  for (const source of sources) {
    const observation = await source.observe(context);
    observed.push(...observation.observations);
    findings.push(...observation.findings);
    excluded.push(...observation.excluded ?? []);
    complete &&= observation.complete;
  }
  if (!complete || findings.some(isError)) return result();
  const definitionOwners = new Map<string, string>();
  for (const tool of observed) {
    const owner = definitionOwners.get(tool.execution.definitionId);
    if (owner !== undefined && owner !== tool.execution.stableKey) {
      findings.push(toolFinding('definition-id-conflict', 'error', tool.execution.stableKey,
        `${tool.execution.definitionId} is also used by ${owner}.`));
    }
    definitionOwners.set(tool.execution.definitionId, tool.execution.stableKey);
  }
  if (findings.some(isError)) return result();

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

  for (const execution of inventory.executions) {
    const tool = observedByKey.get(execution.stableKey);
    if (!tool) throw new Error(`No observation for ${execution.stableKey}`);
    const reportedAttention = tool.findings.some((finding) => finding.severity === 'needs_attention');
    // A tool without a contract can never be bound by the generated module.
    if (!reportedAttention && !tool.contract) {
      findings.push(toolFinding('input-contract-unresolved', 'needs_attention', execution.stableKey,
        'The source reported no input contract for this tool.'));
    }
    const needsAttention = reportedAttention || !tool.contract;
    const defaults = deriveToolPolicyDefaults({
      executionKind: execution.executionKind,
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      definitionId: execution.definitionId,
      ...(tool.evidence.declaredEffect ? { declaredEffect: tool.evidence.declaredEffect } : {}),
      evidence: { externalCall: tool.evidence.externalCall },
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
    for (const warning of resolved.warnings) {
      findings.push(toolFinding(warning.code, 'warning', execution.stableKey, policyWarningMessage(warning.code, warning.field)));
    }
    for (const error of resolved.errors) {
      findings.push(toolFinding(error.code, 'error', execution.stableKey, `${error.field}: ${error.reason}`, error.reason));
    }
    if (previousRisk && riskTier(resolved.effective.riskClass) > riskTier(previousRisk)) {
      findings.push(toolFinding('risk-raised', 'warning', execution.stableKey,
        `Risk raised from ${previousRisk} to ${resolved.effective.riskClass}; confirmation follows automatically.`));
    }
    findings.push(...tool.findings);
    const prose = resolveToolProse({
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      operationGroup: defaults.operationGroup,
      locale: config.locale,
      ...(tool.evidence.jsDoc ? { jsDoc: tool.evidence.jsDoc } : {}),
      ...(tool.prose ? { hints: tool.prose } : {}),
      semantics: inputs.semantics,
      ...(resolved.effective.description && resolved.effective.origin.description !== 'code-default'
        ? { policyDescription: resolved.effective.description }
        : {}),
    });
    findings.push(...prose.findings);
    const schemaQuality = schemaQualityOf(tool.contract, resolutionOrigin(inputs.resolutions, execution.stableKey));
    artifactTools.push({
      execution,
      prose,
      effective: resolved.effective,
      operationGroup: needsAttention ? 'needs_attention' : defaults.operationGroup,
      provenance: {
        policyOrigin: localPolicyOrigin(resolved.effective.origin),
        ...(tool.contract ? { contractSource: tool.contract.source } : {}),
        descriptionSource: prose.descriptionOrigin,
        schemaSource: schemaQuality,
      },
    });
    contractEntries.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      contract: tool.contract ?? null,
      defaults,
    });
    reportTools.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      enabled: resolved.effective.enabled,
      riskClass: resolved.effective.riskClass,
      requiresApproval: confirmationFloor(resolved.effective.riskClass, resolved.effective.requiresApproval),
      contractSource: tool.contract?.source ?? null,
      quality: {
        description: prose.descriptionOrigin,
        schema: schemaQuality,
      },
    });
  }
  for (const key of Object.keys(inputs.policy.tools ?? {})) {
    if (!observedByKey.has(key)) {
      findings.push(toolFinding('policy-entry-orphaned', 'warning', key,
        'This tool-policy.json entry matches no tool in the current code.'));
    }
  }
  if (findings.some(isError)) return result({ changes: generation.changes });

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
