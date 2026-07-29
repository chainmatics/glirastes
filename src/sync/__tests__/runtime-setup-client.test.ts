import { describe, expect, it, vi } from 'vitest';
import {
  parseLocalExecutionInventory,
  RuntimeSetupClient,
} from '../runtime-setup-client.js';

const sourceFingerprint = `sha256:${'A'.repeat(43)}`;
const toolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
const scan = {
  schemaVersion: 1 as const,
  generatedAt: '2026-07-29T00:00:00.000Z',
  candidates: [{
    sourceFile: 'src/app/api/tasks/route.ts',
    sourceFingerprint,
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
const importResult = {
  createdDrafts: 1,
  unchanged: 0,
  bindings: [{
    toolId,
    stableKey: 'GET /api/tasks',
    sourceFingerprint,
  }],
  tombstoneCandidates: [],
  interview: [],
};
const uiFingerprint = `sha256:${'B'.repeat(43)}`;
const inputSchemaDigest = `sha256:${'C'.repeat(43)}`;
const outputSchemaDigest = `sha256:${'D'.repeat(43)}`;

describe('RuntimeSetupClient', () => {
  it('rejects executable schemas or raw content in local inventory evidence', () => {
    expect(() => parseLocalExecutionInventory({
      schemaVersion: 1,
      executions: [{
        definitionId: 'ui.taskDetails.open',
        stableKey: 'UI ui.taskDetails.open',
        executionKind: 'ui',
        sourceFingerprint: uiFingerprint,
        inputSchemaDigest,
        outputSchemaDigest,
        actionBindingRef: 'ui.taskDetails.open',
        inputSchema: { type: 'object' },
      }],
    })).toThrow();
  });

  it('uploads a route scan to the app and environment scoped setup endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(importResult), { status: 201 }),
    );
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

  it('uploads content-free local execution evidence and validates every binding', async () => {
    const uiToolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906';
    const scanWithExecution = {
      ...scan,
      executions: [{
        definitionId: 'ui.taskDetails.open',
        stableKey: 'UI ui.taskDetails.open',
        executionKind: 'ui' as const,
        sourceFingerprint: uiFingerprint,
        inputSchemaDigest,
        outputSchemaDigest,
        actionBindingRef: 'ui.taskDetails.open',
      }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ...importResult,
        createdDrafts: 2,
        bindings: [
          ...importResult.bindings,
          {
            toolId: uiToolId,
            stableKey: 'UI ui.taskDetails.open',
            sourceFingerprint: uiFingerprint,
          },
        ],
      }), { status: 201 }),
    );
    const client = new RuntimeSetupClient({
      baseUrl: 'https://control.example/',
      apiKey: 'secret-key',
      appId: 'app-1',
      environmentId: 'env-1',
      fetchImpl,
    });

    await expect(client.importRouteScan(scanWithExecution)).resolves
      .toMatchObject({ createdDrafts: 2 });
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      executions: [{
        definitionId: 'ui.taskDetails.open',
        stableKey: 'UI ui.taskDetails.open',
        executionKind: 'ui',
        sourceFingerprint: uiFingerprint,
        inputSchemaDigest,
        outputSchemaDigest,
        actionBindingRef: 'ui.taskDetails.open',
      }],
    });
  });

  it('strips unknown raw source fields before upload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(importResult), { status: 201 }),
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

  it('rejects unexpected response content instead of persisting it locally', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ...importResult,
        bindings: [{
          ...importResult.bindings[0],
          rawSource: 'private source',
        }],
      }), { status: 201 }),
    );
    const client = new RuntimeSetupClient({
      baseUrl: 'https://control.example',
      apiKey: 'secret-key',
      appId: 'app-1',
      environmentId: 'env-1',
      fetchImpl,
    });

    await expect(client.importRouteScan(scan)).rejects.toThrow(
      'Invalid Glirastes setup import response',
    );
  });

  it('rejects a binding that does not match the uploaded route identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ...importResult,
        bindings: [{
          ...importResult.bindings[0],
          stableKey: 'GET /api/other',
        }],
      }), { status: 201 }),
    );
    const client = new RuntimeSetupClient({
      baseUrl: 'https://control.example',
      apiKey: 'secret-key',
      appId: 'app-1',
      environmentId: 'env-1',
      fetchImpl,
    });

    await expect(client.importRouteScan(scan)).rejects.toThrow(
      'Invalid Glirastes setup import response',
    );
  });
});
