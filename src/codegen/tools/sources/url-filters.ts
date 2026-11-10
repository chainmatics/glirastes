import { join } from 'node:path';
import ts from 'typescript';
import { compareCodeUnits } from '../canonical.js';
import { MAX_FILTER_KEYS } from '../files.js';
import { toolFinding } from '../findings.js';
import { createAppProgram, type AppProgram } from '../program.js';
import type {
  ExcludedTool,
  JsonSchemaLike,
  ToolFinding,
  ToolProseHints,
  ToolSource,
  ToolSourceObservation,
} from '../types.js';
import { scanAppSources } from './app-files.js';
import { navigationBridgeMissing, scanForNavigationBridge } from './next-pages.js';
import { enumeratePages, pathExclusion, type PageEntry, type PageTreeOptions } from './page-tree.js';
import { componentDeclaration, enumerateRouteConfigPages, type RouterKind } from './route-config.js';
import {
  filterStableKey,
  hasNavigationBridge,
  importBindings,
  importedCalls,
  importedName,
  incompleteUiSource,
  NAVIGATE_ACTION_BINDING,
  uiObservation,
  uniqueDefinitionIds,
  viewName,
  type ImportBindings,
  type ImportedCall,
} from './ui-tools.js';
import { programFileName } from './vue-sfc.js';

export interface UrlFilterSourceOptions extends PageTreeOptions {
  /** Where `defineQueryFilters` and the navigation bridge are searched; `src` when the app has one. */
  srcDir?: string;
  /** Which page list the filters attach to: the Next.js page tree (default) or react-router routes. */
  pages?: 'next' | RouterKind;
}

export type FilterDomain =
  | { kind: 'enum'; values: string[] }
  | { kind: 'number-enum'; values: number[] }
  | { kind: 'string' }
  | { kind: 'integer' }
  | { kind: 'number' }
  | { kind: 'boolean' };

export interface FilterKey {
  key: string;
  domain: FilterDomain;
  /** `comma`: one value joined with commas (nuqs `parseAsArrayOf`); `repeat`: the key repeats. */
  array?: 'comma' | 'repeat';
}

interface Evidence {
  keys: FilterKey[];
  /** Warnings about a key the generator could not read; bound to the view later. */
  notes: Array<{ code: string; message: string }>;
}

/** What one declaration reads, and the other app declarations its code refers to. */
interface Unit {
  evidence: Evidence;
  references: ts.Node[];
}

const NUQS_STATE = ['useQueryState', 'useQueryStates', 'createSearchParamsCache', 'createLoader', 'createSerializer'];
const SIMPLE_PARSERS: Readonly<Record<string, FilterDomain>> = {
  parseAsString: { kind: 'string' },
  parseAsInteger: { kind: 'integer' },
  parseAsIndex: { kind: 'integer' },
  parseAsFloat: { kind: 'number' },
  parseAsBoolean: { kind: 'boolean' },
};
const LITERAL_PARSERS: ReadonlySet<string> = new Set(['parseAsStringLiteral', 'parseAsStringEnum', 'parseAsNumberLiteral']);
const ARRAY_PARSERS: Readonly<Record<string, 'comma' | 'repeat'>> = { parseAsArrayOf: 'comma', parseAsNativeArrayOf: 'repeat' };
/** Every nuqs export the source reads; anything else imported from nuqs is reported, not guessed. */
const NUQS_NAMES = [
  ...NUQS_STATE, ...Object.keys(SIMPLE_PARSERS), ...LITERAL_PARSERS, ...Object.keys(ARRAY_PARSERS),
  'parseAsIsoDate', 'parseAsIsoDateTime', 'parseAsTimestamp', 'parseAsJson', 'parseAsHex', 'createParser',
];
const NUQS_SPECS = ['nuqs', 'nuqs/server'].map((module) => ({ module, names: NUQS_NAMES }));
const SEARCH_PARAMS_SPECS = [{ module: 'next/navigation', names: ['useSearchParams'] }];
const DEFINE_SPECS = [{ module: 'glirastes/browser', names: ['defineQueryFilters'] }];
const MAX_DEPTH = 6;
/** How many declarations deep a page's references are followed (page → component → hook → parser …). */
const MAX_REFERENCE_DEPTH = 8;
const MAX_UNITS_PER_VIEW = 1_000;
/**
 * A name every model provider takes as a tool input property (Anthropic rejects
 * keys outside `[a-zA-Z0-9_.-]{1,64}` with a 400 that fails the whole request),
 * and the name `defineQueryFilters` enforces at app runtime, so a generated tool
 * never offers a key the runtime helper would refuse.
 */
