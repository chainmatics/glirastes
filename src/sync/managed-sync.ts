import {
  capabilityReportFrom,
  uploadCapabilityReport,
  type CapabilityReportResult,
} from './capability-report.js';
import { FetchSsePushConnector } from './fetch-sse-push.js';
import { HttpRuntimePublicKeyProvider } from './jwks-provider.js';
import { RuntimeRevisionVerifier } from './signature-verifier.js';
import {
  FileRuntimeStateStore,
  MemoryRuntimeStateStore,
  type RuntimeStateStore,
} from './state-store.js';
import { PrivacyRefusedError, RuntimeSyncManager } from './sync-manager.js';
export { PrivacyRefusedError } from './sync-manager.js';
import {
  RuntimeControlPlaneClient,
  type RuntimePushConnector,
} from './control-plane-client.js';
import type {
  RuntimeDeploymentBundle,
} from '../contracts/revisions.js';
import type { PrivacyRuntimeStatus } from '../contracts/privacy-policy.js';
import {
  materializeDeploymentRevisions,
  type MaterializedDeploymentRevisions,
} from './materialize-deployment.js';
import { privacyPolicyDigest } from './privacy-digest.js';
import { isProtectedPolicy } from '../contracts/privacy-policy.js';

/**
 * The privacy status of a runner without privacy infrastructure: a
 * protected block cannot be enforced here and is refused; without one the
 * profile is off.
 */
export function unsupportedPrivacyStatus(revisions: MaterializedDeploymentRevisions): PrivacyRuntimeStatus {
  const block = revisions.policyRevision.privacy;
  return {
    schemaVersion: 1,
    state: isProtectedPolicy(block) ? 'refused' : 'off',
    policyRevisionId: block ? revisions.policyRevision.revisionId : null,
    publishedPolicyDigest: block ? privacyPolicyDigest(block) : null,
    effectivePolicyDigest: null,
    localRestrictions: [],
    reasons: isProtectedPolicy(block) ? ['store_missing'] : [],
  };
}


