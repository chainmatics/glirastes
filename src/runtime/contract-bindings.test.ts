import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppSetupArtifactSchema } from '../contracts/index.js';
import { endpointToolToTool, uiActionToolToTool } from '../server/core/index.js';
import {
  createContractBindings,
  createGeneratedRuntimeSource,
  type GeneratedEndpointToolBinding,
  type GeneratedToolBinding,
  type GeneratedToolModule,
  type GeneratedUiToolBinding,
} from './contract-bindings.js';
import { createJsonSchemaLike } from './json-schema.js';
import { createLocalSchemaDigest, materializeManifestToolRegistry } from './local-tool-bindings.js';

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const TENANT = id('f1');
const inputSchema = z.object({ status: z.enum(['open', 'done']).optional() }).strict();
const outputSchema = z.object({ tasks: z.array(z.string()) });
const jsonInput = createJsonSchemaLike({ type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false });
const limits = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

function candidate(toolId: string, method: 'GET' | 'POST' | 'DELETE', enabled: boolean, input: string, output: string) {
  const name = `tasks.${method.toLowerCase()}`;
  return {
    toolId, sourceFingerprint: digest(method[0]!), name, description: `Run ${name}.`,
    modelName: name.replace('.', '_'), module: 'tasks', sharedWith: [], usageHints: [`Run ${name}.`],
    presentation: { locale: 'en-US', singular: name, plural: name, approval: name },
    executionKind: 'endpoint', method, path: '/api/tasks', authBindingRef: 'endpoint-authorization',
    allowedRoles: [], operationGroup: method === 'GET' ? 'read' : method === 'POST' ? 'create' : 'delete',
    riskClass: method === 'GET' ? 'safe-read' : method === 'POST' ? 'write' : 'delete',
    enabled, requiresApproval: method !== 'GET', inputSchemaDigest: input, outputSchemaDigest: output,
  };
}

const tools = [
  candidate(id('a1'), 'GET', true, createLocalSchemaDigest(inputSchema), createLocalSchemaDigest(outputSchema)),
  candidate(id('a2'), 'POST', true, createLocalSchemaDigest(jsonInput), createLocalSchemaDigest(outputSchema)),
  candidate(id('a3'), 'DELETE', false, digest('X'), digest('Y')),
];
const setupArtifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready', tools,
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('a1'), id('a2')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
});

function binding(index: number, overrides: Partial<GeneratedEndpointToolBinding> = {}): GeneratedToolBinding {
  const entry = tools[index]!;
  const input = index === 0 ? inputSchema : jsonInput;
  return {
    toolId: entry.toolId, definitionId: entry.name, executionKind: 'endpoint', method: entry.method, path: entry.path,
    sourceFingerprint: entry.sourceFingerprint, inputSchemaDigest: entry.inputSchemaDigest, outputSchemaDigest: entry.outputSchemaDigest,
    inputSchema: input, outputSchema,
    tool: endpointToolToTool({
      id: entry.name, toolName: entry.modelName, description: entry.description, method: entry.method, path: entry.path,
      inputSchema: input, needsApproval: entry.requiresApproval,
    }),
    ...overrides,
  };
}

const module = (bindings: GeneratedToolBinding[]): GeneratedToolModule => ({ setupArtifact, createToolBindings: () => bindings });

describe('createContractBindings', () => {
  it('binds every matching enabled tool', () => {
    const result = createContractBindings(module([binding(0), binding(1)]));
    expect(result.disabled).toEqual([]);
    expect(result.bindings.map((entry) => entry.toolId)).toEqual([id('a1'), id('a2')]);
    expect(result.setupArtifact.tools.map((tool) => tool.enabled)).toEqual([true, true, false]);
  });

  it('disables only the tools whose live schema, binding or presence differs', () => {
    const tampered = createJsonSchemaLike({ type: 'object', properties: { title: { type: 'number' } }, additionalProperties: false });
    const result = createContractBindings(module([binding(0, { sourceFingerprint: digest('Z') }), binding(1, { inputSchema: tampered })]));
    expect(result.disabled).toEqual([
      { toolId: id('a1'), reason: 'binding-mismatch' },
      { toolId: id('a2'), reason: 'input-schema-digest-mismatch' },
    ]);
    expect(result.bindings).toEqual([]);
    const missing = createContractBindings(module([binding(0), binding(0)]));
    expect(missing.disabled).toEqual([
      { toolId: id('a1'), reason: 'binding-duplicated' },
      { toolId: id('a2'), reason: 'binding-missing' },
    ]);
  });

  it('feeds the standalone runtime with the remaining tools only', () => {
    const runtime = createGeneratedRuntimeSource(module([binding(0)]), { localLimits: limits, identity: { tenantId: TENANT } });
    const snapshot = runtime.source.resolveTurnSnapshot({
      turnId: 'turn-1',
      principal: { subjectId: 'alice', tenantId: TENANT, roles: ['member'], attributes: {} },
    });
    expect(snapshot.manifestRevision.tools.map((tool) => tool.toolId)).toEqual([id('a1')]);
    expect(runtime.disabled).toEqual([{ toolId: id('a2'), reason: 'binding-missing' }]);
  });
});