const FILTER_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SCALAR_KINDS: ReadonlySet<string> = new Set(['string', 'integer', 'number', 'boolean']);

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteral(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function sortedUnique<T extends string | number>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)].sort((left, right) => (
    typeof left === 'number' && typeof right === 'number' ? left - right : compareCodeUnits(String(left), String(right))
  ));
}

/** Two readings of one key: the closed one wins; incompatible ones become open text. */
export function mergeDomains(left: FilterDomain, right: FilterDomain): FilterDomain | undefined {
  if (left.kind === 'string') return right;
  if (right.kind === 'string') return left;
  if (left.kind === 'enum' && right.kind === 'enum') return { kind: 'enum', values: sortedUnique([...left.values, ...right.values]) };
  if (left.kind === 'number-enum' && right.kind === 'number-enum') {
    return { kind: 'number-enum', values: sortedUnique([...left.values, ...right.values]) };
  }
  return left.kind === right.kind ? left : undefined;
}

export function isFilterKeyName(key: string): boolean {
  return FILTER_KEY_NAME.test(key);
}

function scalarSchema(domain: FilterDomain): JsonSchemaLike {
  switch (domain.kind) {
    case 'enum':
      return { type: 'string', enum: domain.values };
    case 'number-enum':
      return { type: 'number', enum: domain.values };
    default:
      return { type: domain.kind };
  }
}

export function filterKeySchema(key: FilterKey): JsonSchemaLike {
  const scalar = scalarSchema(key.domain);
  return key.array ? { type: 'array', items: scalar } : scalar;
}

/** Reads nuqs parsers, typed `searchParams` and `useSearchParams()` through one bounded program. */
class FilterReader {
  private readonly bindings = new Map<ts.SourceFile, ImportBindings>();
  private readonly units = new Map<ts.Node, Unit>();
  private readonly calls = new Map<ts.SourceFile, { nuqs: ImportedCall[]; search: ImportedCall[] }>();

  constructor(private readonly app: AppProgram) {}

  private nuqs(file: ts.SourceFile): ImportBindings {
    let bindings = this.bindings.get(file);
    if (!bindings) {
      bindings = importBindings(file, NUQS_SPECS);
      this.bindings.set(file, bindings);
    }
    return bindings;
  }

  private nuqsName(node: ts.Node): string | undefined {
    return importedName(node, this.nuqs(node.getSourceFile()));
  }

  /** The symbol a name stands for, through imports and re-exports to the declaring module. */
  private symbolOf(node: ts.Node): ts.Symbol | undefined {
    const checker = this.app.checker;
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }

