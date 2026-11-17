/**
 * Model egress check: finds every place in a source tree that can send
 * content to a model provider or the network, and compares it with a
 * reviewed inventory. A new direct model call, provider import, dynamic
 * import or raw network call fails the check until someone reviews it and
 * names it in the inventory.
 *
 * The scanner reads the TypeScript AST: named, aliased, namespace, dynamic
 * and `require` imports and re-exports are followed. It is a guard against
 * accidental bypasses, not a proof against deliberately obfuscated code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';

/** `ai` exports that send content to a model. */
export const MODEL_CALL_SYMBOLS: ReadonlySet<string> = new Set([
  'streamText', 'generateText', 'generateObject', 'streamObject',
  'embed', 'embedMany', 'rerank',
  'transcribe', 'experimental_transcribe',
  'generateSpeech', 'experimental_generateSpeech',
  'generateImage', 'experimental_generateImage',
]);

/** Packages whose import alone carries no egress (UI hooks, types, helpers). */
const CONTENT_FREE_PACKAGES: ReadonlySet<string> = new Set([
  '@ai-sdk/react', '@ai-sdk/provider', '@ai-sdk/provider-utils', '@ai-sdk/ui-utils',
]);

export type EgressKind = 'model_call' | 'provider_import' | 'dynamic_import' | 'network' | 'raw_model_call';

export interface EgressFinding {
  kind: EgressKind;
  /** Path relative to the scan root, `/`-separated. */
  file: string;
  /** The model-call symbol, provider package, `fetch`, `WebSocket`, `doGenerate`/`doStream` or `<computed>`. */
  symbol: string;
  line: number;
}

export const EgressInventoryEntrySchema = z.object({
  file: z.string().min(1),
  symbol: z.string().min(1),
  kind: z.enum(['model_call', 'provider_import', 'dynamic_import', 'network', 'raw_model_call']),
  /**
   * `facade`: the guarded model-call facade itself. `protected`: the call
   * passes the privacy boundary. `exception`: reviewed and outside the
   * protection promise (named, with a reason). `content-free`: carries no
   * prompt, tool or business content.
   */
  decision: z.enum(['facade', 'protected', 'exception', 'content-free']),
  reason: z.string().min(10),
}).strict();

export const EgressInventorySchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(EgressInventoryEntrySchema),
}).strict();

export type EgressInventory = z.infer<typeof EgressInventorySchema>;
export type EgressInventoryEntry = z.infer<typeof EgressInventoryEntrySchema>;

export interface EgressViolation {
  code: 'unapproved_model_call' | 'unapproved_provider_import' | 'unapproved_dynamic_import' | 'unapproved_network_call' | 'stale_inventory_entry' | 'duplicate_inventory_entry';
  file: string;
  symbol: string;
  line?: number;
}

const VIOLATION_CODE: Record<EgressKind, EgressViolation['code']> = {
  model_call: 'unapproved_model_call',
  raw_model_call: 'unapproved_model_call',
  provider_import: 'unapproved_provider_import',
  dynamic_import: 'unapproved_dynamic_import',
  network: 'unapproved_network_call',
};

