import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { deriveToolPolicyDefaults } from '../../../contracts/tool-policy.js';
import type { EndpointMethod } from '../../../types.js';
import {
  createRouteSourceFingerprint,
  scanNextAppRoutes,
  toRoutePath,
} from '../../route-scanner.js';
import { compareCodeUnits } from '../canonical.js';
import {
  contractEntryItem,
  OPAQUE_SCHEMA_DIGEST,
  probeItemFor,
  probeKey,
  resolveEndpointContract,
  type ContractModuleCandidate,
  type ResolvedEndpointContract,
} from '../contract-tiers.js';
import { collectHandlerEvidence } from '../evidence.js';
import { findExclusion, importsChatHandler } from '../exclusions.js';
import { toolFinding } from '../findings.js';
import { analyzeRouteHandler, type HandlerAnalysis } from '../handler-analysis.js';
import { assignDefinitionIds } from '../identity.js';
import { inferResponseSchema } from '../output-inference.js';
import { createAppProgram, type AppProgram } from '../program.js';
import { validateResolutionEntry, type ResolutionEntry } from '../resolutions.js';
import type { SchemaProbeItem, SchemaProbeResult } from '../schema-probe.js';
import type {
  ExcludedTool,
  ObservedTool,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
  ToolSourceObservation,
} from '../types.js';

export const NEXT_DEFAULT_API_DIR = 'src/app/api';
const CONTRACT_FILE_NAMES = ['contract.ts', 'contract.tsx', 'contract.js', 'contract.mjs'];
/** Route exports Next.js serves that the generator does not turn into tools. */
const UNSUPPORTED_METHODS: ReadonlySet<string> = new Set(['OPTIONS']);
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx)$/;

interface RouteEntry {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  pathParams: string[];
  sourceFile: string;
  absoluteFile: string;
  sourceFingerprint: string;
  source: string;
}

interface AnalyzedRoute {
  entry: RouteEntry;
  analysis?: HandlerAnalysis;
  contractModule?: string;
}

interface RoutePiece {
  entry: RouteEntry;
  resolved?: ResolvedEndpointContract;
  findings: ToolFinding[];
  evidence: ObservedTool['evidence'];
  interface?: ObservedTool['interface'];
  files: string[];
}

interface EnumeratedRoutes {
  entries: RouteEntry[];
  findings: ToolFinding[];
  /** Exports of a method the generator does not enumerate; reported, never dropped. */
  unsupported: ExcludedTool[];
}

function incomplete(message: string): ToolSourceObservation {
  return {
    observations: [],
    findings: [toolFinding('E-INVENTORY-011', 'error', 'next-app', message)],
    complete: false,
    excluded: [],
  };
}

/**
 * Mirrors the discovery walk of `scanNextAppRoutes` (route.* files, no
 * `node_modules`, `.git` or `_private` folders). The scan has already passed
 * over the same tree, so it is known to be bounded and free of links.
 */
async function listRouteFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('_')) files.push(...await listRouteFiles(path));
    } else if (entry.isFile() && ROUTE_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
  }
}

/** Names a route file exports by local syntax; `export *` is already fatal upstream. */
function exportedNames(sourceFile: string, source: string): Set<string> {
  const file = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);
  for (const statement of file.statements) {
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.exportClause) continue;
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) names.add(element.name.text);
        }
      } else {
        names.add(statement.exportClause.name.text);
      }
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        names.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
      }
    }
  }
  return names;
}

