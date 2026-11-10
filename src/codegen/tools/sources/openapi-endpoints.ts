import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveToolPolicyDefaults, type DeclaredEffect } from '../../../contracts/tool-policy.js';
import type { EndpointMethod } from '../../../types.js';
import {
  dereference,
  OPENAPI_DOCUMENT_LIMIT,
  OPENAPI_TOOL_METHODS,
  operationFingerprint,
  operationsOf,
  parseOpenapiDocument,
  type OpenapiDocument,
  type OpenapiOperationEntry,
} from '../../openapi-document.js';
import { compareCodeUnits, sortKeysDeep } from '../canonical.js';
import {
  probeItemFor,
  probeKey,
  resolveEndpointContract,
  type OpenapiOperationInput,
  type ResolvedEndpointContract,
} from '../contract-tiers.js';
import { findExclusion } from '../exclusions.js';
import { toolFinding } from '../findings.js';
import { assignDefinitionIds } from '../identity.js';
import type { InputRole } from '../input-roles.js';
import { validateResolutionEntry, type ResolutionEntry } from '../resolutions.js';
import type { SchemaProbeItem, SchemaProbeResult } from '../schema-probe.js';
import type {
  ExcludedTool,
  JsonSchemaLike,
  ObservedTool,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
  ToolSourceObservation,
} from '../types.js';

export const OPENAPI_DEFAULT_DOCUMENT = 'openapi.json';
const COUNTER = fileURLToPath(new URL('./fastapi-routes.py', import.meta.url));
const COUNT_TIMEOUT_MS = 30_000;
const DECLARED_EFFECTS: ReadonlyArray<string> = ['read', 'write', 'destructive', 'external', 'financial'];
const READ_METHODS: ReadonlySet<EndpointMethod> = new Set(['GET', 'HEAD', 'DELETE']);
const SUCCESS_STATUSES = ['200', '201', '202'];

export interface OpenapiSourceOptions {
  /** App-relative path of the exported OpenAPI 3.1 document. */
  document?: string;
  /** App-relative folder of the FastAPI code whose routes are counted against the export. */
  fastapi?: string;
  /** The Python interpreter that counts the routes; tests point it at a missing file. */
  python?: string;
}

interface FastapiRoute {
  file: string;
  line: number;
  methods: string[];
  hidden: boolean;
}

interface OpenapiEntry {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  pathParams: string[];
  operation: OpenapiOperationEntry;
  input: OpenapiOperationInput;
  queryKeys: string[];
  body: JsonSchemaLike | undefined;
  output: JsonSchemaLike | undefined;
  findings: ToolFinding[];
  authEvidence: boolean;
  description: string | undefined;
  normalizedText: string;
  sourceFingerprint: string;
}

interface OpenapiPiece {
  entry: OpenapiEntry;
  resolved: ResolvedEndpointContract;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function incomplete(message: string): ToolSourceObservation {
  return {
    observations: [],
    findings: [toolFinding('E-INVENTORY-011', 'error', 'openapi', message)],
    complete: false,
    excluded: [],
  };
}

function objectSchema(properties: Map<string, JsonSchemaLike>, required: ReadonlyArray<string>): JsonSchemaLike {
  const keys = [...properties.keys()].sort(compareCodeUnits);
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((key) => [key, properties.get(key)!])),
    ...(required.length > 0 ? { required: [...new Set(required)].sort(compareCodeUnits) } : {}),
    additionalProperties: false,
  };
}

/** Path item parameters, overridden by operation parameters of the same name and location. */
function parametersOf(document: OpenapiDocument, entry: OpenapiOperationEntry): { list: JsonObject[]; problems: string[] } {
  const merged = new Map<string, JsonObject>();
  const problems: string[] = [];
  for (const raw of [entry.pathItem.parameters, entry.operation.parameters]) {
    if (!Array.isArray(raw)) continue;
    const resolved = dereference(document, raw);
    problems.push(...resolved.problems);
    for (const parameter of resolved.value as unknown[]) {
      if (isObject(parameter) && typeof parameter.name === 'string' && typeof parameter.in === 'string') {
        merged.set(`${parameter.in}:${parameter.name}`, parameter);
      }
    }
  }
  return { list: [...merged.values()], problems };
}

