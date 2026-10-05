import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from './__tests__/app-fixture.js';
import { renderGeneratedModule } from './emit-module.js';
import type { ToolContract, ToolContractsEntry } from './types.js';

afterEach(removeAppFixtures);

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const NOTE = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };

function candidate(toolId: string, name: string, method: 'GET' | 'POST', enabled: boolean) {
  return {
    toolId, sourceFingerprint: digest('F'), name, description: `Run ${name}.`, modelName: name.replace('.', '_'),
    module: 'notes', sharedWith: [], usageHints: [`Run ${name}.`],
    presentation: { locale: 'en-US', singular: name, plural: name, approval: name },
    executionKind: 'endpoint', method, path: '/api/notes', authBindingRef: 'endpoint-authorization', allowedRoles: [],
    operationGroup: method === 'GET' ? 'read' : 'create', riskClass: method === 'GET' ? 'safe-read' : 'write',
    enabled, requiresApproval: method !== 'GET', inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  };
}

const artifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready',
  tools: [candidate(id('a1'), 'notes.create', 'POST', true), candidate(id('a2'), 'notes.list', 'GET', true), candidate(id('a3'), 'notes.archive', 'POST', false)],
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('a1'), id('a2')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
});

function contract(runtime: ToolContract['runtime']): ToolContract {
  return {
    source: 'native', loadBearing: true, input: NOTE, output: {}, params: { path: [], query: [], body: ['title'] },
    interfaceDigest: digest('N'), runtime,
  };
}

const defaults = { operationGroup: 'create' as const, riskClass: 'write' as const, requiresApproval: true, rulesVersion: 1 as const };

function contracts(schemaModule: string): ToolContractsEntry[] {
  return [
    {
      toolId: id('a1'), stableKey: 'POST /api/notes', definitionId: 'notes.create', defaults,
      contract: contract({
        input: { kind: 'module-export', module: schemaModule, export: 'createNote', property: [] },
        output: { kind: 'json', schema: { type: 'object', properties: { id: { type: 'string' } } } },
      }),
    },
    {
      toolId: id('a2'), stableKey: 'GET /api/notes', definitionId: 'notes.list', defaults,
      contract: contract({
        input: { kind: 'json', schema: { type: 'object', properties: {}, additionalProperties: false } },
        output: { kind: 'module-export', module: schemaModule, export: 'contract', property: ['GET', 'output'] },
      }),
    },
    { toolId: id('a3'), stableKey: 'POST /api/notes/archive', definitionId: 'notes.archive', defaults, contract: null },
  ];
}

describe('renderGeneratedModule', () => {
  it('emits a deterministic, syntactically valid TypeScript module for enabled tools only', () => {
    const input = { modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts: contracts('src/app/api/notes/schemas.ts') };
    const text = renderGeneratedModule(input);
    expect(renderGeneratedModule(input)).toBe(text);
    expect(text).toContain("import { createJsonSchemaLike } from 'glirastes/runtime';");
    expect(text).toContain("import { endpointToolToTool } from 'glirastes/server';");
    expect(text).toContain('import * as m0 from "../../app/api/notes/schemas";');
    expect(text).toContain(`export type GeneratedToolId = "${id('a1')}" | "${id('a2')}";`);
    expect(text).toContain('m0.contract.GET.output');
    expect(text).toContain('] as const;');
    expect(text.slice(text.indexOf('export const toolCatalog'))).not.toContain(id('a3'));
    const output = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    expect(output.diagnostics ?? []).toEqual([]);
  });

  it('keeps extensions and drops type syntax for JavaScript targets', () => {
    const text = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.js', artifact, contracts: contracts('src/app/api/notes/schemas.js'),
    });
    expect(text).toContain('import * as m0 from "../../app/api/notes/schemas.js";');
    expect(text).not.toContain('as const');
    expect(text).not.toContain('export type');
  });

  it('emits an empty module when no tool is enabled', () => {
    const empty = AppSetupArtifactSchema.parse({ ...artifact, tools: [artifact.tools[2]], planner: { ...artifact.planner, toolIds: [] } });
    const text = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: empty, contracts: contracts('src/a.ts') });
    expect(text).toContain('export type GeneratedToolId = never;');
    expect(text).toContain('  return [];');
    expect(text).not.toContain('glirastes/server');
  });

  it('type-checks under strict TypeScript against the SDK runtime surface', async () => {
    const generated = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts: contracts('src/app/api/notes/schemas.ts'),
    });
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
          paths: {
            'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
            'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
          },
        },
      }),
      'src/app/api/notes/schemas.ts': "import { z } from 'zod';\n"
        + 'export const createNote = z.object({ title: z.string() }).strict();\n'
        + 'export const contract = { GET: { output: z.object({ notes: z.array(z.string()) }) } };\n',
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import { createContractBindings } from 'glirastes/runtime';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + 'export const bound = createContractBindings(generated);\n'
        + 'export const ids: generated.GeneratedToolId[] = generated.toolCatalog.map((entry) => entry.toolId);\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
    const files = [app.path('src/consumer.ts'), app.path('src/generated/glirastes/tools.generated.ts')];
    const program = ts.createProgram(files, parsed.options);
    const diagnostics = files.flatMap((file) => program.getSemanticDiagnostics(program.getSourceFile(file)));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});

