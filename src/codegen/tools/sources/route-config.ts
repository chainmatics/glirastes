import { dirname, join } from 'node:path';
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

const JSX_ROUTES = ['Route', 'Routes', 'createRoutesFromElements', 'createRoutesFromChildren'];

/** How one router library declares its route objects. */
interface RouterDialect {
  kind: 'react-router' | 'vue-router';
  specs: ReadonlyArray<ImportSpec>;
  /** Calls that receive the route array. */
  calls: ReadonlyArray<string>;
  /** The route array is the first argument (react-router) or its `routes` property (vue-router). */
  routesIn: 'argument' | 'routes-property';
  components: ReadonlyArray<string>;
  lazy: ReadonlyArray<string>;
  marker: RegExp;
  /** What the component of a route may be, named when it cannot be resolved. */
  unresolved: string;
}

const REACT_ROUTER: RouterDialect = {
  kind: 'react-router',
  specs: ['react-router', 'react-router-dom'].map((module) => ({
    module, names: ['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', ...JSX_ROUTES],
  })),
  calls: ['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes'],
  routesIn: 'argument',
  components: ['Component', 'element'],
  lazy: ['lazy'],
  marker: /['"]react-router(?:-dom)?['"]/,
  unresolved: 'wrapped element, inline component or unresolvable lazy module',
};

const VUE_ROUTER: RouterDialect = {
  kind: 'vue-router',
  specs: [{ module: 'vue-router', names: ['createRouter'] }],
  calls: ['createRouter'],
  routesIn: 'routes-property',
  components: ['component', 'components'],
  lazy: [],
  marker: /['"]vue-router['"]/,
  unresolved: 'inline component, named views without a default view or an unresolvable import',
};

const DIALECTS = { 'react-router': REACT_ROUTER, 'vue-router': VUE_ROUTER } as const;
export type RouterKind = keyof typeof DIALECTS;
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
  return constArrayOf(app, app.checker.getSymbolAtLocation(value));
}

function constArrayOf(app: AppProgram, found: ts.Symbol | undefined): ts.ArrayLiteralExpression | undefined {
  let symbol = found;
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
  const list = declaration?.parent;
  if (!declaration?.initializer || !list || !ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
  const initializer = unwrap(declaration.initializer);
  return ts.isArrayLiteralExpression(initializer) ? initializer : undefined;
}

/** The `.vue` module an import specifier points to: through the program, else relative to the importing file. */
function vueModuleOf(app: AppProgram, specifier: ts.Expression): string | undefined {
  if (!ts.isStringLiteralLike(specifier) || !specifier.text.endsWith('.vue')) return undefined;
  const resolved = app.checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
  if (resolved) return app.appRelative(resolved.fileName);
  if (!specifier.text.startsWith('.')) return undefined;
  return app.appRelative(join(dirname(specifier.getSourceFile().fileName), specifier.text));
}

/** A single-file component: a default import of a `.vue` module, or `() => import('./X.vue')`. */
function vueComponentOf(app: AppProgram, node: ts.Expression): { file: string; component: string } | undefined {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) {
    const declaration = app.checker.getSymbolAtLocation(value)?.declarations?.[0];
    if (!declaration || !ts.isImportClause(declaration) || !ts.isImportDeclaration(declaration.parent)) return undefined;
    const file = vueModuleOf(app, declaration.parent.moduleSpecifier);
    return file ? { file, component: 'default' } : undefined;
  }
  let found: { file: string; component: string } | undefined;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword && child.arguments[0]) {
      const file = vueModuleOf(app, child.arguments[0]);
      if (file) found = { file, component: 'default' };
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(value);
  return found;
}

/** `components: { default: TasksView, sidebar: … }`: the default view renders the page. */
function namedViewsOf(app: AppProgram, node: ts.Expression): { file: string; component: string } | undefined {
  const value = unwrap(node);
  if (!ts.isObjectLiteralExpression(value)) return undefined;
  for (const property of value.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === 'default') return componentOf(app, property.initializer);
  }
  return undefined;
}

/** The module and export name a component reference points to. */
function componentOf(app: AppProgram, node: ts.Expression): { file: string; component: string } | undefined {
  const vue = vueComponentOf(app, node);
  if (vue) return vue;
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
    // vue-router: `:pathMatch(.*)*` matches every remaining path; other custom regexes and repeatables are not read.
    if (/^:\w+\(\.\*\)\*$/.test(segment)) return { params, reason: 'catch-all-page' };
    if (segment.startsWith(':') && (segment.includes('(') || /[*+]$/.test(segment))) return { params, reason: 'unsupported-path' };
    if (segment.endsWith('?')) return { params, reason: 'optional-segment-page' };
    if (segment.startsWith(':')) params.push(segment.slice(1));
  }
  return { params };
}

