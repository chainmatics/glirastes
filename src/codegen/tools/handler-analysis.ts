import ts from 'typescript';
import type { EndpointMethod } from '../../types.js';
import { AUTH_PATTERNS } from '../route-scanner.js';
import { compareCodeUnits } from './canonical.js';
import {
  bindingKey,
  locateRouteHandler,
  normalizedNodeText,
  unwrapExpression,
  type LocatedHandler,
} from './handler-locator.js';
import {
  classifyInputExpression,
  collectBodyKeys,
  collectQueryKeys,
  createRoleContext,
  type InputRole,
  type RoleContext,
} from './input-roles.js';
import type { AppProgram } from './program.js';
import type { SchemaBindingRef } from './types.js';

export interface ModuleExportRef {
  module: string;
  export: string;
}

export interface HandlerWrapperConvention extends ModuleExportRef {
  inputArg?: number;
  queryArg?: number;
  outputArg?: number;
}

export interface HandlerConventions {
  handlerWrappers: ReadonlyArray<HandlerWrapperConvention>;
  bodyReaders: ReadonlyArray<ModuleExportRef>;
  authHelpers: ReadonlyArray<string>;
}

export type SchemaRole = InputRole | 'output' | 'unclear';

export interface SchemaUse {
  role: SchemaRole;
  via: 'parse' | 'wrapper';
  binding?: SchemaBindingRef;
  problem?: 'not-exported';
}

export interface HandlerAnalysis {
  located?: LocatedHandler;
  schemaUses: SchemaUse[];
  queryKeys: string[];
  repeatedQueryKeys: string[];
  bodyKeys: string[] | 'opaque';
  readsBody: boolean;
  normalizedText?: string;
  responseArguments: ts.Expression[];
  importedModules: string[];
}

const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const BODY_METHODS = new Set<EndpointMethod>(['POST', 'PUT', 'PATCH']);
const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const DEFAULT_AUTH_NAMES = AUTH_PATTERNS.map(([name]) => name);

export function sameModule(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(MODULE_EXTENSION, '');
  return normalize(left) === normalize(right);
}

function importDeclarationOf(node: ts.Node): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current;
}

function moduleOfImport(app: AppProgram, declaration: ts.ImportDeclaration | undefined): string | undefined {
  if (!declaration) return undefined;
  const target = app.checker.getSymbolAtLocation(declaration.moduleSpecifier)?.valueDeclaration;
  return target && ts.isSourceFile(target) ? app.appRelative(target.fileName) : undefined;
}

function importedAppModules(app: AppProgram, sourceFile: ts.SourceFile): string[] {
  const modules = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const module = moduleOfImport(app, statement);
    if (module) modules.add(module);
  }
  return [...modules].sort(compareCodeUnits);
}

/** Module and export name of a called function, when it is imported from the app. */
export function resolveCallTarget(app: AppProgram, expression: ts.Expression): ModuleExportRef | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    const declaration = app.checker.getSymbolAtLocation(target)?.declarations?.[0];
    if (declaration && ts.isImportSpecifier(declaration)) {
      const module = moduleOfImport(app, importDeclarationOf(declaration));
      return module ? { module, export: (declaration.propertyName ?? declaration.name).text } : undefined;
    }
    if (declaration && ts.isImportClause(declaration)) {
      const module = moduleOfImport(app, importDeclarationOf(declaration));
      return module ? { module, export: 'default' } : undefined;
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    const declaration = app.checker.getSymbolAtLocation(target.expression)?.declarations?.[0];
    if (declaration && ts.isNamespaceImport(declaration)) {
      const module = moduleOfImport(app, importDeclarationOf(declaration));
      return module ? { module, export: target.name.text } : undefined;
    }
  }
  return undefined;
}