async function enumerateRoutes(
  root: string,
  apiDir: string,
): Promise<EnumeratedRoutes | ToolSourceObservation> {
  let scan: Awaited<ReturnType<typeof scanNextAppRoutes>>;
  try {
    scan = await scanNextAppRoutes({ rootDir: root, apiDir, mode: 'source-discovery' });
  } catch {
    return incomplete('Next.js route discovery is incomplete: a linked, oversized or unreadable file, or too many routes.');
  }
  const fatal = (scan.findings ?? []).find((finding) => finding.code !== 'route-export-unresolved');
  if (fatal) {
    return incomplete(fatal.code === 'route-wildcard-export-unresolved'
      ? `${fatal.sourceFile} uses export *, so its handlers cannot be enumerated.`
      : `${fatal.sourceFile} cannot be parsed.`);
  }
  const sources = new Map<string, string>();
  const read = async (sourceFile: string): Promise<string> => {
    const cached = sources.get(sourceFile);
    if (cached !== undefined) return cached;
    const source = await readFile(join(root, sourceFile), 'utf8');
    sources.set(sourceFile, source);
    return source;
  };
  const entries = new Map<string, RouteEntry>();
  const findings: ToolFinding[] = [];
  const add = (entry: RouteEntry) => {
    const existing = entries.get(entry.stableKey);
    if (existing && existing.sourceFile !== entry.sourceFile) {
      findings.push(toolFinding('E-INVENTORY-010', 'error', entry.stableKey,
        `${existing.sourceFile} and ${entry.sourceFile} both handle ${entry.stableKey}.`));
      return;
    }
    entries.set(entry.stableKey, entry);
  };
  for (const candidate of scan.candidates) {
    add({
      stableKey: `${candidate.method} ${candidate.path}`,
      method: candidate.method,
      path: candidate.path,
      pathParams: [...candidate.pathParams],
      sourceFile: candidate.sourceFile,
      absoluteFile: join(root, candidate.sourceFile),
      sourceFingerprint: candidate.sourceFingerprint,
      source: await read(candidate.sourceFile),
    });
  }
  for (const finding of scan.findings ?? []) {
    if (finding.code !== 'route-export-unresolved' || !finding.exportName) continue;
    const absoluteFile = join(root, finding.sourceFile);
    const route = toRoutePath(resolve(root, apiDir), absoluteFile);
    const source = await read(finding.sourceFile);
    add({
      stableKey: `${finding.exportName} ${route.path}`,
      method: finding.exportName,
      path: route.path,
      pathParams: route.pathParams,
      sourceFile: finding.sourceFile,
      absoluteFile,
      sourceFingerprint: createRouteSourceFingerprint(source, finding.exportName, route.path),
      source,
    });
  }

  // The route reader drops OPTIONS without a trace, and a route file that
  // exports only OPTIONS yields no candidate at all: look at every route file.
  const unsupported = new Map<string, ExcludedTool>();
  const apiRoot = resolve(root, apiDir);
  for (const absoluteFile of (await listRouteFiles(apiRoot)).sort(compareCodeUnits)) {
    const sourceFile = relative(root, absoluteFile).split(sep).join('/');
    const route = toRoutePath(apiRoot, absoluteFile);
    const names = exportedNames(sourceFile, await read(sourceFile));
    for (const method of [...UNSUPPORTED_METHODS].sort(compareCodeUnits)) {
      if (!names.has(method)) continue;
      const stableKey = `${method} ${route.path}`;
      unsupported.set(stableKey, { stableKey, reason: 'unsupported-method', origin: 'code' });
    }
  }
  return {
    entries: [...entries.values()].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    findings,
    unsupported: [...unsupported.values()],
  };
}

function contractModuleOf(app: AppProgram, file: string): string | undefined {
  const sourceFile = app.sourceFile(file);
  if (!sourceFile) return undefined;
  const moduleSymbol = app.checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol || !app.checker.getExportsOfModule(moduleSymbol).some((symbol) => symbol.name === 'contract')) {
    return undefined;
  }
  return app.appRelative(file);
}

