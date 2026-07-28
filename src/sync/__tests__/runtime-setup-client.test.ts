import { describe, expect, it, vi } from 'vitest';
import { RuntimeSetupClient } from '../runtime-setup-client.js';

const scan = {
  schemaVersion: 1 as const,
  generatedAt: '2026-07-29T00:00:00.000Z',
  candidates: [{
    sourceFile: 'src/app/api/tasks/route.ts',
    sourceFingerprint: 'sha256:route',
    exportName: 'GET' as const,
    method: 'GET' as const,
    path: '/api/tasks',
    pathParams: [],
    queryParams: [],
    schemaBindings: [],
    authEvidence: ['resolveUser'],
    externalCallEvidence: [],
    riskClass: 'unknown' as const,
    autoApprovalEligible: false as const,
    reviewReasons: ['data-classification-unverified'],
  }],
  ignored: [],
};

describe('RuntimeSetupClient', () => {
  it('uploads a route scan to the app and environment scoped setup endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      createdDrafts: 1,
      unchanged: 0,
      tombstoneCandidates: [],
      interview: [],
    }), { status: 201 }));
    const client = new RuntimeSetupClient({
      baseUrl: 'https://control.example/',
      apiKey: 'secret-key',
      appId: 'app-1',
      environmentId: 'env-1',
      fetchImpl,
    });

    await expect(client.importRouteScan(scan)).resolves.toMatchObject({
      createdDrafts: 1,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://control.example/v1/apps/app-1/environments/env-1/runtime-setup/scans',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer secret-key',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('strips unknown raw source fields before upload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        createdDrafts: 1,
        unchanged: 0,
        tombstoneCandidates: [],
        interview: [],
      }), { status: 201 }),
    );
    const client = new RuntimeSetupClient({
      baseUrl: 'https://control.example',
      apiKey: 'secret-key',
      appId: 'app-1',
      environmentId: 'env-1',
      fetchImpl,
    });

    await client.importRouteScan({
      ...scan,
      sourceCode: 'private source',
      candidates: [{
        ...scan.candidates[0],
        rawSource: 'private source',
      }],
    } as typeof scan);

    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = String(request.body);
    expect(body).not.toContain('sourceCode');
    expect(body).not.toContain('rawSource');
    expect(body).not.toContain('private source');
  });

  it('surfaces a bounded platform error without echoing response content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('private server details', { status: 403 }),
    );
    const client = new RuntimeSetupClient({
      baseUrl: 'https://control.example',
      apiKey: 'secret-key',
      appId: 'app-1',
      environmentId: 'env-1',
      fetchImpl,
    });

    await expect(client.importRouteScan(scan)).rejects.toThrow(
      'Glirastes setup import failed (403)',
    );
  });
});
