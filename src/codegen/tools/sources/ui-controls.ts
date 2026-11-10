import ts from 'typescript';
import type { ToolPolicyFile } from '../../../contracts/tool-policy.js';
import { compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import type { AppProgram } from '../program.js';
import type { JsonSchemaLike, ToolFinding } from '../types.js';
import type { AppSourceFile } from './app-files.js';
import { importBindings, importedName, uiDefinitionIdForAction } from './ui-tools.js';

/**
 * Stateful UI controls without a client action (concept
 * `2026-10-28-ui-state-controls-concept.md`, option A). A control never
 * becomes a tool here: the finding proposes the `useAiClientAction` the app
 * adds where the state lives, and the `react-actions` source derives the tool
 * from that registration on the next refresh.
 */

/** Text that makes a file worth parsing for controls. */
export const CONTROL_TEXT = /createContext|next-themes/;

/** Names that hint at a secret; such controls stay out of the chat. */
const SECRET_NAME = /password|passwort|secret|token|api_?key|credential/i;

type ControlValue = string | boolean;

/** What a registered client action looks like to the control analysis. */
export interface ControlRegistration {
  actionId: string;
  stableKey: string;
  handler: ts.Expression | undefined;
  schema: JsonSchemaLike | undefined;
}

export interface UiControlInput {
  app: AppProgram;
  /** Files in the program that may declare or reach a control. */
  files: ReadonlyArray<AppSourceFile>;
  /** Every scanned app file, for the files that use a setter. */
  allFiles: ReadonlyArray<AppSourceFile>;
  registrations: ReadonlyArray<ControlRegistration>;
  policy: ToolPolicyFile;
  /** The function a handler or setter expression stands for. */
  functionOf(expression: ts.Expression | undefined): ts.SignatureDeclaration | undefined;
  /** Whether a function writes through `fetch` or `axios` (then the route is the tool). */
  writes(fn: ts.SignatureDeclaration | undefined): boolean;
}

export interface UiControlAnalysis {
  /** `ui-control-unbound` per control no client action reaches. */
  findings: ToolFinding[];
  /** `ui-control-contract-mismatch` by the stable key of the client action. */
  byStableKey: Map<string, ToolFinding[]>;
}

interface Control {
  ref: string;
  file: string;
  setter: string;
  state: string;
  values: ControlValue[];
  actionId: string;
  /** Lines before the registration, e.g. the hook call that yields the setter. */
  preamble?: string;
  reaches(callee: ts.Expression): boolean;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function resolved(app: AppProgram, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? app.checker.getAliasedSymbol(symbol) : symbol;
}

/** `UiSizeContext` → `ui-size`; `CompactModeContext` → `compact-mode`. */
function kebab(name: string): string {
  return name.replace(/Context$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** A closed domain: a boolean or a union of at least two string literals. */
function domainOf(type: ts.Type): ControlValue[] | undefined {
  if (type.flags & ts.TypeFlags.Boolean) return [false, true];
  if (!type.isUnion()) return undefined;
  const values: string[] = [];
  for (const member of type.types) {
    if (!member.isStringLiteral()) return undefined;
    values.push(member.value);
  }
  return values.length >= 2 ? [...new Set(values)].sort(compareCodeUnits) : undefined;
}

function literalText(value: ControlValue): string {
  return typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(value);
}

function registrationOf(control: Control): string {
  const schema = typeof control.values[0] === 'boolean'
    ? 'z.boolean()'
    : `z.enum([${control.values.map(literalText).join(', ')}])`;
  const line = `useAiClientAction('${control.actionId}', ({ ${control.state} }) => ${control.setter}(${control.state}), `
    + `z.object({ ${control.state}: ${schema} }));`;
  return control.preamble ? `${control.preamble}\n${line}` : line;
}

/** The property a destructured binding reads, e.g. `setSize` of `const { setSize } = useUiSize()`. */
function bindingProperty(app: AppProgram, declaration: ts.Declaration): ts.Symbol | undefined {
  if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return undefined;
  const name = declaration.propertyName ?? declaration.name;
  if (!ts.isIdentifier(name)) return undefined;
  return app.checker.getPropertyOfType(app.checker.getTypeAtLocation(declaration.parent), name.text);
}

/** The symbols a callee may stand for: itself, its alias target and the property it was read from. */
function calleeSymbols(app: AppProgram, callee: ts.Expression): ts.Symbol[] {
  const expression = unwrap(callee);
  const symbols: ts.Symbol[] = [];
  const own = resolved(app, app.checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expression) ? expression.name : expression,
  ));
  if (own) symbols.push(own);
  for (const declaration of own?.declarations ?? []) {
    const property = bindingProperty(app, declaration);
    if (property) symbols.push(property);
  }
  return symbols;
}

function calleeName(callee: ts.Expression): string | undefined {
  const expression = unwrap(callee);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function contextControls(app: AppProgram, input: UiControlInput, sources: ReadonlyArray<[AppSourceFile, ts.SourceFile]>): Control[] {
  const checker = app.checker;
  const controls: Control[] = [];
  for (const [file, source] of sources) {
    const bindings = importBindings(source, [{ module: 'react', names: ['createContext'] }]);
    const defaults = new Set(source.statements.flatMap((statement) => (
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === 'react' && statement.importClause?.name
        ? [statement.importClause.name.text] : []
    )));
    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const isCreate = importedName(callee, bindings) === 'createContext'
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createContext'
          && ts.isIdentifier(callee.expression) && defaults.has(callee.expression.text));
      if (!isCreate || !ts.isVariableDeclaration(node.parent) || !ts.isIdentifier(node.parent.name)) return;
      const contextName = node.parent.name.text;
      const contextSymbol = checker.getSymbolAtLocation(node.parent.name);
      const typeNode = node.typeArguments?.[0];
      const valueType = typeNode
        ? checker.getTypeFromTypeNode(typeNode)
        : node.arguments[0] ? checker.getTypeAtLocation(node.arguments[0]) : undefined;
      if (!valueType || !contextSymbol) return;
      const provided = providerValues(app, sources, contextSymbol);
      for (const property of checker.getPropertiesOfType(valueType)) {
        const match = /^set([A-Z]\w*)$/.exec(property.name);
        if (!match) continue;
        const state = match[1]!.charAt(0).toLowerCase() + match[1]!.slice(1);
        if (!checker.getPropertyOfType(valueType, state)) continue;
        if (SECRET_NAME.test(state) || SECRET_NAME.test(contextName)) continue;
        const signatures = checker.getTypeOfSymbolAtLocation(property, node).getCallSignatures();
        const parameter = signatures.length === 1 ? signatures[0]!.parameters[0] : undefined;
        const values = parameter ? domainOf(checker.getTypeOfSymbolAtLocation(parameter, node)) : undefined;
        if (!values) continue;
        const value = provided.get(property.name);
        if (value && input.writes(input.functionOf(value.expression))) continue;
        const identities = new Set<ts.Symbol>([property, ...(value?.symbol ? [value.symbol] : [])]);
        controls.push({
          ref: `${file.path}#${property.name}`,
          file: value?.file ?? file.path,
          setter: property.name,
          state,
          values,
          actionId: `${kebab(contextName) || state}.set`,
          reaches: (callee) => {
            const symbols = calleeSymbols(app, callee);
            // Without types (an `any` hook) the name is the only evidence left.
            if (symbols.length === 0) return calleeName(callee) === property.name;
            return symbols.some((symbol) => identities.has(symbol));
          },
        });
      }
    };
    visit(source);
  }
  return controls;
}

/** What `<Context.Provider value={{ … }}>` (or `<Context value>`) passes per property. */
function providerValues(
  app: AppProgram,
  sources: ReadonlyArray<[AppSourceFile, ts.SourceFile]>,
  contextSymbol: ts.Symbol,
): Map<string, { file: string; expression: ts.Expression; symbol: ts.Symbol | undefined }> {
  const values = new Map<string, { file: string; expression: ts.Expression; symbol: ts.Symbol | undefined }>();
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const tag = node.tagName;
      const target = ts.isPropertyAccessExpression(tag) && tag.name.text === 'Provider' ? tag.expression : tag;
      if (resolved(app, app.checker.getSymbolAtLocation(target)) !== contextSymbol) return;
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name) || attribute.name.text !== 'value') continue;
        const initializer = attribute.initializer;
        const object = initializer && ts.isJsxExpression(initializer) && initializer.expression
          ? unwrap(initializer.expression) : undefined;
        if (!object || !ts.isObjectLiteralExpression(object)) continue;
        for (const property of object.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            values.set(property.name.text, {
              file: file.path,
              expression: property.name,
              symbol: resolved(app, app.checker.getShorthandAssignmentValueSymbol(property)),
            });
          } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
            const expression = unwrap(property.initializer);
            values.set(property.name.text, {
              file: file.path,
              expression,
              symbol: ts.isIdentifier(expression) ? resolved(app, app.checker.getSymbolAtLocation(expression)) : undefined,
            });
          }
        }
      }
    };
    visit(source);
  }
  return values;
}