describe('renderGeneratedModule with UI tools', () => {
  const NAVIGATE = {
    type: 'object',
    properties: { destination: { type: 'string', enum: ['/overview', '/tasks'] } },
    required: ['destination'],
    additionalProperties: false,
  };
  const FILTER = {
    type: 'object',
    properties: { status: { type: 'string', enum: ['done', 'open'] } },
    additionalProperties: false,
  };
  const RESULT = { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] };
  const uiCandidate = (toolId: string, name: string) => ({
    toolId, sourceFingerprint: digest(name === 'ui.navigate' ? 'N' : 'L'), name, description: `Run ${name}.`,
    modelName: name.replace(/\./g, '_'), module: 'ui', sharedWith: [], usageHints: [`Run ${name}.`],
    presentation: { locale: 'en-US', singular: name, plural: name, approval: name },
    executionKind: 'ui', actionBindingRef: 'glirastes.navigate', allowedRoles: [], operationGroup: 'ui',
    riskClass: 'safe-read', enabled: true, requiresApproval: false, inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  });
  const uiArtifact = AppSetupArtifactSchema.parse({
    ...artifact,
    tools: [artifact.tools[0], uiCandidate(id('c1'), 'ui.navigate'), uiCandidate(id('c2'), 'ui.filter.tasks')],
    planner: { ...artifact.planner, toolIds: [id('a1'), id('c1'), id('c2')] },
  });
  const uiDefaults = { operationGroup: 'ui' as const, riskClass: 'safe-read' as const, requiresApproval: false, rulesVersion: 1 as const };
  const uiContract = (input: Record<string, unknown>, uiAction: NonNullable<ToolContract['uiAction']>): ToolContract => ({
    source: 'ui-bridge', loadBearing: true, input, output: RESULT, params: { path: [], query: [], body: [] },
    interfaceDigest: digest('U'), runtime: { input: { kind: 'json', schema: input }, output: { kind: 'json', schema: RESULT } },
    uiAction,
  });
  const uiContracts = (schemaModule: string): ToolContractsEntry[] => [
    contracts(schemaModule)[0]!,
    {
      toolId: id('c1'), stableKey: 'UI navigate', definitionId: 'ui.navigate', defaults: uiDefaults,
      contract: uiContract(NAVIGATE, { kind: 'navigate' }),
    },
    {
      toolId: id('c2'), stableKey: 'UI filter /tasks', definitionId: 'ui.filter.tasks', defaults: uiDefaults,
      contract: uiContract(FILTER, { kind: 'filter', destination: '/tasks', keys: [{ key: 'status' }] }),
    },
  ];

  it('binds navigation and filter tools through uiActionToolToTool with their action', () => {
    const text = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.js', artifact: uiArtifact, contracts: uiContracts('src/app/api/notes/schemas.js'),
    });
    expect(text).toContain("import { endpointToolToTool, uiActionToolToTool } from 'glirastes/server';");
    expect(text).toContain('"actionBindingRef": "glirastes.navigate"');
    expect(text).toContain('"kind": "filter"');
    expect(text.match(/uiActionToolToTool\(\{/g)).toHaveLength(2);
    const output = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    expect(output.diagnostics ?? []).toEqual([]);
  });

  it('refuses an enabled UI tool without its action instead of emitting a dead binding', () => {
    const broken = uiContracts('src/a.ts').map((entry) => (
      entry.toolId === id('c1') ? { ...entry, contract: { ...entry.contract!, uiAction: undefined } } : entry
    ));
    expect(() => renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: uiArtifact, contracts: broken }))
      .toThrow('Enabled UI tool ui.navigate has no UI action to bind.');
  });

  it('type-checks UI bindings under strict TypeScript against the SDK runtime surface', async () => {
    const generated = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: uiArtifact, contracts: uiContracts('src/app/api/notes/schemas.ts'),
    });
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
          paths: {
            'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
            'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
          },
        },
      }),
      'src/app/api/notes/schemas.ts': "import { z } from 'zod';\n"
        + 'export const createNote = z.object({ title: z.string() }).strict();\n',
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import { createContractBindings } from 'glirastes/runtime';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + 'export const bound = createContractBindings(generated);\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
    const files = [app.path('src/consumer.ts'), app.path('src/generated/glirastes/tools.generated.ts')];
    const program = ts.createProgram(files, parsed.options);
    const diagnostics = files.flatMap((file) => program.getSemanticDiagnostics(program.getSourceFile(file)));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});
