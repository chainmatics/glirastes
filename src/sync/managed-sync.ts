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
}) {
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
    manager,
    fetchImpl: options.fetchImpl,
    push: options.push === false
      ? undefined
      : options.push ?? new FetchSsePushConnector(options.fetchImpl),
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });
  return { client, manager, store, verifier, keys };
}
