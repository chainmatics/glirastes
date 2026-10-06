import ts from 'typescript';
import { canonicalJson, compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import { typeToJsonSchema } from '../output-inference.js';
import { createAppProgram, type AppProgram } from '../program.js';
import type { JsonSchemaLike, ToolFinding, ToolSource, ToolSourceObservation } from '../types.js';
import { scanAppSources } from './app-files.js';
import {
  actionStableKey,
  importedCalls,
  incompleteUiSource,
  uiDefinitionIdForAction,
  uiObservation,
  uniqueDefinitionIds,
} from './ui-tools.js';

export interface ReactActionSourceOptions {
  /** Where registrations are searched; `src` when the app has one, else the app root. */
  srcDir?: string;
}

const REGISTRATION_SPECS = [
  { module: 'glirastes/react', names: ['useAiClientAction', 'useAiClientActionById'] },
  { module: 'glirastes/browser', names: ['registerAiClientAction'] },
];
const BUS_MODULES: ReadonlySet<string> = new Set(['glirastes/react', 'glirastes/browser']);
const REGISTRATION_TEXT = /useAiClientAction|registerAiClientAction|subscribeById/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Calls of mutation hooks (React Query, SWR) whose effect the generator cannot see. */
const MUTATION_CALLS: ReadonlySet<string> = new Set(['mutate', 'mutateAsync', 'trigger']);
const EMPTY_PAYLOAD: JsonSchemaLike = { type: 'object', properties: {}, additionalProperties: false };

interface Registration {
  actionId: string;
  file: string;
  /** `payload`: the handler receives the payload; `action`: the whole UI action. */
  style: 'payload' | 'action';
  handler: ts.Expression | undefined;
  contract: ts.Expression | undefined;
  call: ts.CallExpression;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function literalId(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function importsBus(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && BUS_MODULES.has(statement.moduleSpecifier.text)
    && !statement.importClause?.isTypeOnly
  ));
}

/** The function a handler argument stands for: inline, `useCallback(fn)` or a named function. */
function functionOf(app: AppProgram, raw: ts.Expression | undefined, depth = 0): ts.SignatureDeclaration | undefined {
  if (!raw || depth > 4) return undefined;
  const expression = unwrap(raw);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'useCallback') {
    return functionOf(app, expression.arguments[0], depth + 1);
  }
  if (ts.isIdentifier(expression)) {
    let symbol = app.checker.getSymbolAtLocation(expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
    if (declaration && ts.isVariableDeclaration(declaration)) return functionOf(app, declaration.initializer, depth + 1);
  }
  return undefined;
}

function objectSchema(app: AppProgram, type: ts.Type, location: ts.Node): JsonSchemaLike | undefined {
  const schema = typeToJsonSchema(app.checker, type, location);
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) return undefined;
  return { ...schema, additionalProperties: false };
}

/** Contract (`z.infer` via `_output`) first, then the handler's parameter type; undefined when untyped. */
function payloadSchema(app: AppProgram, registration: Registration): JsonSchemaLike | undefined {
  const checker = app.checker;
  if (registration.contract) {
    const contractType = checker.getTypeAtLocation(registration.contract);
    const output = checker.getPropertyOfType(contractType, '_output');
    if (output) {
      const schema = objectSchema(app, checker.getTypeOfSymbolAtLocation(output, registration.contract), registration.contract);
      if (schema) return schema;
    }
  }
  const handler = functionOf(app, registration.handler);
  if (!handler) return undefined;
  const parameter = handler.parameters[0];
  if (!parameter) return EMPTY_PAYLOAD;
  let type = checker.getTypeAtLocation(parameter);
  if (registration.style === 'action') {
    const payload = checker.getPropertyOfType(type, 'payload');
    if (!payload) return undefined;
    type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(payload, parameter));
  }
  return objectSchema(app, type, parameter);
}

interface WriteEvidence {
  /** A non-GET `fetch(…, { method })` or an `axios` write: the tool writes. */
  writes: boolean;
  /** A call that may write but does not show it (D4): a helper of another app file, a mutation hook, a computed fetch method. */
  unproven?: string;
}

/**
 * A declaration a call can run code of: a function, method or class, a module imported
 * as a namespace, or a variable initialised with a function or an object of methods.
 * Fields, parameters and constants are data: a method on them is a built-in or a
 * property of a shared type, not a function of another app file.
 */
function holdsCode(declaration: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)
    || ts.isClassDeclaration(declaration) || ts.isSourceFile(declaration)) return true;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const initializer = unwrap(declaration.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isObjectLiteralExpression(initializer);
}

