import ts from 'typescript';
import type { DeclaredEffect } from '../../../contracts/tool-policy.js';
import { canonicalJson, compareCodeUnits } from '../canonical.js';
import { isClientActionRoute } from '../files.js';
import { toolFinding } from '../findings.js';
import { probeItemFor, probeKey } from '../contract-tiers.js';
import { isSchemaExpression, resolveSchemaBinding } from '../handler-analysis.js';
import { typeToJsonSchema } from '../output-inference.js';
import { createAppProgram, type AppProgram } from '../program.js';
import type { SchemaProbeItem, SchemaProbeResult } from '../schema-probe.js';
import type { JsonSchemaLike, ToolFinding, ToolSource, ToolSourceContext, ToolSourceObservation } from '../types.js';
import { defaultSourceDir, scanAppSources } from './app-files.js';
import { payloadContradiction, probedPayload } from './ui-action-contract.js';
import { analyzeUiControls, CONTROL_TEXT } from './ui-controls.js';
import {
  actionStableKey,
  importedCalls,
  incompleteUiSource,
  uiDefinitionIdForAction,
  uiObservation,
  uniqueDefinitionIds,
} from './ui-tools.js';

export interface ReactActionSourceOptions {
  /** Where registrations are searched; `src` when the app has one, else the app root. */
  srcDir?: string;
  /** The tsconfig of those files; the nearest one from `srcDir` up to the app root by default. */
  tsconfig?: string;
}

const REGISTRATION_SPECS = [
  { module: 'glirastes/react', names: ['useAiClientAction', 'useAiClientActionById'] },
  { module: 'glirastes/browser', names: ['registerAiClientAction'] },
];
const BUS_MODULES: ReadonlySet<string> = new Set(['glirastes/react', 'glirastes/browser']);
const REGISTRATION_TEXT = /useAiClientAction|registerAiClientAction|subscribeById/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Calls of mutation hooks (React Query, SWR) whose effect the generator cannot see. */
const MUTATION_CALLS: ReadonlySet<string> = new Set(['mutate', 'mutateAsync', 'trigger']);
const EMPTY_PAYLOAD: JsonSchemaLike = { type: 'object', properties: {}, additionalProperties: false };

interface Registration {
  actionId: string;
  file: string;
  /** `payload`: the handler receives the payload; `action`: the whole UI action. */
  style: 'payload' | 'action';
  handler: ts.Expression | undefined;
  contract: ts.Expression | undefined;
  /** The options argument that may carry `route`; only the payload-style registrations take one. */
  options: ts.Expression | undefined;
  call: ts.CallExpression;
}

type RouteRead =
  | { kind: 'none' }
  | { kind: 'static'; route: string }
  | { kind: 'invalid'; reason: string };

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function literalId(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function stringOfType(type: ts.Type): string | undefined {
  return type.isStringLiteral() ? type.value : undefined;
}

/** `route` of the options argument: a string literal or a constant with a literal type. */
function routeOf(app: AppProgram, raw: ts.Expression | undefined): RouteRead {
  if (!raw) return { kind: 'none' };
  const options = unwrap(raw);
  let value: string | undefined;
  if (ts.isObjectLiteralExpression(options)) {
    const property = options.properties.find((entry): entry is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (
      (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry))
      && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === 'route'));
    if (!property) {
      return options.properties.some(ts.isSpreadAssignment)
        ? { kind: 'invalid', reason: 'the options spread another object, so route cannot be read' }
        : { kind: 'none' };
    }
    const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    value = literalId(expression) ?? stringOfType(app.checker.getTypeAtLocation(expression));
    if (value === undefined) return { kind: 'invalid', reason: 'route is not a string literal' };
  } else {
    const route = app.checker.getPropertyOfType(app.checker.getTypeAtLocation(options), 'route');
    if (!route) return { kind: 'none' };
    value = stringOfType(app.checker.getNonNullableType(app.checker.getTypeOfSymbolAtLocation(route, options)));
    if (value === undefined) return { kind: 'invalid', reason: 'route is not a string literal' };
  }
  return isClientActionRoute(value)
    ? { kind: 'static', route: value }
    : { kind: 'invalid', reason: `${JSON.stringify(value)} is not a static app path (one leading slash, no query, hash or :param)` };
}