function exportNameOf(app: AppProgram, sourceFile: ts.SourceFile, symbol: ts.Symbol | undefined): string | undefined {
  if (!symbol) return undefined;
  const moduleSymbol = app.checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return undefined;
  const exportSymbol = app.checker.getExportSymbolOfSymbol(symbol);
  for (const exported of app.checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? app.checker.getAliasedSymbol(exported) : exported;
    if (exported === exportSymbol || target === exportSymbol || target === symbol) return exported.name;
  }
  return undefined;
}

function resolveSchemaBinding(
  app: AppProgram,
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): Pick<SchemaUse, 'binding' | 'problem'> {
  const property: string[] = [];
  let node = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(node)) {
    property.unshift(node.name.text);
    node = unwrapExpression(node.expression);
  }
  if (!ts.isIdentifier(node)) return { problem: 'not-exported' };
  const symbol = app.checker.getSymbolAtLocation(node);
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return { problem: 'not-exported' };
  if (ts.isImportSpecifier(declaration)) {
    const module = moduleOfImport(app, importDeclarationOf(declaration));
    return module
      ? { binding: { module, export: (declaration.propertyName ?? declaration.name).text, property } }
      : { problem: 'not-exported' };
  }
  if (ts.isImportClause(declaration)) {
    const module = moduleOfImport(app, importDeclarationOf(declaration));
    return module ? { binding: { module, export: 'default', property } } : { problem: 'not-exported' };
  }
  if (ts.isNamespaceImport(declaration)) {
    const module = moduleOfImport(app, importDeclarationOf(declaration));
    const [exportName, ...rest] = property;
    return module && exportName
      ? { binding: { module, export: exportName, property: rest } }
      : { problem: 'not-exported' };
  }
  const module = app.appRelative(sourceFile.fileName);
  const exported = exportNameOf(app, sourceFile, symbol);
  return module && exported ? { binding: { module, export: exported, property } } : { problem: 'not-exported' };
}

function isSchemaExpression(app: AppProgram, expression: ts.Expression): boolean {
  const type = app.checker.getTypeAtLocation(expression);
  return Boolean(type.getProperty('_zod') ?? type.getProperty('_def'));
}

function isResponseJsonCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'json' && ts.isIdentifier(node.expression.expression)
    && (node.expression.expression.text === 'Response' || node.expression.expression.text === 'NextResponse');
}

function isErrorResponse(call: ts.CallExpression): boolean {
  const init = call.arguments[1];
  if (!init || !ts.isObjectLiteralExpression(init)) return false;
  return init.properties.some((property) => (
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'status'
    && ts.isNumericLiteral(property.initializer) && Number(property.initializer.text) >= 300
  ));
}