/** The app file that declares what a call refers to, when it is not the handler's own file. */
function otherAppFile(app: AppProgram, callee: ts.Expression, ownFile: string): string | undefined {
  const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
  let symbol = app.checker.getSymbolAtLocation(receiver ?? callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  // A called identifier is callable by definition; a receiver counts only when it holds code.
  const declaration = receiver ? symbol?.declarations?.find(holdsCode) : symbol?.declarations?.[0];
  const file = declaration ? app.appRelative(declaration.getSourceFile().fileName) : undefined;
  return file && file !== ownFile ? file : undefined;
}

function calleeLabel(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return `${calleeLabel(callee.expression)}.${callee.name.text}`;
  return 'a computed function';
}

/** What the handler body shows about writing (spec 4.5 "nachweisbar"). */
function writeEvidence(app: AppProgram, handler: ts.SignatureDeclaration | undefined): WriteEvidence {
  const body = handler && 'body' in handler ? (handler as ts.FunctionLikeDeclaration).body : undefined;
  if (!body) return { writes: false };
  const ownFile = app.appRelative(body.getSourceFile().fileName) ?? '';
  let writes = false;
  let unproven: string | undefined;
  const visit = (node: ts.Node): void => {
    if (writes) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch') {
        const options = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
        const method = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
            && ts.isIdentifier(property.name) && property.name.text === 'method'))
          : undefined;
        const value = method && ts.isPropertyAssignment(method) ? unwrap(method.initializer) : undefined;
        if (value && ts.isStringLiteralLike(value)) {
          if (WRITE_METHODS.has(value.text.toUpperCase())) writes = true;
        } else if (options && (!ts.isObjectLiteralExpression(options) || method || options.properties.some(ts.isSpreadAssignment))) {
          unproven ??= 'fetch with a method the generator cannot read';
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'axios' && ['post', 'put', 'patch', 'delete'].includes(callee.name.text)) {
        writes = true;
      } else {
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name && MUTATION_CALLS.has(name)) {
          unproven ??= `${calleeLabel(callee)}()`;
        } else {
          const file = otherAppFile(app, callee, ownFile);
          if (file) unproven ??= `${calleeLabel(callee)} from ${file}`;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return writes ? { writes } : { writes, ...(unproven ? { unproven } : {}) };
}

function docOf(source: ts.SourceFile, node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  const text = source.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const block = [...ranges].reverse().find((range) => text.startsWith('/**', range.pos));
  if (!block) return undefined;
  const lines = text.slice(block.pos + 3, block.end - 2).split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('@'));
  return lines.length > 0 ? lines.join(' ') : undefined;
}

function statementOf(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isExpressionStatement(current) && !ts.isVariableStatement(current)) current = current.parent;
  return current;
}

