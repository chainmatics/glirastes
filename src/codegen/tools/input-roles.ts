import ts from 'typescript';
import { compareCodeUnits } from './canonical.js';
import {
  bindingKey,
  unwrapExpression,
  type HandlerFunction,
  type LocatedHandler,
} from './handler-locator.js';

export type InputRole = 'body' | 'query' | 'path';

export type LocalBinding =
  | { kind: 'init'; expression: ts.Expression }
  | { kind: 'destructured'; from: ts.Expression; property: string };

export interface RoleContext {
  readonly requestName?: string;
  readonly contextName?: string;
  readonly paramsName?: string;
  readonly declarations: ReadonlyMap<string, LocalBinding>;
  isBodyReaderCall(call: ts.CallExpression): boolean;
}

const MAX_DEPTH = 6;

export function createRoleContext(
  handler: LocatedHandler,
  isBodyReaderCall: (call: ts.CallExpression) => boolean,
): RoleContext {
  const declarations = new Map<string, LocalBinding>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        if (!declarations.has(node.name.text)) {
          declarations.set(node.name.text, { kind: 'init', expression: node.initializer });
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = bindingKey(element);
          if (!element.dotDotDotToken && property && ts.isIdentifier(element.name)
            && !declarations.has(element.name.text)) {
            declarations.set(element.name.text, { kind: 'destructured', from: node.initializer, property });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (handler.fn?.body) visit(handler.fn.body);
  return {
    requestName: handler.requestName,
    contextName: handler.contextName,
    paramsName: handler.paramsName,
    declarations,
    isBodyReaderCall,
  };
}

function isRequestExpression(node: ts.Expression, ctx: RoleContext, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isIdentifier(target)) {
    if (ctx.requestName && target.text === ctx.requestName) return true;
    const binding = ctx.declarations.get(target.text);
    return binding?.kind === 'init' && isRequestExpression(binding.expression, ctx, depth + 1);
  }
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
    && target.expression.name.text === 'clone') {
    return isRequestExpression(target.expression.expression, ctx, depth + 1);
  }
  return false;
}

export function isRequestBodyRead(node: ts.Expression, ctx: RoleContext): boolean {
  const target = unwrapExpression(node);
  if (!ts.isCallExpression(target)) return false;
  if (ctx.isBodyReaderCall(target)) return true;
  return ts.isPropertyAccessExpression(target.expression)
    && target.expression.name.text === 'json'
    && isRequestExpression(target.expression.expression, ctx);
}

function isUrlExpression(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isNewExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'URL') {
    const first = target.arguments?.[0];
    const value = first ? unwrapExpression(first) : undefined;
    return Boolean(value && ts.isPropertyAccessExpression(value) && value.name.text === 'url'
      && isRequestExpression(value.expression, ctx, depth + 1));
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'nextUrl') {
    return isRequestExpression(target.expression, ctx, depth + 1);
  }
  if (ts.isIdentifier(target)) {
    const binding = ctx.declarations.get(target.text);
    return binding?.kind === 'init' && isUrlExpression(binding.expression, ctx, depth + 1);
  }
  return false;
}

export function isSearchParamsExpression(node: ts.Expression, ctx: RoleContext, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'searchParams') {
    return isUrlExpression(target.expression, ctx, depth + 1);
  }
  if (ts.isIdentifier(target)) {
    const binding = ctx.declarations.get(target.text);
    if (binding?.kind === 'init') return isSearchParamsExpression(binding.expression, ctx, depth + 1);
    if (binding?.kind === 'destructured') {
      return binding.property === 'searchParams' && isUrlExpression(binding.from, ctx, depth + 1);
    }
  }
  return false;
}

function isSearchParamsLike(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  const target = unwrapExpression(node);
  if (isSearchParamsExpression(target, ctx, depth + 1)) return true;
  return (ts.isIdentifier(target) && target.text === 'searchParams')
    || (ts.isPropertyAccessExpression(target) && target.name.text === 'searchParams');
}

function searchParamRead(
  node: ts.Expression,
  ctx: RoleContext,
  depth: number,
): { key: string; repeated: boolean } | undefined {
  let target = unwrapExpression(node);
  if (ts.isBinaryExpression(target) && (
    target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    || target.operatorToken.kind === ts.SyntaxKind.BarBarToken
  )) {
    target = unwrapExpression(target.left);
  }
  if (!ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression)) return undefined;
  const method = target.expression.name.text;
  if (method !== 'get' && method !== 'getAll') return undefined;
  const key = target.arguments[0];
  if (!key || !ts.isStringLiteralLike(key)) return undefined;
  if (!isSearchParamsLike(target.expression.expression, ctx, depth)) return undefined;
  return { key: key.text, repeated: method === 'getAll' };
}

