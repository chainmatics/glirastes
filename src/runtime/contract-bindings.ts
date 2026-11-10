import { AppSetupArtifactSchema, type AppSetupArtifact } from '../contracts/index.js';
import type { EndpointMethod, SchemaLike, Tool } from '../types.js';
import {
  createLocalRuntimeSource,
  type LocalRuntimeSource,
  type LocalRuntimeSourceOptions,
} from './local-runtime-source.js';
import { createLocalSchemaDigest, type LocalToolBinding } from './local-tool-bindings.js';

interface GeneratedToolBindingBase {
  readonly toolId: string;
  readonly definitionId: string;
  readonly sourceFingerprint: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly inputSchema: SchemaLike;
  readonly outputSchema: SchemaLike;
  readonly tool: Tool;
}

export interface GeneratedEndpointToolBinding extends GeneratedToolBindingBase {
  readonly executionKind: 'endpoint';
  readonly method: EndpointMethod;
  readonly path: string;
}

/** Navigation, filter and client action tools; they run in the browser. */
export interface GeneratedUiToolBinding extends GeneratedToolBindingBase {
  readonly executionKind: 'ui';
  readonly actionBindingRef: string;
}

/** One entry of `createToolBindings()` in the generated module. */
export type GeneratedToolBinding = GeneratedEndpointToolBinding | GeneratedUiToolBinding;

/** The shape of `src/generated/glirastes/tools.generated.ts`. */
export interface GeneratedToolModule {
  readonly setupArtifact: unknown;
  createToolBindings(): ReadonlyArray<GeneratedToolBinding>;
}

export type ContractBindingDisabledReason =
  | 'binding-missing'
  | 'binding-duplicated'
  | 'binding-mismatch'
  | 'input-schema-digest-mismatch'
  | 'output-schema-digest-mismatch';

export interface ContractBindingsResult {
  setupArtifact: AppSetupArtifact;
  bindings: LocalToolBinding[];
  disabled: Array<{ toolId: string; reason: ContractBindingDisabledReason }>;
}

function byToolId(left: { toolId: string }, right: { toolId: string }): number {
  return left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0;
}

type ArtifactTool = AppSetupArtifact['tools'][number];

/** Same kind, same route or action binding, same fingerprint and digests. */
function sameBinding(candidate: ArtifactTool, binding: GeneratedToolBinding): boolean {
  if (
    candidate.sourceFingerprint !== binding.sourceFingerprint
    || candidate.inputSchemaDigest !== binding.inputSchemaDigest
    || candidate.outputSchemaDigest !== binding.outputSchemaDigest
  ) {
    return false;
  }
  if (binding.executionKind === 'endpoint') {
    return candidate.executionKind === 'endpoint'
      && candidate.method === binding.method
      && candidate.path === binding.path;
  }
  return candidate.executionKind === 'ui'
    && candidate.actionBindingRef === binding.actionBindingRef;
}

function toLocalBinding(binding: GeneratedToolBinding): LocalToolBinding {
  const common = {
    toolId: binding.toolId,
    sourceFingerprint: binding.sourceFingerprint,
    inputSchemaDigest: binding.inputSchemaDigest,
    outputSchemaDigest: binding.outputSchemaDigest,
    tool: binding.tool,
  };
  return binding.executionKind === 'endpoint'
    ? { ...common, executionKind: 'endpoint', method: binding.method, path: binding.path }
    : { ...common, executionKind: 'ui', actionBindingRef: binding.actionBindingRef };
}

/**
 * Recomputes every schema digest from the live schema objects at boot and
 * disables only tools whose binding is missing or differs from the artifact.
 */
export function createContractBindings(generated: GeneratedToolModule): ContractBindingsResult {
  const artifact = AppSetupArtifactSchema.parse(generated.setupArtifact);
  const candidates = new Map(artifact.tools.map((tool) => [tool.toolId, tool] as const));
  const grouped = new Map<string, GeneratedToolBinding[]>();
  for (const binding of generated.createToolBindings()) {
    grouped.set(binding.toolId, [...grouped.get(binding.toolId) ?? [], binding]);
  }
  const disabled = new Map<string, ContractBindingDisabledReason>();
  const bindings: LocalToolBinding[] = [];
  for (const [toolId, entries] of grouped) {
    const candidate = candidates.get(toolId);
    if (!candidate?.enabled) continue;
    if (entries.length !== 1) {
      disabled.set(toolId, 'binding-duplicated');
      continue;
    }
    const binding = entries[0]!;
    if (!sameBinding(candidate, binding)) {
      disabled.set(toolId, 'binding-mismatch');
      continue;
    }
    if (createLocalSchemaDigest(binding.inputSchema) !== candidate.inputSchemaDigest) {
      disabled.set(toolId, 'input-schema-digest-mismatch');
      continue;
    }
    if (createLocalSchemaDigest(binding.outputSchema) !== candidate.outputSchemaDigest) {
      disabled.set(toolId, 'output-schema-digest-mismatch');
      continue;
    }
    bindings.push(toLocalBinding(binding));
  }
  for (const tool of artifact.tools) {
    if (tool.enabled && !grouped.has(tool.toolId)) disabled.set(tool.toolId, 'binding-missing');
  }
  const setupArtifact = AppSetupArtifactSchema.parse({
    ...artifact,
    tools: artifact.tools.map((tool) => (disabled.has(tool.toolId) ? { ...tool, enabled: false } : tool)),
  });
  return {
    setupArtifact,
    bindings: bindings.sort(byToolId),
    disabled: [...disabled].map(([toolId, reason]) => ({ toolId, reason })).sort(byToolId),
  };
}

export interface GeneratedRuntimeSource {
  source: LocalRuntimeSource;
  bindings: LocalToolBinding[];
  disabled: ContractBindingsResult['disabled'];
}

export function createGeneratedRuntimeSource(
  generated: GeneratedToolModule,
  options: Omit<LocalRuntimeSourceOptions, 'setupArtifact' | 'bindings'>,
): GeneratedRuntimeSource {
  const result = createContractBindings(generated);
  return {
    source: createLocalRuntimeSource({ ...options, setupArtifact: result.setupArtifact, bindings: result.bindings }),
    bindings: result.bindings,
    disabled: result.disabled,
  };
}