function isProviderPackage(specifier: string): boolean {
  if (CONTENT_FREE_PACKAGES.has(specifier)) return false;
  return /^@ai-sdk\//.test(specifier) || /^@openrouter\//.test(specifier)
    || ['openai', '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', '@deepgram/sdk', '@mistralai/mistralai', 'groq-sdk', 'cohere-ai'].includes(specifier);
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/** Scans one source text. `file` is only used to label findings. */
export function scanSourceForEgress(file: string, text: string): EgressFinding[] {
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const findings: EgressFinding[] = [];
  const seen = new Set<string>();
  const add = (findingKind: EgressKind, symbol: string, node: ts.Node) => {
    const key = `${findingKind}\0${symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind: findingKind, file, symbol, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  /** Local names bound to the whole `ai` module. */
  const aiNamespaces = new Set<string>();

  const bindingFromModule = (binding: ts.BindingName, specifier: string, node: ts.Node) => {
    if (isProviderPackage(specifier)) { add('provider_import', specifier, node); return; }
    if (specifier !== 'ai') return;
    if (ts.isIdentifier(binding)) { aiNamespaces.add(binding.text); return; }
    if (ts.isObjectBindingPattern(binding)) {
      for (const element of binding.elements) {
        if (element.dotDotDotToken) { add('model_call', '*', element); continue; }
        const imported = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (imported && MODEL_CALL_SYMBOLS.has(imported)) add('model_call', imported, element);
      }
    }
  };

  /** `import('x')` or `require('x')`: returns the specifier, `<computed>` or undefined. */
  const moduleLoad = (node: ts.Node): string | undefined => {
    let target: ts.Node = node;
    while (ts.isAwaitExpression(target) || ts.isParenthesizedExpression(target)) target = target.expression;
    if (!ts.isCallExpression(target)) return undefined;
    const isImport = target.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(target.expression) && target.expression.text === 'require';
    if (!isImport && !isRequire) return undefined;
    return stringLiteral(target.arguments[0]) ?? '<computed>';
  };

  const visit = (node: ts.Node): void => {
    // Static imports and re-exports.
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteral(node.moduleSpecifier);
      const clause = node.importClause;
      if (specifier && clause && !clause.isTypeOnly) {
        if (isProviderPackage(specifier)) {
          const bindings = clause.namedBindings;
          const valueNames = bindings && ts.isNamedImports(bindings)
            ? bindings.elements.filter((element) => !element.isTypeOnly).length
            : 1;
          if (clause.name || valueNames > 0) add('provider_import', specifier, node);
        } else if (specifier === 'ai') {
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) aiNamespaces.add(bindings.name.text);
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (element.isTypeOnly) continue;
              const imported = (element.propertyName ?? element.name).text;
              if (MODEL_CALL_SYMBOLS.has(imported)) add('model_call', imported, element);
            }
          }
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const specifier = stringLiteral(node.moduleSpecifier);
      if (specifier && isProviderPackage(specifier)) add('provider_import', specifier, node);
      if (specifier === 'ai') {
        const clause = node.exportClause;
        if (!clause || !ts.isNamedExports(clause)) add('model_call', '*', node);
        else for (const element of clause.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && MODEL_CALL_SYMBOLS.has(imported)) add('model_call', imported, element);
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && !node.isTypeOnly) {
      const specifier = stringLiteral(node.moduleReference.expression);
      if (specifier) bindingFromModule(node.name, specifier, node);
    }

    // `const x = await import('ai')`, `const { generateText: g } = require('ai')`.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const specifier = moduleLoad(node.initializer);
      if (specifier === '<computed>') add('dynamic_import', '<computed>', node);
      else if (specifier) bindingFromModule(node.name, specifier, node);
    }

    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) {
        const specifier = stringLiteral(node.arguments[0]);
        if (!specifier) add('dynamic_import', '<computed>', node);
        else if (isProviderPackage(specifier)) add('provider_import', specifier, node);
        else if (specifier === 'ai') {
          // Bound by a variable declaration above, or used inline: `(await import('ai')).streamText`.
          let parent = node.parent;
          while (parent && (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))) parent = parent.parent;
          if (parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))) {
            const name = ts.isPropertyAccessExpression(parent) ? parent.name.text : stringLiteral(parent.argumentExpression) ?? '*';
            if (name === '*' || MODEL_CALL_SYMBOLS.has(name)) add('model_call', name, parent);
          } else if (!parent || !ts.isVariableDeclaration(parent)) {
            add('model_call', '*', node);
          }
        }
      }
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'doGenerate' || callee.name.text === 'doStream')) {
        add('raw_model_call', callee.name.text, node);
      }
    }
    // The global network primitives, called or passed on as a value
    // (`fetchImpl ?? fetch`, `globalThis.fetch`, `new WebSocket`).
    if (ts.isIdentifier(node) && NETWORK_GLOBALS.has(node.text) && isGlobalValueReference(node)) {
      add('network', node.text, node);
    }

    // Uses of a whole-module `ai` binding.
    if (ts.isIdentifier(node) && aiNamespaces.has(node.text) && !isDeclarationName(node)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (MODEL_CALL_SYMBOLS.has(parent.name.text)) add('model_call', parent.name.text, parent);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const name = stringLiteral(parent.argumentExpression);
        if (!name || MODEL_CALL_SYMBOLS.has(name)) add('model_call', name ?? '*', parent);
      } else if (!ts.isTypeQueryNode(parent) && !ts.isQualifiedName(parent)) {
        // The module escapes (passed on, spread, destructured): every call is possible.
        add('model_call', '*', node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

const NETWORK_GLOBALS: ReadonlySet<string> = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']);
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'window', 'self', 'global']);

/** True for a value use of the global binding, not a member, key, declaration or type of the same name. */
function isGlobalValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return ts.isIdentifier(parent.expression) && GLOBAL_OBJECTS.has(parent.expression.text);
  }
  if (isDeclarationName(node)) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)
    || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isParameter(parent)
    || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)
    || ts.isTypeAliasDeclaration(parent) || ts.isEnumMember(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)
    || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && (parent as { name?: ts.Node }).name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isQualifiedName(parent) || ts.isLabeledStatement(parent) || ts.isJsxAttribute(parent)) return false;
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current)) return false;
    if (ts.isStatement(current) || ts.isSourceFile(current)) break;
  }
  return true;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) && parent.name === node)
    || ts.isNamespaceImport(parent)
    || (ts.isImportEqualsDeclaration(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.name === node);
}

export interface ScanTreeOptions {
  /** Directories (relative to `root`) to scan. Default: `['src']`. */
  include?: ReadonlyArray<string>;
  /** Extra path test for files to skip. Tests, fixtures and declarations are skipped by default. */
  exclude?: (relativePath: string) => boolean;
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const SKIPPED = /(?:^|\/)(?:node_modules|dist|\.next|__tests__|__fixtures__|__vectors__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

/** Scans every source file below the included directories. */
export function scanTreeForEgress(root: string, options: ScanTreeOptions = {}): EgressFinding[] {
  const findings: EgressFinding[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join('/');
      if (SKIPPED.test(rel) || options.exclude?.(rel)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_FILE.test(name)) findings.push(...scanSourceForEgress(rel, readFileSync(path, 'utf8')));
    }
  };
  for (const dir of options.include ?? ['src']) walk(join(root, dir));
  return findings;
}

/**
 * Compares findings with the inventory. Every finding needs an entry with
 * the same file, symbol and kind; an entry without a finding is stale and
 * fails too, so the inventory never lists a call that no longer exists.
 */
export function checkEgressInventory(findings: ReadonlyArray<EgressFinding>, inventory: EgressInventory): EgressViolation[] {
  const parsed = EgressInventorySchema.parse(inventory);
  const key = (entry: { file: string; symbol: string; kind: string }) => `${entry.kind}\0${entry.file}\0${entry.symbol}`;
  const violations: EgressViolation[] = [];
  const entries = new Map<string, EgressInventoryEntry>();
  for (const entry of parsed.entries) {
    if (entries.has(key(entry))) violations.push({ code: 'duplicate_inventory_entry', file: entry.file, symbol: entry.symbol });
    entries.set(key(entry), entry);
  }
  const used = new Set<string>();
  for (const finding of findings) {
    const k = key(finding);
    if (entries.has(k)) { used.add(k); continue; }
    violations.push({ code: VIOLATION_CODE[finding.kind], file: finding.file, symbol: finding.symbol, line: finding.line });
  }
  for (const [k, entry] of entries) {
    if (!used.has(k)) violations.push({ code: 'stale_inventory_entry', file: entry.file, symbol: entry.symbol });
  }
  return violations;
}