function isSearchParamsObject(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  const target = unwrapExpression(node);
  if (
    ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
    && ts.isIdentifier(target.expression.expression) && target.expression.expression.text === 'Object'
    && target.expression.name.text === 'fromEntries'
  ) {
    const argument = target.arguments[0];
    if (!argument) return false;
    const inner = unwrapExpression(argument);
    if (isSearchParamsExpression(inner, ctx, depth + 1)) return true;
    return ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)
      && inner.expression.name.text === 'entries'
      && isSearchParamsExpression(inner.expression.expression, ctx, depth + 1);
  }
  if (ts.isObjectLiteralExpression(target) && target.properties.length > 0) {
    return target.properties.every((property) => (
      ts.isPropertyAssignment(property) && searchParamRead(property.initializer, ctx, depth) !== undefined
    ));
  }
  return false;
}

function isContextExpression(node: ts.Expression, ctx: RoleContext): boolean {
  const target = unwrapExpression(node);
  return Boolean(ctx.contextName) && ts.isIdentifier(target) && target.text === ctx.contextName;
}

function isParamsExpression(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isIdentifier(target)) {
    if (ctx.paramsName && target.text === ctx.paramsName) return true;
    const binding = ctx.declarations.get(target.text);
    if (binding?.kind === 'init') return isParamsExpression(binding.expression, ctx, depth + 1);
    if (binding?.kind === 'destructured') {
      return binding.property === 'params' && isContextExpression(binding.from, ctx);
    }
    return false;
  }
  return ts.isPropertyAccessExpression(target) && target.name.text === 'params'
    && isContextExpression(target.expression, ctx);
}

/** Data flow inside one handler: where does the value a schema parses come from? */
export function classifyInputExpression(
  node: ts.Expression,
  ctx: RoleContext,
  depth = 0,
): InputRole | 'unclear' {
  if (depth > MAX_DEPTH) return 'unclear';
  const target = unwrapExpression(node);
  if (isRequestBodyRead(target, ctx)) return 'body';
  if (isSearchParamsObject(target, ctx, depth)) return 'query';
  if (isParamsExpression(target, ctx, depth)) return 'path';
  if (ts.isIdentifier(target)) {
    const binding = ctx.declarations.get(target.text);
    if (binding?.kind === 'init') return classifyInputExpression(binding.expression, ctx, depth + 1);
  }
  return 'unclear';
}

export function collectQueryKeys(
  scope: ts.Node,
  ctx: RoleContext,
): { keys: string[]; repeated: string[] } {
  const keys = new Set<string>();
  const repeated = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const read = searchParamRead(node, ctx, 0);
      if (read) {
        keys.add(read.key);
        if (read.repeated) repeated.add(read.key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return {
    keys: [...keys].sort(compareCodeUnits),
    repeated: [...repeated].sort(compareCodeUnits),
  };
}

/** Body keys from closed destructuring and literal property reads; anything else is opaque. */
export function collectBodyKeys(
  fn: HandlerFunction | undefined,
  ctx: RoleContext,
  checker: ts.TypeChecker,
): { readsBody: boolean; keys: string[] | 'opaque' } {
  let readsBody = false;
  let opaque = false;
  const keys = new Set<string>();
  const body = fn?.body;
  if (!body) return { readsBody, keys: [] };

  const addPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      const key = bindingKey(element);
      if (element.dotDotDotToken || key === undefined) {
        opaque = true;
        continue;
      }
      keys.add(key);
    }
  };
  const followVariable = (name: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) {
      opaque = true;
      return;
    }
    const visitReferences = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== name && checker.getSymbolAtLocation(node) === symbol) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          keys.add(parent.name.text);
        } else if (ts.isElementAccessExpression(parent) && parent.expression === node
          && ts.isStringLiteralLike(parent.argumentExpression)) {
          keys.add(parent.argumentExpression.text);
        } else if (ts.isVariableDeclaration(parent) && parent.initializer === node
          && ts.isObjectBindingPattern(parent.name)) {
          addPattern(parent.name);
        } else {
          opaque = true;
        }
      }
      ts.forEachChild(node, visitReferences);
    };
    visitReferences(body);
  };
  const consume = (read: ts.Node): void => {
    let consumer = read;
    while (consumer.parent && (
      ts.isAwaitExpression(consumer.parent) || ts.isParenthesizedExpression(consumer.parent)
      || ts.isAsExpression(consumer.parent) || ts.isNonNullExpression(consumer.parent)
      || ts.isSatisfiesExpression(consumer.parent)
    )) {
      consumer = consumer.parent;
    }
    const parent = consumer.parent;
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === consumer) {
      if (ts.isObjectBindingPattern(parent.name)) {
        addPattern(parent.name);
        return;
      }
      if (ts.isIdentifier(parent.name)) {
        followVariable(parent.name);
        return;
      }
    }
    opaque = true;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRequestBodyRead(node, ctx)) {
      readsBody = true;
      consume(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { readsBody, keys: opaque ? 'opaque' : [...keys].sort(compareCodeUnits) };
}