export function createManagedRuntimeSync(options: {
  baseUrl: string;
  apiKey: string;
  appId: string;
  tenantId?: string;
  environmentId: string;
  runnerKey: string;
  version: string;
  /** Development connection: sync and stream only, no heartbeat, capability report or registration. */
  readOnly?: boolean;
  stateStore?: RuntimeStateStore;
  stateFilePath?: string;
  fetchImpl?: typeof fetch;
  push?: RuntimePushConnector | false;
  pollIntervalMs?: number;
  validateDeployment?: (
    deployment: RuntimeDeploymentBundle,
    revisions: MaterializedDeploymentRevisions,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /**
   * Whether this runner can enforce the privacy block of a verified
   * deployment (store, keyring, approved provider bindings). Its content-free
   * status goes into the heartbeat. A `refused` deployment is reported
   * unhealthy (`validationStage: 'privacy_refused'`), rejected and recorded in
   * the state's `privacyRefusedDeploymentIds`; the accepted deployment stays,
   * but AI traffic must stay blocked while a refusal is recorded (the
   * `createGlirastes` gate does this). Without it, a deployment with a
   * protected block is refused too: this runner has no privacy infrastructure.
   */
  privacyStatus?: (revisions: MaterializedDeploymentRevisions) => PrivacyRuntimeStatus;
  /**
   * This runner enforces a protected policy and keeps its accepted state in
   * a durable store; registration then claims `privacyPolicyVersions`.
   */
  privacyCapable?: boolean;
  /** This process received and durably accepted a complete live snapshot. */
  onReconciled?: () => void;
  /**
   * The committed setup artifact of the running code, e.g. the generated
   * module's `setupArtifact`. Its discovery digest goes into every runner
   * registration, and `reportCapabilities()` uploads it as the capability
   * report (spec 4.10.6). Content-free; it never enables a tool. With it the
   * runner also reports `policyRelaxations` (D16): compose the turns from
   * the same artifact (`createLocalRuntimeSource`, or `createTurnSnapshot`
   * with `relaxableToolIds(setupArtifact)`).
   */
  setupArtifact?: unknown;
}) {
  const report = options.setupArtifact === undefined
    ? undefined
    : capabilityReportFrom(options.setupArtifact);
  if (report && report.artifact.appId !== options.appId) {
    throw new Error('The setup artifact belongs to a different app');
  }
  const store = options.stateStore
    ?? (options.stateFilePath
      ? new FileRuntimeStateStore(options.stateFilePath)
      : new MemoryRuntimeStateStore());
  const keys = new HttpRuntimePublicKeyProvider({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
  });
  const verifier = new RuntimeRevisionVerifier(keys);
  let client: RuntimeControlPlaneClient;
  const privacyOfRevisions = (revisions: MaterializedDeploymentRevisions): PrivacyRuntimeStatus =>
    (options.privacyStatus ?? unsupportedPrivacyStatus)(revisions);
  const privacyOf = (deployment: RuntimeDeploymentBundle): PrivacyRuntimeStatus =>
    privacyOfRevisions(materializeDeploymentRevisions(deployment));
  const stage = options.validateDeployment ? 'signature-schema-bindings' : 'missing-local-binding-validator';
  const health = options.validateDeployment ? 'healthy' : 'degraded';
  const manager = new RuntimeSyncManager({
    targetAppId: options.appId,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    environmentId: options.environmentId,
    store,
    verifier,
    onReconciled: options.onReconciled,
    validateDeployment: async (deployment, revisions) => {
      const privacy = privacyOfRevisions(revisions);
      if (privacy.state === 'refused') throw new PrivacyRefusedError();
      await options.validateDeployment?.(deployment, revisions);
    },
    onPrivacyRefused: async (deployments) => {
      if (options.readOnly) return;
      for (const deployment of deployments) await client.heartbeat({
        health: 'unhealthy', validatedDeploymentId: deployment.deploymentId,
        technicalMetadata: {validationStage: 'privacy_refused', privacy: privacyOf(deployment)},
      }).catch((error:unknown) => options.onError?.(error));
    },
    onPending: async (deployments) => {
      if (options.readOnly) return;
      for (const deployment of deployments) {
        await client.heartbeat({
          health,
          validatedDeploymentId: deployment.deploymentId,
          technicalMetadata: { validationStage: stage, privacy: privacyOf(deployment) },
        });
      }
    },
    onActivated: async (deployments) => {
      if (options.readOnly) return;
      for (const deployment of deployments) {
        await client.heartbeat({
          health,
          lastAppliedDeploymentId: deployment.deploymentId,
          technicalMetadata: { activationStage: stage, privacy: privacyOf(deployment) },
        });
      }
    },
    onPrivacyDowngrade: async (deploymentIds) => {
      if (options.readOnly) return;
      for (const deploymentId of deploymentIds) {
        // The runner keeps serving the accepted, protected revision.
        await client.heartbeat({
          health: 'degraded',
          validatedDeploymentId: deploymentId,
          technicalMetadata: {
            validationStage: 'privacy_policy_downgrade',
            privacy: {
              schemaVersion: 1,
              state: 'downgrade-rejected',
              policyRevisionId: null,
              publishedPolicyDigest: null,
              effectivePolicyDigest: null,
              localRestrictions: [],
              reasons: ['policy_downgrade'],
            } satisfies PrivacyRuntimeStatus,
          },
        });
      }
    },
  });
  client = new RuntimeControlPlaneClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    appId: options.appId,
    environmentId: options.environmentId,
    runnerKey: options.runnerKey,
    version: options.version,
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(report ? { discoveryDigest: report.discoveryDigest, setupRunId: report.artifact.runId } : {}),
    policyRelaxations: report !== undefined,
    ...(options.privacyCapable ? { privacyCapable: true } : {}),
    manager,
    fetchImpl: options.fetchImpl,
    push: options.push === false
      ? undefined
      : options.push ?? new FetchSsePushConnector(options.fetchImpl),
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });
  let reported: Promise<CapabilityReportResult> | undefined;
  /** Uploads the capability report once per process; undefined without one. */
  const reportCapabilities = async (): Promise<CapabilityReportResult | undefined> => {
    if (!report || options.readOnly) return undefined;
    reported ??= uploadCapabilityReport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      appId: options.appId,
      report,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }).catch((error: unknown) => {
      reported = undefined;
      throw error;
    });
    return reported;
  };
  return { client, manager, store, verifier, keys, reportCapabilities };
}
