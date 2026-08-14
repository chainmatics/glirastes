import { describe, expect, it, vi } from 'vitest';
import { AppSetupClient } from '../app-setup-client.js';

const id = (suffix: string) => (
  `019fa9a9-d5f7-7ec3-a3c7-8899de1f${suffix.padStart(4, '0')}`
);
const digest = (character: string) => `sha256:${character.repeat(43)}`;

const artifact = {
  schemaVersion: 1,
  artifactId: id('1'),
  runId: id('2'),
  appId: id('3'),
  discoveryDigest: digest('A'),
  assessmentMode: 'interview',
  status: 'ready',
  tools: [],
  planner: {
    plannerId: id('4'),
    modelBindingRef: 'model-standard',
    promptBindingRef: 'prompt-v1',
    budgetProfileRef: 'interactive-default',
    toolIds: [],
  },
  prompts: {
    bundleDigest: digest('B'),
    artifactRef: 'registry://fixture/prompts/v1',
    plannerDigest: digest('C'),
    appBehaviorDigest: digest('D'),
    responseStyleDigest: digest('E'),
    capabilityFragmentDigests: {},
  },
  warnings: [],
  generatedAt: '2026-07-30T10:00:00.000Z',
} as const;

const runResponse = {
  runId: artifact.runId,
  appId: artifact.appId,
  status: 'discovering',
  updatedAt: '2026-07-30T10:00:00.000Z',
};

describe('AppSetupClient', () => {
  it('creates an app-scoped run without transmitting an environment ID', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(runResponse), { status: 201 }),
    );
    const client = new AppSetupClient({
      baseUrl: 'https://control.example/',
      setupApiKey: 'setup-secret',
      appId: artifact.appId,
      fetchImpl,
    });

    await expect(client.createRun({
      runId: artifact.runId,
      assessmentMode: artifact.assessmentMode,
      discoveryDigest: artifact.discoveryDigest,
    })).resolves.toMatchObject({ status: 'discovering' });

    const [url, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://control.example/v2/apps/${artifact.appId}/runtime-setup/runs`,
    );
    expect(url).not.toContain('environment');
    expect(request.headers).toMatchObject({
      authorization: 'Bearer setup-secret',
      'content-type': 'application/json',
    });
    expect(String(request.body)).not.toContain('environmentId');
  });

  it('updates bounded progress and resumes status by run ID', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...runResponse,
        status: 'assessing',
        progress: { completed: 7, total: 12 },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...runResponse,
        status: 'waiting_for_interview',
        progress: { completed: 7, total: 12 },
      })));
    const client = new AppSetupClient({
      baseUrl: 'https://control.example',
      setupApiKey: 'setup-secret',
      appId: artifact.appId,
      fetchImpl,
    });

    await client.updateStatus(artifact.runId, {
      status: 'assessing',
      progress: { completed: 7, total: 12 },
    });
    await expect(client.getRun(artifact.runId)).resolves.toMatchObject({
      status: 'waiting_for_interview',
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `https://control.example/v2/apps/${artifact.appId}`
        + `/runtime-setup/runs/${artifact.runId}/status`,
      `https://control.example/v2/apps/${artifact.appId}`
        + `/runtime-setup/runs/${artifact.runId}`,
    ]);
  });

  it('uploads a validated final artifact', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ...runResponse,
        status: 'ready',
        artifactDigest: digest('F'),
      })),
    );
    const client = new AppSetupClient({
      baseUrl: 'https://control.example',
      setupApiKey: 'setup-secret',
      appId: artifact.appId,
      fetchImpl,
    });

    await expect(client.uploadArtifact(artifact)).resolves.toMatchObject({
      status: 'ready',
    });
    const [url, request] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://control.example/v2/apps/${artifact.appId}`
        + `/runtime-setup/runs/${artifact.runId}/artifact`,
    );
    expect(JSON.parse(String(request.body))).toEqual(artifact);
  });

  it('syncs an existing identical run using only create and upload requests', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...runResponse,
        status: 'ready',
        artifactDigest: digest('F'),
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...runResponse,
        status: 'ready',
        artifactDigest: digest('F'),
      })));
    const client = new AppSetupClient({
      baseUrl: 'https://control.example',
      setupApiKey: 'setup-secret',
      appId: artifact.appId,
      fetchImpl,
    });

    await expect(client.syncArtifact(artifact)).resolves.toMatchObject({
      status: 'ready',
      artifactDigest: digest('F'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url, init]) => [
      String(url),
      (init as RequestInit).method,
    ])).toEqual([
      [
        `https://control.example/v2/apps/${artifact.appId}/runtime-setup/runs`,
        'POST',
      ],
      [
        `https://control.example/v2/apps/${artifact.appId}`
          + `/runtime-setup/runs/${artifact.runId}/artifact`,
        'PUT',
      ],
    ]);
  });

  it('rejects an app mismatch before network access', async () => {
    const fetchImpl = vi.fn();
    const client = new AppSetupClient({
      baseUrl: 'https://control.example',
      setupApiKey: 'setup-secret',
      appId: id('99'),
      fetchImpl,
    });

    await expect(client.uploadArtifact(artifact)).rejects.toThrow(
      'App setup artifact targets a different app',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns bounded errors without credentials or response content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        'setup-secret private business response Bearer another-secret-value',
        { status: 403 },
      ),
    );
    const client = new AppSetupClient({
      baseUrl: 'https://control.example',
      setupApiKey: 'setup-secret',
      appId: artifact.appId,
      fetchImpl,
    });

    const error = await client.getRun(artifact.runId).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toBe('Glirastes app setup request failed (403)');
    expect(error.message).not.toContain('setup-secret');
    expect(error.message).not.toContain('private business');
  });

  it('rejects malformed response content without echoing it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ...runResponse,
        rawPrompt: 'private prompt',
      })),
    );
    const client = new AppSetupClient({
      baseUrl: 'https://control.example',
      setupApiKey: 'setup-secret',
      appId: artifact.appId,
      fetchImpl,
    });

    await expect(client.getRun(artifact.runId)).rejects.toThrow(
      'Invalid Glirastes app setup response',
    );
  });
});
