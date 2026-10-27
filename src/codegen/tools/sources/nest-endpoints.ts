import ts from 'typescript';
import { deriveToolPolicyDefaults } from '../../../contracts/tool-policy.js';
import type { EndpointMethod } from '../../../types.js';
import { createRouteSourceFingerprint } from '../../route-scanner.js';
import { compareCodeUnits } from '../canonical.js';
import {
  OPAQUE_SCHEMA_DIGEST,
  probeItemFor,
  probeKey,
  resolveEndpointContract,
  type ResolvedEndpointContract,
} from '../contract-tiers.js';
import { collectHandlerEvidence } from '../evidence.js';
import { findExclusion, hasAiIgnoreMarker, importsChatHandler } from '../exclusions.js';
import { toolFinding } from '../findings.js';
import { isSchemaExpression, resolveSchemaBinding, type SchemaUse } from '../handler-analysis.js';
import { jsDocOf, normalizedNodeText, unwrapExpression } from '../handler-locator.js';
import { assignDefinitionIds } from '../identity.js';
import { typeToJsonSchema } from '../output-inference.js';
import { createAppProgram, type AppProgram } from '../program.js';
import { validateResolutionEntry, type ResolutionEntry } from '../resolutions.js';
import type { SchemaProbeItem, SchemaProbeResult } from '../schema-probe.js';
import type {
  ExcludedTool,
  JsonSchemaLike,
  ObservedTool,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
  ToolSourceObservation,
} from '../types.js';
import { scanAppSources, type AppSourceFile } from './app-files.js';

export const NEST_DEFAULT_SRC_DIR = 'src';
const NEST_COMMON = '@nestjs/common';
const NEST_CORE = '@nestjs/core';
const NEST_ZOD = 'nestjs-zod';
/** The HTTP method decorators of `@nestjs/common` that become endpoint tools. */
export const NEST_METHOD_DECORATORS: Readonly<Record<string, EndpointMethod>> = {
  Get: 'GET', Head: 'HEAD', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE',
};
/** Routes Nest serves that the generator does not turn into tools; reported, never dropped. */
const UNSUPPORTED_DECORATORS: Readonly<Record<string, string>> = { All: 'ALL', Options: 'OPTIONS', Search: 'SEARCH' };
const PARAM_ROLES: Readonly<Record<string, 'body' | 'query' | 'path'>> = { Body: 'body', Query: 'query', Param: 'path' };
const PARSE_METHODS = new Set(['parse', 'parseAsync']);
const NEST_MARKERS = /@nestjs\/(?:common|core)/;

interface NestImports {
  /** Local name → exported name, for named imports of `@nestjs/common`. */
  common: Map<string, string>;
  commonNamespaces: Set<string>;
  core: Set<string>;
  createZodDto: Set<string>;
}

interface NestEntry {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  pathParams: string[];
  sourceFile: string;
  absoluteFile: string;
  sourceFingerprint: string;
  source: string;
  className: string;
  methodName: string;
  classGuarded: boolean;
}

interface NestApp {
  prefix: string;
  globalGuard: boolean;
  globalPipe: boolean;
}

interface EnumeratedNest {
  entries: NestEntry[];
  excluded: ExcludedTool[];
  findings: ToolFinding[];
}

interface NestPiece {
  entry: NestEntry;
  resolved?: ResolvedEndpointContract;
  findings: ToolFinding[];
  evidence: ObservedTool['evidence'];
  interface?: ObservedTool['interface'];
  files: string[];
}

function incomplete(message: string): ToolSourceObservation {
  return {
    observations: [],
    findings: [toolFinding('E-INVENTORY-011', 'error', 'nest', message)],
    complete: false,
    excluded: [],
  };
}

function readImports(file: ts.SourceFile): NestImports {
  const imports: NestImports = { common: new Map(), commonNamespaces: new Set(), core: new Set(), createZodDto: new Set() };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (module === NEST_COMMON && bindings && ts.isNamespaceImport(bindings)) imports.commonNamespaces.add(bindings.name.text);
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const exported = (element.propertyName ?? element.name).text;
      if (module === NEST_COMMON) imports.common.set(element.name.text, exported);
      if (module === NEST_CORE) imports.core.add(exported);
      if (module === NEST_ZOD && exported === 'createZodDto') imports.createZodDto.add(element.name.text);
    }
  }
  return imports;
}