  /** The expression a name stands for: a variable initializer, also across app modules. */
  private initializerOf(node: ts.Expression): ts.Expression | undefined {
    const symbol = this.symbolOf(node);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) return undefined;
    if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) return declaration.initializer;
    if (ts.isShorthandPropertyAssignment(declaration)) return declaration.name;
    return undefined;
  }

  private literalValues(raw: ts.Expression | undefined, kind: 'string' | 'number', depth = 0): Array<string | number> | undefined {
    if (!raw || depth > MAX_DEPTH) return undefined;
    const expression = unwrap(raw);
    if (ts.isArrayLiteralExpression(expression)) {
      const values: Array<string | number> = [];
      for (const element of expression.elements) {
        const value = unwrap(element as ts.Expression);
        if (kind === 'string' && ts.isStringLiteralLike(value)) values.push(value.text);
        else if (kind === 'number' && ts.isNumericLiteral(value)) values.push(Number(value.text));
        else return undefined;
      }
      return values.length > 0 ? values : undefined;
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const initializer = this.initializerOf(expression);
      const fromSyntax = initializer ? this.literalValues(initializer, kind, depth + 1) : undefined;
      if (fromSyntax) return fromSyntax;
    }
    return this.literalValuesOfType(this.app.checker.getTypeAtLocation(expression), kind);
  }

  private literalValuesOfType(type: ts.Type, kind: 'string' | 'number'): Array<string | number> | undefined {
    const checker = this.app.checker;
    const elements = checker.isTupleType(type)
      ? checker.getTypeArguments(type as ts.TypeReference)
      : checker.isArrayType(type) ? checker.getTypeArguments(type as ts.TypeReference) : [];
    const members = elements.flatMap((element) => (element.isUnion() ? element.types : [element]));
    if (members.length === 0) return undefined;
    const values: Array<string | number> = [];
    for (const member of members) {
      if (kind === 'string' && member.isStringLiteral()) values.push(member.value);
      else if (kind === 'number' && member.isNumberLiteral()) values.push(member.value);
      else return undefined;
    }
    return values;
  }

  /** A nuqs parser expression → domain; `undefined` for a parser this source does not read. */
  parser(raw: ts.Expression, notes: Evidence['notes'], key: string, depth = 0): Omit<FilterKey, 'key'> | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const expression = unwrap(raw);
    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      if (ts.isPropertyAccessExpression(callee) && ['withDefault', 'withOptions'].includes(callee.name.text)) {
        return this.parser(callee.expression, notes, key, depth + 1);
      }
      const name = this.nuqsName(callee);
      if (name !== undefined && LITERAL_PARSERS.has(name)) {
        const numeric = name === 'parseAsNumberLiteral';
        const values = this.literalValues(expression.arguments[0], numeric ? 'number' : 'string');
        if (!values) return { domain: { kind: numeric ? 'number' : 'string' } };
        return numeric
          ? { domain: { kind: 'number-enum', values: sortedUnique(values as number[]) } }
          : { domain: { kind: 'enum', values: sortedUnique(values as string[]) } };
      }
      if (name !== undefined && Object.hasOwn(ARRAY_PARSERS, name)) {
        const separator = expression.arguments[1];
        if (separator && stringLiteral(separator) !== ',') {
          notes.push({ code: 'filter-parser-unsupported', message: `${key} uses parseAsArrayOf with a custom separator.` });
          return undefined;
        }
        const inner = expression.arguments[0] ? this.parser(expression.arguments[0], notes, key, depth + 1) : undefined;
        if (!inner || inner.array) return undefined;
        return { domain: inner.domain, array: ARRAY_PARSERS[name]! };
      }
      if (name !== undefined) {
        notes.push({ code: 'filter-parser-unsupported', message: `${key} uses ${name}, which the chat cannot set.` });
        return undefined;
      }
      notes.push({ code: 'filter-parser-unsupported', message: `${key} uses a custom parser.` });
      return undefined;
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const name = this.nuqsName(expression);
      if (name !== undefined) {
        if (Object.hasOwn(SIMPLE_PARSERS, name)) return { domain: SIMPLE_PARSERS[name]! };
        notes.push({ code: 'filter-parser-unsupported', message: `${key} uses ${name}, which the chat cannot set.` });
        return undefined;
      }
      const initializer = this.initializerOf(expression);
      if (initializer) return this.parser(initializer, notes, key, depth + 1);
    }
    notes.push({ code: 'filter-definition-unreadable', message: `The parser of ${key} cannot be read from code.` });
    return undefined;
  }

  /** `{ status: parseAs…, page: parseAs… }`, also behind a name or spread. */
  private parserMap(raw: ts.Expression | undefined, notes: Evidence['notes'], depth = 0): Array<{ key: string; parser: ts.Expression }> {
    if (!raw || depth > MAX_DEPTH) return [];
    const expression = unwrap(raw);
    if (ts.isObjectLiteralExpression(expression)) {
      const entries: Array<{ key: string; parser: ts.Expression }> = [];
      for (const property of expression.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = propertyName(property.name);
          if (key !== undefined) {
            entries.push({ key, parser: property.initializer });
            continue;
          }
        } else if (ts.isShorthandPropertyAssignment(property)) {
          entries.push({ key: property.name.text, parser: property.name });
          continue;
        } else if (ts.isSpreadAssignment(property)) {
          entries.push(...this.parserMap(property.expression, notes, depth + 1));
          continue;
        }
        notes.push({ code: 'filter-definition-unreadable', message: 'A URL parameter map has an entry that is not a plain key.' });
      }
      return entries;
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      return this.parserMap(this.initializerOf(expression), notes, depth + 1);
    }
    notes.push({ code: 'filter-definition-unreadable', message: 'A URL parameter map cannot be read from code.' });
    return [];
  }

  private urlKeys(options: ts.Expression | undefined): Map<string, string> {
    const keys = new Map<string, string>();
    const value = options ? unwrap(options) : undefined;
    if (!value || !ts.isObjectLiteralExpression(value)) return keys;
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'urlKeys') continue;
      const map = unwrap(property.initializer);
      if (!ts.isObjectLiteralExpression(map)) continue;
      for (const entry of map.properties) {
        if (!ts.isPropertyAssignment(entry)) continue;
        const from = propertyName(entry.name);
        const to = stringLiteral(entry.initializer);
        if (from !== undefined && to !== undefined) keys.set(from, to);
      }
    }
    return keys;
  }

  /** The calls of nuqs or `useSearchParams` that sit inside `root`. */
  private callsWithin(root: ts.Node, kind: 'nuqs' | 'search'): ImportedCall[] {
    const file = root.getSourceFile();
    let cached = this.calls.get(file);
    if (!cached) {
      cached = { nuqs: importedCalls(file, NUQS_SPECS), search: importedCalls(file, SEARCH_PARAMS_SPECS) };
      this.calls.set(file, cached);
    }
    return cached[kind].filter(({ call }) => call.pos >= root.pos && call.end <= root.end);
  }

  private nuqsKeys(root: ts.Node, evidence: Evidence): void {
    for (const { name, call } of this.callsWithin(root, 'nuqs')) {
      if (name === 'useQueryState') {
        const key = stringLiteral(call.arguments[0]);
        if (key === undefined) {
          evidence.notes.push({ code: 'filter-definition-unreadable', message: 'useQueryState is called with a key that is not a literal.' });
          continue;
        }
        const parsed = call.arguments[1] ? this.parser(call.arguments[1], evidence.notes, key) : { domain: { kind: 'string' } as const };
        if (parsed) evidence.keys.push({ key, ...parsed });
      } else if (NUQS_STATE.includes(name)) {
        const renamed = this.urlKeys(call.arguments[1]);
        for (const entry of this.parserMap(call.arguments[0], evidence.notes)) {
          const key = renamed.get(entry.key) ?? entry.key;
          const parsed = this.parser(entry.parser, evidence.notes, key);
          if (parsed) evidence.keys.push({ key, ...parsed });
        }
      }
    }
  }

  private searchParamsKeys(root: ts.Node, evidence: Evidence): void {
    const calls = this.callsWithin(root, 'search').map(({ call }) => call);
    if (calls.length === 0) return;
    const checker = this.app.checker;
    const holders = new Set<ts.Symbol>();
    for (const call of calls) {
      const parent = call.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === call && ts.isIdentifier(parent.name)) {
        const symbol = checker.getSymbolAtLocation(parent.name);
        if (symbol) holders.add(symbol);
      }
    }
    const callSet = new Set<ts.Node>(calls);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['get', 'getAll'].includes(node.expression.name.text)) {
        const target = unwrap(node.expression.expression);
        const symbol = ts.isIdentifier(target) ? checker.getSymbolAtLocation(target) : undefined;
        if (callSet.has(target) || (symbol && holders.has(symbol))) {
          const key = stringLiteral(node.arguments[0]);
          if (key !== undefined) {
            evidence.keys.push(node.expression.name.text === 'getAll'
              ? { key, domain: { kind: 'string' }, array: 'repeat' }
              : { key, domain: { kind: 'string' } });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  private typeDomain(type: ts.Type): Omit<FilterKey, 'key'> | undefined {
    const checker = this.app.checker;
    const members = (type.isUnion() ? type.types : [type])
      .filter((member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
    if (members.length === 0) return undefined;
    const scalars = members.filter((member) => !checker.isArrayType(member));
    const arrays = members.filter((member) => checker.isArrayType(member));
    const elementTypes = arrays.flatMap((member) => checker.getTypeArguments(member as ts.TypeReference))
      .flatMap((element) => (element.isUnion() ? element.types : [element]));
    const all = [...scalars, ...elementTypes];
    if (all.some((member) => member.flags & ts.TypeFlags.String)) {
      return scalars.length === 0 ? { domain: { kind: 'string' }, array: 'repeat' } : { domain: { kind: 'string' } };
    }
    if (all.length > 0 && all.every((member) => member.isStringLiteral())) {
      const domain: FilterDomain = { kind: 'enum', values: sortedUnique(all.map((member) => (member as ts.StringLiteralType).value)) };
      return scalars.length === 0 ? { domain, array: 'repeat' } : { domain };
    }
    return undefined;
  }

  /** Keys of a typed `searchParams` prop of the page's default export. */
  private typedSearchParams(file: ts.SourceFile, evidence: Evidence): void {
    const component = defaultExportFunction(file);
    const parameter = component?.parameters[0];
    if (!parameter) return;
    const checker = this.app.checker;
    const props = checker.getTypeAtLocation(parameter);
    const property = checker.getPropertyOfType(props, 'searchParams');
    if (!property) return;
    const declared = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, parameter));
    const params = checker.getAwaitedType(declared) ?? declared;
    for (const entry of checker.getPropertiesOfType(params)) {
      const parsed = this.typeDomain(checker.getTypeOfSymbolAtLocation(entry, parameter));
      if (parsed) evidence.keys.push({ key: entry.name, ...parsed });
      else evidence.notes.push({ code: 'filter-parser-unsupported', message: `searchParams.${entry.name} has a type the chat cannot set.` });
    }
  }

  /** The app declarations (not libraries, not types) a symbol is declared by. */
  private declarationUnits(symbol: ts.Symbol | undefined): ts.Node[] {
    return (symbol?.declarations ?? []).flatMap((declaration) => {
      const unit = unitRoot(declaration);
      return unit && this.app.appRelative(unit.getSourceFile().fileName) !== undefined ? [unit] : [];
    });
  }

  /** The declarations outside `root` that its code refers to; imports are followed to where they are declared. */
  private references(root: ts.Node): ts.Node[] {
    const found = new Set<ts.Node>();
    const file = root.getSourceFile();
    const add = (units: ReadonlyArray<ts.Node>): void => {
      for (const unit of units) {
        const inside = unit.getSourceFile() === file && unit.pos >= root.pos && unit.end <= root.end;
        if (!inside) found.add(unit);
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        || (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node))
      ) {
        return;
      }
      if (ts.isIdentifier(node)) {
        add(this.declarationUnits(this.symbolOf(node)));
        return;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const member = this.declarationUnits(this.symbolOf(node));
        add(member);
        // `caches.people`: the object only matters through the property the code reads.
        if (member.length > 0 && member.every(ts.isPropertyAssignment) && isNameChain(node.expression)) return;
        visit(node.expression);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    return [...found];
  }

  private unit(root: ts.Node): Unit {
    let unit = this.units.get(root);
    if (!unit) {
      const evidence: Evidence = { keys: [], notes: [] };
      this.nuqsKeys(root, evidence);
      this.searchParamsKeys(root, evidence);
      if (ts.isSourceFile(root)) this.typedSearchParams(root, evidence);
      unit = { evidence, references: this.references(root) };
      this.units.set(root, unit);
    }
    return unit;
  }

  /**
   * What the page reads from the URL: its own code and the declarations it
   * refers to (components, hooks, caches, parser maps), breadth first and
   * bounded. A binding is resolved to where it is declared, so a barrel, a
   * module's other exports and a cache another page uses are not credited.
   */
  viewEvidence(page: ts.Node): Evidence {
    const found: Evidence = { keys: [], notes: [] };
    const seen = new Set<ts.Node>([page]);
    let frontier: ts.Node[] = [page];
    for (let depth = 0; frontier.length > 0; depth += 1) {
      const next: ts.Node[] = [];
      for (const root of frontier) {
        const unit = this.unit(root);
        found.keys.push(...unit.evidence.keys);
        found.notes.push(...unit.evidence.notes);
        if (depth === MAX_REFERENCE_DEPTH) continue;
        for (const reference of unit.references) {
          if (seen.has(reference) || seen.size >= MAX_UNITS_PER_VIEW) continue;
          seen.add(reference);
          next.push(reference);
        }
      }
      frontier = next;
    }
    return found;
  }

  /** `defineQueryFilters({ path, filters })` literals of `glirastes/browser`. */
  definitions(file: ts.SourceFile, notes: Array<{ file: string; code: string; message: string }>): Array<{ path: string; keys: FilterKey[] }> {
    const definitions: Array<{ path: string; keys: FilterKey[] }> = [];
    const local = this.app.appRelative(file.fileName) ?? file.fileName;
    for (const { call } of importedCalls(file, DEFINE_SPECS)) {
      let argument = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
      if (argument && (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument))) {
        const initializer = this.initializerOf(argument);
        argument = initializer ? unwrap(initializer) : undefined;
      }
      const property = (name: string) => (argument && ts.isObjectLiteralExpression(argument)
        ? argument.properties.find((entry): entry is ts.PropertyAssignment => (
          ts.isPropertyAssignment(entry) && propertyName(entry.name) === name))
        : undefined);
      const path = stringLiteral(property('path')?.initializer);
      const filters = property('filters')?.initializer;
      const map = filters ? unwrap(filters) : undefined;
      if (path === undefined || !path.startsWith('/') || !map || !ts.isObjectLiteralExpression(map)) {
        notes.push({ file: local, code: 'filter-definition-unreadable', message: 'A defineQueryFilters call has no literal path and filters.' });
        continue;
      }
      const keys: FilterKey[] = [];
      for (const entry of map.properties) {
        const key = ts.isPropertyAssignment(entry) ? propertyName(entry.name) : undefined;
        const spec = key !== undefined && ts.isPropertyAssignment(entry) ? specKey(key, entry.initializer) : undefined;
        if (spec) keys.push(spec);
        else notes.push({ file: local, code: 'filter-definition-unreadable', message: `A filter of ${path} is not a literal spec.` });
      }
      definitions.push({ path: normalizedDefinitionPath(path), keys });
    }
    return definitions;
  }
}

/** The node whose code a declaration stands for: the variable, function, class or property, never a type or a parameter. */
function unitRoot(declaration: ts.Declaration): ts.Node | undefined {
  let node: ts.Node = declaration;
  while (ts.isBindingElement(node)) node = node.parent.parent;
  return ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
    || ts.isExportAssignment(node) || ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)
    || ts.isPropertyDeclaration(node)
    ? node
    : undefined;
}

function isNameChain(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) || (ts.isPropertyAccessExpression(expression) && isNameChain(expression.expression));
}

