import ts from 'typescript';
import { compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import { createAppProgram, type AppProgram } from '../program.js';
import type { ExcludedTool, ToolFinding, ToolSource } from '../types.js';
import { scanAppSources } from './app-files.js';
import { pageStableKey, pathExclusion, type PageEntry, type PageTree } from './page-tree.js';
import { importBindings, importedName, type ImportSpec } from './ui-tools.js';
import { observeNavigation } from './next-pages.js';
import type { PolicyExcludeRule } from '../exclusions.js';

const ROUTER_MODULES = ['react-router', 'react-router-dom'];
const ROUTER_CALLS = ['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes'];
const JSX_ROUTES = ['Route', 'Routes', 'createRoutesFromElements', 'createRoutesFromChildren'];
const ROUTER_SPECS: ReadonlyArray<ImportSpec> = ROUTER_MODULES.map((module) => ({
  module, names: [...ROUTER_CALLS, ...JSX_ROUTES],
}));
const MAX_ROUTES = 5_000;
const MAX_DEPTH = 32;

export interface RouteConfigOptions {
  /** Where the route objects are searched; `src` when the app has one, else the app root. */
  srcDir?: string;
}

interface RoutePage {
  path: string;
  params: string[];
  file: string;
  component?: string;
  reason?: string;
  /** An index route: it renders inside its parent, so it is the page of the parent's path. */
  index: boolean;
}

type Read = { pages: RoutePage[] } | { failure: string };

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** An array literal, directly or through a `const` binding. */
function arrayOf(app: AppProgram, node: ts.Expression): ts.ArrayLiteralExpression | undefined {
  const value = unwrap(node);
  if (ts.isArrayLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;
  let symbol = app.checker.getSymbolAtLocation(value);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
  const list = declaration?.parent;
  if (!declaration?.initializer || !list || !ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
  const initializer = unwrap(declaration.initializer);
  return ts.isArrayLiteralExpression(initializer) ? initializer : undefined;
}

/** The module and export name a component reference points to. */
function componentOf(app: AppProgram, node: ts.Expression): { file: string; component: string } | undefined {
  let target: ts.Node | undefined = unwrap(node);
  if (ts.isJsxSelfClosingElement(target) || ts.isJsxElement(target)) {
    const tag = ts.isJsxElement(target) ? target.openingElement.tagName : target.tagName;
    target = tag;
  }
  if (!ts.isIdentifier(target)) return undefined;
  let symbol = app.checker.getSymbolAtLocation(target);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  const file = declaration ? app.appRelative(declaration.getSourceFile().fileName) : undefined;
  if (!declaration || !file || !symbol) return undefined;
  const isDefault = ts.canHaveModifiers(declaration)
    && (ts.getModifiers(declaration) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  return { file, component: isDefault ? 'default' : symbol.name };
}

/** `lazy: () => import('./TasksPage')`: the module, rendering its `Component` or default export. */
function lazyComponentOf(app: AppProgram, node: ts.Expression): { file: string; component: string } | undefined {
  let found: { file: string; component: string } | undefined;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword && child.arguments[0]) {
      const moduleSymbol = app.checker.getSymbolAtLocation(child.arguments[0]);
      const sourceFile = moduleSymbol?.declarations?.find(ts.isSourceFile);
      const file = sourceFile ? app.appRelative(sourceFile.fileName) : undefined;
      if (moduleSymbol && file) {
        const names = new Set(app.checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name));
        const component = names.has('Component') ? 'Component' : names.has('default') ? 'default' : undefined;
        if (component) found = { file, component };
      }
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function joinRoute(parent: string, own: string): string {
  const segments = (own.startsWith('/') ? own : `${parent}/${own}`).split('/').filter(Boolean);
  return `/${segments.join('/')}`;
}

function shape(path: string): { params: string[]; reason?: string } {
  const params: string[] = [];
  for (const segment of path.split('/').filter(Boolean)) {
    if (segment === '*' || segment.startsWith('*')) return { params, reason: 'catch-all-page' };
    if (segment.endsWith('?')) return { params, reason: 'optional-segment-page' };
    if (segment.startsWith(':')) params.push(segment.slice(1));
  }
  return { params };
}

function readRoutes(app: AppProgram, file: string, array: ts.ArrayLiteralExpression, parent: string, depth: number, into: RoutePage[]): string | undefined {
  if (depth > MAX_DEPTH) return `${file} nests routes deeper than ${MAX_DEPTH} levels.`;
  for (const element of array.elements) {
    const route = unwrap(element as ts.Expression);
    if (!ts.isObjectLiteralExpression(route)) return `${file} has a route that is not an object literal.`;
    let path: string | undefined;
    let index = false;
    let component: { file: string; component: string } | undefined;
    let children: ts.ArrayLiteralExpression | undefined;
    for (const property of route.properties) {
      if (ts.isSpreadAssignment(property)) return `${file} spreads a route object, so its routes cannot be enumerated.`;
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      if (name === 'path') {
        const literal = unwrap(value);
        if (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal)) {
          return `${file} has a route path that is not a string literal.`;
        }
        path = literal.text;
      } else if (name === 'index') {
        index = value.kind === ts.SyntaxKind.TrueKeyword;
      } else if (name === 'children') {
        children = arrayOf(app, value);
        if (!children) return `${file} has route children that are not an array literal.`;
      } else if (name === 'Component' || name === 'element') {
        component = componentOf(app, value) ?? component;
      } else if (name === 'lazy') {
        component = lazyComponentOf(app, value) ?? component;
      }
    }
    const full = path !== undefined ? joinRoute(parent, path) : parent;
    if ((path !== undefined || index) && (component || index)) {
      const { params, reason } = shape(full);
      into.push({
        path: full,
        params,
        file: component?.file ?? file,
        ...(component ? { component: component.component } : {}),
        ...(reason ? { reason } : {}),
        index: index && path === undefined,
      });
      if (into.length > MAX_ROUTES) return 'The app has too many routes to enumerate.';
    }
    if (children) {
      const failure = readRoutes(app, file, children, full, depth + 1, into);
      if (failure) return failure;
    }
  }
  return undefined;
}

function readFile(app: AppProgram, source: ts.SourceFile): Read {
  const file = app.appRelative(source.fileName) ?? source.fileName;
  const bindings = importBindings(source, ROUTER_SPECS);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) return { pages: [] };
  const pages: RoutePage[] = [];
  let failure: string | undefined;
  const visit = (node: ts.Node): void => {
    if (failure) return;
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      && JSX_ROUTES.includes(importedName(node.tagName, bindings) ?? '')) {
      failure = `${file} declares JSX routes; the generator reads route object arrays only.`;
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = importedName(node.expression, bindings);
      if (name && JSX_ROUTES.includes(name)) {
        failure = `${file} builds routes from elements; the generator reads route object arrays only.`;
        return;
      }
      if (name && ROUTER_CALLS.includes(name)) {
        const array = node.arguments[0] ? arrayOf(app, node.arguments[0]) : undefined;
        if (!array) {
          failure = `${file} passes ${name} routes that are not an array literal.`;
          return;
        }
        failure = readRoutes(app, file, array, '', 0, pages);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failure ? { failure } : { pages };
}

/**
 * Pages of a react-router app: the route object arrays given to
 * `createBrowserRouter`, `createHashRouter`, `createMemoryRouter` or
 * `useRoutes`. JSX routes, spread or computed routes make the enumeration
 * incomplete instead of silently missing pages.
 */
export async function enumerateRouteConfigPages(
  root: string,
  options: RouteConfigOptions,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
): Promise<PageTree> {
  const scan = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: (source) => /['"]react-router(?:-dom)?['"]/.test(source),
  });
  if (!scan.complete) return { complete: false, reason: scan.reason };
  if (scan.files.length === 0) return { complete: true, pages: [], excluded: [], findings: [] };
  const app = createAppProgram({ root, rootNames: scan.files.map((file) => file.absolute) });
  const read: RoutePage[] = [];
  for (const file of scan.files) {
    const source = app.sourceFile(file.absolute);
    if (!source) return { complete: false, reason: `${file.path} cannot be read.` };
    const result = readFile(app, source);
    if ('failure' in result) return { complete: false, reason: result.failure };
    read.push(...result.pages);
  }
  const pages = new Map<string, PageEntry>();
  const excluded = new Map<string, ExcludedTool>();
  const findings: ToolFinding[] = [];
  for (const page of read) {
    const stableKey = pageStableKey(page.path);
    const exclusion = page.reason ? { reason: page.reason, origin: 'default' as const } : pathExclusion(page.path, policyExcludes);
    if (exclusion) {
      excluded.set(stableKey, { stableKey, ...exclusion });
      continue;
    }
    const existing = pages.get(page.path);
    if (existing && !page.index) {
      findings.push(toolFinding('page-path-duplicated', 'warning', stableKey,
        `Two routes render ${page.path}; navigation uses the one in ${existing.file}.`));
      continue;
    }
    pages.set(page.path, {
      path: page.path, params: page.params, file: page.file, ...(page.component ? { component: page.component } : {}),
    });
  }
  return {
    complete: true,
    pages: [...pages.values()].sort((left, right) => compareCodeUnits(left.path, right.path)),
    excluded: [...excluded.values()].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    findings,
  };
}

/** The declaration of a page component in its module: a named export or `default`. */
export function componentDeclaration(source: ts.SourceFile, component: string): ts.Node | undefined {
  const named = (name: string): ts.Node | undefined => {
    for (const statement of source.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return statement;
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find((candidate) => (
          ts.isIdentifier(candidate.name) && candidate.name.text === name));
        if (declaration) return declaration;
      }
    }
    return undefined;
  };
  if (component !== 'default') return named(component);
  for (const statement of source.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return statement;
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const value = unwrap(statement.expression);
      return ts.isIdentifier(value) ? named(value.text) ?? value : value;
    }
  }
  return undefined;
}

/**
 * The `react-router` source: one `ui.navigate` tool whose destinations are
 * the app's route objects, executed by the navigation bridge.
 */
export function createReactRouterSource(options: RouteConfigOptions = {}): ToolSource {
  return {
    kind: 'react-router',
    observe: async (ctx) => observeNavigation('react-router',
      await enumerateRouteConfigPages(ctx.root, options, ctx.policy.exclude ?? []), ctx.root, ctx.config.locale, options.srcDir),
  };
}
