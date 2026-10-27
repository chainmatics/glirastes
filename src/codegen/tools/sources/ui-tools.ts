import ts from 'typescript';
import { TOOL_NAME_PATTERN } from '../../../runtime/local-tool-bindings.js';
import type { GeneratedUiAction } from '../../../server/core/generated-ui-tool.js';
import { canonicalJson, compareCodeUnits, jsonSchemaDigest, sha256Digest } from '../canonical.js';
import { OPAQUE_SCHEMA_DIGEST } from '../contract-tiers.js';
import { toolFinding } from '../findings.js';
import type {
  JsonSchemaLike,
  ObservedTool,
  ToolContract,
  ToolFinding,
  ToolProseHints,
  ToolSourceObservation,
} from '../types.js';
import type { AppSourceFile } from './app-files.js';

/** Action id the navigation bridge listens to; `ui.navigate` and every `ui.filter.<view>` use it. */
export const NAVIGATE_ACTION_BINDING = 'glirastes.navigate';
export const NAVIGATE_STABLE_KEY = 'UI navigate';
export const NAVIGATE_DEFINITION_ID = 'ui.navigate';

export function filterStableKey(path: string): string {
  return `UI filter ${path}`;
}

export function actionStableKey(actionId: string): string {
  return `UI action ${actionId}`;
}

/** What every generated UI tool returns (`uiActionToolToTool`). */
export const UI_TOOL_OUTPUT_SCHEMA: JsonSchemaLike = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    error: { type: 'string' },
    uiAction: { type: 'object' },
  },
  required: ['success'],
};

function words(segment: string): string[] {
  return segment.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function camel(parts: ReadonlyArray<string>): string {
  return parts.map((part, index) => (
    index === 0
      ? part.charAt(0).toLowerCase() + part.slice(1)
      : part.charAt(0).toUpperCase() + part.slice(1)
  )).join('');
}

/** `/tasks` → `tasks`, `/` → `home`, `/tasks/:id` → `tasksItem`: the `<view>` of `ui.filter.<view>`. */
export function viewName(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const statics = segments.filter((segment) => !segment.startsWith(':') && !segment.startsWith('*'));
  let name = camel(statics.flatMap(words)) || 'home';
  if (segments.at(-1)?.startsWith(':')) name = `${name}Item`;
  return /^[0-9]/.test(name) ? `v${name}` : name;
}

/** The inventory and `tool-contracts.json` cap a definition id at 200 characters. */
const MAX_DEFINITION_ID_LENGTH = 200;

const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(['navigate', 'filter', 'action']);

/**
 * `tasks.highlight` → `ui.tasks.highlight`. A single segment or one that
 * would shadow `ui.navigate`/`ui.filter.*` moves under `ui.action.`;
 * undefined when the id cannot form a tool name.
 */
export function uiDefinitionIdForAction(actionId: string): string | undefined {
  const segments = actionId.split('.').map((segment) => camel(words(segment)));
  if (segments.some((segment) => segment.length === 0)) return undefined;
  const named = segments.map((segment) => (/^[0-9]/.test(segment) ? `a${segment}` : segment));
  const parts = named.length === 1 || RESERVED_FIRST_SEGMENTS.has(named[0]!) ? ['action', ...named] : named;
  const id = `ui.${parts.join('.')}`;
  return id.length <= MAX_DEFINITION_ID_LENGTH && TOOL_NAME_PATTERN.test(id) ? id : undefined;
}

/**
 * `base` plus an 8-character digest of the stable key, cut so the id stays
 * within the cap; a cut that ends on a dot drops it so the id stays a tool name.
 */
function suffixedDefinitionId(base: string, stableKey: string, attempt: number): string {
  const suffix = sha256Digest(attempt === 0 ? stableKey : `${stableKey}#${attempt}`)
    .slice(7, 15).replace(/[^A-Za-z0-9]/g, 'x');
  return `${base.slice(0, MAX_DEFINITION_ID_LENGTH - suffix.length).replace(/\.+$/, '')}${suffix}`;
}

/**
 * Same base name for two stable keys: the later key gets a digest suffix,
 * independent of order. A base over the cap is cut and suffixed the same way,
 * and no id is handed out twice.
 */
export function uniqueDefinitionIds(entries: ReadonlyArray<{ stableKey: string; base: string }>): Map<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const entry of [...entries].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey))) {
    let id = entry.base;
    for (let attempt = 0; id.length > MAX_DEFINITION_ID_LENGTH || taken.has(id); attempt += 1) {
      id = suffixedDefinitionId(entry.base, entry.stableKey, attempt);
    }
    taken.add(id);
    ids.set(entry.stableKey, id);
  }
  return ids;
}

export function parseAppSource(file: Pick<AppSourceFile, 'path' | 'source'>): ts.SourceFile {
  const kind = /\.tsx$/.test(file.path) ? ts.ScriptKind.TSX
    : /\.(?:[cm]?ts|vue)$/.test(file.path) ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  return ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, kind);
}

export interface ImportSpec {
  module: string;
  names: ReadonlyArray<string>;
}