type EffectRead =
  | { kind: 'none' }
  | { kind: 'declared'; effect: DeclaredEffect }
  | { kind: 'invalid' };

const DECLARED_EFFECTS: ReadonlySet<string> = new Set(['read', 'write', 'destructive', 'external', 'financial']);
const EFFECT_STRENGTH: Readonly<Record<DeclaredEffect, number>> = {
  read: 0, write: 1, destructive: 2, external: 2, financial: 2,
};

/**
 * `effect` of the options argument. Written in the options object it must
 * be a literal (or a constant of literal type) of the known set, or the
 * declaration needs attention. Reached any other way (a spread, a typed
 * options variable), only a single literal type counts; anything else is
 * undeclared, so an app that declares nothing reads as before.
 */
function effectOf(app: AppProgram, raw: ts.Expression | undefined): EffectRead {
  if (!raw) return { kind: 'none' };
  const options = unwrap(raw);
  const checker = app.checker;
  const known = (value: string | undefined): EffectRead => (
    value !== undefined && DECLARED_EFFECTS.has(value) ? { kind: 'declared', effect: value as DeclaredEffect } : { kind: 'invalid' });
  if (ts.isObjectLiteralExpression(options)) {
    const members = [...options.properties];
    /** The static key of a member: its name, a computed key of literal type, else undefined (unknown). */
    const keyOf = (entry: ts.ObjectLiteralElementLike): string | undefined => {
      const name = entry.name;
      if (!name) return undefined;
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
      if (ts.isComputedPropertyName(name)) {
        const type = checker.getTypeAtLocation(name.expression);
        return type.isStringLiteral() || type.isNumberLiteral() ? String(type.value) : undefined;
      }
      return undefined;
    };
    const mayCarryEffect = (type: ts.Type): boolean => {
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
      if (type.isUnionOrIntersection()) return type.types.some(mayCarryEffect);
      return checker.getPropertyOfType(type, 'effect') !== undefined || checker.getIndexInfosOfType(type).length > 0;
    };
    let index = members.length - 1;
    while (index >= 0 && (ts.isSpreadAssignment(members[index]!) || keyOf(members[index]!) !== 'effect')) index -= 1;
    const property = index >= 0 ? members[index]! : undefined;
    if (property) {
      // A later member that may also set effect (a spread, an unknown computed key) decides at runtime.
      const overridden = members.slice(index + 1).some((entry) => (
        ts.isSpreadAssignment(entry) ? mayCarryEffect(checker.getTypeAtLocation(entry.expression)) : keyOf(entry) === undefined));
      if (overridden || !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) return { kind: 'invalid' };
      const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      return known(literalId(expression) ?? stringOfType(checker.getTypeAtLocation(expression)));
    }
    // No literal effect: an unknown computed key reads as undeclared, so the guess stays (nothing is lowered).
  }
  const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(options), 'effect');
  if (!symbol) return { kind: 'none' };
  const value = stringOfType(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(symbol, options)));
  return value !== undefined && DECLARED_EFFECTS.has(value) ? { kind: 'declared', effect: value as DeclaredEffect } : { kind: 'none' };
}

const DISPATCH_RECEIVERS: ReadonlySet<string> = new Set(['window', 'document', 'globalThis', 'self']);

function isEventRelay(node: ts.Expression): boolean {
  let expression = unwrap(node);
  if (ts.isVoidExpression(expression)) expression = unwrap(expression.expression);
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const dispatches = ts.isIdentifier(callee)
    ? callee.text === 'dispatchEvent'
    : ts.isPropertyAccessExpression(callee) && callee.name.text === 'dispatchEvent'
      && ts.isIdentifier(callee.expression) && DISPATCH_RECEIVERS.has(callee.expression.text);
  const event = expression.arguments[0] ? unwrap(expression.arguments[0]) : undefined;
  return dispatches && event !== undefined && ts.isNewExpression(event)
    && ts.isIdentifier(event.expression) && ['CustomEvent', 'Event'].includes(event.expression.text);
}

/** A handler whose whole body is `window.dispatchEvent(new CustomEvent(…))`: its effect is a listener elsewhere. */
function onlyRelaysEvents(handler: ts.SignatureDeclaration | undefined): boolean {
  const body = handler && 'body' in handler ? (handler as ts.FunctionLikeDeclaration).body : undefined;
  if (!body) return false;
  if (!ts.isBlock(body)) return isEventRelay(body);
  return body.statements.length > 0 && body.statements.every((statement) => (
    ts.isExpressionStatement(statement) ? isEventRelay(statement.expression)
      : ts.isReturnStatement(statement) && statement.expression !== undefined && isEventRelay(statement.expression)
  ));
}