function jsonContent(document: OpenapiDocument, carrier: unknown): { schema?: JsonSchemaLike; problems: string[]; nonJson: boolean } {
  const resolved = dereference(document, carrier);
  const content = isObject(resolved.value) ? resolved.value.content : undefined;
  if (!isObject(content)) return { problems: resolved.problems, nonJson: false };
  const json = content['application/json'];
  if (!isObject(json)) return { problems: resolved.problems, nonJson: Object.keys(content).length > 0 };
  const schema = isObject(json.schema) ? json.schema as JsonSchemaLike : {};
  return { schema, problems: resolved.problems, nonJson: false };
}

function successOutput(document: OpenapiDocument, operation: JsonObject): { schema?: JsonSchemaLike; problems: string[] } {
  const responses = isObject(operation.responses) ? operation.responses : {};
  for (const status of SUCCESS_STATUSES) {
    if (responses[status] === undefined) continue;
    const { schema, problems } = jsonContent(document, responses[status]);
    return { ...(schema ? { schema } : {}), problems };
  }
  return { problems: [] };
}

/** `security` of the operation, else of the document; every requirement must name a scheme. */
function securedBy(document: OpenapiDocument, operation: JsonObject): boolean {
  const security = operation.security ?? document.security;
  return Array.isArray(security) && security.length > 0
    && security.every((requirement) => isObject(requirement) && Object.keys(requirement).length > 0);
}

function readEntry(
  document: OpenapiDocument,
  documentPath: string,
  operation: OpenapiOperationEntry,
  method: EndpointMethod,
  path: string,
): OpenapiEntry | { unsupportedBody: true } {
  const stableKey = `${method} ${path}`;
  const findings: ToolFinding[] = [];
  const where = `${documentPath} ${operation.operationKey.toUpperCase()} ${operation.documentPath}`;
  const pathParams = path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
  const parameters = parametersOf(document, operation);
  const body = operation.operation.requestBody === undefined
    ? { problems: [], nonJson: false }
    : jsonContent(document, operation.operation.requestBody);
  if (body.nonJson) return { unsupportedBody: true };
  const output = successOutput(document, operation.operation);

  const pathProperties = new Map<string, JsonSchemaLike>(pathParams.map((name) => [name, { type: 'string' }]));
  const queryProperties = new Map<string, JsonSchemaLike>();
  const queryRequired: string[] = [];
  for (const parameter of parameters.list) {
    const schema = isObject(parameter.schema) ? parameter.schema as JsonSchemaLike : {};
    const name = parameter.name as string;
    if (parameter.in === 'path' && pathProperties.has(name)) pathProperties.set(name, schema);
    else if (parameter.in === 'query') {
      queryProperties.set(name, schema);
      if (parameter.required === true) queryRequired.push(name);
    } else if ((parameter.in === 'header' || parameter.in === 'cookie') && parameter.required === true) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', stableKey,
        `${where} requires the ${parameter.in} ${name}, which a tool call cannot send.`));
    }
  }
  if (body.schema && READ_METHODS.has(method)) {
    findings.push(toolFinding('input-role-unsupported', 'needs_attention', stableKey,
      `${where} reads a request body, which a ${method} tool cannot send.`));
  }
  const parts: Array<OpenapiOperationInput['parts'][number]> = [];
  const add = (role: InputRole, json: JsonSchemaLike, label: string) => parts.push({ role, json, label });
  if (pathParams.length > 0) add('path', objectSchema(pathProperties, pathParams), `${where} path parameters`);
  if (queryProperties.size > 0) add('query', objectSchema(queryProperties, queryRequired), `${where} query parameters`);
  if (body.schema) add('body', body.schema, `${where} request body`);

  for (const problem of [...new Set([...parameters.problems, ...body.problems, ...output.problems])].sort(compareCodeUnits)) {
    findings.push(toolFinding('schema-reference-unresolved', 'warning', stableKey,
      `${where} has a ${problem}; that part of the schema accepts any value and the server keeps validating it.`));
  }
  const declared = operation.operation['x-glirastes-effect'];
  let effect: DeclaredEffect | undefined;
  if (typeof declared === 'string' && DECLARED_EFFECTS.includes(declared)) effect = declared as DeclaredEffect;
  else if (declared !== undefined) {
    findings.push(toolFinding('contract-effect-invalid', 'needs_attention', stableKey,
      `${where} declares an x-glirastes-effect that is not read, write, destructive, external or financial, so the declaration is ignored.`));
  }
  const description = typeof operation.operation.description === 'string' && operation.operation.description.trim()
    ? operation.operation.description.trim()
    : typeof operation.operation.summary === 'string' && operation.operation.summary.trim()
      ? operation.operation.summary.trim()
      : undefined;
  const subject = dereference(document, { operation: operation.operation, parameters: operation.pathItem.parameters ?? [] }).value;
  return {
    stableKey,
    method,
    path,
    pathParams,
    operation,
    input: { parts, ...(effect ? { effect } : {}) },
    queryKeys: [...queryProperties.keys()].sort(compareCodeUnits),
    body: body.schema,
    output: output.schema,
    findings,
    authEvidence: securedBy(document, operation.operation),
    description,
    normalizedText: JSON.stringify(sortKeysDeep(subject)),
    sourceFingerprint: operationFingerprint(document, operation, method, path),
  };
}