function observeRoute(
  ctx: ToolSourceContext,
  app: AppProgram,
  route: AnalyzedRoute,
  probes: ReadonlyMap<string, SchemaProbeResult>,
  resolution: ResolutionEntry | undefined,
): RoutePiece {
  const { entry, analysis, contractModule } = route;
  const files = [...new Set([
    entry.sourceFile,
    ...(contractModule ? [contractModule] : []),
    ...(analysis?.importedModules ?? []),
  ])].sort(compareCodeUnits);
  if (!analysis?.located?.fn) {
    return {
      entry,
      findings: [toolFinding('handler-unresolved', 'needs_attention', entry.stableKey,
        `The ${entry.method} export of ${entry.sourceFile} is not a function the generator can read.`)],
      evidence: { authEvidence: false, externalCall: false },
      files,
    };
  }
  const located = analysis.located;
  const evidence = collectHandlerEvidence({
    app, scope: located.scope, authHelpers: ctx.resolutions.conventions.authHelpers,
  });
  const inferredOutput = inferResponseSchema(app.checker, analysis.responseArguments);
  const candidate: ContractModuleCandidate | undefined = contractModule
    ? {
      module: contractModule,
      loadBearing: analysis.importedModules.includes(contractModule),
      result: probes.get(probeKey(contractEntryItem(contractModule, entry.method))) ?? { ok: false, reason: 'probe-failed' },
    }
    : undefined;
  const previousContract = ctx.previousContracts.get(entry.stableKey);
  const resolved = resolveEndpointContract({
    stableKey: entry.stableKey,
    method: entry.method,
    path: entry.path,
    pathParams: entry.pathParams,
    evidence: {
      schemaUses: analysis.schemaUses,
      queryKeys: analysis.queryKeys,
      repeatedQueryKeys: analysis.repeatedQueryKeys,
      bodyKeys: analysis.bodyKeys,
      readsBody: analysis.readsBody,
      ...(analysis.normalizedText !== undefined ? { normalizedText: analysis.normalizedText } : {}),
    },
    ...(inferredOutput ? { inferredOutput } : {}),
    probes,
    ...(candidate ? { contractModule: candidate } : {}),
    ...(resolution ? { resolution } : {}),
    ...(previousContract ? { previousContract } : {}),
  });
  const findings = [...resolved.findings];
  if (evidence.authEvidence.length === 0) {
    findings.push(toolFinding('auth-evidence-missing', 'needs_attention', entry.stableKey,
      `No session or auth helper call was found for ${entry.stableKey}; the tool stays disabled until the endpoint's authorization is visible.`));
  }
  return {
    entry,
    resolved,
    findings,
    evidence: {
      authEvidence: evidence.authEvidence.length > 0,
      externalCall: evidence.externalCall,
      ...(resolved.declaredEffect ? { declaredEffect: resolved.declaredEffect } : {}),
      ...(located.jsDoc ? { jsDoc: located.jsDoc } : {}),
    },
    interface: {
      digest: resolved.interfaceDigest,
      params: resolved.contract?.params ?? {
        path: [...entry.pathParams],
        query: [...analysis.queryKeys],
        body: analysis.bodyKeys === 'opaque' ? 'opaque' : [...analysis.bodyKeys],
      },
    },
    files,
  };
}

function toObserved(piece: RoutePiece, definitionId: string): ObservedTool {
  const { entry, resolved } = piece;
  return {
    execution: {
      definitionId,
      stableKey: entry.stableKey,
      executionKind: 'endpoint',
      sourceKind: 'next-app',
      sourceFile: entry.sourceFile,
      method: entry.method,
      path: entry.path,
      sourceFingerprint: entry.sourceFingerprint,
      inputSchemaDigest: resolved?.inputSchemaDigest ?? OPAQUE_SCHEMA_DIGEST,
      outputSchemaDigest: resolved?.outputSchemaDigest ?? OPAQUE_SCHEMA_DIGEST,
    },
    ...(resolved?.contract ? { contract: resolved.contract } : {}),
    ...(piece.interface ? { interface: piece.interface } : {}),
    files: piece.files,
    evidence: piece.evidence,
    findings: piece.findings,
    ...(resolved && Object.keys(resolved.prose).length > 0 ? { prose: resolved.prose } : {}),
  };
}

