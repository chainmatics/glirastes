import { riskTier } from '../contracts/tool-policy.js';
import {
  assertLocalToolBindingMatches,
  type LocalToolBinding,
} from '../runtime/local-tool-bindings.js';
import type {
  MaterializedDeploymentRevisions,
} from './materialize-deployment.js';

export function validateLocalDeploymentBindings(options: {
  revisions: MaterializedDeploymentRevisions;
  bindings: ReadonlyArray<LocalToolBinding>;
}): void {
  const bindings = uniqueIndex(
    options.bindings,
    (binding) => binding.toolId,
    'local tool binding',
  );
  const manifestTools = uniqueIndex(
    options.revisions.manifestRevision.tools,
    (tool) => tool.toolId,
    'manifest tool',
  );
  const policies = uniqueIndex(
    options.revisions.policyRevision.toolPolicies,
    (policy) => policy.toolId,
    'runtime tool policy',
  );
  const allowlist = new Set<string>();

  for (const toolId of options.revisions.agentRevision.toolAllowlist) {
    if (allowlist.has(toolId)) {
      throw new Error(`Duplicate agent tool allowlist entry: ${toolId}`);
    }
    allowlist.add(toolId);

    const manifestTool = manifestTools.get(toolId);
    if (!manifestTool || !manifestTool.enabled || manifestTool.tombstone) {
      throw new Error(`Unavailable manifest tool: ${toolId}`);
    }
    const policy = policies.get(toolId);
    if (!policy || !policy.enabled) {
      throw new Error(`Missing enabled runtime tool policy: ${toolId}`);
    }
    // A policy may raise the manifest risk, never lower it.
    if (riskTier(policy.riskClass) < riskTier(manifestTool.riskClass)) {
      throw new Error(`Runtime tool policy risk below manifest: ${toolId}`);
    }
    const binding = bindings.get(toolId);
    if (!binding) {
      throw new Error(`Missing local tool binding: ${toolId}`);
    }
    assertLocalToolBindingMatches(binding, manifestTool);
  }
}

function uniqueIndex<T>(
  values: ReadonlyArray<T>,
  key: (value: T) => string,
  label: string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (indexed.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    indexed.set(id, value);
  }
  return indexed;
}