function collectResponseArguments(scope: ts.Node): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (isResponseJsonCall(node) && node.arguments[0] && !isErrorResponse(node)) found.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function isResponsePayload(app: AppProgram, body: ts.Node, call: ts.CallExpression): boolean {
  let consumer: ts.Node = call;
  while (consumer.parent && (
    ts.isAwaitExpression(consumer.parent) || ts.isParenthesizedExpression(consumer.parent)
    || ts.isAsExpression(consumer.parent) || ts.isNonNullExpression(consumer.parent)
  )) {
    consumer = consumer.parent;
  }
  const parent = consumer.parent;
  if (parent && isResponseJsonCall(parent) && parent.arguments[0] === consumer) return true;
  if (!parent || !ts.isVariableDeclaration(parent) || parent.initializer !== consumer
    || !ts.isIdentifier(parent.name)) return false;
  const symbol = app.checker.getSymbolAtLocation(parent.name);
  if (!symbol) return false;
  let returned = false;
  const visit = (node: ts.Node): void => {
    if (isResponseJsonCall(node) && node.arguments[0]) {
      let value = unwrapExpression(node.arguments[0]);
      if (ts.isPropertyAccessExpression(value)) value = unwrapExpression(value.expression);
      if (ts.isIdentifier(value) && app.checker.getSymbolAtLocation(value) === symbol) returned = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returned;
}

function parseUses(app: AppProgram, sourceFile: ts.SourceFile, located: LocatedHandler, ctx: RoleContext): SchemaUse[] {
  const body = located.fn?.body;
  if (!body) return [];
  const uses: SchemaUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && PARSE_METHODS.has(node.expression.name.text) && node.arguments[0]
      && isSchemaExpression(app, node.expression.expression)) {
      let role: SchemaRole = classifyInputExpression(node.arguments[0], ctx);
      if (role === 'unclear' && isResponsePayload(app, body, node)) role = 'output';
      uses.push({ role, via: 'parse', ...resolveSchemaBinding(app, sourceFile, node.expression.expression) });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return uses;
}

function wrapperUses(
  app: AppProgram,
  sourceFile: ts.SourceFile,
  located: LocatedHandler,
  conventions: HandlerConventions,
): SchemaUse[] {
  const uses: SchemaUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = resolveCallTarget(app, node.expression);
      const convention = target && conventions.handlerWrappers.find((wrapper) => (
        wrapper.export === target.export && sameModule(wrapper.module, target.module)
      ));
      if (convention) {
        const slots = [
          ['body', convention.inputArg],
          ['query', convention.queryArg],
          ['output', convention.outputArg],
        ] as const;
        for (const [role, index] of slots) {
          if (index === undefined) continue;
          const argument = node.arguments[index];
          uses.push(argument
            ? { role, via: 'wrapper', ...resolveSchemaBinding(app, sourceFile, argument) }
            : { role, via: 'wrapper', problem: 'not-exported' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(located.scope);
  return uses;
}

/** Request members that expose the body (or a copy of it); every other member is body-free metadata. */
const BODY_MEMBERS = new Set(['json', 'text', 'formData', 'arrayBuffer', 'blob', 'bytes', 'body', 'clone']);

type RequestUse =
  | { kind: 'neutral' }
  | { kind: 'escape' }
  | { kind: 'alias'; name: ts.Identifier; direct: boolean };

const NEUTRAL: RequestUse = { kind: 'neutral' };
const ESCAPE: RequestUse = { kind: 'escape' };

/** Identifier references of a body by symbol; a shorthand property name reads the variable, not the property. */
function referencesBySymbol(checker: ts.TypeChecker, body: ts.Node): Map<ts.Symbol, ts.Identifier[]> {
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol) references.set(symbol, [...(references.get(symbol) ?? []), node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return references;
}

function isBindingSite(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.left === node);
}

/**
 * Follows one reference of the request (or of a variable holding it) outwards through the
 * expressions that carry the value on, and says where it ends up. `direct` is true while the
 * value is still the request itself rather than something containing it.
 */
function classifyRequestUse(
  reference: ts.Identifier,
  direct: boolean,
  isSafeCall: (call: ts.CallExpression) => boolean,
): RequestUse {
  let node: ts.Node = reference;
  let isDirect = direct;
  for (;;) {
    const parent: ts.Node = node.parent;
    if (
      ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isAwaitExpression(parent)
      || (ts.isConditionalExpression(parent) && parent.condition !== node)
      || (ts.isBinaryExpression(parent) && (
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ))
    ) {
      node = parent;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) {
      node = parent.parent;
      isDirect = false;
      continue;
    }
    if (ts.isSpreadElement(parent) || ts.isArrayLiteralExpression(parent)) {
      node = parent;
      isDirect = false;
      continue;
    }
    if (
      isDirect && ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'clone'
      && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
    ) {
      node = parent.parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      return isDirect && !BODY_MEMBERS.has(parent.name.text) ? NEUTRAL : ESCAPE;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      if (ts.isIdentifier(parent.name)) return { kind: 'alias', name: parent.name, direct: isDirect };
      if (!isDirect || !ts.isObjectBindingPattern(parent.name)) return ESCAPE;
      return parent.name.elements.some((element) => {
        const key = bindingKey(element);
        return element.dotDotDotToken || key === undefined || BODY_MEMBERS.has(key);
      }) ? ESCAPE : NEUTRAL;
    }
    if (
      ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.right === node && ts.isIdentifier(parent.left)
    ) {
      return { kind: 'alias', name: parent.left, direct: isDirect };
    }
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent))
      && parent.arguments?.some((argument) => argument === node)
    ) {
      return ts.isCallExpression(parent) && isSafeCall(parent) ? NEUTRAL : ESCAPE;
    }
    return ESCAPE;
  }
}

/**
 * A write handler whose request body may be consumed where the key collector cannot follow: read as
 * text, form data or a stream, or the request (or a copy, alias or container of it) handed to unknown code.
 */
function requestEscapes(
  app: AppProgram,
  located: LocatedHandler,
  conventions: HandlerConventions,
): boolean {
  const body = located.fn?.body;
  const parameter = located.fn?.parameters[0];
  if (!body || !parameter || !ts.isIdentifier(parameter.name)) return false;
  const requestSymbol = app.checker.getSymbolAtLocation(parameter.name);
  if (!requestSymbol) return false;
  const safeNames = new Set([...DEFAULT_AUTH_NAMES, ...conventions.authHelpers]);
  const isSafeCall = (call: ts.CallExpression): boolean => {
    const callee = unwrapExpression(call.expression);
    const calleeName = ts.isIdentifier(callee) ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    if (calleeName && safeNames.has(calleeName)) return true;
    const target = resolveCallTarget(app, call.expression);
    return Boolean(target && [...conventions.handlerWrappers, ...conventions.bodyReaders].some((entry) => (
      entry.export === target.export && sameModule(entry.module, target.module)
    )));
  };
  const references = referencesBySymbol(app.checker, body);
  // Each symbol that holds the request (or something containing it), and whether it is the request itself.
  const holders = new Map<ts.Symbol, boolean>([[requestSymbol, true]]);
  const queue = [requestSymbol];
  for (let symbol = queue.pop(); symbol; symbol = queue.pop()) {
    for (const reference of references.get(symbol) ?? []) {
      if (isBindingSite(reference)) continue;
      const use = classifyRequestUse(reference, holders.get(symbol) === true, isSafeCall);
      if (use.kind === 'escape') return true;
      if (use.kind !== 'alias') continue;
      const target = app.checker.getSymbolAtLocation(use.name);
      if (!target) return true;
      const direct = (holders.get(target) ?? true) && use.direct;
      if (holders.get(target) === direct) continue;
      holders.set(target, direct);
      queue.push(target);
    }
  }
  return false;
}

export function analyzeRouteHandler(input: {
  app: AppProgram;
  sourceFile: ts.SourceFile;
  method: EndpointMethod;
  conventions: HandlerConventions;
}): HandlerAnalysis {
  const { app, sourceFile, conventions } = input;
  const importedModules = importedAppModules(app, sourceFile);
  const located = locateRouteHandler(sourceFile, input.method);
  if (!located) {
    return {
      schemaUses: [], queryKeys: [], repeatedQueryKeys: [], bodyKeys: [], readsBody: false,
      responseArguments: [], importedModules,
    };
  }
  const ctx = createRoleContext(located, (call) => {
    const target = resolveCallTarget(app, call.expression);
    return Boolean(target && conventions.bodyReaders.some((reader) => (
      reader.export === target.export && sameModule(reader.module, target.module)
    )));
  });
  const query = collectQueryKeys(located.scope, ctx);
  let body = collectBodyKeys(located.fn, ctx, app.checker);
  if (BODY_METHODS.has(input.method) && !body.readsBody && requestEscapes(app, located, conventions)) {
    body = { readsBody: true, keys: 'opaque' };
  }
  return {
    located,
    schemaUses: [
      ...parseUses(app, sourceFile, located, ctx),
      ...wrapperUses(app, sourceFile, located, conventions),
    ],
    queryKeys: query.keys,
    repeatedQueryKeys: query.repeated,
    bodyKeys: body.keys,
    readsBody: body.readsBody,
    normalizedText: normalizedNodeText(located.scope, sourceFile),
    responseArguments: collectResponseArguments(located.scope),
    importedModules,
  };
}