function scalarSpec(raw: ts.Expression): FilterDomain | undefined {
  const expression = unwrap(raw);
  const kind = stringLiteral(expression);
  if (kind !== undefined) return SCALAR_KINDS.has(kind) ? { kind: kind as 'string' | 'integer' | 'number' | 'boolean' } : undefined;
  if (ts.isArrayLiteralExpression(expression)) {
    const values = expression.elements.map((element) => stringLiteral(element as ts.Expression));
    if (values.length === 0 || values.some((value) => value === undefined || value.length === 0)) return undefined;
    return { kind: 'enum', values: sortedUnique(values as string[]) };
  }
  return undefined;
}

function specKey(key: string, raw: ts.Expression): FilterKey | undefined {
  const expression = unwrap(raw);
  if (ts.isObjectLiteralExpression(expression)) {
    const get = (name: string) => expression.properties.find((entry): entry is ts.PropertyAssignment => (
      ts.isPropertyAssignment(entry) && propertyName(entry.name) === name))?.initializer;
    const inner = get('arrayOf');
    const domain = inner ? scalarSpec(inner) : undefined;
    const format = get('format') ? stringLiteral(get('format')) : 'comma';
    if (!domain || (format !== 'comma' && format !== 'repeat')) return undefined;
    return { key, domain, array: format };
  }
  const domain = scalarSpec(expression);
  return domain ? { key, domain } : undefined;
}

