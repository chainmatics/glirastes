import { describe, expect, it } from 'vitest';
import { defineTool } from '../../types.js';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from './turn-snapshot.test.js';
import { createTurnSnapshot } from '../turn-snapshot.js';
import {
  materializeManifestToolRegistry,
  type LocalToolBinding,
} from '../local-tool-bindings.js';

const localTool = defineTool({
  id: 'local.tasks.list',
  description: 'Stale local description.',
  inputSchema: {
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  },
  method: 'GET',
  needsApproval: true,
  execute: async () => ({ tasks: [] }),
});

const binding: LocalToolBinding = {
  toolId: manifestRevision.tools[0]!.toolId,
  sourceFingerprint: 'sha256:tool',
  executionKind: 'endpoint',
  method: 'GET',
  path: '/api/tasks',
  inputSchemaDigest: 'sha256:input',
  outputSchemaDigest: 'sha256:output',
  tool: localTool,
};

function snapshot() {
  return createTurnSnapshot({
    turnId: 'turn-1',
    agentRevision,
    manifestRevision,
    policyRevision,
    principal,
    localLimits,
  });
}

describe('materializeManifestToolRegistry', () => {
  it('joins platform semantics to a fingerprinted local executor', async () => {
    const registry = materializeManifestToolRegistry({
      snapshot: snapshot(),
      bindings: [binding],
    });

    expect(Object.keys(registry)).toEqual(['list_tasks']);
    expect(registry.list_tasks).toMatchObject({
      id: manifestRevision.tools[0]?.toolId,
      description: manifestRevision.tools[0]?.description,
      method: 'GET',
      needsApproval: false,
      inputSchema: localTool.inputSchema,
    });
    await expect(registry.list_tasks?.execute({}, {
      currentDate: new Date('2026-07-29T00:00:00.000Z'),
      locale: 'de-DE',
    })).resolves.toEqual({ tasks: [] });
  });

  it('exposes only tools enabled by agent, manifest, and policy', () => {
    const restrictedSnapshot = createTurnSnapshot({
      turnId: 'turn-1',
      agentRevision: { ...agentRevision, toolAllowlist: [] },
      manifestRevision,
      policyRevision,
      principal,
      localLimits,
    });

    expect(materializeManifestToolRegistry({
      snapshot: restrictedSnapshot,
      bindings: [binding],
    })).toEqual({});
  });

  it('materializes a UI action binding without an HTTP endpoint', () => {
    const endpointManifestTool = manifestRevision.tools[0]!;
    if (endpointManifestTool.executionKind !== 'endpoint') {
      throw new Error('Expected endpoint fixture');
    }
    const {
      method: _method,
      path: _path,
      authBindingRef: _authBindingRef,
      ...commonTool
    } = endpointManifestTool;
    const uiSnapshot = createTurnSnapshot({
      turnId: 'turn-1',
      agentRevision,
      manifestRevision: {
        ...manifestRevision,
        tools: [{
          ...commonTool,
          executionKind: 'ui',
          name: 'open_task_details',
          actionBindingRef: 'task-details.open',
        }],
      },
      policyRevision,
      principal,
      localLimits,
    });
    const uiBinding: LocalToolBinding = {
      toolId: endpointManifestTool.toolId,
      sourceFingerprint: endpointManifestTool.sourceFingerprint,
      executionKind: 'ui',
      actionBindingRef: 'task-details.open',
      inputSchemaDigest: endpointManifestTool.inputSchemaDigest,
      outputSchemaDigest: endpointManifestTool.outputSchemaDigest,
      tool: localTool,
    };
    const registry = materializeManifestToolRegistry({
      snapshot: uiSnapshot,
      bindings: [uiBinding],
    });

    expect(registry.open_task_details).toMatchObject({
      id: endpointManifestTool.toolId,
      description: endpointManifestTool.description,
    });
    expect(registry.open_task_details?.method).toBeUndefined();
    expect(() => materializeManifestToolRegistry({
      snapshot: uiSnapshot,
      bindings: [{
        ...uiBinding,
        actionBindingRef: 'task-details.wrong',
      }],
    })).toThrow(/local tool binding mismatch/i);
  });

  it.each([
    ['source fingerprint', { sourceFingerprint: 'sha256:changed' }],
    ['method', { method: 'POST' as const }],
    ['path', { path: '/api/other' }],
    ['input schema digest', { inputSchemaDigest: 'sha256:changed' }],
    ['output schema digest', { outputSchemaDigest: 'sha256:changed' }],
  ])('fails closed on a mismatched %s', (_label, override) => {
    expect(() => materializeManifestToolRegistry({
      snapshot: snapshot(),
      bindings: [{ ...binding, ...override }],
    })).toThrow(/local tool binding mismatch/i);
  });

  it('fails closed when an enabled manifest tool has no local binding', () => {
    expect(() => materializeManifestToolRegistry({
      snapshot: snapshot(),
      bindings: [],
    })).toThrow(/missing local tool binding/i);
  });
});
