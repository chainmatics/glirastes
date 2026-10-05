import { describe, expect, it, vi } from 'vitest';
import {
  capabilityReportFrom,
  uploadCapabilityReport,
} from '../capability-report.js';
import { RuntimeControlPlaneClient } from '../control-plane-client.js';
import { createManagedRuntimeSync } from '../managed-sync.js';
import { RuntimeSyncManager } from '../sync-manager.js';

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de1f${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const APP_ID = id('3');
const ENVIRONMENT_ID = id('9');
const DISCOVERY_DIGEST = digest('A');

const artifact = {
  schemaVersion: 1,
  artifactId: id('1'),
  runId: id('2'),
  appId: APP_ID,
  discoveryDigest: DISCOVERY_DIGEST,
  assessmentMode: 'autonomous',
  status: 'ready',
  tools: [{
    toolId: id('5'),
    sourceFingerprint: digest('F'),
    name: 'tasks.list',
    executionKind: 'endpoint',
    method: 'GET',
    path: '/api/tasks',
    operationGroup: 'read',
    riskClass: 'safe-read',
    enabled: true,
    requiresApproval: false,
    inputSchemaDigest: digest('I'),
    outputSchemaDigest: digest('O'),
    provenance: { descriptionSource: 'template', schemaSource: 'field-names', contractSource: 'derived' },
  }],
  planner: {
    plannerId: id('4'),
    modelBindingRef: 'default',
    promptBindingRef: 'prompt:fixture',
    budgetProfileRef: 'default',
    toolIds: [id('5')],
  },
  prompts: {
    bundleDigest: digest('B'),
    artifactRef: 'local://fixture/prompts',
    plannerDigest: digest('C'),
    appBehaviorDigest: digest('D'),
    responseStyleDigest: digest('E'),
    capabilityFragmentDigests: {},
  },
  warnings: [],
  exclusions: [{ stableKey: 'POST /api/auth/login', origin: 'default' }],
  generatedAt: '2026-10-05T08:00:00.000Z',
};

const run = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  runId: artifact.runId,
  appId: APP_ID,
  status: 'discovering',
  updatedAt: '2026-10-05T08:00:00.000Z',
  ...extra,
}));

function requests(fetchImpl: ReturnType<typeof vi.fn>): Array<{ method: string; url: string; body: unknown }> {
  return fetchImpl.mock.calls.map(([url, init]) => ({
    method: String((init as RequestInit).method),
    url: String(url),
    body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)),
  }));
}

describe('runner registration with the code version', () => {
  it('sends the discovery digest of the running code next to the other capabilities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runnerId: id('7') })));
    const client = new RuntimeControlPlaneClient({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      discoveryDigest: DISCOVERY_DIGEST,
      manager: {} as RuntimeSyncManager,
      fetchImpl,
    });

    await client.register({ capabilities: { engine: 'vercel-ai-sdk', localBindingCount: 1 } });

    expect(requests(fetchImpl)[0]).toMatchObject({
      method: 'POST',
      url: `https://control.example/v1/runtime/apps/${APP_ID}/environments/${ENVIRONMENT_ID}/runners/register`,
      body: {
        runnerKey: 'runner-a',
        capabilities: { engine: 'vercel-ai-sdk', localBindingCount: 1, discoveryDigest: DISCOVERY_DIGEST },
      },
    });
    await expect(client.register({ capabilities: { discoveryDigest: digest('Z') } }))
      .rejects.toThrow(/discoveryDigest/);
  });

  it('refuses a code version that is not a sha256 digest', () => {
    expect(() => new RuntimeControlPlaneClient({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      discoveryDigest: 'tasks: list, create',
      manager: {} as RuntimeSyncManager,
    })).toThrow(/discoveryDigest/);
  });
});

describe('capability report upload', () => {
  it('reads the committed setup artifact as the report, including provenance and exclusions', () => {
    const report = capabilityReportFrom(artifact);
    expect(report.discoveryDigest).toBe(DISCOVERY_DIGEST);
    expect(report.artifact.tools[0]?.provenance?.schemaSource).toBe('field-names');
    expect(report.artifact.exclusions).toEqual(artifact.exclusions);
    expect(() => capabilityReportFrom({ ...artifact, tools: [{ ...artifact.tools[0], prompt: 'x' }] })).toThrow();
  });

  it('uploads the artifact once per code version through the setup transport', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(run())
      .mockResolvedValueOnce(run({ status: 'ready', artifactDigest: digest('R') }));
    const result = await uploadCapabilityReport({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      report: capabilityReportFrom(artifact),
      fetchImpl,
    });

    expect(result).toEqual({ discoveryDigest: DISCOVERY_DIGEST, runId: artifact.runId, uploaded: true });
    expect(requests(fetchImpl)).toEqual([
      {
        method: 'POST',
        url: `https://control.example/v2/apps/${APP_ID}/runtime-setup/runs`,
        body: { runId: artifact.runId, assessmentMode: 'autonomous', discoveryDigest: DISCOVERY_DIGEST },
      },
      {
        method: 'PUT',
        url: `https://control.example/v2/apps/${APP_ID}/runtime-setup/runs/${artifact.runId}/artifact`,
        body: artifact,
      },
    ]);
  });

  it('skips the upload when the Platform already holds the artifact of this run', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(run({ status: 'ready', artifactDigest: digest('R') }));
    await expect(uploadCapabilityReport({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      report: capabilityReportFrom(artifact),
      fetchImpl,
    })).resolves.toEqual({ discoveryDigest: DISCOVERY_DIGEST, runId: artifact.runId, uploaded: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('wires the report into the managed sync: digest at registration, upload once per process', async () => {
    const fetchImpl = vi.fn(async (url: string) => (
      url.endsWith('/register') ? new Response(JSON.stringify({ runnerId: id('7') })) : run()
    ));
    const runtime = createManagedRuntimeSync({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      setupArtifact: artifact,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      push: false,
    });

    await runtime.client.register();
    await runtime.reportCapabilities();
    await runtime.reportCapabilities();

    expect(requests(fetchImpl).map((request) => `${request.method} ${request.url.split('/').slice(-1)[0]}`))
      .toEqual(['POST register', 'POST runs', 'PUT artifact']);
    expect(requests(fetchImpl)[0]?.body).toMatchObject({ capabilities: { discoveryDigest: DISCOVERY_DIGEST } });
  });

  it('refuses a setup artifact of another app before anything is sent', () => {
    expect(() => createManagedRuntimeSync({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: id('8'),
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      setupArtifact: artifact,
      push: false,
    })).toThrow(/different app/);
  });
});
