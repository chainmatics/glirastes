/**
 * How a file reaches the decorators of `@nestjs/common`, through a named or a
 * namespace import. Shared by the Nest endpoint source and the execution
 * inventory, so a controller the source enumerates is one the inventory verifies.
 */
import ts from 'typescript';
import type { EndpointMethod } from '../../../types.js';

const NEST_COMMON = '@nestjs/common';
const NEST_CORE = '@nestjs/core';
const NEST_ZOD = 'nestjs-zod';
/** The HTTP method decorators of `@nestjs/common` that become endpoint tools. */
export const NEST_METHOD_DECORATORS: Readonly<Record<string, EndpointMethod>> = {
  Get: 'GET', Head: 'HEAD', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE',
};

export interface NestImports {
  /** Local name → exported name, for named imports of `@nestjs/common`. */
  common: Map<string, string>;
  commonNamespaces: Set<string>;
  core: Set<string>;
  createZodDto: Set<string>;
}

/** The `@nestjs/common`, `@nestjs/core` and `nestjs-zod` bindings of a file, ignoring type-only imports. */
export function readImports(file: ts.SourceFile): NestImports {
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
export function decoratorName(decorator: ts.Decorator, imports: NestImports): { name: string; args: ts.NodeArray<ts.Expression> } | undefined {
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

export function decoratorsOf(node: ts.Node, imports: NestImports): Array<{ name: string; args: ts.NodeArray<ts.Expression> }> {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  return decorators.flatMap((decorator) => {
    const found = decoratorName(decorator, imports);
    return found ? [found] : [];
  });
}