const NEXT_THEMES = [{ module: 'next-themes', names: ['ThemeProvider', 'useTheme'] }];

/** Whether an expression is a `useTheme()` call of next-themes, directly or through a variable. */
function isUseThemeCall(app: AppProgram, expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (ts.isCallExpression(value)) {
    return importedName(value.expression, importBindings(value.getSourceFile(), NEXT_THEMES)) === 'useTheme';
  }
  if (ts.isIdentifier(value)) {
    const declaration = resolved(app, app.checker.getSymbolAtLocation(value))?.valueDeclaration;
    return Boolean(declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isCallExpression(unwrap(declaration.initializer)) && isUseThemeCall(app, declaration.initializer));
  }
  return false;
}

/** `setTheme` read from `useTheme()`, by destructuring or property access. */
function reachesSetTheme(app: AppProgram, callee: ts.Expression): boolean {
  const expression = unwrap(callee);
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === 'setTheme' && isUseThemeCall(app, expression.expression);
  }
  if (!ts.isIdentifier(expression)) return false;
  const declaration = resolved(app, app.checker.getSymbolAtLocation(expression))?.valueDeclaration;
  if (!declaration || !ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return false;
  const name = declaration.propertyName ?? declaration.name;
  const variable = declaration.parent.parent;
  return ts.isIdentifier(name) && name.text === 'setTheme'
    && ts.isVariableDeclaration(variable) && variable.initializer !== undefined && isUseThemeCall(app, variable.initializer);
}