/** `/projects/[projectId]` is accepted like `/projects/:projectId`. */
function normalizedDefinitionPath(path: string): string {
  return path.split('/').map((segment) => segment.replace(/^\[([^\].]+)\]$/, ':$1')).join('/');
}

function defaultExportFunction(file: ts.SourceFile): ts.SignatureDeclaration | undefined {
  const locals = new Map<string, ts.Node>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) locals.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) locals.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const asFunction = (node: ts.Node | undefined): ts.SignatureDeclaration | undefined => {
    if (!node) return undefined;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
    if (ts.isParenthesizedExpression(node)) return asFunction(node.expression);
    if (ts.isIdentifier(node)) return asFunction(locals.get(node.text));
    return undefined;
  };
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return asFunction(statement.expression);
  }
  return undefined;
}

interface View {
  path: string;
  params: string[];
  keys: Map<string, FilterKey>;
  notes: Array<{ code: string; message: string }>;
}

function describeKey(key: FilterKey, german: boolean): string {
  const domain = key.domain;
  const scalar = domain.kind === 'enum' || domain.kind === 'number-enum'
    ? domain.values.join('|')
    : german
      ? { string: 'Text', integer: 'Ganzzahl', number: 'Zahl', boolean: 'ja/nein' }[domain.kind]
      : { string: 'text', integer: 'integer', number: 'number', boolean: 'true/false' }[domain.kind];
  return `${key.key} (${key.array ? `${german ? 'Liste von' : 'list of'} ${scalar}` : scalar})`;
}

