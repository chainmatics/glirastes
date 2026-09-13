import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { collectNextEndpointExecutions, reconcileExecutionInventory, discoverFoundationExecutions } from 'glirastes/codegen';
import { assertAppSetupSemanticParity } from 'glirastes/contracts';
import { createLocalRuntimeSource, createLocalSchemaDigest, createManagedTurnGuard, materializeManifestToolRegistry } from 'glirastes/runtime';
import { createAiSdkTools } from 'glirastes/ai-sdk';
import { endpointToolToTool, toolsToAiTools } from 'glirastes/server';

const appId = '019fb007-0000-7000-8000-000000000001';
export const tenantId = '019fb007-0000-7000-8000-000000000002';
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('base64url')}`;
const referenceDir = dirname(fileURLToPath(import.meta.url));
const limits = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

// This is an app-specific setup-agent output, NOT universal schema inference.
// The fixture's native query wrapper owns session/role/input/output checks.
// A different wrapper or route convention requires a new local assessment.
function usesNativeQuery(source, sourceFile) {
  const file = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
  const imports = file.statements.filter(ts.isImportDeclaration);
  const imported = (module, names) => imports.some((entry) =>
    ts.isStringLiteral(entry.moduleSpecifier) && entry.moduleSpecifier.text === module
    && entry.importClause?.namedBindings && ts.isNamedImports(entry.importClause.namedBindings)
    && names.every((name) => entry.importClause.namedBindings.elements.some((item) =>
      item.name.text === name && !item.propertyName && !item.isTypeOnly)));
  const handler = file.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === 'GET');
  const statement = handler?.body?.statements;
  const expression = statement?.length === 1 && ts.isReturnStatement(statement[0]) ? statement[0].expression : undefined;
  return imported('./contract.js', ['inputSchema', 'outputSchema'])
    && imported('../../../query.js', ['query'])
    && handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && handler.parameters.length === 1 && ts.isIdentifier(handler.parameters[0].name)
    && handler.parameters[0].name.text === 'request' && !handler.parameters[0].initializer
    && expression && ts.isCallExpression(expression) && expression.expression.getText(file) === 'query'
    && expression.arguments.length === 4
    && expression.arguments.slice(0, 3).map((arg) => arg.getText(file)).join(',') === 'request,inputSchema,outputSchema';
}

/** Run once per local build/process. Native modules are trusted app code. */
export async function generateReference({ rootDir, previous }) {
  const root = await realpath(rootDir);
  if (await readFile(resolve(root, 'src/query.js'), 'utf8')
    !== await readFile(resolve(referenceDir, 'native/src/query.js'), 'utf8')) {
    throw new Error('Native authorization wrapper changed; local assessment required');
  }
  const contracts = new Map();
  const executions = await collectNextEndpointExecutions({
    rootDir: root,
    resolveContract: async (candidate) => {
      const source = await readFile(resolve(root, candidate.sourceFile), 'utf8');
      if (candidate.method !== 'GET' || !usesNativeQuery(source, candidate.sourceFile)) return undefined;
      const importedWrapper = await realpath(resolve(root, dirname(candidate.sourceFile), '../../../query.js'));
      if (importedWrapper !== resolve(root, 'src/query.js')) return undefined;
      const contractFile = await realpath(resolve(root, dirname(candidate.sourceFile), 'contract.js'));
      const relativeFile = relative(root, contractFile);
      if (relativeFile === '..' || relativeFile.startsWith(`..${sep}`)) return undefined;
      const native = await import(pathToFileURL(contractFile).href);
      if (!native.inputSchema?.safeParse || !native.outputSchema?.safeParse || !native.outputSchema.description) return undefined;
      const key = `${candidate.method} ${candidate.path}`;
      contracts.set(key, native);
      return {
        definitionId: `query.${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
        inputSchemaDigest: createLocalSchemaDigest(native.inputSchema),
        outputSchemaDigest: createLocalSchemaDigest(native.outputSchema),
      };
    },
  });
  const generated = reconcileExecutionInventory({ appId, targetAppKey: 'native-query-fixture',
    previous, observed: { complete: true, executions } });
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory: generated.state.inventory });
  const handlers = new Map();
  const bindings = [];
  const candidates = [];
  for (const entry of generated.state.inventory.executions) {
    const native = contracts.get(entry.stableKey);
    const handler = await import(pathToFileURL(resolve(root, entry.sourceFile)).href);
    handlers.set(entry.path, handler.GET);
    const tool = endpointToolToTool({ id: entry.definitionId, toolName: entry.definitionId.replaceAll('.', '_'),
      description: native.outputSchema.description, method: entry.method, path: entry.path,
      inputSchema: native.inputSchema, outputSchema: native.outputSchema, needsApproval: false });
    bindings.push({ ...entry, tool });
    candidates.push({ toolId: entry.toolId, name: entry.definitionId, modelName: entry.definitionId.replaceAll('.', '_'),
      description: native.outputSchema.description, module: 'queries', sharedWith: [],
      usageHints: [native.outputSchema.description],
      presentation: { locale: 'en-US', singular: entry.path, plural: entry.path, approval: `Read ${entry.path}` },
      executionKind: 'endpoint', method: entry.method, path: entry.path, authBindingRef: 'native-session',
      allowedRoles: ['member'], operationGroup: 'read', riskClass: 'safe-read', enabled: true, requiresApproval: false,
      sourceFingerprint: entry.sourceFingerprint, inputSchemaDigest: entry.inputSchemaDigest, outputSchemaDigest: entry.outputSchemaDigest });
  }
  const promptDigest = hash('Use only the available native queries; ask when the target is unclear.');
  const artifact = assertAppSetupSemanticParity({ schemaVersion: 1, artifactId: randomUUID(), runId: randomUUID(), appId,
    discoveryDigest: discovery.inventoryDigest, assessmentMode: 'autonomous', status: 'ready', tools: candidates,
    planner: { plannerId: '019fb007-0000-7000-8000-000000000003', modelBindingRef: 'local-test',
      promptBindingRef: 'local-test', budgetProfileRef: 'fixture', toolIds: candidates.map((tool) => tool.toolId) },
    prompts: { bundleDigest: promptDigest, artifactRef: 'local://fixture/prompts', plannerDigest: promptDigest,
      appBehaviorDigest: promptDigest, responseStyleDigest: promptDigest, capabilityFragmentDigests: {} },
    warnings: [], generatedAt: new Date().toISOString(),
  }, candidates.map((tool) => tool.name));
  const source = createLocalRuntimeSource({ setupArtifact: artifact, bindings, localLimits: limits, identity: { tenantId } });
  return { ...generated, bindings,
    createTurn({ request, resolvePrincipal }) {
      const principal = resolvePrincipal();
      if (!principal) throw new Error('missing_principal');
      const snapshot = source.resolveTurnSnapshot({ turnId: randomUUID(), principal });
      const guard = createManagedTurnGuard({ snapshot, resolvePrincipal });
      const registry = materializeManifestToolRegistry({ snapshot, bindings });
      const context = { currentDate: new Date(), locale: 'en-US',
        callEndpoint: async ({ method, path }) => {
          const url = new URL(path, 'http://fixture.local');
          const handler = handlers.get(url.pathname);
          if (!handler) return { ok: false, status: 404, error: 'Unavailable' };
          const response = await handler(new Request(url, { method, headers: request.headers }));
          return { ok: response.ok, status: response.status, data: await response.json() };
        },
      };
      const tools = createAiSdkTools({ tools: toolsToAiTools(registry, context), ...guard });
      return { snapshot, async execute(stableKey, input) {
        const entry = generated.state.inventory.executions.find((candidate) => candidate.stableKey === stableKey);
        if (!entry) throw new Error('Tool unavailable');
        const native = contracts.get(stableKey);
        const parsed = native.inputSchema.safeParse(input);
        if (!parsed.success) throw new Error('Input does not match native contract');
        return tools[entry.definitionId.replaceAll('.', '_')].execute(parsed.data);
      } };
    },
  };
}