describe('generated UI tool bindings', () => {
  const navigationInput = createJsonSchemaLike({
    type: 'object',
    properties: { destination: { type: 'string', enum: ['/overview', '/tasks'] } },
    required: ['destination'],
    additionalProperties: false,
  });
  const uiOutput = createJsonSchemaLike({ type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] });
  const UI_ID = id('c1');
  const uiCandidate = {
    toolId: UI_ID, sourceFingerprint: digest('N'), name: 'ui.navigate', description: 'Open a page of this app.',
    modelName: 'ui_navigate', module: 'ui', sharedWith: [], usageHints: ['Open a page of this app.'],
    presentation: { locale: 'en-US', singular: 'Navigation', plural: 'Navigation', approval: 'Open a page' },
    executionKind: 'ui', actionBindingRef: 'glirastes.navigate', allowedRoles: [], operationGroup: 'ui',
    riskClass: 'safe-read', enabled: true, requiresApproval: false,
    inputSchemaDigest: createLocalSchemaDigest(navigationInput), outputSchemaDigest: createLocalSchemaDigest(uiOutput),
  };
  const uiArtifact = AppSetupArtifactSchema.parse({
    ...setupArtifact,
    tools: [uiCandidate],
    planner: { ...setupArtifact.planner, toolIds: [UI_ID] },
  });
  const uiBinding = (overrides: Partial<GeneratedUiToolBinding> = {}): GeneratedToolBinding => ({
    toolId: UI_ID, definitionId: 'ui.navigate', executionKind: 'ui', actionBindingRef: 'glirastes.navigate',
    sourceFingerprint: uiCandidate.sourceFingerprint, inputSchemaDigest: uiCandidate.inputSchemaDigest,
    outputSchemaDigest: uiCandidate.outputSchemaDigest, inputSchema: navigationInput, outputSchema: uiOutput,
    tool: uiActionToolToTool({
      id: 'ui.navigate', toolName: 'ui_navigate', description: 'Open a page of this app.',
      inputSchema: navigationInput, needsApproval: false, action: { kind: 'navigate' },
    }),
    ...overrides,
  });
  const uiModule = (bindings: GeneratedToolBinding[]): GeneratedToolModule => ({ setupArtifact: uiArtifact, createToolBindings: () => bindings });

  it('binds a UI tool and runs it through the standalone registry', async () => {
    const runtime = createGeneratedRuntimeSource(uiModule([uiBinding()]), { localLimits: limits, identity: { tenantId: TENANT } });
    expect(runtime.disabled).toEqual([]);
    expect(runtime.bindings).toEqual([expect.objectContaining({ executionKind: 'ui', actionBindingRef: 'glirastes.navigate' })]);
    const snapshot = runtime.source.resolveTurnSnapshot({
      turnId: 'turn-ui',
      principal: { subjectId: 'alice', tenantId: TENANT, roles: ['member'], attributes: {} },
    });
    const registry = materializeManifestToolRegistry({ snapshot, bindings: runtime.bindings });
    expect(await registry.ui_navigate!.execute({ destination: '/overview' }, {} as never)).toMatchObject({
      success: true,
      uiAction: { type: 'glirastes.navigate', payload: { href: '/overview' } },
    });
  });

  it('disables a UI tool whose action binding or kind differs', () => {
    expect(createContractBindings(uiModule([uiBinding({ actionBindingRef: 'native.navigate' })])).disabled)
      .toEqual([{ toolId: UI_ID, reason: 'binding-mismatch' }]);
    const asEndpoint = { ...binding(0), toolId: UI_ID, sourceFingerprint: uiCandidate.sourceFingerprint };
    expect(createContractBindings(uiModule([asEndpoint])).disabled)
      .toEqual([{ toolId: UI_ID, reason: 'binding-mismatch' }]);
  });
});
