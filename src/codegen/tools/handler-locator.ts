import ts from 'typescript';
import type { EndpointMethod } from '../../types.js';

export type HandlerFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

export interface LocatedHandler {
  /** The exported declaration or initializer, including any wrapper call around the handler. */
  scope: ts.Node;
  fn?: HandlerFunction;
  jsDoc?: string;
  requestName?: string;
  contextName?: string;
  paramsName?: string;
}

const ROUTE_LINE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/\S*$/;
const printer = ts.createPrinter({ removeComments: true });

export function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isAwaitExpression(current)
      || ts.isAsExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

export function bindingKey(element: ts.BindingElement): string | undefined {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** Re-creates string literals without their source quote style and drops trailing list commas. */
function withoutCosmetics(node: ts.Node): ts.Node {
  const { transformed, dispose } = ts.transform<ts.Node>(node, [(context) => {
    const { factory } = context;
    const nodesVisitor = ((
      nodes: ts.NodeArray<ts.Node> | undefined,
      visitor: ts.Visitor,
      test?: (node: ts.Node) => boolean,
      start?: number,
      count?: number,
    ) => {
      const visited = ts.visitNodes(nodes, visitor, test, start, count);
      return visited?.hasTrailingComma ? factory.createNodeArray([...visited], false) : visited;
    }) as unknown as typeof ts.visitNodes;
    const visit = (child: ts.Node): ts.Node => (
      ts.isStringLiteral(child)
        ? factory.createStringLiteral(child.text)
        : (ts.visitEachChild(child, visit, context, nodesVisitor) ?? child)
    );
    return visit;
  }]);
  const [result] = transformed;
  dispose();
  return result ?? node;
}

/**
 * Text free of comments, whitespace, string-literal quote style and trailing commas, so
 * cosmetic and formatter edits never change a digest. Changed literal values still do.
 */
export function normalizedNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, withoutCosmetics(node), sourceFile)
    .replace(/\s+/g, ' ')
    .trim();
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isHandlerFunction(node: ts.Node): node is HandlerFunction {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
    && node.body !== undefined;
}

function localDeclarations(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const locals = new Map<string, ts.Node>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      locals.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          locals.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return locals;
}

function functionOf(
  node: ts.Node,
  locals: ReadonlyMap<string, ts.Node>,
  depth = 0,
): HandlerFunction | undefined {
  if (depth > 4) return undefined;
  const target = ts.isExpression(node) ? unwrapExpression(node) : node;
  if (isHandlerFunction(target)) return target;
  if (ts.isIdentifier(target)) {
    const local = locals.get(target.text);
    return local ? functionOf(local, locals, depth + 1) : undefined;
  }
  if (ts.isCallExpression(target)) {
    for (const argument of target.arguments) {
      const found = functionOf(argument, locals, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function jsDocOf(host: ts.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(host).filter(ts.isJSDoc);
  const last = docs[docs.length - 1];
  const text = last ? ts.getTextOfJSDocComment(last.comment) : undefined;
  if (!text) return undefined;
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !ROUTE_LINE.test(line));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, 1_000) : undefined;
}

function hostStatement(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  return current;
}

export function locateRouteHandler(
  sourceFile: ts.SourceFile,
  method: EndpointMethod,
): LocatedHandler | undefined {
  const locals = localDeclarations(sourceFile);
  const located = (scope: ts.Node, host: ts.Node): LocatedHandler => {
    const fn = functionOf(scope, locals);
    const [request, context] = fn?.parameters ?? [];
    const contextPattern = context && ts.isObjectBindingPattern(context.name) ? context.name : undefined;
    const paramsElement = contextPattern?.elements.find((element) => bindingKey(element) === 'params');
    const jsDoc = jsDocOf(host);
    return {
      scope,
      ...(fn ? { fn } : {}),
      ...(jsDoc ? { jsDoc } : {}),
      ...(request && ts.isIdentifier(request.name) ? { requestName: request.name.text } : {}),
      ...(context && ts.isIdentifier(context.name) ? { contextName: context.name.text } : {}),
      ...(paramsElement && ts.isIdentifier(paramsElement.name) ? { paramsName: paramsElement.name.text } : {}),
    };
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) && statement.name?.text === method
      && statement.body && hasExportModifier(statement)
    ) {
      return located(statement, statement);
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === method && declaration.initializer) {
          return located(declaration.initializer, statement);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly
      && statement.exportClause && ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly || element.name.text !== method) continue;
        const local = locals.get((element.propertyName ?? element.name).text);
        if (local) return located(local, hostStatement(local));
      }
    }
  }
  return undefined;
}