function importsBus(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && BUS_MODULES.has(statement.moduleSpecifier.text)
    && !statement.importClause?.isTypeOnly
  ));
}

/** The function a handler argument stands for: inline, `useCallback(fn)` or a named function. */
function functionOf(app: AppProgram, raw: ts.Expression | undefined, depth = 0): ts.SignatureDeclaration | undefined {
  if (!raw || depth > 4) return undefined;
  const expression = unwrap(raw);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'useCallback') {
    return functionOf(app, expression.arguments[0], depth + 1);
  }
  if (ts.isIdentifier(expression)) {
    let symbol = app.checker.getSymbolAtLocation(expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
    if (declaration && ts.isVariableDeclaration(declaration)) return functionOf(app, declaration.initializer, depth + 1);
  }
  return undefined;
}

function objectSchema(app: AppProgram, type: ts.Type, location: ts.Node): JsonSchemaLike | undefined {
  const schema = typeToJsonSchema(app.checker, type, location);
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) return undefined;
  return { ...schema, additionalProperties: false };
}

/** The TypeScript type of the contract's input side (`z.input`), else the handler's parameter type; undefined when untyped. */
function typedPayloadSchema(app: AppProgram, registration: Registration): JsonSchemaLike | undefined {
  const checker = app.checker;
  if (registration.contract) {
    const contractType = checker.getTypeAtLocation(registration.contract);
    // `_input` is what the browser receives before parsing; `_output` only for contract types without it.
    const side = checker.getPropertyOfType(contractType, '_input') ?? checker.getPropertyOfType(contractType, '_output');
    if (side) {
      const schema = objectSchema(app, checker.getTypeOfSymbolAtLocation(side, registration.contract), registration.contract);
      if (schema) return schema;
    }
  }
  const handler = functionOf(app, registration.handler);
  if (!handler) return undefined;
  const parameter = handler.parameters[0];
  if (!parameter) return EMPTY_PAYLOAD;
  let type = checker.getTypeAtLocation(parameter);
  if (registration.style === 'action') {
    const payload = checker.getPropertyOfType(type, 'payload');
    if (!payload) return undefined;
    type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(payload, parameter));
  }
  return objectSchema(app, type, parameter);
}

const MAX_SPECIFIER_CHARS = 200;

/** The import declaration an alias symbol comes from, when it is one. */
function importOf(declaration: ts.Declaration | undefined): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/**
 * Module specifiers the checker cannot resolve that the registration's
 * contract, handler (by name) or handler parameter type is imported from: the
 * reason a payload is untyped although the code types it. Only specifiers.
 */
function unresolvedImports(app: AppProgram, registration: Registration): string[] {
  const nodes: ts.Node[] = registration.contract ? [registration.contract] : [];
  // The handler counts by its name (an imported function), never by the imports its body uses.
  let handler = registration.handler ? unwrap(registration.handler) : undefined;
  for (let depth = 0; handler && depth < 4; depth += 1) {
    if (ts.isCallExpression(handler) && ts.isIdentifier(handler.expression) && handler.expression.text === 'useCallback') {
      handler = handler.arguments[0] ? unwrap(handler.arguments[0]) : undefined;
      continue;
    }
    if (ts.isIdentifier(handler) || ts.isPropertyAccessExpression(handler)) nodes.push(handler);
    break;
  }
  const parameter = functionOf(app, registration.handler)?.parameters[0];
  if (parameter?.type) nodes.push(parameter.type);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = app.checker.getSymbolAtLocation(node);
      const declaration = symbol && symbol.flags & ts.SymbolFlags.Alias ? importOf(symbol.declarations?.[0]) : undefined;
      if (declaration && ts.isStringLiteral(declaration.moduleSpecifier)
        && app.checker.getSymbolAtLocation(declaration.moduleSpecifier) === undefined) {
        found.add(declaration.moduleSpecifier.text.slice(0, MAX_SPECIFIER_CHARS));
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const node of nodes) visit(node);
  return [...found];
}