function attributeValue(attribute: ts.JsxAttribute): ts.Expression | 'present' | undefined {
  if (!attribute.initializer) return 'present';
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer;
  return ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression
    ? unwrap(attribute.initializer.expression) : undefined;
}

/** The next-themes `ThemeProvider` decides the themes: `themes`, else light and dark, plus system unless disabled. */
function themeControls(app: AppProgram, sources: ReadonlyArray<[AppSourceFile, ts.SourceFile]>): Control[] {
  for (const [file, source] of sources) {
    const bindings = importBindings(source, NEXT_THEMES);
    let found: ControlValue[] | undefined;
    const visit = (node: ts.Node): void => {
      if (found) return;
      ts.forEachChild(node, visit);
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      if (importedName(node.tagName, bindings) !== 'ThemeProvider') return;
      let themes: string[] | undefined = ['dark', 'light'];
      let system = true;
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) continue;
        const value = attributeValue(attribute);
        if (attribute.name.text === 'enableSystem') {
          system = value === 'present' || value?.kind === ts.SyntaxKind.TrueKeyword;
        } else if (attribute.name.text === 'themes') {
          themes = value && value !== 'present' && ts.isArrayLiteralExpression(value)
            && value.elements.every(ts.isStringLiteralLike)
            ? value.elements.map((element) => (element as ts.StringLiteralLike).text)
            : undefined;
        }
      }
      if (themes) found = [...new Set([...themes, ...(system ? ['system'] : [])])].sort(compareCodeUnits);
    };
    visit(source);
    if (found && found.length >= 2) {
      return [{
        ref: `${file.path}#setTheme`,
        file: file.path,
        setter: 'setTheme',
        state: 'theme',
        values: found,
        actionId: 'theme.set',
        preamble: 'const { setTheme } = useTheme();',
        reaches: (callee) => reachesSetTheme(app, callee),
      }];
    }
  }
  return [];
}