function filterProse(locale: string, view: View, keys: ReadonlyArray<FilterKey>): ToolProseHints {
  const german = locale.toLowerCase().startsWith('de');
  const listed = keys.map((key) => describeKey(key, german)).join(', ');
  const params = view.params.map((name) => `params.${name}`).join(', ');
  const label = (text: string) => (text.length <= 200 ? text : `${text.slice(0, 199)}…`);
  return german
    ? {
      contractDescription: `Zeigt die Seite ${view.path} mit URL-Filtern: ${listed}.${params ? ` Braucht ${params}.` : ''}`,
      presentation: { locale, singular: label(`${view.path} filtern`), plural: label(`${view.path} filtern`), approval: label(`${view.path} filtern`) },
    }
    : {
      contractDescription: `Show the ${view.path} page with URL filters: ${listed}.${params ? ` Needs ${params}.` : ''}`,
      presentation: { locale, singular: label(`Filter ${view.path}`), plural: label(`Filter ${view.path}`), approval: label(`Filter ${view.path}`) },
    };
}

function addNote(view: View, note: { code: string; message: string }): void {
  if (!view.notes.some((entry) => entry.code === note.code && entry.message === note.message)) view.notes.push(note);
}

function addKey(view: View, key: FilterKey): void {
  if (key.key === 'params') {
    addNote(view, { code: 'filter-key-reserved', message: 'The URL parameter params is reserved for route parameters.' });
    return;
  }
  if (!isFilterKeyName(key.key)) {
    const shown = key.key.length > 64 ? `${key.key.slice(0, 63)}…` : key.key;
    addNote(view, {
      code: 'filter-key-invalid',
      message: `The URL parameter ${JSON.stringify(shown)} is not a plain name (letters, digits, _ and -, starting with a letter or _, at most 64 characters), so the chat cannot set it.`,
    });
    return;
  }
  const existing = view.keys.get(key.key);
  if (!existing) {
    view.keys.set(key.key, key);
    return;
  }
  const domain = mergeDomains(existing.domain, key.domain);
  if (!domain || (existing.array ?? null) !== (key.array ?? null)) {
    view.keys.set(key.key, { key: key.key, domain: { kind: 'string' }, ...(existing.array ? { array: existing.array } : {}) });
    addNote(view, { code: 'filter-domain-conflict', message: `${key.key} is read with different parsers; it accepts any text.` });
    return;
  }
  view.keys.set(key.key, { ...existing, domain });
}

