import { riskTier } from '../contracts/tool-policy.js';
import {
  localToolBindingMismatches,
  type LocalToolBinding,
} from '../runtime/local-tool-bindings.js';
import type {
  MaterializedDeploymentRevisions,
} from './materialize-deployment.js';

export interface IgnoredPlatformTool {
  toolId: string;
  /**
   * `platform-tool-not-in-code`: the deployed code has no binding (spec 4.9).
   * `platform-tool-binding-mismatch`: the code changed the tool after the
   * Platform last saw it; the local manifest keeps running it.
   */
  reason: 'platform-tool-not-in-code' | 'platform-tool-binding-mismatch';
  /** Names of mismatched technical facts; never values or content. */
  mismatches?: string[];
}

export interface LocalDeploymentValidation {
  ignored: IgnoredPlatformTool[];
}

/**
 * Accepts a Platform deployment for the deployed code. A Platform tool the
 * code does not have, or has in a changed form, is ignored and reported
 * instead of rejecting the whole deployment, so restrict-only Platform
 * decisions keep reaching the runtime while the Platform catches up with the
 * code. Inconsistent Platform revisions still fail closed. The allowlist is
 * checked against the reported `toolPolicies`, never against `toolOverrides`
 * restrictions, so a tool only a Platform decision disables stays allowlisted.
 */
export function validateLocalDeploymentBindings(options: {
  revisions: MaterializedDeploymentRevisions;
  bindings: ReadonlyArray<LocalToolBinding>;
}): LocalDeploymentValidation {
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
  const ignored: IgnoredPlatformTool[] = [];

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
      ignored.push({ toolId, reason: 'platform-tool-not-in-code' });
      continue;
    }
    const mismatches = localToolBindingMismatches(binding, manifestTool);
    if (mismatches.length > 0) {
      ignored.push({ toolId, reason: 'platform-tool-binding-mismatch', mismatches });
    }
  }
  return {
    ignored: ignored.sort((left, right) => (
      left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0
    )),
  };
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
