import type { EndpointMethod, Tool, ToolRegistry } from '../types.js';
import type { TurnSnapshot } from './turn-snapshot.js';

interface LocalToolBindingBase {
  /** Stable UUID assigned by the control plane and synced into the target app. */
  toolId: string;
  /** Fingerprint derived locally from the bound source route. */
  sourceFingerprint: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  /** Local schema and executor; never transmitted to the control plane. */
  tool: Tool;
}

export interface LocalEndpointToolBinding extends LocalToolBindingBase {
  executionKind: 'endpoint';
  method: EndpointMethod;
  path: string;
}

export interface LocalUiToolBinding extends LocalToolBindingBase {
  executionKind: 'ui';
  actionBindingRef: string;
}

export type LocalToolBinding =
  | LocalEndpointToolBinding
  | LocalUiToolBinding;

export function materializeManifestToolRegistry(options: {
  snapshot: TurnSnapshot;
  bindings: ReadonlyArray<LocalToolBinding>;
}): ToolRegistry {
  const bindingsByToolId = new Map<string, LocalToolBinding>();
  for (const binding of options.bindings) {
    if (bindingsByToolId.has(binding.toolId)) {
      throw new Error(`Duplicate local tool binding: ${binding.toolId}`);
    }
    bindingsByToolId.set(binding.toolId, binding);
  }

  const policiesByToolId = new Map(
    options.snapshot.policyRevision.toolPolicies.map(
      (policy) => [policy.toolId, policy] as const,
    ),
  );
  const allowedToolIds = new Set(
    options.snapshot.agentRevision.toolAllowlist,
  );
  const registry: ToolRegistry = {};

  for (const manifestTool of options.snapshot.manifestRevision.tools) {
    if (
      !manifestTool.enabled
      || manifestTool.tombstone
      || !allowedToolIds.has(manifestTool.toolId)
    ) {
      continue;
    }

    const policy = policiesByToolId.get(manifestTool.toolId);
    if (!policy) {
      throw new Error(`Missing runtime tool policy: ${manifestTool.toolId}`);
    }
    if (!policy.enabled) continue;
    if (policy.riskClass !== manifestTool.riskClass) {
      throw new Error(`Runtime tool policy mismatch: ${manifestTool.toolId}`);
    }

    const binding = bindingsByToolId.get(manifestTool.toolId);
    if (!binding) {
      throw new Error(`Missing local tool binding: ${manifestTool.toolId}`);
    }

    const mismatches: Array<readonly [string, unknown, unknown]> = [
      ['execution kind', binding.executionKind, manifestTool.executionKind],
      ['source fingerprint', binding.sourceFingerprint, manifestTool.sourceFingerprint],
      ['input schema digest', binding.inputSchemaDigest, manifestTool.inputSchemaDigest],
      ['output schema digest', binding.outputSchemaDigest, manifestTool.outputSchemaDigest],
    ];
    if (
      binding.executionKind === 'endpoint'
      && manifestTool.executionKind === 'endpoint'
    ) {
      mismatches.push(
        ['method', binding.method, manifestTool.method],
        ['path', binding.path, manifestTool.path],
      );
    }
    if (
      binding.executionKind === 'ui'
      && manifestTool.executionKind === 'ui'
    ) {
      mismatches.push([
        'action binding',
        binding.actionBindingRef,
        manifestTool.actionBindingRef,
      ]);
    }
    const bindingMismatches = mismatches.filter(
      ([, local, published]) => local !== published,
    );
    if (bindingMismatches.length > 0) {
      throw new Error(
        `Local tool binding mismatch (${manifestTool.toolId}): `
        + bindingMismatches.map(([field]) => field).join(', '),
      );
    }
    if (registry[manifestTool.name]) {
      throw new Error(`Duplicate manifest tool name: ${manifestTool.name}`);
    }

    registry[manifestTool.name] = {
      ...binding.tool,
      id: manifestTool.toolId,
      description: manifestTool.description,
      method: manifestTool.executionKind === 'endpoint'
        ? manifestTool.method
        : undefined,
      needsApproval: policy.requiresApproval,
    };
  }

  return registry;
}