interface ZodContract {
  /** Where the probe imports the contract; undefined when it is inline or outside the app. */
  item?: SchemaProbeItem;
  /** An inline contract built only from calls the TypeScript type fully describes. */
  typeOnly?: boolean;
}

/**
 * zod calls whose whole meaning is in the TypeScript type: an inline contract
 * of only these loses nothing when it is typed from TypeScript. Any other
 * call on a schema or on `z` (`describe`, `uuid`, `min`, `regex`, `meta`, …)
 * may carry a format, bound or description.
 */
const TYPE_ONLY_ZOD_CALLS: ReadonlySet<string> = new Set([
  'object', 'strictObject', 'looseObject', 'string', 'number', 'boolean', 'bigint', 'null', 'undefined',
  'literal', 'enum', 'nativeEnum', 'array', 'tuple', 'union', 'discriminatedUnion', 'intersection', 'record',
  'optional', 'nullable', 'nullish', 'strict', 'passthrough', 'strip', 'partial', 'required', 'extend',
  'merge', 'pick', 'omit', 'readonly', 'any', 'unknown',
]);

function isTypeOnlyInline(app: AppProgram, contract: ts.Expression, zodNames: ReadonlySet<string>): boolean {
  const expression = unwrap(contract);
  if (!ts.isCallExpression(expression)) return false;
  let typeOnly = true;
  const visit = (node: ts.Node): void => {
    if (!typeOnly) return;
    // A schema held elsewhere (`z.object({ id: idSchema })`) may carry a format the syntax here does not show.
    const parent = node.parent;
    const isName = parent !== undefined && (
      (ts.isPropertyAssignment(parent) && parent.name === node)
      || (ts.isPropertyAccessExpression(parent) && parent.name === node));
    if (ts.isIdentifier(node) && !isName && !zodNames.has(node.text) && isSchemaExpression(app, node)) {
      typeOnly = false;
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const onZod = (ts.isIdentifier(receiver) && zodNames.has(receiver.text)) || isSchemaExpression(app, receiver);
      if (onZod && !TYPE_ONLY_ZOD_CALLS.has(node.expression.name.text)) typeOnly = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return typeOnly;
}

/** Local names of the zod namespace (`import { z } from 'zod'`, `import * as z from 'zod/v4'`). */
function zodNamespaces(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/^zod(?:\/|$)/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.name) names.add(statement.importClause.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'z') names.add(element.name.text);
      }
    }
  }
  return names;
}

interface PayloadResolution {
  schema?: JsonSchemaLike;
  /** The schema read from the TypeScript type, whether or not the probed one wins. */
  typed?: JsonSchemaLike;
  /** `schema` comes from the probed zod contract. */
  probed?: boolean;
  /** `.describe()` of the probed contract itself. */
  description?: string;
  findings: ToolFinding[];
}

function isEmptyObject(schema: JsonSchemaLike | undefined): boolean {
  return schema !== undefined && Object.keys((schema.properties ?? {}) as Record<string, unknown>).length === 0;
}

/**
 * The payload schema of one registration. A zod contract the probe can load
 * wins over the TypeScript type: it carries formats, descriptions, enums and
 * bounds, and it is what the browser checks. Any other zod contract keeps the
 * schema read from the TypeScript type and warns, so no tool changes state.
 */
function resolvePayload(
  app: AppProgram,
  registration: Registration,
  zod: ZodContract | undefined,
  probes: ReadonlyMap<string, SchemaProbeResult>,
): PayloadResolution {
  const typed = typedPayloadSchema(app, registration);
  if (!zod) return { ...(typed ? { schema: typed, typed } : {}), findings: [] };
  const subject = actionStableKey(registration.actionId);
  const probed = zod.item
    ? probedPayload(probes.get(probeKey(zod.item)))
    : { ok: false as const, reason: 'is not exported from a module of this app (inline, or in another package)' };
  if (!probed.ok) {
    // An empty object, or an inline contract of type-only calls, has nothing the TypeScript type misses.
    if (isEmptyObject(typed) || zod.typeOnly) return { ...(typed ? { schema: typed, typed } : {}), findings: [] };
    const why = zod.item ? `could not be probed (${probed.reason})` : probed.reason;
    return {
      ...(typed ? { schema: typed, typed } : {}),
      findings: [toolFinding('ui-action-contract-unprobed', 'warning', subject,
        `The zod payload contract of ${registration.actionId} ${why}, so its formats and descriptions are not used; the payload is typed from TypeScript as before.`)],
    };
  }
  const contradiction = typed ? payloadContradiction(probed.schema, typed) : undefined;
  return {
    schema: probed.schema,
    ...(typed ? { typed } : {}),
    probed: true,
    ...(probed.description ? { description: probed.description } : {}),
    findings: contradiction
      ? [toolFinding('ui-action-contract-mismatch', 'warning', subject,
        `The zod payload contract of ${registration.actionId} contradicts its TypeScript type (${contradiction}); the tool follows the zod contract, which the browser checks.`)]
      : [],
  };
}