/** The `@nestjs/common` export a decorator calls, e.g. `Get` for `@Get(':id')` or `@common.Get()`. */
function decoratorName(decorator: ts.Decorator, imports: NestImports): { name: string; args: ts.NodeArray<ts.Expression> } | undefined {
  const call = decorator.expression;
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const name = imports.common.get(callee.text);
    return name ? { name, args: call.arguments } : undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && imports.commonNamespaces.has(callee.expression.text)) {
    return { name: callee.name.text, args: call.arguments };
  }
  return undefined;
}

function decoratorsOf(node: ts.Node, imports: NestImports): Array<{ name: string; args: ts.NodeArray<ts.Expression> }> {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  return decorators.flatMap((decorator) => {
    const found = decoratorName(decorator, imports);
    return found ? [found] : [];
  });
}

function literalText(node: ts.Expression | undefined): string | undefined {
  if (!node) return '';
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** `@Controller()`, `@Controller('tasks')` or `@Controller({ path: 'tasks' })`; anything else is not enumerable. */
function controllerPath(args: ts.NodeArray<ts.Expression>): string | undefined {
  if (args.length > 1) return undefined;
  const [first] = args;
  if (first && ts.isObjectLiteralExpression(first)) {
    let path = '';
    for (const property of first.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return undefined;
      if (property.name.text !== 'path') return undefined;
      const text = literalText(property.initializer);
      if (text === undefined) return undefined;
      path = text;
    }
    return path;
  }
  return literalText(first);
}

function joinPath(...parts: string[]): string {
  const segments = parts.flatMap((part) => part.split('/')).filter(Boolean);
  return `/${segments.join('/')}`;
}

/** Path parameters, or undefined for a wildcard, optional or pattern segment the generator cannot fill. */
function pathParamsOf(path: string): string[] | undefined {
  const params: string[] = [];
  for (const segment of path.split('/').filter(Boolean)) {
    if (/[*?+(){}]/.test(segment)) return undefined;
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
      params.push(name);
    } else if (segment.includes(':')) {
      return undefined;
    }
  }
  return params;
}

function callsMember(node: ts.Node, member: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
      && child.expression.name.text === member) calls.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

function mentions(file: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(child) && child.text === name && !ts.isImportSpecifier(child.parent)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(file);
  return found;
}

/** App-wide settings from `main.ts` and the modules: global prefix, guards and pipes. */
function readApp(files: ReadonlyArray<{ file: AppSourceFile; ast: ts.SourceFile; imports: NestImports }>): NestApp | string {
  let prefix: string | undefined;
  let globalGuard = false;
  let globalPipe = false;
  for (const { file, ast, imports } of files) {
    if (imports.core.has('RouterModule')) {
      return `${file.path} uses RouterModule, whose route prefixes the generator does not read.`;
    }
    for (const call of callsMember(ast, 'setGlobalPrefix')) {
      const value = call.arguments.length === 1 ? literalText(call.arguments[0]) : undefined;
      if (value === undefined) return `${file.path} sets a global prefix that is not one string literal.`;
      if (prefix !== undefined && prefix !== value) return `${file.path} sets a second, different global prefix.`;
      prefix = value;
    }
    if (callsMember(ast, 'enableVersioning').length > 0) {
      return `${file.path} enables versioning, whose route prefixes the generator does not read.`;
    }
    if (callsMember(ast, 'useGlobalGuards').length > 0 || (imports.core.has('APP_GUARD') && mentions(ast, 'APP_GUARD'))) {
      globalGuard = true;
    }
    if (callsMember(ast, 'useGlobalPipes').length > 0 || (imports.core.has('APP_PIPE') && mentions(ast, 'APP_PIPE'))) {
      globalPipe = true;
    }
  }
  return { prefix: prefix ?? '', globalGuard, globalPipe };
}

