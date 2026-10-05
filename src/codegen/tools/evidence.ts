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
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : undefined;
}

function isChildProcessCall(app: AppProgram, expression: ts.Expression): boolean {
  const target = unwrapExpression(expression);
  const identifier = ts.isIdentifier(target)
    ? target
    : ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)
      ? target.expression
      : undefined;
  if (!identifier) return false;
  const declaration = app.checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration || !(
    ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)
  )) return false;
  const module = importModuleOf(declaration);
  return module !== undefined && CHILD_PROCESS_MODULES.has(module);
}

function appFunctionBody(app: AppProgram, expression: ts.Expression): ts.Node | undefined {
  const target = unwrapExpression(expression);
  const identifier = ts.isIdentifier(target)
    ? target
    : ts.isPropertyAccessExpression(target) ? target.name : undefined;
  if (!identifier) return undefined;
  let symbol = app.checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !app.appRelative(declaration.getSourceFile().fileName)) return undefined;
  if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) {
    return declaration.body;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = unwrapExpression(declaration.initializer);
    if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body) {
      return initializer.body;
    }
  }
  return undefined;
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
  const queue: Array<{ node: ts.Node; depth: number }> = [{ node: input.scope, depth: 0 }];
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
        const name = calleeName(child.expression);
        if (name && helpers.has(name)) auth.add(name);
        const callee = unwrapExpression(child.expression);
        if (ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) {
          externalCall = true;
        }
        if (isChildProcessCall(input.app, child.expression)) externalCall = true;
        if (depth < EVIDENCE_DEPTH) {
          const body = appFunctionBody(input.app, child.expression);
          if (body) queue.push({ node: body, depth: depth + 1 });
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  return { authEvidence: [...auth].sort(), externalCall };
}
