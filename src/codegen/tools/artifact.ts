import { z } from 'zod';
import {
  APP_SETUP_EXCLUSION_LIMITS,
  AppSetupArtifactSchema,
  ToolRiskClassSchema,
  type AppSetupArtifact,
  type AppSetupExclusion,
  type AppSetupOperationGroup,
  type AppSetupToolCandidate,
  type AppSetupToolProvenance,
  type ToolRiskClass,
} from '../../contracts/index.js';
import { confirmationFloor, type EffectiveToolPolicy } from '../../contracts/tool-policy.js';
import type { LocalPromptBundle } from '../../cli/commands/validate-build.js';
import { modelFacingToolName } from '../../runtime/local-tool-bindings.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import type { FoundationExecutionInventory } from '../execution-inventory.js';
import { canonicalJson, compareCodeUnits, deterministicUuid, sha256Digest } from './canonical.js';
import { sortFindings, TRANSIENT_FINDING_CODES } from './findings.js';
import type { DescriptionOrigin, ToolProse } from './prose.js';
import type {
  ContractSource,
  ExcludedTool,
  ToolContract,
  ToolContractsEntry,
  ToolFinding,
} from './types.js';

export const EPOCH = '1970-01-01T00:00:00.000Z';
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

type InventoryExecution = FoundationExecutionInventory['executions'][number];
type ArtifactContent = Omit<AppSetupArtifact, 'artifactId' | 'runId' | 'generatedAt'>;

export interface ArtifactToolInput {
  execution: InventoryExecution;
  prose: ToolProse;
  effective: EffectiveToolPolicy;
  operationGroup: AppSetupOperationGroup;
  /** Content-free capability-report provenance (P08b shared contract item 5). */
  provenance?: AppSetupToolProvenance;
}

export interface PreviousArtifact {
  artifact?: AppSetupArtifact;
  planner?: AppSetupArtifact['planner'];
}

export interface BuildSetupArtifactInput {
  appId: string;
  targetAppKey: string;
  discoveryDigest: string;
  tools: ReadonlyArray<ArtifactToolInput>;
  promptBundle: Pick<LocalPromptBundle, 'artifactRef' | 'sections'>;
  warnings: ReadonlyArray<{ code: string; subjectRef: string }>;
  previous?: PreviousArtifact;
  now: (() => Date) | null;
  /** Reported as the artifact's `exclusions`, clipped to the Platform caps. */
  exclusions?: ReadonlyArray<ExcludedTool>;
}

/**
 * The Platform accepts at most 5,000 exclusions with stable keys of at most
 * 512 characters (P08b Task 9). One oversized entry would reject the whole
 * capability report, so longer keys are left out and the list is cut in
 * code-unit order. `tool-report.json` keeps the complete list.
 */
export function clipExclusions(excluded: ReadonlyArray<ExcludedTool>): AppSetupExclusion[] {
  const byKey = new Map<string, AppSetupExclusion>();
  for (const entry of excluded) {
    if (entry.stableKey.length > APP_SETUP_EXCLUSION_LIMITS.maxStableKeyLength) continue;
    if (!byKey.has(entry.stableKey)) byKey.set(entry.stableKey, { stableKey: entry.stableKey, origin: entry.origin });
  }
  return [...byKey.values()]
    .sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey))
    .slice(0, APP_SETUP_EXCLUSION_LIMITS.maxEntries);
}

export function promptMetadata(
  bundle: Pick<LocalPromptBundle, 'artifactRef' | 'sections'>,
): AppSetupArtifact['prompts'] {
  return {
    bundleDigest: sha256Digest(canonicalRuntimeJson(bundle.sections)),
    artifactRef: bundle.artifactRef,
    plannerDigest: sha256Digest(bundle.sections.planner),
    appBehaviorDigest: sha256Digest(bundle.sections.appBehavior),
    responseStyleDigest: sha256Digest(bundle.sections.responseStyle),
    capabilityFragmentDigests: Object.fromEntries(Object.entries(bundle.sections.capabilityFragments)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, content]) => [name, sha256Digest(content)])),
  };
}

function candidate(tool: ArtifactToolInput): AppSetupToolCandidate {
  const { execution, prose, effective } = tool;
  const base = {
    toolId: execution.toolId,
    sourceFingerprint: execution.sourceFingerprint,
    name: execution.definitionId,
    description: prose.description,
    modelName: modelFacingToolName(execution.definitionId),
    module: prose.module,
    sharedWith: [...prose.sharedWith],
    usageHints: [...prose.usageHints],
    presentation: prose.presentation,
    allowedRoles: [...effective.allowedRoles].sort(compareCodeUnits),
    operationGroup: tool.operationGroup,
    riskClass: effective.riskClass,
    enabled: effective.enabled,
    requiresApproval: confirmationFloor(effective.riskClass, effective.requiresApproval),
    inputSchemaDigest: execution.inputSchemaDigest,
    outputSchemaDigest: execution.outputSchemaDigest,
    ...(tool.provenance ? { provenance: tool.provenance } : {}),
  };
  if (execution.executionKind === 'endpoint') {
    return {
      ...base,
      executionKind: 'endpoint',
      method: execution.method,
      path: execution.path,
      authBindingRef: 'endpoint-authorization',
    };
  }
  return { ...base, executionKind: 'ui', actionBindingRef: execution.actionBindingRef };
}

function withoutIdentity(artifact: AppSetupArtifact): ArtifactContent {
  const { artifactId: _artifactId, runId: _runId, generatedAt: _generatedAt, ...content } = artifact;
  return content;
}

function contentDigestOf(content: ArtifactContent): string {
  return sha256Digest(canonicalJson(content));
}

