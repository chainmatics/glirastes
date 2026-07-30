import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const reactRoot = join(process.cwd(), 'src/react');

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionSources(path);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function isBoundedDiagnosticExpression(expression: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
    || ts.isNumericLiteral(expression)
  ) {
    return true;
  }
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.every((span) => (
      isBoundedDiagnosticExpression(span.expression)
    ));
  }
  return (
    ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'length'
  );
}

describe('React production diagnostics', () => {
  it('logs only bounded static text and counts', () => {
    const violations: string[] = [];

    for (const path of productionSources(reactRoot)) {
      const sourceText = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'console'
          && !node.arguments.every(isBoundedDiagnosticExpression)
        ) {
          const position = source.getLineAndCharacterOfPosition(node.getStart());
          violations.push(
            `${path.slice(process.cwd().length + 1)}:${position.line + 1}`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
