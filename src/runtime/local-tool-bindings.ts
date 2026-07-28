import { createHash } from 'node:crypto';
import type {
  EndpointMethod,
  SchemaLike,
  Tool,
  ToolRegistry,
} from '../types.js';
import type { TurnSnapshot } from './turn-snapshot.js';

function canonicalSchemaValue(
  value: unknown,
  ancestors: ReadonlyArray<object> = [],
): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (typeof value === 'function') return { function: true };
  if (typeof value !== 'object') return { type: typeof value };
  if (value instanceof Date) return { date: value.toISOString() };
  if (value instanceof RegExp) return { regexp: value.toString() };
  if (ancestors.includes(value)) return { circular: true };
  const nextAncestors = [...ancestors, value];

  const schemaDefinition = (
    value as { _zod?: { def?: unknown }; _def?: unknown }
  )._zod?.def ?? (value as { _def?: unknown })._def;
  if (schemaDefinition) {
    return {
      schema: canonicalSchemaValue(schemaDefinition, nextAncestors),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      canonicalSchemaValue(entry, nextAncestors));
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [
        canonicalSchemaValue(key, nextAncestors),
        canonicalSchemaValue(entry, nextAncestors),
      ])
      .sort(([left], [right]) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value instanceof Set) {
    return [...value]
      .map((entry) => canonicalSchemaValue(entry, nextAncestors))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        const child = (value as Record<string, unknown>)[key];
        const canonicalChild = (
          (key === 'shape' || key === 'getter')
          && typeof child === 'function'
        )
          ? canonicalSchemaValue(child(), nextAncestors)
          : canonicalSchemaValue(child, nextAncestors);
        return [key, canonicalChild];
      }),
  );
}

function createLocalSchemaDescriptor(
  schema: SchemaLike | undefined,
): string {
  return JSON.stringify(canonicalSchemaValue(schema));
}

export function createLocalSchemaDigest(
  schema: SchemaLike | undefined,
): string {
  const canonical = createLocalSchemaDescriptor(schema);
  return `sha256:${createHash('sha256')
    .update(canonical)
    .digest('base64url')}`;
}

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
