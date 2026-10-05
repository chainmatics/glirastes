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
import { RuntimeSyncManager } from './sync-manager.js';
import {
  RuntimeControlPlaneClient,
  type RuntimePushConnector,
} from './control-plane-client.js';
import type {
  RuntimeDeploymentBundle,
} from '../contracts/revisions.js';
import type {
  MaterializedDeploymentRevisions,
} from './materialize-deployment.js';

export function createManagedRuntimeSync(options: {
  baseUrl: string;
  apiKey: string;
  appId: string;
  environmentId: string;
  runnerKey: string;
  version: string;
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
  const manager = new RuntimeSyncManager({
    environmentId: options.environmentId,
    store,
    verifier,
    validateDeployment: options.validateDeployment,
    onPending: async (deployments) => {
      for (const deployment of deployments) {
        await client.heartbeat({
          health: options.validateDeployment ? 'healthy' : 'degraded',
          validatedDeploymentId: deployment.deploymentId,
          technicalMetadata: {
            validationStage: options.validateDeployment
              ? 'signature-schema-bindings'
              : 'missing-local-binding-validator',
          },
        });
      }
    },
    onActivated: async (deployments) => {
      for (const deployment of deployments) {
        await client.heartbeat({
          health: options.validateDeployment ? 'healthy' : 'degraded',
          lastAppliedDeploymentId: deployment.deploymentId,
          technicalMetadata: {
            activationStage: options.validateDeployment
              ? 'signature-schema-bindings'
              : 'missing-local-binding-validator',
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
    ...(report ? { discoveryDigest: report.discoveryDigest } : {}),
    policyRelaxations: report !== undefined,
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
    if (!report) return undefined;
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