async function observeNextEndpoints(ctx: ToolSourceContext, apiDir: string): Promise<ToolSourceObservation> {
  if (!existsSync(resolve(ctx.root, apiDir))) {
    return { observations: [], findings: [], complete: true, excluded: [] };
  }
  const enumerated = await enumerateRoutes(ctx.root, apiDir);
  if (!('entries' in enumerated)) return enumerated;
  const findings: ToolFinding[] = [...enumerated.findings];
  const excluded: ExcludedTool[] = [...enumerated.unsupported];
  const kept: RouteEntry[] = [];
  const policyExcludes = ctx.policy.exclude ?? [];
  for (const entry of enumerated.entries) {
    const exclusion = findExclusion({
      stableKey: entry.stableKey,
      method: entry.method,
      path: entry.path,
      chatHandler: importsChatHandler(entry.source),
    }, policyExcludes);
    if (exclusion) excluded.push(exclusion);
    else kept.push(entry);
  }
  excluded.sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  if (kept.length === 0) return { observations: [], findings, complete: true, excluded };

  const contractFiles = new Map<string, string>();
  for (const entry of kept) {
    const directory = dirname(entry.absoluteFile);
    if (contractFiles.has(directory)) continue;
    const file = CONTRACT_FILE_NAMES.map((name) => join(directory, name)).find((candidate) => existsSync(candidate));
    if (file) contractFiles.set(directory, file);
  }
  const app = createAppProgram({
    root: ctx.root,
    rootNames: [...new Set([...kept.map((entry) => entry.absoluteFile), ...contractFiles.values()])],
  });
  const conventions = ctx.resolutions.conventions;
  const analyzed: AnalyzedRoute[] = kept.map((entry) => {
    const sourceFile = app.sourceFile(entry.absoluteFile);
    const analysis = sourceFile
      ? analyzeRouteHandler({ app, sourceFile, method: entry.method, conventions })
      : undefined;
    const contractFile = contractFiles.get(dirname(entry.absoluteFile));
    const contractModule = contractFile ? contractModuleOf(app, contractFile) : undefined;
    return { entry, ...(analysis ? { analysis } : {}), ...(contractModule ? { contractModule } : {}) };
  });

  const resolutions = new Map<string, ResolutionEntry>();
  for (const { entry, analysis } of analyzed) {
    const raw = ctx.resolutions.entries.get(entry.stableKey);
    if (raw === undefined) continue;
    const validated = validateResolutionEntry({
      stableKey: entry.stableKey,
      raw,
      evidence: {
        pathParams: entry.pathParams,
        queryKeys: analysis?.queryKeys ?? [],
        bodyKeys: analysis?.bodyKeys ?? 'opaque',
      },
      codeRiskClass: deriveToolPolicyDefaults({
        executionKind: 'endpoint', method: entry.method, path: entry.path, definitionId: '',
      }).riskClass,
    });
    findings.push(...validated.findings);
    if (validated.entry) resolutions.set(entry.stableKey, validated.entry);
  }

  const items = new Map<string, SchemaProbeItem>();
  const request = (item: SchemaProbeItem) => items.set(probeKey(item), item);
  for (const { entry, analysis, contractModule } of analyzed) {
    for (const use of analysis?.schemaUses ?? []) {
      if (use.binding) request(probeItemFor(use.binding, use.role === 'output' ? 'output' : 'input'));
    }
    if (contractModule) request(contractEntryItem(contractModule, entry.method));
    const resolution = resolutions.get(entry.stableKey);
    if (resolution?.input?.schemaRef) request(probeItemFor(resolution.input.schemaRef, 'input'));
    if (resolution?.output?.schemaRef) request(probeItemFor(resolution.output.schemaRef, 'output'));
  }
  const keys = [...items.keys()].sort(compareCodeUnits);
  const results = keys.length > 0 ? await ctx.probe.probe(ctx.root, keys.map((key) => items.get(key)!)) : [];
  const probes = new Map<string, SchemaProbeResult>(keys.map((key, index) => [
    key,
    results[index] ?? { ok: false, reason: 'probe-failed' },
  ]));

  const pieces = analyzed.map((route) => observeRoute(ctx, app, route, probes, resolutions.get(route.entry.stableKey)));
  const naming = assignDefinitionIds(
    pieces.map(({ entry, resolved }) => ({
      stableKey: entry.stableKey,
      method: entry.method,
      path: entry.path,
      ...(resolved?.explicitId ? { explicitId: resolved.explicitId } : {}),
    })),
    new Map((ctx.previous?.inventory.executions ?? []).map((execution) => [execution.stableKey, execution.definitionId])),
  );
  findings.push(...naming.findings);
  return {
    observations: pieces.map((piece) => toObserved(piece, naming.ids.get(piece.entry.stableKey)!)),
    findings,
    complete: true,
    excluded,
  };
}

export function createNextEndpointSource(options: { apiDir?: string } = {}): ToolSource {
  const apiDir = options.apiDir ?? NEXT_DEFAULT_API_DIR;
  return { kind: 'next-app', observe: (ctx) => observeNextEndpoints(ctx, apiDir) };
}
