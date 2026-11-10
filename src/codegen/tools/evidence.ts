import ts from 'typescript';
import { AUTH_PATTERNS } from '../route-scanner.js';
import { unwrapExpression } from './handler-locator.js';
import type { AppProgram } from './program.js';

export const EVIDENCE_DEPTH = 2;

const DEFAULT_AUTH_HELPERS = AUTH_PATTERNS.map(([name]) => name);
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

export interface HandlerEvidence {
  authEvidence: string[];
  externalCall: boolean;
}

function calleeName(expression: ts.Expression): string | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function importModuleOf(declaration: ts.Node): string | undefined {
  if (ts.isImportEqualsDeclaration(declaration)) {
    const reference = declaration.moduleReference;
    return ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)
      ? reference.expression.text
      : undefined;
  }
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : undefined;
}

/** `x: ExecOptions` and `typeof exec` name the binding without running it. */
function inTypePosition(identifier: ts.Identifier): boolean {
  let node: ts.Node = identifier;
  while (ts.isQualifiedName(node.parent)) node = node.parent;
  return ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent);
}

/**
 * Any value reference to a binding imported from child_process counts, not only a direct call:
 * `promisify(exec)`, `{ exec }` and `cp.execFile` passed along all hand the process API onward.
 */
function isChildProcessReference(app: AppProgram, identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
    ? app.checker.getShorthandAssignmentValueSymbol(parent)
    : app.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !(
    ts.isImportSpecifier(declaration)
    || ts.isNamespaceImport(declaration)
    || ts.isImportClause(declaration)
    || ts.isImportEqualsDeclaration(declaration)
  ) || inTypePosition(identifier)) return false;
  const module = importModuleOf(declaration);
  return module !== undefined && CHILD_PROCESS_MODULES.has(module);
}

/** require('child_process') and import('child_process'), wherever the result ends up. */
function isChildProcessLoad(call: ts.CallExpression): boolean {
  const [specifier] = call.arguments;
  if (!specifier || !ts.isStringLiteralLike(specifier) || !CHILD_PROCESS_MODULES.has(specifier.text)) return false;
  return call.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(call.expression) && call.expression.text === 'require');
}

function appDeclaration(app: AppProgram, identifier: ts.Node): ts.Declaration | undefined {
  let symbol = app.checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  return declaration && app.appRelative(declaration.getSourceFile().fileName) ? declaration : undefined;
}

function functionInitializer(declaration: ts.VariableDeclaration): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

interface FollowTarget {
  node: ts.Node;
  /** A binding initializer runs at module load, not as part of the handler's own auth path. */
  externalOnly: boolean;
}

function followTargets(app: AppProgram, expression: ts.Expression): FollowTarget[] {
  const target = unwrapExpression(expression);
  const callee = ts.isIdentifier(target)
    ? target
    : ts.isPropertyAccessExpression(target) ? target.name : undefined;
  const root = ts.isIdentifier(target)
    ? target
    : ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) ? target.expression : undefined;
  const targets: FollowTarget[] = [];
  const declaration = callee && appDeclaration(app, callee);
  if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) {
    targets.push({ node: declaration.body, externalOnly: false });
  } else if (declaration && ts.isVariableDeclaration(declaration)) {
    const fn = functionInitializer(declaration);
    if (fn) targets.push({ node: fn.body, externalOnly: false });
  }
  // `const run = promisify(exec)` or `const cp = require('child_process')` declared outside the
  // handler: the called binding's initializer is where the process API enters.
  const bound = root && appDeclaration(app, root);
  if (bound && ts.isVariableDeclaration(bound) && bound.initializer && !functionInitializer(bound)) {
    targets.push({ node: bound.initializer, externalOnly: true });
  }
  return targets;
}

/** Static evidence only; the endpoint stays the authorization boundary. */
export function collectHandlerEvidence(input: {
  app: AppProgram;
  scope: ts.Node;
  authHelpers: ReadonlyArray<string>;
}): HandlerEvidence {
  const helpers = new Set([...DEFAULT_AUTH_HELPERS, ...input.authHelpers]);
  const auth = new Set<string>();
  let externalCall = false;
  const visited = new Set<ts.Node>();
  const queue: Array<{ node: ts.Node; depth: number; externalOnly: boolean }> = [
    { node: input.scope, depth: 0, externalOnly: false },
  ];
  while (queue.length > 0) {
    const { node, depth, externalOnly } = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child) && isChildProcessReference(input.app, child)) externalCall = true;
      if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
        const name = calleeName(child.expression);
        if (!externalOnly && name && helpers.has(name)) auth.add(name);
        const callee = unwrapExpression(child.expression);
        if (ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) {
          externalCall = true;
        }
        if (ts.isCallExpression(child) && isChildProcessLoad(child)) externalCall = true;
        if (depth < EVIDENCE_DEPTH) {
          for (const target of followTargets(input.app, child.expression)) {
            queue.push({ node: target.node, depth: depth + 1, externalOnly: externalOnly || target.externalOnly });
          }
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  return { authEvidence: [...auth].sort(), externalCall };
}