export function buildSetupArtifact(input: BuildSetupArtifactInput): { artifact: AppSetupArtifact; raw: string } {
  const tools = input.tools.map(candidate).sort((left, right) => compareCodeUnits(left.toolId, right.toolId));
  const previousPlanner = input.previous?.planner ?? input.previous?.artifact?.planner;
  const warnings = [...new Map(input.warnings.map((warning) => [`${warning.code}|${warning.subjectRef}`, warning])).values()]
    .sort((left, right) => compareCodeUnits(left.code, right.code) || compareCodeUnits(left.subjectRef, right.subjectRef));
  const draft = AppSetupArtifactSchema.parse({
    schemaVersion: 1,
    artifactId: PLACEHOLDER_ID,
    runId: PLACEHOLDER_ID,
    appId: input.appId,
    discoveryDigest: input.discoveryDigest,
    assessmentMode: 'autonomous',
    status: tools.some((tool) => tool.operationGroup === 'needs_attention') ? 'review' : 'ready',
    tools,
    planner: {
      plannerId: previousPlanner?.plannerId ?? deterministicUuid(input.appId, ['planner']),
      modelBindingRef: previousPlanner?.modelBindingRef ?? 'default',
      promptBindingRef: previousPlanner?.promptBindingRef ?? `prompt:${input.targetAppKey}`,
      budgetProfileRef: previousPlanner?.budgetProfileRef ?? 'default',
      toolIds: tools.filter((tool) => tool.enabled).map((tool) => tool.toolId),
    },
    prompts: promptMetadata(input.promptBundle),
    warnings,
    ...(input.exclusions ? { exclusions: clipExclusions(input.exclusions) } : {}),
    generatedAt: EPOCH,
  });
  const contentDigest = contentDigestOf(withoutIdentity(draft));
  const previous = input.previous?.artifact;
  const generatedAt = previous && contentDigestOf(withoutIdentity(previous)) === contentDigest
    ? previous.generatedAt
    : input.now ? input.now().toISOString() : previous?.generatedAt ?? EPOCH;
  const artifact = AppSetupArtifactSchema.parse({
    ...draft,
    artifactId: deterministicUuid(input.appId, ['setup-artifact', contentDigest]),
    runId: deterministicUuid(input.appId, ['setup-run', contentDigest]),
    generatedAt,
  });
  return { artifact, raw: canonicalJson(artifact) };
}

export function renderToolContracts(appId: string, entries: ReadonlyArray<ToolContractsEntry>): string {
  return canonicalJson({
    schemaVersion: 1,
    appId,
    tools: [...entries].sort((left, right) => compareCodeUnits(left.toolId, right.toolId)),
  });
}

export type SchemaQuality = 'zod' | 'openapi' | 'json-schema' | 'agent' | 'field-names' | 'none';

export function schemaQualityOf(
  contract: ToolContract | null | undefined,
  resolutionOrigin?: 'human' | 'agent',
): SchemaQuality {
  if (!contract) return 'none';
  switch (contract.source) {
    case 'native':
    case 'contract-module':
    case 'legacy-ai-tool':
    case 'ui-bridge':
      return 'zod';
    case 'openapi':
      return 'openapi';
    case 'derived':
      return 'field-names';
    case 'resolution':
      if (resolutionOrigin === 'agent') return 'agent';
      return contract.runtime.input.kind === 'module-export' ? 'zod' : 'json-schema';
  }
}

export interface ToolReportTool {
  toolId: string;
  stableKey: string;
  definitionId: string;
  enabled: boolean;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  contractSource: ContractSource | null;
  quality: { description: DescriptionOrigin; schema: SchemaQuality };
}

export const ToolReportFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  discoveryDigest: z.string(),
  tools: z.array(z.object({
    toolId: z.uuid(),
    stableKey: z.string(),
    definitionId: z.string(),
    enabled: z.boolean(),
    riskClass: ToolRiskClassSchema,
    requiresApproval: z.boolean(),
    contractSource: z.enum([
      'native', 'contract-module', 'legacy-ai-tool', 'resolution', 'openapi', 'derived', 'ui-bridge',
    ]).nullable(),
    quality: z.object({
      description: z.enum(['human', 'code', 'agent', 'template']),
      schema: z.enum(['zod', 'openapi', 'json-schema', 'agent', 'field-names', 'none']),
    }).strict(),
  }).strict()),
  findings: z.array(z.object({
    code: z.string(),
    severity: z.enum(['error', 'needs_attention', 'warning']),
    subjectRef: z.string(),
    nextAction: z.string(),
  }).strict()),
  excluded: z.array(z.object({
    stableKey: z.string(),
    reason: z.string(),
    origin: z.enum(['default', 'policy', 'code']),
  }).strict()),
}).strict();

export type ToolReportFile = z.infer<typeof ToolReportFileSchema>;

/** Content-free state report: no messages, no change-relative findings. */
export function renderToolReport(input: {
  appId: string;
  discoveryDigest: string;
  tools: ReadonlyArray<ToolReportTool>;
  findings: ReadonlyArray<ToolFinding>;
  excluded: ReadonlyArray<ExcludedTool>;
}): string {
  const seen = new Set<string>();
  const findings = sortFindings(input.findings)
    .filter((finding) => !TRANSIENT_FINDING_CODES.has(finding.code))
    .filter((finding) => {
      const key = `${finding.severity}|${finding.code}|${finding.subjectRef}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ code, severity, subjectRef, nextAction }) => ({ code, severity, subjectRef, nextAction }));
  return canonicalJson({
    schemaVersion: 1,
    appId: input.appId,
    discoveryDigest: input.discoveryDigest,
    tools: [...input.tools].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    findings,
    excluded: [...input.excluded].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
  });
}