function enumerate(
  files: ReadonlyArray<{ file: AppSourceFile; ast: ts.SourceFile; imports: NestImports }>,
  app: NestApp,
): EnumeratedNest | string {
  const entries = new Map<string, NestEntry>();
  const excluded = new Map<string, ExcludedTool>();
  const findings: ToolFinding[] = [];
  for (const { file, ast, imports } of files) {
    for (const statement of ast.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const classDecorators = decoratorsOf(statement, imports);
      const controller = classDecorators.find((decorator) => decorator.name === 'Controller');
      if (!controller) continue;
      const className = statement.name?.text ?? 'default';
      const base = controllerPath(controller.args);
      if (base === undefined) return `The @Controller path of ${className} in ${file.path} is not one string literal.`;
      const classGuarded = classDecorators.some((decorator) => decorator.name === 'UseGuards');
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        for (const decorator of decoratorsOf(member, imports)) {
          const method = NEST_METHOD_DECORATORS[decorator.name];
          const unsupported = UNSUPPORTED_DECORATORS[decorator.name];
          if (!method && !unsupported) continue;
          const own = decorator.args.length <= 1 ? literalText(decorator.args[0]) : undefined;
          if (own === undefined) {
            return `The @${decorator.name} path of ${className}.${member.name.text} in ${file.path} is not one string literal.`;
          }
          const path = joinPath(app.prefix, base, own);
          if (unsupported) {
            const stableKey = `${unsupported} ${path}`;
            excluded.set(stableKey, { stableKey, reason: 'unsupported-method', origin: 'code' });
            continue;
          }
          const stableKey = `${method} ${path}`;
          const pathParams = pathParamsOf(path);
          if (!pathParams) {
            excluded.set(stableKey, { stableKey, reason: 'unsupported-path', origin: 'code' });
            continue;
          }
          const existing = entries.get(stableKey);
          if (existing) {
            findings.push(toolFinding('E-INVENTORY-010', 'error', stableKey,
              `${existing.className}.${existing.methodName} and ${className}.${member.name.text} both handle ${stableKey}.`));
            continue;
          }
          entries.set(stableKey, {
            stableKey,
            method: method!,
            path,
            pathParams,
            sourceFile: file.path,
            absoluteFile: file.absolute,
            sourceFingerprint: createRouteSourceFingerprint(file.source, method!, path),
            source: file.source,
            className,
            methodName: member.name.text,
            classGuarded,
          });
        }
      }
    }
  }
  return {
    entries: [...entries.values()].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    excluded: [...excluded.values()],
    findings,
  };
}

function findMethod(sourceFile: ts.SourceFile, entry: NestEntry): ts.MethodDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || (statement.name?.text ?? 'default') !== entry.className) continue;
    return statement.members.find((member): member is ts.MethodDeclaration => (
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === entry.methodName
    ));
  }
  return undefined;
}