function bodyKeysOf(body: JsonSchemaLike | undefined): ReadonlyArray<string> | 'opaque' {
  if (!body) return [];
  const properties = body.type === 'object' && isObject(body.properties) ? body.properties : undefined;
  return properties ? Object.keys(properties).sort(compareCodeUnits) : 'opaque';
}

function countFastapiRoutes(
  python: string,
  root: string,
  folder: string,
): Promise<{ routes: FastapiRoute[]; problems: string[] } | string> {
  return new Promise((settleWith) => {
    let settled = false;
    const settle = (value: { routes: FastapiRoute[]; problems: string[] } | string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleWith(value);
    };
    const child = spawn(python, ['-I', COUNTER, resolve(root, folder)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), COUNT_TIMEOUT_MS);
    child.on('error', (error: NodeJS.ErrnoException) => settle(error.code === 'ENOENT'
      ? `${python} was not found; Python 3.12 counts the FastAPI routes in ${folder} without importing the app.`
      : `${python} could not count the FastAPI routes in ${folder}: ${error.message}`));
    child.on('close', (code, signal) => {
      if (signal) return settle(`Counting the FastAPI routes in ${folder} took longer than ${COUNT_TIMEOUT_MS / 1000} seconds.`);
      if (code !== 0) {
        return settle(`Counting the FastAPI routes in ${folder} failed: ${stderr.trim().split('\n').at(-1) || `exit code ${String(code)}`}`);
      }
      try {
        const parsed = JSON.parse(stdout) as { routes?: unknown; problems?: unknown };
        if (!Array.isArray(parsed.routes) || !Array.isArray(parsed.problems)) throw new Error('shape');
        settle({ routes: parsed.routes as FastapiRoute[], problems: parsed.problems as string[] });
      } catch {
        settle(`Counting the FastAPI routes in ${folder} returned no readable result.`);
      }
    });
  });
}