/** Every call inside a function body, including the body of a handler given by name. */
function calleesOf(fn: ts.SignatureDeclaration | undefined): ts.Expression[] {
  const body = fn && 'body' in fn ? (fn as ts.FunctionLikeDeclaration).body : undefined;
  if (!body) return [];
  const callees: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) callees.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return callees;
}

/** String properties of a payload: at least one must stay within the setter's values. */
function contractAllowsOthers(schema: JsonSchemaLike | undefined, values: ReadonlyArray<ControlValue>): boolean {
  if (!schema || typeof values[0] === 'boolean') return false;
  const properties = Object.values((schema.properties ?? {}) as Record<string, JsonSchemaLike>)
    .filter((property) => property.type === 'string');
  if (properties.length === 0) return false;
  return !properties.some((property) => Array.isArray(property.enum)
    && property.enum.every((value) => values.includes(value as ControlValue)));
}

export function analyzeUiControls(input: UiControlInput): UiControlAnalysis {
  const sources = input.files
    .filter((file) => CONTROL_TEXT.test(file.source) || /useAiClientAction|registerAiClientAction|subscribeById/.test(file.source))
    .flatMap((file) => {
      const source = input.app.sourceFile(file.absolute);
      return source ? [[file, source] as [AppSourceFile, ts.SourceFile]] : [];
    });
  const excluded = new Set((input.policy.excludeControls ?? []).map((entry) => entry.control));
  const controls = [...contextControls(input.app, input, sources), ...themeControls(input.app, sources)]
    .filter((control) => !excluded.has(control.ref))
    .filter((control) => uiDefinitionIdForAction(control.actionId) !== undefined);
  const findings: ToolFinding[] = [];
  const byStableKey = new Map<string, ToolFinding[]>();
  for (const control of controls.sort((left, right) => compareCodeUnits(left.ref, right.ref))) {
    const reaching = input.registrations.filter((registration) => {
      const handler = registration.handler ? unwrap(registration.handler) : undefined;
      if (handler && ts.isIdentifier(handler) && control.reaches(handler)) return true;
      return calleesOf(input.functionOf(registration.handler)).some((callee) => control.reaches(callee));
    });
    if (reaching.length > 0) {
      for (const registration of reaching) {
        if (!contractAllowsOthers(registration.schema, control.values)) continue;
        byStableKey.set(registration.stableKey, [...byStableKey.get(registration.stableKey) ?? [],
          toolFinding('ui-control-contract-mismatch', 'needs_attention', registration.stableKey,
            `${registration.actionId} calls ${control.setter}, which takes ${control.values.join(', ')}; its contract allows other values.`)]);
      }
      continue;
    }
    const setterText = new RegExp(`\\b${control.setter}\\b`);
    const definedIn = control.ref.slice(0, control.ref.indexOf('#'));
    const usedIn = input.allFiles
      .filter((file) => file.path !== control.file && file.path !== definedIn && setterText.test(file.source))
      .map((file) => file.path)
      .sort(compareCodeUnits);
    findings.push({
      ...toolFinding('ui-control-unbound', 'warning', control.ref,
        `${control.setter} (${control.values.join(', ')}) has no client action, so the chat cannot set ${control.state}.`),
      expected: {
        actionId: control.actionId,
        file: control.file,
        setter: control.setter,
        state: control.state,
        values: control.values,
        usedIn,
        registration: registrationOf(control),
      },
    });
  }
  return { findings, byStableKey };
}
