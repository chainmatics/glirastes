import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod-v3';
import type { ToolRiskClass } from '../../contracts/index.js';
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
  createLocalSchemaDigest,
  materializeManifestToolRegistry,
  type LocalToolBinding,
  type ToolRegistryDiagnostic,
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
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: uiSnapshot,
      bindings: [{
        ...uiBinding,
        actionBindingRef: 'task-details.wrong',
      }],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-011',
      reason: 'local-binding-mismatch',
      toolId: endpointManifestTool.toolId,
      mismatches: ['action binding'],
    }]);
  });

  it.each([
    ['source fingerprint', { sourceFingerprint: 'sha256:changed' }],
    ['method', { method: 'POST' as const }],
    ['path', { path: '/api/other' }],
    ['input schema digest', { inputSchemaDigest: 'sha256:changed' }],
    ['output schema digest', { outputSchemaDigest: 'sha256:changed' }],
  ])('disables only the tool with a mismatched %s', (label, override) => {
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: snapshot(),
      bindings: [{ ...binding, ...override }],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-011',
      reason: 'local-binding-mismatch',
      toolId: binding.toolId,
      mismatches: [label],
    }]);
  });

  it('encodes dotted manifest names into model-safe registry keys', () => {
    // Model providers reject '.' in function names (^[a-zA-Z0-9_-]+$), so a
    // manifest tool named by definitionId is exposed under a deterministic
    // model-safe encoding while keeping its signed identity untouched.
    const base = snapshot();
    const dotted = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{
          ...base.manifestRevision.tools[0]!,
          name: 'ui.taskView.switch',
        }],
      },
    };

    const registry = materializeManifestToolRegistry({
      snapshot: dotted,
      bindings: [binding],
    });

    expect(Object.keys(registry)).toEqual(['ui_taskView_switch']);
  });

  it('fails closed when two manifest names collide after encoding', () => {
    const base = snapshot();
    const first = base.manifestRevision.tools[0]!;
    const colliding = {
      ...base,
      agentRevision: {
        ...base.agentRevision,
        toolAllowlist: [first.toolId, 'tool-2'],
      },
      manifestRevision: {
        ...base.manifestRevision,
        tools: [
          { ...first, name: 'ui.navigate' },
          { ...first, toolId: 'tool-2', name: 'ui_navigate' },
        ],
      },
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [
          ...base.policyRevision.toolPolicies,
          { ...base.policyRevision.toolPolicies[0]!, toolId: 'tool-2' },
        ],
      },
    };

    expect(() => materializeManifestToolRegistry({
      snapshot: colliding,
      bindings: [
        binding,
        { ...binding, toolId: 'tool-2' },
      ],
    })).toThrow(/collide/i);
  });

  it('disables a tool without a local binding and reports it', () => {
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: snapshot(),
      bindings: [],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-010',
      reason: 'local-binding-missing',
      toolId: binding.toolId,
    }]);
  });

  it('keeps every other tool when one binding is missing', () => {
    const base = snapshot();
    const first = base.manifestRevision.tools[0]!;
    const secondToolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a10';
    const twoTools = {
      ...base,
      agentRevision: {
        ...base.agentRevision,
        toolAllowlist: [first.toolId, secondToolId],
      },
      manifestRevision: {
        ...base.manifestRevision,
        tools: [first, { ...first, toolId: secondToolId, name: 'archive_tasks' }],
      },
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [
          ...base.policyRevision.toolPolicies,
          { ...base.policyRevision.toolPolicies[0]!, toolId: secondToolId },
        ],
      },
    };
    const diagnostics: ToolRegistryDiagnostic[] = [];

    const registry = materializeManifestToolRegistry({
      snapshot: twoTools,
      bindings: [binding],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(Object.keys(registry)).toEqual(['list_tasks']);
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-010',
      reason: 'local-binding-missing',
      toolId: secondToolId,
    }]);
  });

  it('disables a tool without a runtime policy and reports it', () => {
    const base = snapshot();
    const unpolicied = {
      ...base,
      policyRevision: { ...base.policyRevision, toolPolicies: [] },
    };
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: unpolicied,
      bindings: [binding],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-POLICY-010',
      reason: 'runtime-policy-missing',
      toolId: binding.toolId,
    }]);
  });

  it('accepts a policy that raises the manifest risk and confirms it', () => {
    const base = snapshot();
    const raised = {
      ...base,
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [{
          ...base.policyRevision.toolPolicies[0]!,
          riskClass: 'delete' as const,
          requiresApproval: false,
        }],
      },
    };
    expect(materializeManifestToolRegistry({
      snapshot: raised,
      bindings: [binding],
    }).list_tasks?.needsApproval).toBe(true);
  });

  it('disables a tool whose policy sits below the manifest risk', () => {
    const base = snapshot();
    const lowered = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{ ...base.manifestRevision.tools[0]!, riskClass: 'write' as const }],
      },
    };
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: lowered,
      bindings: [binding],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-POLICY-011',
      reason: 'runtime-policy-risk-below-manifest',
      toolId: binding.toolId,
    }]);
  });

  it('reports an unavailable tool through console.warn by default without content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(materializeManifestToolRegistry({
        snapshot: snapshot(),
        bindings: [],
      })).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[glirastes] tool disabled for this turn',
        {
          code: 'E-BINDING-010',
          reason: 'local-binding-missing',
          toolId: binding.toolId,
        },
      );
      expect(JSON.stringify(warn.mock.calls))
        .not.toMatch(/description|schema|execute/i);
    } finally {
      warn.mockRestore();
    }
  });

  it('confirms tier-3 tools even when the policy does not ask for it', () => {
    const base = snapshot();
    const tierThree = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{ ...base.manifestRevision.tools[0]!, riskClass: 'delete' as const }],
      },
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [{
          ...base.policyRevision.toolPolicies[0]!,
          riskClass: 'delete' as const,
          requiresApproval: false,
        }],
      },
    };
    expect(materializeManifestToolRegistry({
      snapshot: tierThree,
      bindings: [binding],
    }).list_tasks?.needsApproval).toBe(true);
  });

  it('keeps a reviewed write relaxation unconfirmed', () => {
    const base = snapshot();
    const relaxedWrite = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{ ...base.manifestRevision.tools[0]!, riskClass: 'write' as const }],
      },
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [{
          ...base.policyRevision.toolPolicies[0]!,
          riskClass: 'write' as const,
          requiresApproval: false,
        }],
      },
    };
    expect(materializeManifestToolRegistry({
      snapshot: relaxedWrite,
      bindings: [binding],
    }).list_tasks?.needsApproval).toBe(false);
  });

  it.each(['Delete', 'constructor'])(
    'disables a tool whose manifest risk class %j is out of enum above its policy',
    (label) => {
      const base = snapshot();
      const unassessed = {
        ...base,
        manifestRevision: {
          ...base.manifestRevision,
          tools: [{
            ...base.manifestRevision.tools[0]!,
            riskClass: label as ToolRiskClass,
          }],
        },
      };
      const diagnostics: ToolRegistryDiagnostic[] = [];
      expect(materializeManifestToolRegistry({
        snapshot: unassessed,
        bindings: [binding],
        onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
      })).toEqual({});
      expect(diagnostics).toEqual([{
        code: 'E-POLICY-011',
        reason: 'runtime-policy-risk-below-manifest',
        toolId: binding.toolId,
      }]);
    },
  );

  it.each(['Delete', 'constructor'])(
    'confirms a tool whose policy risk class %j is out of enum',
    (label) => {
      const base = snapshot();
      const unassessed = {
        ...base,
        policyRevision: {
          ...base.policyRevision,
          toolPolicies: [{
            ...base.policyRevision.toolPolicies[0]!,
            riskClass: label as ToolRiskClass,
            requiresApproval: false,
          }],
        },
      };
      expect(materializeManifestToolRegistry({
        snapshot: unassessed,
        bindings: [binding],
      }).list_tasks?.needsApproval).toBe(true);
    },
  );
});