/** How many left-out keys `filter-keys-capped` names before it only counts them. */
const SHOWN_CAPPED_KEYS = 10;

function cappedKeysMessage(total: number, leftOut: ReadonlyArray<string>): string {
  const shown = leftOut.slice(0, SHOWN_CAPPED_KEYS).join(', ');
  const more = leftOut.length > SHOWN_CAPPED_KEYS ? ` and ${leftOut.length - SHOWN_CAPPED_KEYS} more` : '';
  return `The view reads ${total} URL parameters; a filter tool takes at most ${MAX_FILTER_KEYS}, so the chat cannot set ${shown}${more}.`;
}

function pathParams(path: string): string[] {
  return path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
}

/** A path with its parameter names left out: `/tasks/:id` and `/tasks/:taskId` are the same page. */
function routeShape(path: string): string {
  return path.split('/').map((segment) => (segment.startsWith(':') ? ':' : segment)).join('/');
}

async function observeFilters(
  root: string,
  locale: string,
  options: UrlFilterSourceOptions,
  policyExcludes: ReadonlyArray<{ match: string; reason: string }>,
): Promise<ToolSourceObservation> {
  const routeConfig = options.pages === 'react-router' || options.pages === 'vue-router' ? options.pages : undefined;
  const tree = routeConfig
    ? await enumerateRouteConfigPages(root, options, policyExcludes, routeConfig)
    : await enumeratePages(root, options, policyExcludes);
  if (!tree.complete) return incompleteUiSource('url-filters', tree.reason);
  const defined = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: (source) => source.includes('defineQueryFilters'),
  });
  if (!defined.complete) return incompleteUiSource('url-filters', defined.reason);
  if (tree.pages.length === 0 && defined.files.length === 0) {
    return { observations: [], findings: [], complete: true, excluded: [] };
  }
  const app = createAppProgram({
    root,
    rootNames: [
      ...tree.pages.map((page) => programFileName(join(root, page.file))),
      ...defined.files.map((file) => file.absolute),
    ],
  });
  const reader = new FilterReader(app);
  const views = new Map<string, View>();
  const viewOf = (path: string, params: string[]): View => {
    let view = views.get(path);
    if (!view) {
      view = { path, params, keys: new Map(), notes: [] };
      views.set(path, view);
    }
    return view;
  };
  for (const page of tree.pages as ReadonlyArray<PageEntry>) {
    const source = app.sourceFile(programFileName(join(root, page.file)));
    const rendered = source && page.component ? componentDeclaration(source, page.component) : source;
    if (!rendered) continue;
    const found = reader.viewEvidence(rendered);
    if (found.keys.length === 0 && found.notes.length === 0) continue;
    const pageView = viewOf(page.path, page.params);
    for (const key of found.keys) addKey(pageView, key);
    for (const note of found.notes) addNote(pageView, note);
  }
  const findings: ToolFinding[] = [];
  const definitionNotes: Array<{ file: string; code: string; message: string }> = [];
  const excludedPaths = new Map(tree.excluded.map((entry) => [entry.stableKey.slice('PAGE '.length), entry] as const));
  const excluded: ExcludedTool[] = [];
  // A route config lists every page the SPA serves; a filter for any other path would navigate nowhere.
  const routed = routeConfig ? new Set(tree.pages.map((page) => routeShape(page.path))) : undefined;
  for (const file of defined.files) {
    const source = app.sourceFile(file.absolute);
    if (!source) continue;
    for (const definition of reader.definitions(source, definitionNotes)) {
      // A view outside the page tree (an SPA path) follows the same default and policy exclusions.
      const pageExclusion = excludedPaths.get(definition.path) ?? pathExclusion(definition.path, policyExcludes);
      if (pageExclusion) {
        excluded.push({ stableKey: filterStableKey(definition.path), reason: pageExclusion.reason, origin: pageExclusion.origin });
        continue;
      }
      if (routed && !routed.has(routeShape(definition.path))) {
        findings.push(toolFinding('filter-path-unrouted', 'warning', filterStableKey(definition.path),
          `${file.path} defines query filters for ${definition.path}, which no route serves; no filter tool is generated for it.`));
        continue;
      }
      const view = viewOf(definition.path, pathParams(definition.path));
      for (const key of definition.keys) addKey(view, key);
    }
  }
  excluded.sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  for (const note of definitionNotes) findings.push(toolFinding(note.code, 'warning', note.file, note.message));

  const withKeys = [...views.values()].filter((view) => view.keys.size > 0)
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  for (const view of views.values()) {
    if (view.keys.size === 0) {
      for (const note of view.notes) findings.push(toolFinding(note.code, 'warning', filterStableKey(view.path), note.message));
    }
  }
  if (withKeys.length === 0) return { observations: [], findings, complete: true, excluded };
  const bridge = await scanForNavigationBridge(root, options.srcDir);
  if (!bridge.complete) return incompleteUiSource('url-filters', bridge.reason);
  const bridged = hasNavigationBridge(bridge.files);
  const ids = uniqueDefinitionIds(withKeys.map((view) => ({
    stableKey: filterStableKey(view.path), base: `ui.filter.${viewName(view.path)}`,
  })));
  const observations = withKeys.map((view) => {
    const stableKey = filterStableKey(view.path);
    const sorted = [...view.keys.values()].sort((left, right) => compareCodeUnits(left.key, right.key));
    // The committed contract takes at most MAX_FILTER_KEYS keys; the rest are reported, never written.
    const keys = sorted.slice(0, MAX_FILTER_KEYS);
    const leftOut = sorted.slice(MAX_FILTER_KEYS).map((key) => key.key);
    const open = keys.filter((key) => key.domain.kind === 'string').map((key) => key.key);
    const toolFindings: ToolFinding[] = [
      ...view.notes.map((note) => toolFinding(note.code, 'warning', stableKey, note.message)),
      ...(leftOut.length > 0
        ? [toolFinding('filter-keys-capped', 'warning', stableKey, cappedKeysMessage(sorted.length, leftOut))]
        : []),
      ...(open.length > 0
        ? [toolFinding('filter-domain-open', 'warning', stableKey, `${open.join(', ')} accept any text.`)]
        : []),
      ...(bridged ? [] : [navigationBridgeMissing(stableKey)]),
    ];
    const input: JsonSchemaLike = {
      type: 'object',
      properties: {
        ...Object.fromEntries(keys.map((key) => [key.key, filterKeySchema(key)])),
        ...(view.params.length > 0
          ? {
            params: {
              type: 'object',
              properties: Object.fromEntries(view.params.map((name) => [name, { type: 'string', minLength: 1 }])),
              required: [...view.params],
              additionalProperties: false,
            },
          }
          : {}),
      },
      ...(view.params.length > 0 ? { required: ['params'] } : {}),
      additionalProperties: false,
    };
    return uiObservation({
      stableKey,
      definitionId: ids.get(stableKey)!,
      actionBindingRef: NAVIGATE_ACTION_BINDING,
      input,
      uiAction: {
        kind: 'filter',
        destination: view.path,
        keys: keys.map((key) => ({ key: key.key, ...(key.array ? { array: key.array } : {}) })),
      },
      params: { path: [...view.params], query: keys.map((key) => key.key), body: [] },
      facts: { path: view.path, params: view.params, keys },
      findings: toolFindings,
      prose: filterProse(locale, view, keys),
    });
  });
  return { observations, findings, complete: true, excluded };
}

/**
 * The `url-filters` source: one `ui.filter.<view>` tool per page or
 * `defineQueryFilters` view whose URL filters the code reads (nuqs parsers,
 * typed `searchParams`, `useSearchParams().get`), executed by the navigation
 * bridge as a URL push.
 */
export function createUrlFilterSource(options: UrlFilterSourceOptions = {}): ToolSource {
  return {
    kind: 'url-filters',
    observe: (ctx) => observeFilters(ctx.root, ctx.config.locale, options, ctx.policy.exclude ?? []),
  };
}