interface WriteEvidence {
  /** A non-GET `fetch(…, { method })` or an `axios` write: the tool writes. */
  writes: boolean;
  /** A call that may write but does not show it (D4): a helper of another app file, a mutation hook, a computed fetch method. */
  unproven?: string;
}

/**
 * A declaration a call can run code of: a function, method or class, a module imported
 * as a namespace, or a variable initialised with a function or an object of methods.
 * Fields, parameters and constants are data: a method on them is a built-in or a
 * property of a shared type, not a function of another app file.
 */
function holdsCode(declaration: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)
    || ts.isClassDeclaration(declaration) || ts.isSourceFile(declaration)) return true;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const initializer = unwrap(declaration.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isObjectLiteralExpression(initializer);
}

/** The app file that declares what a call refers to, when it is not the handler's own file. */
function otherAppFile(app: AppProgram, callee: ts.Expression, ownFile: string): string | undefined {
  const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
  let symbol = app.checker.getSymbolAtLocation(receiver ?? callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  // A called identifier is callable by definition; a receiver counts only when it holds code.
  const declaration = receiver ? symbol?.declarations?.find(holdsCode) : symbol?.declarations?.[0];
  const file = declaration ? app.appRelative(declaration.getSourceFile().fileName) : undefined;
  return file && file !== ownFile ? file : undefined;
}

function calleeLabel(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return `${calleeLabel(callee.expression)}.${callee.name.text}`;
  return 'a computed function';
}

/** What the handler body shows about writing (spec 4.5 "nachweisbar"). */
function writeEvidence(app: AppProgram, handler: ts.SignatureDeclaration | undefined): WriteEvidence {
  const body = handler && 'body' in handler ? (handler as ts.FunctionLikeDeclaration).body : undefined;
  if (!body) return { writes: false };
  const ownFile = app.appRelative(body.getSourceFile().fileName) ?? '';
  let writes = false;
  let unproven: string | undefined;
  const visit = (node: ts.Node): void => {
    if (writes) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch') {
        const options = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
        const method = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
            && ts.isIdentifier(property.name) && property.name.text === 'method'))
          : undefined;
        const value = method && ts.isPropertyAssignment(method) ? unwrap(method.initializer) : undefined;
        if (value && ts.isStringLiteralLike(value)) {
          if (WRITE_METHODS.has(value.text.toUpperCase())) writes = true;
        } else if (options && (!ts.isObjectLiteralExpression(options) || method || options.properties.some(ts.isSpreadAssignment))) {
          unproven ??= 'fetch with a method the generator cannot read';
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'axios' && ['post', 'put', 'patch', 'delete'].includes(callee.name.text)) {
        writes = true;
      } else {
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name && MUTATION_CALLS.has(name)) {
          unproven ??= `${calleeLabel(callee)}()`;
        } else {
          const file = otherAppFile(app, callee, ownFile);
          if (file) unproven ??= `${calleeLabel(callee)} from ${file}`;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return writes ? { writes } : { writes, ...(unproven ? { unproven } : {}) };
}

function docOf(source: ts.SourceFile, node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  const text = source.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const block = [...ranges].reverse().find((range) => text.startsWith('/**', range.pos));
  if (!block) return undefined;
  const lines = text.slice(block.pos + 3, block.end - 2).split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('@'));
  return lines.length > 0 ? lines.join(' ') : undefined;
}

function statementOf(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isExpressionStatement(current) && !ts.isVariableStatement(current)) current = current.parent;
  return current;
}