describe('createLocalSchemaDigest', () => {
  it('is deterministic and changes with structural validation rules', () => {
    const first = z.object({
      title: z.string().min(1),
      limit: z.number().max(50).optional(),
    });
    const equivalent = z.object({
      title: z.string().min(1),
      limit: z.number().max(50).optional(),
    });
    const changed = z.object({
      title: z.string().min(2),
      limit: z.number().max(50).optional(),
    });

    expect(createLocalSchemaDigest(first))
      .toBe(createLocalSchemaDigest(equivalent));
    expect(createLocalSchemaDigest(changed))
      .not.toBe(createLocalSchemaDigest(first));
    expect(createLocalSchemaDigest(first)).toMatch(
      /^sha256:[A-Za-z0-9_-]+$/,
    );
  });

  it('depends on schema meaning rather than shared object identity', () => {
    const sharedMember = z3.object({
      id: z3.string(),
      label: z3.string().optional(),
    });
    const shared = z3.object({
      registered: z3.array(sharedMember),
      discoverable: z3.array(sharedMember),
    });
    const expanded = z3.object({
      registered: z3.array(z3.object({
        id: z3.string(),
        label: z3.string().optional(),
      })),
      discoverable: z3.array(z3.object({
        id: z3.string(),
        label: z3.string().optional(),
      })),
    });

    expect(createLocalSchemaDigest(shared))
      .toBe(createLocalSchemaDigest(expanded));
  });

  it('ignores build-dependent function source formatting', () => {
    const verbose = {
      _def: {
        typeName: 'ZodString',
        errorMap: function errorMap(issue: unknown) {
          return issue ? { message: 'invalid' } : undefined;
        },
      },
      safeParse: () => ({ success: true as const, data: '' }),
    };
    const minified = {
      _def: {
        typeName: 'ZodString',
        errorMap: (a: unknown) => a ? { message: 'invalid' } : undefined,
      },
      safeParse: () => ({ success: true as const, data: '' }),
    };

    expect(createLocalSchemaDigest(verbose))
      .toBe(createLocalSchemaDigest(minified));
  });
});