/** The schema behind `class Dto extends createZodDto(schema) {}`, when the parameter is typed with such a class. */
function dtoSchema(app: AppProgram, parameter: ts.ParameterDeclaration): ts.Expression | undefined {
  if (!parameter.type || !ts.isTypeReferenceNode(parameter.type)) return undefined;
  let symbol = app.checker.getSymbolAtLocation(parameter.type.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.find(ts.isClassDeclaration);
  const heritage = declaration?.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const base = heritage?.types[0]?.expression;
  if (!declaration || !base || !ts.isCallExpression(base) || !ts.isIdentifier(base.expression)) return undefined;
  const imports = readImports(declaration.getSourceFile());
  if (!imports.createZodDto.has(base.expression.text)) return undefined;
  return base.arguments[0];
}

interface NestAnalysis {
  schemaUses: SchemaUse[];
  queryKeys: string[];
  bodyKeys: string[] | 'opaque';
  readsBody: boolean;
  normalizedText?: string;
  inferredOutput?: JsonSchemaLike;
  findings: ToolFinding[];
  guarded: boolean;
}

function returnedExpressions(body: ts.Block): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

function analyzeMethod(
  app: AppProgram,
  sourceFile: ts.SourceFile,
  entry: NestEntry,
  member: ts.MethodDeclaration,
  nestApp: NestApp,
): NestAnalysis {
  const imports = readImports(sourceFile);
  const schemaUses: SchemaUse[] = [];
  const queryKeys = new Set<string>();
  let bodyKeys: Set<string> | 'opaque' = new Set();
  let readsBody = false;
  const findings: ToolFinding[] = [];
  const use = (role: 'body' | 'query' | 'path', expression: ts.Expression) => {
    schemaUses.push({ role, via: 'parse', ...resolveSchemaBinding(app, sourceFile, expression) });
  };
  const methodDecorators = decoratorsOf(member, imports);
  const methodPipes = methodDecorators.filter((decorator) => decorator.name === 'UsePipes')
    .flatMap((decorator) => [...decorator.args]);
  for (const parameter of member.parameters) {
    for (const decorator of decoratorsOf(parameter, imports)) {
      const role = PARAM_ROLES[decorator.name];
      if (!role) continue;
      const [first, ...rest] = decorator.args;
      const key = first ? literalText(first) : undefined;
      const pipes = key === undefined && first ? [first, ...rest] : rest;
      const schema = [...pipes, ...(key === undefined ? methodPipes : [])].flatMap((pipe) => {
        const node = unwrapExpression(pipe);
        return ts.isNewExpression(node) && node.arguments?.[0] && isSchemaExpression(app, node.arguments[0])
          ? [node.arguments[0]] : [];
      })[0];
      if (role === 'body') readsBody = true;
      if (key !== undefined && key !== '') {
        if (role === 'query') queryKeys.add(key);
        if (role === 'body' && bodyKeys !== 'opaque') bodyKeys.add(key);
        continue;
      }
      if (schema) {
        use(role, schema);
        continue;
      }
      const dto = dtoSchema(app, parameter);
      if (dto && nestApp.globalPipe) {
        use(role, dto);
        continue;
      }
      if (dto) {
        findings.push(toolFinding('nest-dto-unvalidated', 'needs_attention', entry.stableKey,
          `${entry.className}.${entry.methodName} reads a createZodDto class, but no global pipe validates it.`));
      }
      if (role === 'body') bodyKeys = 'opaque';
      if (role === 'query') {
        findings.push(toolFinding('input-contract-unresolved', 'needs_attention', entry.stableKey,
          `${entry.className}.${entry.methodName} reads the whole query without a Zod schema.`));
      }
    }
  }
  const returns = member.body ? returnedExpressions(member.body) : [];
  const parsed = returns.map((expression) => {
    const node = unwrapExpression(expression);
    return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && PARSE_METHODS.has(node.expression.name.text) && isSchemaExpression(app, node.expression.expression)
      ? node.expression.expression : undefined;
  });
  if (parsed.length > 0 && parsed.every(Boolean)) {
    for (const schema of parsed) schemaUses.push({ role: 'output', via: 'parse', ...resolveSchemaBinding(app, sourceFile, schema!) });
  }
  let inferredOutput: JsonSchemaLike | undefined;
  const signature = app.checker.getSignatureFromDeclaration(member);
  if (signature) {
    const returned = app.checker.getReturnTypeOfSignature(signature);
    const awaited = app.checker.getAwaitedType(returned) ?? returned;
    if (!(awaited.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
      const schema = typeToJsonSchema(app.checker, awaited, member);
      if (Object.keys(schema).length > 0) inferredOutput = schema;
    }
  }
  const guarded = nestApp.globalGuard || entry.classGuarded
    || methodDecorators.some((decorator) => decorator.name === 'UseGuards');
  return {
    schemaUses,
    queryKeys: [...queryKeys].sort(compareCodeUnits),
    bodyKeys: bodyKeys === 'opaque' ? 'opaque' : [...bodyKeys].sort(compareCodeUnits),
    readsBody,
    ...(bodyKeys === 'opaque' ? { normalizedText: normalizedNodeText(member, sourceFile) } : {}),
    ...(inferredOutput ? { inferredOutput } : {}),
    findings,
    guarded,
  };
}

function observeEntry(
  ctx: ToolSourceContext,
  app: AppProgram,
  entry: NestEntry,
  probes: ReadonlyMap<string, SchemaProbeResult>,
  resolution: ResolutionEntry | undefined,
  analysis: NestAnalysis | undefined,
  member: ts.MethodDeclaration | undefined,
): NestPiece {
  if (!analysis || !member?.body) {
    return {
      entry,
      findings: [toolFinding('handler-unresolved', 'needs_attention', entry.stableKey,
        `${entry.className}.${entry.methodName} in ${entry.sourceFile} is not a method the generator can read.`)],
      evidence: { authEvidence: false, externalCall: false },
      files: [entry.sourceFile],
    };
  }
  const evidence = collectHandlerEvidence({ app, scope: member.body, authHelpers: ctx.resolutions.conventions.authHelpers });
  const previousContract = ctx.previousContracts.get(entry.stableKey);
  const resolved = resolveEndpointContract({
    stableKey: entry.stableKey,
    method: entry.method,
    path: entry.path,
    pathParams: entry.pathParams,
    evidence: {
      schemaUses: analysis.schemaUses,
      queryKeys: analysis.queryKeys,
      repeatedQueryKeys: [],
      bodyKeys: analysis.bodyKeys,
      readsBody: analysis.readsBody,
      ...(analysis.normalizedText !== undefined ? { normalizedText: analysis.normalizedText } : {}),
    },
    ...(analysis.inferredOutput ? { inferredOutput: analysis.inferredOutput } : {}),
    probes,
    ...(resolution ? { resolution } : {}),
    ...(previousContract ? { previousContract } : {}),
  });
  const findings = [...analysis.findings, ...resolved.findings];
  const authEvidence = analysis.guarded || evidence.authEvidence.length > 0;
  if (!authEvidence) {
    findings.push(toolFinding('auth-evidence-missing', 'needs_attention', entry.stableKey,
      `No guard or auth helper call was found for ${entry.stableKey}; the tool stays disabled until the endpoint's authorization is visible.`));
  }
  const jsDoc = jsDocOf(member);
  const modules = analysis.schemaUses.flatMap((use) => (use.binding ? [use.binding.module] : []));
  return {
    entry,
    resolved,
    findings,
    evidence: {
      authEvidence,
      externalCall: evidence.externalCall,
      ...(resolved.declaredEffect ? { declaredEffect: resolved.declaredEffect } : {}),
      ...(jsDoc ? { jsDoc } : {}),
    },
    interface: {
      digest: resolved.interfaceDigest,
      params: resolved.contract?.params ?? {
        path: [...entry.pathParams],
        query: [...analysis.queryKeys],
        body: analysis.bodyKeys === 'opaque' ? 'opaque' : [...analysis.bodyKeys],
      },
    },
    files: [...new Set([entry.sourceFile, ...modules])].sort(compareCodeUnits),
  };
}

function toObserved(piece: NestPiece, definitionId: string): ObservedTool {
  const { entry, resolved } = piece;
  return {
    execution: {
      definitionId,
      stableKey: entry.stableKey,
      executionKind: 'endpoint',
      sourceKind: 'nest',
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

async function observeNestEndpoints(ctx: ToolSourceContext, srcDir: string): Promise<ToolSourceObservation> {
  const scan = await scanAppSources(ctx.root, { srcDir, matches: (source) => NEST_MARKERS.test(source) });
  if (!scan.complete) return incomplete(scan.reason);
  const parsed = scan.files.map((file) => {
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    return { file, ast, imports: readImports(ast) };
  });
  const nestApp = readApp(parsed);
  if (typeof nestApp === 'string') return incomplete(nestApp);
  const enumerated = enumerate(parsed, nestApp);
  if (typeof enumerated === 'string') return incomplete(enumerated);
  const findings: ToolFinding[] = [...enumerated.findings];
  const excluded: ExcludedTool[] = [...enumerated.excluded];
  const kept: NestEntry[] = [];
  const policyExcludes = ctx.policy.exclude ?? [];
  for (const entry of enumerated.entries) {
    const exclusion = findExclusion({
      stableKey: entry.stableKey,
      method: entry.method,
      path: entry.path,
      chatHandler: importsChatHandler(entry.source),
      aiIgnore: hasAiIgnoreMarker(entry.source),
    }, policyExcludes);
    if (exclusion) excluded.push(exclusion);
    else kept.push(entry);
  }
  excluded.sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  if (kept.length === 0) return { observations: [], findings, complete: true, excluded };

  const app = createAppProgram({ root: ctx.root, rootNames: [...new Set(kept.map((entry) => entry.absoluteFile))] });
  const analyzed = kept.map((entry) => {
    const sourceFile = app.sourceFile(entry.absoluteFile);
    const member = sourceFile ? findMethod(sourceFile, entry) : undefined;
    const analysis = sourceFile && member ? analyzeMethod(app, sourceFile, entry, member, nestApp) : undefined;
    return { entry, member, analysis };
  });

  const resolutions = new Map<string, ResolutionEntry>();
  for (const { entry } of analyzed) {
    const raw = ctx.resolutions.entries.get(entry.stableKey);
    if (raw === undefined) continue;
    const validated = validateResolutionEntry({
      stableKey: entry.stableKey,
      raw,
      codeRiskClass: deriveToolPolicyDefaults({
        executionKind: 'endpoint', method: entry.method, path: entry.path, definitionId: '',
      }).riskClass,
    });
    findings.push(...validated.findings);
    if (validated.entry) resolutions.set(entry.stableKey, validated.entry);
  }

  const items = new Map<string, SchemaProbeItem>();
  const request = (item: SchemaProbeItem) => items.set(probeKey(item), item);
  for (const { entry, analysis } of analyzed) {
    for (const use of analysis?.schemaUses ?? []) {
      if (use.binding) request(probeItemFor(use.binding, use.role === 'output' ? 'output' : 'input'));
    }
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

  const pieces = analyzed.map(({ entry, member, analysis }) => observeEntry(
    ctx, app, entry, probes, resolutions.get(entry.stableKey), analysis, member,
  ));
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

/**
 * NestJS controllers: `@Controller` classes with the HTTP method decorators of
 * `@nestjs/common`, read from syntax and the app's TypeScript checker. The
 * app is never imported or run.
 */
export function createNestEndpointSource(options: { srcDir?: string } = {}): ToolSource {
  const srcDir = options.srcDir ?? NEST_DEFAULT_SRC_DIR;
  return { kind: 'nest', observe: (ctx) => observeNestEndpoints(ctx, srcDir) };
}
