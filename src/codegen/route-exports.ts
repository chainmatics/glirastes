import ts from 'typescript';
import type { EndpointMethod } from '../types.js';

const methods = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface RouteExportFinding {
  code: 'route-export-unresolved' | 'route-wildcard-export-unresolved' | 'route-source-invalid';
  exportName?: EndpointMethod;
}

/** Read only local export syntax. Never import or execute the scanned application. */
export function readRouteExports(source: string, fileName = 'route.ts'): {
  exports: Array<{ method: EndpointMethod; body: string }>;
  findings: RouteExportFinding[];
} {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  // A recovery AST can contain a seemingly valid export in invalid source.
  // Use the public diagnostic API with an in-memory host: no imports, libs,
  // filesystem reads or evaluation of application code.
  const program = ts.createProgram([file.fileName], { noLib: true, noResolve: true, noEmit: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, {
    getSourceFile: (name) => name === file.fileName ? file : undefined,
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === file.fileName,
    readFile: (name) => name === file.fileName ? source : undefined,
  });
  if (program.getSyntacticDiagnostics(file).length > 0) {
    return { exports: [], findings: [{ code: 'route-source-invalid' }] };
  }
  const locals = new Map<string, ts.Node>();
  const exports: Array<{ method: EndpointMethod; body: string }> = [];
  const findings: RouteExportFinding[] = [];
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          locals.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  const bodyOf = (node: ts.Node | undefined, seen = new Set<string>()): string | undefined => {
    if (!node) return undefined;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      return node.body?.getText(file);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return bodyOf(node.expression, seen);
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      return bodyOf(locals.get(node.text), seen);
    }
    return undefined;
  };
  const add = (name: string, node?: ts.Node) => {
    if (!methods.has(name)) return;
    const method = name as EndpointMethod;
    const body = bodyOf(node);
    if (body === undefined) {
      findings.push({ exportName: method, code: 'route-export-unresolved' });
    } else if (!exports.some((entry) => entry.method === method)) {
      exports.push({ method, body });
    }
  };
  const unresolvedBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      add(name.text);
    } else {
      for (const element of name.elements) {
        if (!ts.isOmittedExpression(element)) unresolvedBinding(element.name);
      }
    }
  };

  for (const statement of file.statements) {
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) {
        findings.push({ code: 'route-wildcard-export-unresolved' });
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          add(element.name.text, statement.moduleSpecifier
            ? undefined
            : locals.get((element.propertyName ?? element.name).text));
        }
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        add(statement.exportClause.name.text);
      }
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        add(statement.name.text, locals.get(statement.name.text));
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            add(declaration.name.text, declaration.initializer);
          } else {
            unresolvedBinding(declaration.name);
          }
        }
      }
    }
  }
  return { exports, findings };
}
