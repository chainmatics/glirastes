import { createHash } from 'node:crypto';
import {
  AgentRevisionSchema,
  AppSetupArtifactSchema,
  ExecutionBudgetSchema,
  ManifestRevisionSchema,
  PromptBundleSchema,
  RuntimePolicyRevisionSchema,
  type AgentRevision,
  type AppSetupArtifact,
  type AppSetupToolCandidate,
  type ExecutionBudget,
  type ManifestRevision,
  type ManifestTool,
  type Principal,
  type PromptPin,
  type RuntimePolicyRevision,
  type RuntimeToolPolicy,
} from '../contracts/index.js';
import { confirmationFloor } from '../contracts/tool-policy.js';
import { canonicalRuntimeJson } from '../sync/signature-verifier.js';
import {
  createEphemeralLocalSigner,
  type LocalRevisionSigner,
} from './local-signer.js';
import type { LocalToolBinding } from './local-tool-bindings.js';
import {
  applyPolicyOverlay,
  overlayDescriptions,
  relaxableToolIds,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
import {
  createTurnSnapshot,
  withTurnPrincipal,
  type TurnSnapshot,
} from './turn-snapshot.js';

const TURN_CACHE_LIMIT = 256;

export interface LocalRuntimeSourceOptions {
  /** Parsed .glirastes artifacts; loading from disk is the caller's job. */
  setupArtifact: unknown;
  /** Optional locally generated prompt bundle (content-addressed). */
  promptBundle?: unknown;
  bindings: ReadonlyArray<LocalToolBinding>;
  localLimits: ExecutionBudget;
  /**
   * Stable ids for the standalone world; defaults are derived
   * deterministically from the setup artifact's app identity so restarts
   * agree with themselves.
   */
  identity?: {
    tenantId?: string;
    targetAppId?: string;
    environmentId?: string;
  };
  /**
   * Managed mode only: returns the latest verified Platform overlay, e.g.
   * `policyOverlayFromRevision(revisions.policyRevision)` for the deployment
   * the sync manager accepted. It restricts the local policy and may switch a
   * confirmation off only where the setup artifact allows it (D16). Called
   * synchronously when a new turn starts; it must read local state, never
   * the network.
   */
  policyOverlay?: () => VerifiedPolicyOverlay | undefined;
  /**
   * Managed mode only, required together with `policyOverlay`: the Platform
   * agent and manifest revisions of the same accepted deployment, e.g. the
   * sync manager's `MaterializedDeploymentRevisions`. The turn snapshot
   * carries their ids so Platform revocations by `agentRevisionIds` keep
   * matching (spec 4.9). Read with `policyOverlay` when a new turn starts.
   *
   * Both getters return undefined until a deployment was accepted; the turn
   * then runs on the local base with derived ids, and only `toolIds`
   * revocations can apply. Once a deployment was accepted, keep returning
   * it, a revoked one included, so its revocations keep matching.
   */
  platformRevisions?: () => PlatformRevisionRefs | undefined;
  /** Content-free report each time a new overlay revision is composed. */
  onPolicyOverlayApplied?: (report: {
    revisionId: string;
    ignored: PolicyOverlayResult['ignored'];
    relaxations: PolicyOverlayResult['relaxations'];
  }) => void;
  signer?: LocalRevisionSigner;
}

/** The Platform revisions a managed turn stands in for. */
export interface PlatformRevisionRefs {
  agentRevision: Pick<AgentRevision, 'revisionId' | 'revision'>;
  manifestRevision: Pick<ManifestRevision, 'revisionId' | 'revision'>;
}

type RevisionRef = PlatformRevisionRefs['agentRevision'];

export interface LocalRuntimeSourceIdentity {
  readonly tenantId: string;
  readonly targetAppId: string;
  readonly environmentId: string;
}

export interface LocalRuntimeSource {
  readonly mode: 'standalone' | 'managed';
  readonly keyId: string;
  readonly identity: LocalRuntimeSourceIdentity;
  /**
   * Satisfies ManagedLocalRuntimeConfig.resolveTurnSnapshot. The same
   * turnId returns the identical snapshot (approval continuations).
   */
  resolveTurnSnapshot(context: {
    turnId: string;
    principal: Principal;
  }): TurnSnapshot;
}

/**
 * Deterministic RFC-4122-shaped id from stable inputs, so a standalone
 * restart derives the same identity and revision ids without any store.
 */
function deriveUuid(...parts: string[]): string {
  const hex = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}`
    + `-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function materializeManifestTool(
  candidate: AppSetupToolCandidate,
): ManifestTool {
  if (!candidate.description) {
    throw new Error(
      `Standalone tool ${candidate.name} has no curated description. `
      + 'Re-run "glirastes setup" so every enabled tool carries one.',
    );
  }
  const base = {
    toolId: candidate.toolId,
    sourceFingerprint: candidate.sourceFingerprint,
    name: candidate.name,
    description: candidate.description,
    ...(candidate.modelName ? { modelName: candidate.modelName } : {}),
    ...(candidate.module ? { module: candidate.module } : {}),
    ...(candidate.sharedWith ? { sharedWith: candidate.sharedWith } : {}),
    ...(candidate.usageHints ? { usageHints: candidate.usageHints } : {}),
    ...(candidate.presentation
      ? { presentation: candidate.presentation }
      : {}),
    riskClass: candidate.riskClass,
    enabled: true,
    tombstone: false,
    inputSchemaDigest: candidate.inputSchemaDigest,
    outputSchemaDigest: candidate.outputSchemaDigest,
  };
  if (candidate.executionKind === 'endpoint') {
    if (!candidate.method || !candidate.path) {
      throw new Error(
        `Standalone endpoint tool ${candidate.name} is missing its route`,
      );
    }
    return {
      ...base,
      executionKind: 'endpoint',
      method: candidate.method,
      path: candidate.path,
      authBindingRef: candidate.authBindingRef ?? 'local',
    };
  }
  if (!candidate.actionBindingRef) {
    throw new Error(
      `Standalone ui tool ${candidate.name} is missing its action binding`,
    );
  }
  return {
    ...base,
    executionKind: 'ui',
    actionBindingRef: candidate.actionBindingRef,
  };
}

function materializePromptPin(
  bundle: unknown,
  signer: LocalRevisionSigner,
): PromptPin {
  const candidate = bundle as {
    signature?: unknown;
    sections?: unknown;
    bundleDigest?: unknown;
  };
  const actualDigest = `sha256:${createHash('sha256')
    .update(canonicalRuntimeJson(candidate.sections))
    .digest('base64url')}`;
  if (candidate.bundleDigest !== actualDigest) {
    throw new Error(
      'Local prompt bundle digest does not match its sections',
    );
  }
  const signed = candidate.signature
    ? candidate
    : signer.sign(candidate as object);
  const parsed = PromptBundleSchema.parse(signed);
  return {
    revisionId: parsed.revisionId,
    revision: parsed.revision,
    bundleDigest: parsed.bundleDigest,
  };
}

export function createLocalRuntimeSource(
  options: LocalRuntimeSourceOptions,
): LocalRuntimeSource {
  const artifact: AppSetupArtifact =
    AppSetupArtifactSchema.parse(options.setupArtifact);
  const localLimits = ExecutionBudgetSchema.parse(options.localLimits);
  const signer = options.signer ?? createEphemeralLocalSigner();

  if (
    options.policyOverlay
    && (!options.identity?.tenantId || !options.identity.environmentId)
  ) {
    // Platform revocations match on the Platform environment; a derived
    // standalone identity would silently never match them.
    throw new Error(
      'Managed mode needs the Platform tenantId and environmentId so '
      + 'Platform revocations keep matching.',
    );
  }
  if (Boolean(options.policyOverlay) !== Boolean(options.platformRevisions)) {
    // Derived agent revision ids would never match Platform revocations.
    throw new Error(
      'Managed mode needs both policyOverlay and platformRevisions so '
      + 'Platform revocations keep matching.',
    );
  }

  const identity: LocalRuntimeSourceIdentity = {
    tenantId: options.identity?.tenantId
      ?? deriveUuid('glirastes-standalone', 'tenant', artifact.appId),
    targetAppId: options.identity?.targetAppId ?? artifact.appId,
    environmentId: options.identity?.environmentId
      ?? deriveUuid('glirastes-standalone', 'environment', artifact.appId),
  };

  const enabledTools = artifact.tools.filter((tool) => tool.enabled);
  const manifestTools = enabledTools.map(materializeManifestTool);

  const signManifestRevision = (
    ref: RevisionRef,
    descriptions: ReadonlyMap<string, string> = new Map(),
  ): ManifestRevision =>
    ManifestRevisionSchema.parse(signer.sign({
      revisionId: ref.revisionId,
      revision: ref.revision,
      tenantId: identity.tenantId,
      targetAppId: identity.targetAppId,
      environmentId: identity.environmentId,
      sourceDigest: artifact.discoveryDigest,
      // The model-facing description: Platform > local > code (spec 4.5).
      tools: manifestTools.map((tool) => {
        const description = descriptions.get(tool.toolId);
        return description === undefined ? tool : { ...tool, description };
      }),
      publishedAt: artifact.generatedAt,
    }));

  const signAgentRevision = (ref: RevisionRef): AgentRevision =>
    AgentRevisionSchema.parse(signer.sign({
      revisionId: ref.revisionId,
      revision: ref.revision,
      agentId: artifact.planner.plannerId,
      tenantId: identity.tenantId,
      name: 'Standalone planner',
      objective:
        'Run the locally generated tool inventory without a control plane.',
      modelAlias: artifact.planner.modelBindingRef,
      promptBindingRef: artifact.planner.promptBindingRef,
      toolAllowlist: enabledTools.map((tool) => tool.toolId),
      budget: localLimits,
      publishedAt: artifact.generatedAt,
    }));

  const manifestRevision = signManifestRevision({
    revisionId: deriveUuid(
      'glirastes-standalone', 'manifest', artifact.appId,
      artifact.discoveryDigest,
    ),
    revision: 1,
  });
  const agentRevision = signAgentRevision({
    revisionId: deriveUuid(
      'glirastes-standalone', 'agent', artifact.appId,
      artifact.discoveryDigest,
    ),
    revision: 1,
  });

  const localToolPolicies: RuntimeToolPolicy[] = enabledTools.map((tool) => ({
    toolId: tool.toolId,
    enabled: true,
    riskClass: tool.riskClass,
    // Unassessed ('unknown') and tier-3 tools never run unattended.
    requiresApproval: confirmationFloor(tool.riskClass, tool.requiresApproval),
    allowedRoles: tool.allowedRoles ?? [],
  }));

  const basePolicyRevision: RuntimePolicyRevision = RuntimePolicyRevisionSchema
    .parse(
      signer.sign({
        revisionId: deriveUuid(
          'glirastes-standalone', 'policy', artifact.appId,
          artifact.discoveryDigest,
        ),
        revision: 1,
        tenantId: identity.tenantId,
        environmentId: identity.environmentId,
        budget: localLimits,
        toolPolicies: localToolPolicies,
        publishedAt: artifact.generatedAt,
      }),
    );

  let composed: {
    overlay: VerifiedPolicyOverlay;
    revision: RuntimePolicyRevision;
  } | undefined;
  let platform: {
    key: string;
    agentRevision: AgentRevision;
    manifestRevision: ManifestRevision;
  } | undefined;

  // D16: the code report decides which confirmations the Platform may relax.
  const relaxable = relaxableToolIds(artifact);

  /**
   * Local code is the base; a verified Platform overlay restricts it (spec
   * 4.9) and switches a confirmation off only for relaxable tools, pinned and
   * up to tier 2 (D16). The composed revision keeps the Platform revision id
   * so revocations of that policy revision keep matching.
   */
  const composePolicyRevision = (
    overlay: VerifiedPolicyOverlay,
  ): RuntimePolicyRevision => {
    if (composed?.overlay === overlay) return composed.revision;
    const applied = applyPolicyOverlay(localToolPolicies, overlay.entries, {
      relaxableToolIds: relaxable,
    });
    const revision = RuntimePolicyRevisionSchema.parse(
      signer.sign({
        revisionId: overlay.revisionId,
        revision: overlay.revision,
        tenantId: identity.tenantId,
        environmentId: identity.environmentId,
        budget: overlay.budget ?? localLimits,
        toolPolicies: applied.policies,
        ...(overlay.privacy ? { privacy: overlay.privacy } : {}),
        publishedAt: artifact.generatedAt,
      }),
    );
    composed = { overlay, revision };
    options.onPolicyOverlayApplied?.({
      revisionId: overlay.revisionId,
      ignored: applied.ignored,
      relaxations: applied.relaxations,
    });
    return revision;
  };

  const localToolIds = new Set(localToolPolicies.map((policy) => policy.toolId));

  /**
   * The local agent and manifest stand in for the Platform revisions of the
   * accepted deployment and carry their ids, so agent revocations match. The
   * manifest carries the overlay's descriptions, so the model sees them.
   */
  const platformRevisionsFor = (
    refs: PlatformRevisionRefs,
    overlay: VerifiedPolicyOverlay,
  ) => {
    const key = [
      refs.agentRevision.revisionId,
      refs.agentRevision.revision,
      refs.manifestRevision.revisionId,
      refs.manifestRevision.revision,
      overlay.revisionId,
      overlay.revision,
    ].join('/');
    if (platform?.key !== key) {
      platform = {
        key,
        agentRevision: signAgentRevision(refs.agentRevision),
        manifestRevision: signManifestRevision(
          refs.manifestRevision,
          overlayDescriptions(localToolIds, overlay.entries),
        ),
      };
    }
    return platform;
  };

  const currentRevisions = (): {
    agentRevision: AgentRevision;
    manifestRevision: ManifestRevision;
    policyRevision: RuntimePolicyRevision;
  } => {
    const overlay = options.policyOverlay?.();
    const refs = options.platformRevisions?.();
    if (Boolean(overlay) !== Boolean(refs)) {
      throw new Error(
        'Managed mode needs the policy overlay and the Platform revisions of '
        + 'the same accepted deployment.',
      );
    }
    if (!overlay || !refs) {
      return { agentRevision, manifestRevision, policyRevision: basePolicyRevision };
    }
    const managed = platformRevisionsFor(refs, overlay);
    return {
      agentRevision: managed.agentRevision,
      manifestRevision: managed.manifestRevision,
      policyRevision: composePolicyRevision(overlay),
    };
  };

  const promptPin = options.promptBundle === undefined
    ? undefined
    : materializePromptPin(options.promptBundle, signer);

  const turnCache = new Map<string, TurnSnapshot>();

  return {
    mode: options.policyOverlay ? 'managed' : 'standalone',
    keyId: signer.keyId,
    identity,
    resolveTurnSnapshot({ turnId, principal }) {
      const cached = turnCache.get(turnId);
      if (cached) {
        // Revisions, budget, prompt pin and start stay pinned; the principal
        // follows the current session. Another subject or tenant gets the
        // cached snapshot back unchanged and is refused by the caller.
        return cached.principal.subjectId === principal.subjectId
          && cached.principal.tenantId === principal.tenantId
          ? withTurnPrincipal(cached, principal)
          : cached;
      }
      const snapshot = createTurnSnapshot({
        turnId,
        ...currentRevisions(),
        principal,
        localLimits,
        ...(promptPin ? { promptPin } : {}),
      });
      turnCache.set(turnId, snapshot);
      if (turnCache.size > TURN_CACHE_LIMIT) {
        const oldest = turnCache.keys().next().value;
        if (oldest !== undefined) turnCache.delete(oldest);
      }
      return snapshot;
    },
  };
}