function toObserved(piece: OpenapiPiece, definitionId: string, documentPath: string): ObservedTool {
  const { entry, resolved } = piece;
  const findings = [...entry.findings, ...resolved.findings];
  const bodyKeys = bodyKeysOf(entry.body);
  if (!entry.authEvidence) {
    findings.push(toolFinding('auth-evidence-missing', 'needs_attention', entry.stableKey,
      `${entry.stableKey} has no security requirement in ${documentPath}; the tool stays disabled until the endpoint's authorization is visible.`));
  }
  return {
    execution: {
      definitionId,
      stableKey: entry.stableKey,
      executionKind: 'endpoint',
      sourceKind: 'openapi',
      sourceFile: documentPath,
      method: entry.method,
      path: entry.path,
      sourceFingerprint: entry.sourceFingerprint,
      inputSchemaDigest: resolved.inputSchemaDigest,
      outputSchemaDigest: resolved.outputSchemaDigest,
    },
    ...(resolved.contract ? { contract: resolved.contract } : {}),
    interface: {
      digest: resolved.interfaceDigest,
      params: resolved.contract?.params ?? {
        path: [...entry.pathParams],
        query: [...entry.queryKeys],
        body: bodyKeys === 'opaque' ? 'opaque' : [...bodyKeys],
      },
    },
    files: [documentPath],
    evidence: {
      authEvidence: entry.authEvidence,
      externalCall: false,
      ...(resolved.declaredEffect ? { declaredEffect: resolved.declaredEffect } : {}),
      ...(entry.description ? { jsDoc: entry.description } : {}),
    },
    findings,
    ...(Object.keys(resolved.prose).length > 0 ? { prose: resolved.prose } : {}),
  };
}

