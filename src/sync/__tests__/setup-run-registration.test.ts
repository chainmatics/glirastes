import { describe, expect, it, vi } from 'vitest';
import { RuntimeControlPlaneClient } from '../control-plane-client.js';
import { createManagedRuntimeSync } from '../managed-sync.js';
import type { RuntimeSyncManager } from '../sync-manager.js';

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de1f${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const APP_ID = id('3');
const ENVIRONMENT_ID = id('9');
const RUN_ID = id('2');

const artifact = {
  schemaVersion: 1,
  artifactId: id('1'),
  runId: RUN_ID,
  appId: APP_ID,
  discoveryDigest: digest('A'),
  assessmentMode: 'autonomous',
  status: 'ready',
  tools: [],
  planner: {
    plannerId: id('4'),
    modelBindingRef: 'default',
    promptBindingRef: 'prompt:fixture',
    budgetProfileRef: 'default',
    toolIds: [],
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
  exclusions: [],
  generatedAt: '2026-10-05T08:00:00.000Z',
};

const bodies = (fetchImpl: ReturnType<typeof vi.fn>) => fetchImpl.mock.calls
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { capabilities: Record<string, unknown> });

function client(options: { discoveryDigest?: string; setupRunId?: string }, fetchImpl = vi.fn()) {
  return new RuntimeControlPlaneClient({
    baseUrl: 'https://control.example',
    apiKey: 'runtime-key',
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    runnerKey: 'runner-a',
    version: '1.0.0',
    ...options,
    manager: {} as RuntimeSyncManager,
    fetchImpl,
  });
}

describe('runner registration with the setup run (P10)', () => {
  it('names the setup run of the committed artifact next to the discovery digest', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ runnerId: id('7') })));
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

    await runtime.client.register({ capabilities: { engine: 'vercel-ai-sdk' } });

    expect(bodies(fetchImpl)[0]?.capabilities).toEqual({
      engine: 'vercel-ai-sdk',
      discoveryDigest: digest('A'),
      setupRunId: RUN_ID,
      policyRelaxations: 1,
    });
  });

  it('never lets a caller name a setup run the runtime does not carry', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ runnerId: id('7') })));
    const withRun = client({ discoveryDigest: digest('A'), setupRunId: RUN_ID }, fetchImpl);
    const withoutRun = client({ discoveryDigest: digest('A') }, fetchImpl);

    await expect(withRun.register({ capabilities: { setupRunId: id('8') } }))
      .rejects.toThrow(/setupRunId/);
    await expect(withoutRun.register({ capabilities: { setupRunId: RUN_ID } }))
      .rejects.toThrow(/setupRunId/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a setup run without a discovery digest or outside the uuid form', () => {
    expect(() => client({ setupRunId: RUN_ID })).toThrow(/pass both/);
    expect(() => client({ discoveryDigest: digest('A'), setupRunId: 'build 42' })).toThrow(/uuid/);
  });
});