function readRoutes(
  app: AppProgram,
  dialect: RouterDialect,
  file: string,
  array: ts.ArrayLiteralExpression,
  parent: string,
  depth: number,
  into: RoutePage[],
): string | undefined {
  if (depth > MAX_DEPTH) return `${file} nests routes deeper than ${MAX_DEPTH} levels.`;
  for (const element of array.elements) {
    const route = unwrap(element as ts.Expression);
    if (!ts.isObjectLiteralExpression(route)) return `${file} has a route that is not an object literal.`;
    let path: string | undefined;
    let index = false;
    let component: { file: string; component: string } | undefined;
    let children: ts.ArrayLiteralExpression | undefined;
    let rendersElsewhere = false;
    let declaresRender = false;
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
      } else if (name === 'index' && dialect.kind === 'react-router') {
        index = value.kind === ts.SyntaxKind.TrueKeyword;
      } else if (name === 'children') {
        children = arrayOf(app, value);
        if (!children) return `${file} has route children that are not an array literal.`;
      } else if (name === 'alias' && dialect.kind === 'vue-router') {
        return `${file} has a route alias; the generator reads one path per route.`;
      } else if (name === 'redirect' && dialect.kind === 'vue-router') {
        // A redirect navigates elsewhere; its component, if any, never renders.
        rendersElsewhere = true;
      } else if (name === 'components' && dialect.components.includes(name)) {
        declaresRender = true;
        component = namedViewsOf(app, value) ?? component;
      } else if (name && dialect.components.includes(name)) {
        declaresRender = true;
        component = componentOf(app, value) ?? component;
        const element = unwrap(value);
        if ((ts.isJsxSelfClosingElement(element) || ts.isJsxElement(element))
          && /^Navigate$/.test(ts.isJsxElement(element) ? element.openingElement.tagName.getText() : element.tagName.getText())) {
          rendersElsewhere = true;
        }
      } else if (name && dialect.lazy.includes(name)) {
        declaresRender = true;
        component = lazyComponentOf(app, value) ?? component;
      }
    }
    if (path !== undefined && !index && !component && !children && declaresRender && !rendersElsewhere) {
      return `${file} has a route "${path}" whose component cannot be resolved (${dialect.unresolved}).`;
    }
    if (dialect.kind === 'vue-router' && rendersElsewhere) component = undefined;
    // vue-router: an empty child path renders at its parent's path, like a react-router index route.
    if (dialect.kind === 'vue-router' && path === '' && depth > 0) {
      path = undefined;
      index = component !== undefined;
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
      const failure = readRoutes(app, dialect, file, children, full, depth + 1, into);
      if (failure) return failure;
    }
  }
  return undefined;
}

/** The route array a router call receives. */
function routesOf(app: AppProgram, dialect: RouterDialect, call: ts.CallExpression): ts.ArrayLiteralExpression | undefined {
  const argument = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!argument) return undefined;
  if (dialect.routesIn === 'argument') return arrayOf(app, argument);
  if (!ts.isObjectLiteralExpression(argument)) return undefined;
  for (const property of argument.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === 'routes') return arrayOf(app, property.initializer);
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'routes') {
      return constArrayOf(app, app.checker.getShorthandAssignmentValueSymbol(property));
    }
  }
  return undefined;
}

function readFile(app: AppProgram, dialect: RouterDialect, source: ts.SourceFile): Read {
  const file = app.appRelative(source.fileName) ?? source.fileName;
  const bindings = importBindings(source, dialect.specs);
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
      if (name && dialect.calls.includes(name)) {
        const array = routesOf(app, dialect, node);
        if (!array) {
          failure = `${file} passes ${name} routes that are not an array literal.`;
          return;
        }
        failure = readRoutes(app, dialect, file, array, '', 0, pages);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failure ? { failure } : { pages };
}

/**
 * Pages of a react-router or vue-router app: the route object arrays given
 * to `createBrowserRouter`, `createHashRouter`, `createMemoryRouter` or
 * `useRoutes`, or the `routes` of vue-router's `createRouter`. JSX routes,
 * spread or computed routes and aliases make the enumeration incomplete
 * instead of silently missing pages.
 */
export async function enumerateRouteConfigPages(
  root: string,
  options: RouteConfigOptions,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
  router: RouterKind = 'react-router',
): Promise<PageTree> {
  const dialect = DIALECTS[router];
  const scan = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: (source) => dialect.marker.test(source),
  });
  if (!scan.complete) return { complete: false, reason: scan.reason };
  if (scan.files.length === 0) return { complete: true, pages: [], excluded: [], findings: [] };
  const app = createAppProgram({ root, rootNames: scan.files.map((file) => file.absolute) });
  const read: RoutePage[] = [];
  for (const file of scan.files) {
    const source = app.sourceFile(file.absolute);
    if (!source) return { complete: false, reason: `${file.path} cannot be read.` };
    const result = readFile(app, dialect, source);
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

/**
 * The `vue-router` source: one `ui.navigate` tool whose destinations are the
 * routes of `createRouter`, executed by `registerNavigationBridge`.
 */
export function createVueRouterSource(options: RouteConfigOptions = {}): ToolSource {
  return {
    kind: 'vue-router',
    observe: async (ctx) => observeNavigation('vue-router',
      await enumerateRouteConfigPages(ctx.root, options, ctx.policy.exclude ?? [], 'vue-router'),
      ctx.root, ctx.config.locale, options.srcDir),
  };
}