export interface ImportedCall {
  /** The exported name the call resolves to, whatever the local alias. */
  name: string;
  call: ts.CallExpression;
}

export interface ImportBindings {
  /** Local name → exported name. */
  named: ReadonlyMap<string, string>;
  /** Namespace alias → the exported names it may reach. */
  namespaces: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Value imports of the given names from the given modules; type-only imports never count. */
export function importBindings(source: ts.SourceFile, specs: ReadonlyArray<ImportSpec>): ImportBindings {
  const named = new Map<string, string>();
  const namespaces = new Map<string, ReadonlySet<string>>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const spec = specs.find((candidate) => candidate.module === (statement.moduleSpecifier as ts.StringLiteral).text);
    if (!spec) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, new Set(spec.names));
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && spec.names.includes(imported)) named.set(element.name.text, imported);
      }
    }
  }
  return { named, namespaces };
}

/** The exported name `node` refers to through `bindings`: `alias` or `namespace.name`. */
export function importedName(node: ts.Node, bindings: ImportBindings): string | undefined {
  if (ts.isIdentifier(node)) return bindings.named.get(node.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return bindings.namespaces.get(node.expression.text)?.has(node.name.text) ? node.name.text : undefined;
  }
  return undefined;
}

/**
 * Calls of named or namespace imports from the given modules, read from
 * syntax only: a same-named local function, a comment or an import that is
 * never called does not count.
 */
export function importedCalls(source: ts.SourceFile, specs: ReadonlyArray<ImportSpec>): ImportedCall[] {
  const bindings = importBindings(source, specs);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) return [];
  const calls: ImportedCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = importedName(node.expression, bindings);
      if (name !== undefined) calls.push({ name, call: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

const BRIDGE_IMPORTS: ReadonlyArray<ImportSpec> = [
  { module: 'glirastes/react', names: ['useGlirastesNavigationBridge'] },
  { module: 'glirastes/browser', names: ['registerNavigationBridge'] },
];

/** True when app code calls the navigation bridge that executes `ui.navigate` and `ui.filter.*`. */
export function hasNavigationBridge(files: ReadonlyArray<Pick<AppSourceFile, 'path' | 'source'>>): boolean {
  return files.some((file) => (
    file.source.includes('NavigationBridge') && importedCalls(parseAppSource(file), BRIDGE_IMPORTS).length > 0
  ));
}

export function mentionsNavigationBridge(source: string): boolean {
  return source.includes('NavigationBridge');
}

export interface UiObservationInput {
  stableKey: string;
  definitionId: string;
  actionBindingRef: string;
  /** Undefined when the payload is untyped: the tool keeps its identity but has no contract. */
  input?: JsonSchemaLike;
  uiAction: GeneratedUiAction;
  params?: ToolContract['params'];
  /** Facts the tool depends on; a change of these is a changed tool. */
  facts: unknown;
  findings: ToolFinding[];
  prose?: ToolProseHints;
  jsDoc?: string;
  uiMutation?: boolean;
  /** App-relative files that register or read this tool, for the work lists. */
  files?: string[];
}

/** An `ObservedTool` for a generated UI tool; its contract is JSON Schema read from code. */
export function uiObservation(input: UiObservationInput): ObservedTool {
  const output = UI_TOOL_OUTPUT_SCHEMA;
  const contract: ToolContract | undefined = input.input
    ? {
      source: 'ui-bridge',
      loadBearing: true,
      input: input.input,
      output,
      params: input.params ?? { path: [], query: [], body: [] },
      interfaceDigest: sha256Digest(canonicalJson({ stableKey: input.stableKey, input: input.input, uiAction: input.uiAction })),
      runtime: { input: { kind: 'json', schema: input.input }, output: { kind: 'json', schema: output } },
      uiAction: input.uiAction,
    }
    : undefined;
  return {
    execution: {
      definitionId: input.definitionId,
      stableKey: input.stableKey,
      executionKind: 'ui',
      actionBindingRef: input.actionBindingRef,
      sourceFingerprint: sha256Digest(canonicalJson({ stableKey: input.stableKey, facts: input.facts })),
      inputSchemaDigest: input.input ? jsonSchemaDigest(input.input) : OPAQUE_SCHEMA_DIGEST,
      outputSchemaDigest: jsonSchemaDigest(output),
    },
    ...(contract ? { contract, interface: { digest: contract.interfaceDigest, params: contract.params } } : {}),
    ...(input.files ? { files: [...input.files] } : {}),
    evidence: {
      authEvidence: false,
      externalCall: false,
      ...(input.jsDoc ? { jsDoc: input.jsDoc } : {}),
      ...(input.uiMutation ? { uiMutation: true } : {}),
    },
    findings: input.findings,
    ...(input.prose ? { prose: input.prose } : {}),
  };
}

/** One incomplete UI enumeration stops the refresh, like an unreadable route file. */
export function incompleteUiSource(kind: string, reason: string): ToolSourceObservation {
  return {
    observations: [],
    findings: [toolFinding('E-INVENTORY-011', 'error', kind, reason)],
    complete: false,
    excluded: [],
  };
}