function registrationsOf(
  source: ts.SourceFile,
  file: string,
  findings: ToolFinding[],
): Registration[] {
  const found: Array<Omit<Registration, 'actionId'> & { id: ts.Expression | undefined }> = [];
  for (const { name, call } of importedCalls(source, REGISTRATION_SPECS)) {
    found.push(name === 'useAiClientActionById'
      ? { file, style: 'action', id: call.arguments[1], handler: call.arguments[2], contract: undefined, call }
      : { file, style: 'payload', id: call.arguments[0], handler: call.arguments[1], contract: call.arguments[2], call });
  }
  if (importsBus(source)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'subscribeById') {
        found.push({ file, style: 'action', id: node.arguments[0], handler: node.arguments[1], contract: undefined, call: node });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const registrations: Registration[] = [];
  for (const { id, ...entry } of found.sort((left, right) => left.call.getStart() - right.call.getStart())) {
    const actionId = literalId(id);
    const line = source.getLineAndCharacterOfPosition(entry.call.getStart()).line + 1;
    if (actionId === undefined) {
      findings.push(toolFinding('ui-action-id-dynamic', 'warning', `${file}:${line}`,
        'A client action is registered with an id that is not a literal, so the chat cannot call it.'));
      continue;
    }
    if (actionId.startsWith('glirastes.')) {
      findings.push(toolFinding('ui-action-id-reserved', 'warning', `${file}:${line}`,
        `${actionId} belongs to the SDK and is not a client action of this app.`));
      continue;
    }
    registrations.push({ ...entry, actionId });
  }
  return registrations;
}

async function observeActions(root: string, options: ReactActionSourceOptions): Promise<ToolSourceObservation> {
  const scan = await scanAppSources(root, {
    ...(options.srcDir ? { srcDir: options.srcDir } : {}),
    matches: (source) => REGISTRATION_TEXT.test(source),
  });
  if (!scan.complete) return incompleteUiSource('react-actions', scan.reason);
  if (scan.files.length === 0) return { observations: [], findings: [], complete: true, excluded: [] };
  const app = createAppProgram({ root, rootNames: scan.files.map((file) => file.absolute) });
  const findings: ToolFinding[] = [];
  const byId = new Map<string, Registration[]>();
  for (const file of scan.files) {
    const source = app.sourceFile(file.absolute);
    if (!source) continue;
    for (const registration of registrationsOf(source, file.path, findings)) {
      byId.set(registration.actionId, [...byId.get(registration.actionId) ?? [], registration]);
    }
  }
  const named: Array<{ actionId: string; base: string }> = [];
  for (const [actionId, registrations] of byId) {
    const base = uiDefinitionIdForAction(actionId);
    if (base === undefined) {
      findings.push(toolFinding('ui-action-id-invalid', 'warning', registrations[0]!.file,
        `${JSON.stringify(actionId)} cannot become a tool name.`));
      continue;
    }
    named.push({ actionId, base });
  }
  const ids = uniqueDefinitionIds(named.map(({ actionId, base }) => ({ stableKey: actionStableKey(actionId), base })));
  const observations = named
    .sort((left, right) => compareCodeUnits(left.actionId, right.actionId))
    .map(({ actionId }) => {
      const stableKey = actionStableKey(actionId);
      const registrations = byId.get(actionId)!;
      const schemas = registrations.map((registration) => payloadSchema(app, registration));
      const typed = [...new Map(schemas
        .filter((schema): schema is JsonSchemaLike => schema !== undefined)
        .map((schema) => [canonicalJson(schema), schema] as const)).values()];
      const handlers = registrations.map((registration) => functionOf(app, registration.handler));
      const toolFindings: ToolFinding[] = [];
      if (typed.length === 0) {
        toolFindings.push(toolFinding('ui-action-payload-untyped', 'needs_attention', stableKey,
          `${actionId} has neither a payload contract nor a typed handler parameter.`));
      } else if (typed.length > 1) {
        toolFindings.push(toolFinding('ui-action-contract-conflict', 'needs_attention', stableKey,
          `${actionId} is registered with ${typed.length} different payload contracts.`));
      }
      const input = typed[0];
      const jsDoc = registrations
        .map((registration, index) => {
          const handler = handlers[index];
          return docOf(registration.call.getSourceFile(), statementOf(registration.call))
            ?? (handler && ts.isFunctionDeclaration(handler) ? docOf(handler.getSourceFile(), handler) : undefined);
        })
        .find((doc) => doc !== undefined);
      const evidence = handlers.map((handler) => writeEvidence(app, handler));
      const uiMutation = evidence.some((entry) => entry.writes);
      const unproven = evidence.find((entry) => entry.unproven)?.unproven;
      if (!uiMutation && unproven) {
        toolFindings.push(toolFinding('ui-action-write-unproven', 'warning', stableKey,
          `${actionId} calls ${unproven}; if that changes data, raise the tool to write so the chat asks first.`));
      }
      return uiObservation({
        stableKey,
        definitionId: ids.get(stableKey)!,
        actionBindingRef: actionId,
        ...(input ? { input } : {}),
        uiAction: { kind: 'client-action', actionId },
        params: {
          path: [],
          query: [],
          body: Object.keys((input?.properties ?? {}) as Record<string, unknown>).sort(compareCodeUnits),
        },
        facts: {
          actionId,
          files: [...new Set(registrations.map((registration) => registration.file))].sort(compareCodeUnits),
          payloads: typed,
          uiMutation,
        },
        findings: toolFindings,
        files: [...new Set(registrations.map((registration) => registration.file))].sort(compareCodeUnits),
        ...(jsDoc ? { jsDoc } : {}),
        ...(uiMutation ? { uiMutation } : {}),
      });
    });
  return { observations, findings, complete: true, excluded: [] };
}

/**
 * The `react-actions` source: one `ui.<actionId>` tool per literal client
 * action id registered with `useAiClientAction`, `registerAiClientAction`,
 * `useAiClientActionById` or `bus.subscribeById` (spec 4.4).
 */
export function createReactActionSource(options: ReactActionSourceOptions = {}): ToolSource {
  return { kind: 'react-actions', observe: (ctx) => observeActions(ctx.root, options) };
}