async function observeOpenapiEndpoints(ctx: ToolSourceContext, options: OpenapiSourceOptions): Promise<ToolSourceObservation> {
  const documentPath = options.document ?? OPENAPI_DEFAULT_DOCUMENT;
  let text: string;
  try {
    const absolute = resolve(ctx.root, documentPath);
    if ((await stat(absolute)).size > OPENAPI_DOCUMENT_LIMIT) {
      return incomplete(`${documentPath} is larger than 2 MiB; the generator reads smaller OpenAPI exports.`);
    }
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return incomplete(`${documentPath} does not exist; export the OpenAPI document of the API first, then run glirastes tools refresh.`);
    }
    throw error;
  }
  const parsed = parseOpenapiDocument(text);
  if (!parsed.ok) return incomplete(`${documentPath} ${parsed.reason}.`);
  const { document } = parsed;
  const operations = operationsOf(document);
  const findings: ToolFinding[] = [];

  if (options.fastapi !== undefined) {
    const counted = await countFastapiRoutes(options.python ?? 'python3', ctx.root, options.fastapi);
    if (typeof counted === 'string') return incomplete(counted);
    if (counted.problems.length > 0) {
      return incomplete(counted.problems.map((problem) => `${options.fastapi}/${problem}`).join(' '));
    }
    for (const route of counted.routes.filter((candidate) => candidate.hidden)) {
      const subject = `${options.fastapi}/${route.file}:${route.line}`;
      findings.push(toolFinding('route-hidden', 'warning', subject,
        `${subject} declares ${route.methods.join(', ')} with include_in_schema=False; FastAPI serves it, the export leaves it out, so no tool is generated for it.`));
    }
    const declared = counted.routes.filter((route) => !route.hidden).reduce((sum, route) => sum + route.methods.length, 0);
    if (declared !== operations.length) {
      return incomplete(`${documentPath} lists ${operations.length} operations, the FastAPI code in ${options.fastapi} declares ${declared}; run the export again.`);
    }
  }

  const excluded = new Map<string, ExcludedTool>();
  const kept: OpenapiEntry[] = [];
  const policyExcludes = ctx.policy.exclude ?? [];
  for (const operation of operations) {
    const method = OPENAPI_TOOL_METHODS[operation.operationKey];
    const shownPath = operation.path ?? operation.documentPath;
    if (!method) {
      const stableKey = `${operation.operationKey.toUpperCase()} ${shownPath}`;
      excluded.set(stableKey, { stableKey, reason: 'unsupported-method', origin: 'code' });
      continue;
    }
    if (operation.path === undefined) {
      const stableKey = `${method} ${shownPath}`;
      excluded.set(stableKey, { stableKey, reason: 'unsupported-path', origin: 'code' });
      continue;
    }
    const stableKey = `${method} ${operation.path}`;
    const exclusion = findExclusion({
      stableKey,
      method,
      path: operation.path,
      chatHandler: false,
      aiIgnore: operation.operation['x-glirastes-ignore'] === true,
    }, policyExcludes);
    if (exclusion) {
      excluded.set(stableKey, exclusion);
      continue;
    }
    const entry = readEntry(document, documentPath, operation, method, operation.path);
    if ('unsupportedBody' in entry) {
      excluded.set(stableKey, { stableKey, reason: 'unsupported-body', origin: 'code' });
      continue;
    }
    kept.push(entry);
  }
  const excludedList = [...excluded.values()].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  kept.sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  if (kept.length === 0) return { observations: [], findings, complete: true, excluded: excludedList };

  const resolutions = new Map<string, ResolutionEntry>();
  for (const entry of kept) {
    const raw = ctx.resolutions.entries.get(entry.stableKey);
    if (raw === undefined) continue;
    const validated = validateResolutionEntry({
      stableKey: entry.stableKey,
      raw,
      codeRiskClass: deriveToolPolicyDefaults({
        executionKind: 'endpoint', method: entry.method, path: entry.path, definitionId: '',
      }).riskClass,
    });
    findings.push(...validated.findings);
    if (validated.entry) resolutions.set(entry.stableKey, validated.entry);
  }
  const items = new Map<string, SchemaProbeItem>();
  for (const resolution of resolutions.values()) {
    for (const [ref, role] of [[resolution.input?.schemaRef, 'input'], [resolution.output?.schemaRef, 'output']] as const) {
      if (ref) items.set(probeKey(probeItemFor(ref, role)), probeItemFor(ref, role));
    }
  }
  const keys = [...items.keys()].sort(compareCodeUnits);
  const results = keys.length > 0 ? await ctx.probe.probe(ctx.root, keys.map((key) => items.get(key)!)) : [];
  const probes = new Map<string, SchemaProbeResult>(keys.map((key, index) => [
    key,
    results[index] ?? { ok: false, reason: 'probe-failed' },
  ]));

  const pieces = kept.map((entry): OpenapiPiece => {
    const resolution = resolutions.get(entry.stableKey);
    const previousContract = ctx.previousContracts.get(entry.stableKey);
    const resolved = resolveEndpointContract({
      stableKey: entry.stableKey,
      method: entry.method,
      path: entry.path,
      pathParams: entry.pathParams,
      evidence: {
        schemaUses: [],
        queryKeys: entry.queryKeys,
        repeatedQueryKeys: [],
        bodyKeys: bodyKeysOf(entry.body),
        readsBody: entry.body !== undefined,
        normalizedText: entry.normalizedText,
      },
      ...(entry.output ? { inferredOutput: entry.output } : {}),
      probes,
      openapi: entry.input,
      ...(resolution ? { resolution } : {}),
      ...(previousContract ? { previousContract } : {}),
    });
    return { entry, resolved };
  });
  const naming = assignDefinitionIds(
    pieces.map(({ entry, resolved }) => ({
      stableKey: entry.stableKey,
      method: entry.method,
      path: entry.path,
      ...(resolved.explicitId ? { explicitId: resolved.explicitId } : {}),
    })),
    new Map((ctx.previous?.inventory.executions ?? []).map((execution) => [execution.stableKey, execution.definitionId])),
  );
  findings.push(...naming.findings);
  return {
    observations: pieces.map((piece) => toObserved(piece, naming.ids.get(piece.entry.stableKey)!, documentPath)),
    findings,
    complete: true,
    excluded: excludedList,
  };
}

/**
 * An exported OpenAPI 3.1 document (FastAPI writes one), read as JSON. With
 * `fastapi` set, the routes of the FastAPI code are counted with Python's
 * `ast` module (`python3 -I`, the app is never imported) and a stale export
 * stops the refresh.
 */
export function createOpenapiEndpointSource(options: OpenapiSourceOptions = {}): ToolSource {
  return { kind: 'openapi', observe: (ctx) => observeOpenapiEndpoints(ctx, options) };
}