function registrationsOf(
  source: ts.SourceFile,
  file: string,
  findings: ToolFinding[],
): Registration[] {
  const found: Array<Omit<Registration, 'actionId'> & { id: ts.Expression | undefined }> = [];
  for (const { name, call } of importedCalls(source, REGISTRATION_SPECS)) {
    found.push(name === 'useAiClientActionById'
      ? { file, style: 'action', id: call.arguments[1], handler: call.arguments[2], contract: undefined, options: undefined, call }
      : {
        file, style: 'payload', id: call.arguments[0], handler: call.arguments[1], contract: call.arguments[2], options: call.arguments[3], call,
      });
  }
  if (importsBus(source)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'subscribeById') {
        found.push({ file, style: 'action', id: node.arguments[0], handler: node.arguments[1], contract: undefined, options: undefined, call: node });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const registrations: Registration[] = [];
  for (const { id, ...entry } of found.sort((left, right) => left.call.getStart() - right.call.getStart())) {
    const actionId = literalId(id);
    const line = source.getLineAndCharacterOfPosition(entry.call.getStart()).line + 1;
    if (actionId === undefined) {
      findings.push(toolFinding('ui-action-id-dynamic', 'warning', `${file}:${line}`,
        'A client action is registered with an id that is not a literal, so the chat cannot call it.'));
      continue;
    }
    if (actionId.startsWith('glirastes.')) {
      findings.push(toolFinding('ui-action-id-reserved', 'warning', `${file}:${line}`,
        `${actionId} belongs to the SDK and is not a client action of this app.`));
      continue;
    }
    registrations.push({ ...entry, actionId });
  }
  return registrations;
}

async function observeActions(ctx: ToolSourceContext, options: ReactActionSourceOptions): Promise<ToolSourceObservation> {
  const { root } = ctx;
  // Every file is read: a control's setter may be used anywhere; only candidates enter the program.
  const scan = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: () => true,
  });
  if (!scan.complete) return incompleteUiSource('react-actions', scan.reason);
  const files = scan.files.filter((file) => REGISTRATION_TEXT.test(file.source) || CONTROL_TEXT.test(file.source));
  if (files.length === 0) return { observations: [], findings: [], complete: true, excluded: [] };
  const app = createAppProgram({
    root,
    rootNames: files.map((file) => file.absolute),
    searchFrom: options.srcDir ?? defaultSourceDir(root),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
  });
  const findings: ToolFinding[] = [];
  const byId = new Map<string, Registration[]>();
  for (const file of files) {
    const source = app.sourceFile(file.absolute);
    if (!source) continue;
    for (const registration of registrationsOf(source, file.path, findings)) {
      byId.set(registration.actionId, [...byId.get(registration.actionId) ?? [], registration]);
    }
  }
  const named: Array<{ actionId: string; base: string }> = [];
  for (const [actionId, registrations] of byId) {
    const base = uiDefinitionIdForAction(actionId);
    if (base === undefined) {
      findings.push(toolFinding('ui-action-id-invalid', 'warning', registrations[0]!.file,
        `${JSON.stringify(actionId)} cannot become a tool name.`));
      continue;
    }
    named.push({ actionId, base });
  }
  const ids = uniqueDefinitionIds(named.map(({ actionId, base }) => ({ stableKey: actionStableKey(actionId), base })));
  const zodContracts = new Map<Registration, ZodContract>();
  const items = new Map<string, SchemaProbeItem>();
  for (const registration of [...byId.values()].flat()) {
    if (!registration.contract || !isSchemaExpression(app, registration.contract)) continue;
    const { binding } = resolveSchemaBinding(app, registration.contract.getSourceFile(), registration.contract);
    const item = binding ? probeItemFor(binding, 'input') : undefined;
    if (item) items.set(probeKey(item), item);
    zodContracts.set(registration, item
      ? { item }
      : { typeOnly: isTypeOnlyInline(app, registration.contract, zodNamespaces(registration.contract.getSourceFile())) });
  }
  // Only apps with zod contracts start the probe; every other app is read as before.
  const keys = [...items.keys()].sort(compareCodeUnits);
  const results = keys.length > 0
    ? await ctx.probe.probe(root, keys.map((key) => items.get(key)!), { tsconfig: app.tsconfigPath ?? null })
    : [];
  const probes = new Map<string, SchemaProbeResult>(keys.map((key, index) => [
    key,
    results[index] ?? { ok: false, reason: 'probe-failed' },
  ]));
  const payloads = new Map<Registration, PayloadResolution>();
  const payloadOf = (registration: Registration): PayloadResolution => {
    let resolved = payloads.get(registration);
    if (!resolved) {
      resolved = resolvePayload(app, registration, zodContracts.get(registration), probes);
      payloads.set(registration, resolved);
    }
    return resolved;
  };
  const controls = analyzeUiControls({
    app,
    files,
    allFiles: scan.files,
    registrations: [...byId].flatMap(([actionId, registrations]) => registrations.map((registration) => ({
      actionId,
      stableKey: actionStableKey(actionId),
      handler: registration.handler,
      schema: payloadOf(registration).schema,
    }))),
    policy: ctx.policy,
    functionOf: (expression) => functionOf(app, expression),
    writes: (fn) => writeEvidence(app, fn).writes,
  });
  findings.push(...controls.findings);
  const observations = named
    .sort((left, right) => compareCodeUnits(left.actionId, right.actionId))
    .map(({ actionId }) => {
      const stableKey = actionStableKey(actionId);
      const registrations = byId.get(actionId)!;
      const resolved = registrations.map(payloadOf);
      const distinct = (schemas: ReadonlyArray<JsonSchemaLike | undefined>) => [...new Map(schemas
        .filter((schema): schema is JsonSchemaLike => schema !== undefined)
        .map((schema) => [canonicalJson(schema), schema] as const)).values()];
      // A registration whose zod contract the probe could not load has only its TypeScript type,
      // which lacks formats and descriptions: that gap is no conflict. Registrations conflict when
      // their TypeScript types differ (as before the probe) or when two probed schemas differ.
      const probedSchemas = distinct(resolved.filter((payload) => payload.probed).map((payload) => payload.schema));
      const typedSchemas = distinct(resolved.map((payload) => payload.typed));
      const typed = probedSchemas.length > 1 || typedSchemas.length > 1
        ? (probedSchemas.length >= typedSchemas.length ? probedSchemas : typedSchemas)
        : probedSchemas.length === 1 ? probedSchemas : typedSchemas;
      const handlers = registrations.map((registration) => functionOf(app, registration.handler));
      const toolFindings: ToolFinding[] = [
        ...controls.byStableKey.get(stableKey) ?? [],
        ...new Map(resolved.flatMap((payload) => payload.findings)
          .map((finding) => [`${finding.code}\u0000${finding.message}`, finding] as const)).values(),
      ];
      const unresolved = typed.length === 0
        ? [...new Set(registrations.flatMap((registration) => unresolvedImports(app, registration)))].sort(compareCodeUnits)
        : [];
      if (unresolved.length > 0) {
        toolFindings.push(toolFinding('ui-action-import-unresolved', 'needs_attention', stableKey,
          `${actionId} has no payload type because the import of ${unresolved.map((specifier) => JSON.stringify(specifier)).join(', ')} `
          + `cannot be resolved with ${app.tsconfig ?? 'no tsconfig (TypeScript defaults)'}.`));
      } else if (typed.length === 0) {
        toolFindings.push(toolFinding('ui-action-payload-untyped', 'needs_attention', stableKey,
          `${actionId} has neither a payload contract nor a typed handler parameter.`));
      } else if (typed.length > 1) {
        toolFindings.push(toolFinding('ui-action-contract-conflict', 'needs_attention', stableKey,
          `${actionId} is registered with ${typed.length} different payload contracts.`));
      }
      const input = typed[0];
      const schemaDescription = resolved.find((payload) => payload.schema === input)?.description;
      const jsDoc = registrations
        .map((registration, index) => {
          const handler = handlers[index];
          return docOf(registration.call.getSourceFile(), statementOf(registration.call))
            ?? (handler && ts.isFunctionDeclaration(handler) ? docOf(handler.getSourceFile(), handler) : undefined);
        })
        .find((doc) => doc !== undefined);
      const routes = registrations.map((registration) => routeOf(app, registration.options));
      const routeKeys = [...new Set(routes.map((route) => route.kind === 'static' ? route.route : route.kind === 'none' ? '' : undefined)
        .filter((key): key is string => key !== undefined))];
      const invalid = routes.find((route): route is Extract<RouteRead, { kind: 'invalid' }> => route.kind === 'invalid');
      let route: string | undefined;
      if (invalid) {
        toolFindings.push(toolFinding('ui-action-route-invalid', 'needs_attention', stableKey,
          `${actionId} is registered with a route the generator cannot use: ${invalid.reason}.`));
      } else if (routeKeys.length > 1) {
        toolFindings.push(toolFinding('ui-action-route-conflict', 'needs_attention', stableKey,
          `${actionId} is registered with different routes: ${routeKeys.map((key) => key === '' ? 'none' : key).sort(compareCodeUnits).join(', ')}.`));
      } else if (routeKeys[0]) {
        route = routeKeys[0];
      }
      if (handlers.some((handler, index) => routes[index]!.kind === 'none' && onlyRelaysEvents(handler))) {
        toolFindings.push(toolFinding('ui-action-indirect', 'warning', stableKey,
          `${actionId} only dispatches a window event, so it works only where a listener for that event is mounted.`));
      }
      const effects = registrations.map((registration) => effectOf(app, registration.options));
      if (effects.some((effect) => effect.kind === 'invalid')) {
        toolFindings.push(toolFinding('ui-action-effect-invalid', 'needs_attention', stableKey,
          `${actionId} declares an effect that is not a literal read, write, destructive, external or financial, so the declaration is ignored.`));
      }
      const declared = [...new Set(effects
        .flatMap((effect) => (effect.kind === 'declared' ? [effect.effect] : [])))]
        .sort((left, right) => EFFECT_STRENGTH[right] - EFFECT_STRENGTH[left] || compareCodeUnits(left, right));
      // Raise-only, like every other declared effect: the strongest declaration applies.
      const declaredEffect = declared[0];
      if (declared.length > 1) {
        toolFindings.push(toolFinding('ui-action-effect-conflict', 'warning', stableKey,
          `${actionId} is registered with different effects (${[...declared].sort(compareCodeUnits).join(', ')}); the strongest, ${declaredEffect}, applies.`));
      }
      const evidence = handlers.map((handler) => writeEvidence(app, handler));
      const uiMutation = evidence.some((entry) => entry.writes);
      // A declared effect answers the write question for its own registration; the guess stays for the others.
      const unproven = evidence.find((entry, index) => entry.unproven && effects[index]!.kind !== 'declared')?.unproven;
      if (!uiMutation && unproven) {
        toolFindings.push(toolFinding('ui-action-write-unproven', 'warning', stableKey,
          `${actionId} calls ${unproven}; if that changes data, raise the tool to write so the chat asks first.`));
      }
      if (uiMutation && declaredEffect === 'read') {
        toolFindings.push(toolFinding('ui-action-effect-contradicted', 'warning', stableKey,
          `${actionId} declares the effect read, but its handler writes (a non-GET request); the tool stays write.`));
      }
      return uiObservation({
        stableKey,
        definitionId: ids.get(stableKey)!,
        actionBindingRef: actionId,
        ...(input ? { input } : {}),
        uiAction: { kind: 'client-action', actionId, ...(route ? { route } : {}) },
        params: {
          path: [],
          query: [],
          body: Object.keys((input?.properties ?? {}) as Record<string, unknown>).sort(compareCodeUnits),
        },
        facts: {
          actionId,
          files: [...new Set(registrations.map((registration) => registration.file))].sort(compareCodeUnits),
          payloads: typed,
          uiMutation,
          ...(declaredEffect ? { effect: declaredEffect } : {}),
        },
        findings: toolFindings,
        files: [...new Set(registrations.map((registration) => registration.file))].sort(compareCodeUnits),
        ...(jsDoc ? { jsDoc } : {}),
        ...(uiMutation ? { uiMutation } : {}),
        ...(declaredEffect ? { declaredEffect } : {}),
        ...(schemaDescription ? { prose: { schemaDescription } } : {}),
      });
    });
  return { observations, findings, complete: true, excluded: [] };
}

/**
 * The `react-actions` source: one `ui.<actionId>` tool per literal client
 * action id registered with `useAiClientAction`, `registerAiClientAction`,
 * `useAiClientActionById` or `bus.subscribeById` (spec 4.4). It also reports
 * stateful UI controls that no client action reaches yet (`ui-control-unbound`).
 */
export function createReactActionSource(options: ReactActionSourceOptions = {}): ToolSource {
  return { kind: 'react-actions', observe: (ctx) => observeActions(ctx, options) };
}
