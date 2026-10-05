import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from './__tests__/app-fixture.js';
import { renderGeneratedModule } from './emit-module.js';
import type { ToolContract, ToolContractsEntry } from './types.js';

afterEach(removeAppFixtures);

const id = (suffix: string) => `019fb701-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const NAVIGATE = {
  type: 'object',
  properties: { destination: { type: 'string', enum: ['/overview', '/tasks'] } },
  required: ['destination'],
  additionalProperties: false,
};
const RESULT = { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] };

const artifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready',
  tools: [{
    toolId: id('c1'), sourceFingerprint: digest('N'), name: 'ui.navigate', description: 'Open a page.',
    modelName: 'ui_navigate', executionKind: 'ui', actionBindingRef: 'glirastes.navigate', allowedRoles: [],
    operationGroup: 'ui', riskClass: 'safe-read', enabled: true, requiresApproval: false,
    inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  }],
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('c1')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-05T08:00:00.000Z',
});

const navigateContract: ToolContract = {
  source: 'ui-bridge', loadBearing: true, input: NAVIGATE, output: RESULT, params: { path: [], query: [], body: [] },
  interfaceDigest: digest('U'), runtime: { input: { kind: 'json', schema: NAVIGATE }, output: { kind: 'json', schema: RESULT } },
  uiAction: { kind: 'navigate' },
};

const contracts: ToolContractsEntry[] = [{
  toolId: id('c1'), stableKey: 'UI navigate', definitionId: 'ui.navigate',
  defaults: { operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
  contract: navigateContract,
}];

describe('chat interactions in the generated module', () => {
  it('emits the derived commands next to the tool catalog, byte-stable', () => {
    const input = { modulePath: 'src/generated/glirastes/tools.generated.js', artifact, contracts };
    const text = renderGeneratedModule(input);
    expect(renderGeneratedModule(input)).toBe(text);
    expect(text).toContain('export const chatInteractions = {');
    expect(text).toContain('"id": "open.overview"');
    expect(text).toContain('"destination": "/tasks"');
    expect(text.indexOf('export const chatInteractions')).toBeGreaterThan(text.indexOf('export const toolCatalog'));
  });

  it('emits empty interactions when no tool is enabled', () => {
    const disabled = AppSetupArtifactSchema.parse({ ...artifact, tools: [{ ...artifact.tools[0]!, enabled: false }] });
    const text = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: disabled, contracts });
    expect(text).toContain('export const chatInteractions = {\n  "commands": [],\n  "entities": [],\n  "schemaVersion": 1\n} as const;');
  });

  it('type-checks the readonly interactions against the shared data type', async () => {
    const generated = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts });
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
          paths: {
            'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
            'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
            'glirastes/chat-interactions': [join(SDK_ROOT, 'src/contracts/chat-interactions.ts')],
          },
        },
      }),
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import type { ChatInteractionsData } from 'glirastes/chat-interactions';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + 'export const data: ChatInteractionsData = generated.chatInteractions;\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
    const files = [app.path('src/consumer.ts'), app.path('src/generated/glirastes/tools.generated.ts')];
    const program = ts.createProgram(files, parsed.options);
    const diagnostics = files.flatMap((file) => program.getSemanticDiagnostics(program.getSourceFile(file)));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});
