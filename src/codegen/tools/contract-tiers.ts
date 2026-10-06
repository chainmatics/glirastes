import type { DeclaredEffect } from '../../contracts/tool-policy.js';
import type { EndpointMethod } from '../../types.js';
import { compareCodeUnits, jsonSchemaDigest, OPAQUE_JSON_SCHEMA } from './canonical.js';
import { toolFinding } from './findings.js';
import type { SchemaUse } from './handler-analysis.js';
import type { InputRole } from './input-roles.js';
import { computeInterfaceDigest } from './interface-digest.js';
import { inputEvidenceProblem, type ResolutionEntry } from './resolutions.js';
import type {
  ProbedContractEntry,
  ProbedSchema,
  SchemaProbeItem,
  SchemaProbeResult,
} from './schema-probe.js';
import type {
  ContractBinding,
  JsonSchemaLike,
  RuntimeSchemaSource,
  SchemaBindingRef,
  ToolContract,
  ToolFinding,
  ToolProseHints,
} from './types.js';

export interface EndpointEvidence {
  schemaUses: ReadonlyArray<SchemaUse>;
  queryKeys: ReadonlyArray<string>;
  repeatedQueryKeys: ReadonlyArray<string>;
  bodyKeys: ReadonlyArray<string> | 'opaque';
  readsBody: boolean;
  normalizedText?: string;
}

export interface ContractModuleCandidate {
  module: string;
  loadBearing: boolean;
  result: SchemaProbeResult;
}

export interface ResolveEndpointContractInput {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  pathParams: ReadonlyArray<string>;
  evidence: EndpointEvidence;
  inferredOutput?: JsonSchemaLike;
  probes: ReadonlyMap<string, SchemaProbeResult>;
  contractModule?: ContractModuleCandidate;
  resolution?: ResolutionEntry;
  previousContract?: ToolContract;
}

export interface ResolvedEndpointContract {
  contract?: ToolContract;
  interfaceDigest: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  findings: ToolFinding[];
  prose: ToolProseHints;
  explicitId?: string;
  declaredEffect?: DeclaredEffect;
}

export const OPAQUE_SCHEMA_DIGEST = jsonSchemaDigest(OPAQUE_JSON_SCHEMA);

const READ_METHODS: ReadonlySet<EndpointMethod> = new Set(['GET', 'HEAD', 'DELETE']);
const EFFECT_STRENGTH: Readonly<Record<DeclaredEffect, number>> = {
  read: 0, write: 1, destructive: 2, external: 2, financial: 2,
};

interface RolePart {
  role: InputRole;
  json: JsonSchemaLike | null;
  source: RuntimeSchemaSource;
  digest: string;
  label: string;
  /** Tier 2/4 schemas describe the whole tool input, path parameters included. */
  wholeInput?: boolean;
}

interface ComposedInput {
  source: RuntimeSchemaSource;
  json: JsonSchemaLike;
  digest: string;
  findings: ToolFinding[];
}

interface OutputChoice {
  source: RuntimeSchemaSource;
  json: JsonSchemaLike;
  digest: string;
  description?: string;
  findings: ToolFinding[];
}

export function probeItemFor(binding: SchemaBindingRef, io: 'input' | 'output'): SchemaProbeItem {
  return { kind: 'schema', io, module: binding.module, export: binding.export, property: [...binding.property] };
}

export function contractEntryItem(module: string, method: EndpointMethod): SchemaProbeItem {
  return { kind: 'contract-entry', io: 'input', module, export: 'contract', property: [method] };
}

export function probeKey(item: SchemaProbeItem): string {
  return JSON.stringify([item.kind, item.io, item.module, item.export, item.property]);
}

export function bindingLabel(role: string, binding: SchemaBindingRef): string {
  return `${role}:${binding.module}#${[binding.export, ...binding.property].join('.')}`;
}

function moduleExport(binding: SchemaBindingRef): RuntimeSchemaSource {
  return { kind: 'module-export', module: binding.module, export: binding.export, property: [...binding.property] };
}

function jsonSource(schema: JsonSchemaLike): RuntimeSchemaSource {
  return { kind: 'json', schema };
}

function asSchema(result: SchemaProbeResult | undefined): ProbedSchema | undefined {
  return result?.ok && result.kind === 'schema' ? result : undefined;
}

function isContentRejected(result: SchemaProbeResult | undefined): boolean {
  return result !== undefined && !result.ok && result.reason === 'content-rejected';
}

/**
 * A probe that produced no usable schema. Secret-looking content is reported
 * apart from load errors, and the finding never repeats the content itself.
 */
function probeFailureFinding(subject: string, label: string, outcome: SchemaProbeResult | undefined): ToolFinding {
  if (isContentRejected(outcome)) {
    return toolFinding('schema-content-rejected', 'needs_attention', subject,
      `${label} carries a secret-looking value, so none of it is used.`);
  }
  return toolFinding('schema-module-unloadable', 'needs_attention', subject,
    `${label} could not be loaded (${outcome && !outcome.ok ? outcome.reason : 'not probed'}).`);
}

/** Fail closed: a rejected output schema is never committed, so the output stays untyped. */
function rejectedOutput(subject: string, label: string, outcome: SchemaProbeResult | undefined): OutputChoice {
  return {
    source: jsonSource(OPAQUE_JSON_SCHEMA),
    json: OPAQUE_JSON_SCHEMA,
    digest: OPAQUE_SCHEMA_DIGEST,
    findings: [probeFailureFinding(subject, label, outcome)],
  };
}

/**
 * A declared `effect` can only raise the derived risk, so a typo would lose the
 * author's hardening intent without a trace; the tool needs attention until it
 * is fixed. A bad presentation is cosmetic and only warns. Neither message
 * repeats the declared value.
 */
function invalidMetadataFindings(subject: string, module: string, entry: ProbedContractEntry): ToolFinding[] {
  const findings: ToolFinding[] = [];
  if (entry.invalidFields?.includes('effect')) {
    findings.push(toolFinding('contract-effect-invalid', 'needs_attention', subject,
      `${module} declares an effect that is not read, write, destructive, external or financial, so the declaration is ignored.`));
  }
  if (entry.invalidFields?.includes('presentation')) {
    findings.push(toolFinding('contract-presentation-invalid', 'warning', subject,
      `${module} declares a presentation that does not match the presentation schema, so it is ignored.`));
  }
  return findings;
}

function propertiesOf(json: JsonSchemaLike | null): Record<string, JsonSchemaLike> | undefined {
  if (!json || json.type !== 'object') return undefined;
  const value = json.properties;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonSchemaLike> : {};
}

function requiredOf(json: JsonSchemaLike): string[] {
  return Array.isArray(json.required)
    ? json.required.filter((value): value is string => typeof value === 'string')
    : [];
}

function strongerEffect(
  first: DeclaredEffect | null | undefined,
  second: DeclaredEffect | undefined,
): DeclaredEffect | undefined {
  if (!first) return second;
  if (!second) return first;
  return EFFECT_STRENGTH[second] > EFFECT_STRENGTH[first] ? second : first;
}

function composeInput(
  subject: string,
  parts: ReadonlyArray<RolePart>,
  pathParams: ReadonlyArray<string>,
): ComposedInput | { findings: ToolFinding[] } {
  const only = parts.length === 1 ? parts[0] : undefined;
  const covers = only?.wholeInput === true
    && pathParams.every((name) => propertiesOf(only.json)?.[name] !== undefined);
  if (only && (pathParams.length === 0 || only.role === 'path' || covers)) {
    return {
      source: only.source,
      json: only.json ?? OPAQUE_JSON_SCHEMA,
      digest: only.digest,
      findings: only.json ? [] : [toolFinding('schema-json-unavailable', 'warning', subject, `${only.label} has no JSON Schema description.`)],
    };
  }
  const findings: ToolFinding[] = [];
  const properties: Record<string, JsonSchemaLike> = {};
  const required = new Set<string>();
  const owners = new Map<string, InputRole>();
  if (!parts.some((part) => part.role === 'path')) {
    for (const name of pathParams) {
      properties[name] = { type: 'string' };
      required.add(name);
      owners.set(name, 'path');
    }
  }
  for (const part of parts) {
    if (!part.json) {
      findings.push(toolFinding('schema-json-unavailable', 'needs_attention', subject,
        `${part.label} has no JSON Schema, so it cannot be combined with other parameters.`));
      continue;
    }
    const partProperties = propertiesOf(part.json);
    if (!partProperties) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `${part.label} is not an object schema and cannot be combined with other parameters.`));
      continue;
    }
    for (const [key, value] of Object.entries(partProperties)) {
      if (part.wholeInput && pathParams.includes(key)) {
        properties[key] = value;
        continue;
      }
      const owner = owners.get(key);
      if (owner !== undefined && owner !== part.role) {
        findings.push(toolFinding('parameter-collision', 'needs_attention', subject,
          `Parameter ${key} is used both as ${owner} and as ${part.role} parameter.`));
        continue;
      }
      owners.set(key, part.role);
      properties[key] = value;
    }
    for (const key of requiredOf(part.json)) required.add(key);
  }
  if (findings.length > 0) return { findings };
  const json: JsonSchemaLike = {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).sort(([left], [right]) => compareCodeUnits(left, right))),
    ...(required.size ? { required: [...required].sort(compareCodeUnits) } : {}),
    additionalProperties: false,
  };
  return { source: jsonSource(json), json, digest: jsonSchemaDigest(json), findings: [] };
}

function paramsFrom(
  pathParams: ReadonlyArray<string>,
  parts: ReadonlyArray<RolePart>,
  evidence: EndpointEvidence,
): ToolContract['params'] {
  const keysOf = (role: InputRole): string[] | undefined => {
    const part = parts.find((candidate) => candidate.role === role);
    return part
      ? Object.keys(propertiesOf(part.json) ?? {}).filter((key) => !pathParams.includes(key)).sort(compareCodeUnits)
      : undefined;
  };
  return {
    path: [...pathParams],
    query: keysOf('query') ?? [...evidence.queryKeys],
    body: keysOf('body') ?? (evidence.bodyKeys === 'opaque' ? 'opaque' : [...evidence.bodyKeys]),
  };
}

function nativeParts(
  input: ResolveEndpointContractInput,
  uses: ReadonlyArray<SchemaUse>,
): { parts: RolePart[]; description?: string } | { findings: ToolFinding[] } {
  const subject = input.stableKey;
  if (uses.length === 0) {
    return { findings: [toolFinding('input-role-unclear', 'needs_attention', subject,
      'A schema validates request data, but its role (body, query or path) could not be traced.')] };
  }
  const findings: ToolFinding[] = [];
  const byRole = new Map<InputRole, RolePart>();
  let description: string | undefined;
  for (const use of uses) {
    const role = use.role as InputRole;
    if (!use.binding) {
      findings.push(toolFinding('schema-not-exported', 'needs_attention', subject,
        `The ${role} schema is not exported from an app module.`));
      continue;
    }
    if ((role === 'query' && !READ_METHODS.has(input.method)) || (role === 'body' && READ_METHODS.has(input.method))) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `A ${input.method} tool cannot send ${role} parameters.`));
      continue;
    }
    const label = bindingLabel(role, use.binding);
    const outcome = input.probes.get(probeKey(probeItemFor(use.binding, 'input')));
    const schema = asSchema(outcome);
    if (!schema) {
      findings.push(probeFailureFinding(subject, `${use.binding.module}#${use.binding.export}`, outcome));
      continue;
    }
    const existing = byRole.get(role);
    if (existing && existing.label !== label) {
      findings.push(toolFinding('input-role-unclear', 'needs_attention', subject,
        `Two different schemas validate the ${role}.`));
      continue;
    }
    byRole.set(role, { role, json: schema.jsonSchema, source: moduleExport(use.binding), digest: schema.digest, label });
    description ??= schema.description ?? undefined;
  }
  if (findings.length > 0) return { findings };
  return {
    parts: [...byRole.values()].sort((left, right) => compareCodeUnits(left.role, right.role)),
    ...(description ? { description } : {}),
  };
}

function chooseOutput(
  input: ResolveEndpointContractInput,
  entry: ProbedContractEntry | undefined,
  resolution: ResolutionEntry | undefined,
): OutputChoice {
  const outputBindings = input.evidence.schemaUses
    .filter((use) => use.role === 'output' && use.binding)
    .map((use) => use.binding!)
    .sort((left, right) => compareCodeUnits(bindingLabel('output', left), bindingLabel('output', right)));
  for (const binding of outputBindings) {
    const outcome = input.probes.get(probeKey(probeItemFor(binding, 'output')));
    const schema = asSchema(outcome);
    if (schema) {
      return {
        source: moduleExport(binding),
        json: schema.jsonSchema ?? OPAQUE_JSON_SCHEMA,
        digest: schema.digest,
        ...(schema.description ? { description: schema.description } : {}),
        findings: [],
      };
    }
    if (isContentRejected(outcome)) return rejectedOutput(input.stableKey, `${binding.module}#${binding.export}`, outcome);
  }
  if (entry?.output && input.contractModule) {
    return {
      source: moduleExport({ module: input.contractModule.module, export: 'contract', property: [input.method, 'output'] }),
      json: entry.output.jsonSchema ?? OPAQUE_JSON_SCHEMA,
      digest: entry.output.digest,
      ...(entry.output.description ? { description: entry.output.description } : {}),
      findings: [],
    };
  }
  const resolutionOutput = resolution?.output;
  if (resolutionOutput?.schemaRef) {
    // assessResolution only passes an entry whose references all load.
    const schema = asSchema(input.probes.get(probeKey(probeItemFor(resolutionOutput.schemaRef, 'output'))))!;
    return { source: moduleExport(resolutionOutput.schemaRef), json: schema.jsonSchema ?? OPAQUE_JSON_SCHEMA, digest: schema.digest, findings: [] };
  }
  if (resolutionOutput?.jsonSchema) {
    const json = resolutionOutput.jsonSchema;
    return { source: jsonSource(json), json, digest: jsonSchemaDigest(json), findings: [] };
  }
  if (input.inferredOutput) {
    return { source: jsonSource(input.inferredOutput), json: input.inferredOutput, digest: jsonSchemaDigest(input.inferredOutput), findings: [] };
  }
  return {
    source: jsonSource(OPAQUE_JSON_SCHEMA),
    json: OPAQUE_JSON_SCHEMA,
    digest: OPAQUE_SCHEMA_DIGEST,
    findings: [toolFinding('output-contract-opaque', 'warning', input.stableKey,
      'The response shape could not be determined; the model sees an untyped result.')],
  };
}

interface ResolutionAssessment {
  /** The entry, when it is current and every schema it references loads. */
  usable?: ResolutionEntry;
  /** A human entry written for an earlier interface: the tool needs attention. */
  staleHuman: boolean;
  findings: ToolFinding[];
}

function staleResolutionFinding(subject: string): ToolFinding {
  return toolFinding('contract-stale', 'needs_attention', subject,
    'The handler interface changed after its tool-resolutions.json entry was written.');
}

/**
 * Whether the tool-resolutions.json entry can be used (spec 4.4, 4.6). The
 * interface comes first: a human entry for an older interface makes the tool
 * `contract-stale` whichever tier wins, also without an input schema, so a
 * raised effect never lapses unseen; an agent entry for an older interface is
 * ignored with `enrichment-stale`. Only a current entry is held against the
 * code: one whose input keys lack evidence or drop evidenced parameters, or
 * whose schema reference does not load, carries secret-looking content or is
 * no object, is ignored with `resolution-rejected`. An ignored entry leaves
 * the tool its fallback contract.
 */
function assessResolution(
  input: ResolveEndpointContractInput,
  interfaceDigest: string,
): ResolutionAssessment {
  const resolution = input.resolution;
  if (!resolution) return { staleHuman: false, findings: [] };
  const subject = input.stableKey;
  if (resolution.interfaceDigest !== interfaceDigest) {
    if (resolution.origin === 'human') return { staleHuman: true, findings: [staleResolutionFinding(subject)] };
    return {
      staleHuman: false,
      findings: [toolFinding('enrichment-stale', 'warning', subject,
        'The handler interface changed after an agent described this tool; it uses the contract derived from code until the description is renewed.')],
    };
  }
  const reject = (reason: string): ResolutionAssessment => ({
    staleHuman: false,
    findings: [toolFinding('resolution-rejected', 'warning', subject,
      `The tool-resolutions.json entry was rejected: ${reason}.`)],
  });
  const evidenceProblem = (schema: Record<string, unknown>) => inputEvidenceProblem(schema, {
    pathParams: input.pathParams,
    queryKeys: input.evidence.queryKeys,
    bodyKeys: input.evidence.bodyKeys,
  });
  if (resolution.input?.jsonSchema) {
    const problem = evidenceProblem(resolution.input.jsonSchema);
    if (problem) return reject(problem);
  }
  const references = [['input', resolution.input?.schemaRef], ['output', resolution.output?.schemaRef]] as const;
  for (const [role, ref] of references) {
    if (!ref) continue;
    const outcome = input.probes.get(probeKey(probeItemFor(ref, role)));
    const label = `${ref.module}#${[ref.export, ...ref.property].join('.')}`;
    if (isContentRejected(outcome)) return reject(`the ${role} schema ${label} carries secret-looking content`);
    const schema = asSchema(outcome);
    if (!schema) return reject(`the ${role} schema ${label} could not be loaded (${outcome && !outcome.ok ? outcome.reason : 'not probed'})`);
    if (role === 'input' && schema.jsonSchema && schema.jsonSchema.type !== 'object') {
      return reject(`the input schema ${label} is not an object at its root`);
    }
    if (role === 'input' && schema.jsonSchema) {
      const problem = evidenceProblem(schema.jsonSchema);
      if (problem) return reject(problem);
    }
  }
  return { usable: resolution, staleHuman: false, findings: [] };
}

/** Tiers: 1 native, 2 contract module, 4 tool-resolutions.json, 5 derived, 6 unresolved. */
export function resolveEndpointContract(input: ResolveEndpointContractInput): ResolvedEndpointContract {
  const subject = input.stableKey;
  const { evidence } = input;
  const bound = evidence.schemaUses.filter((use) => use.binding);
  const interfaceDigest = computeInterfaceDigest({
    method: input.method,
    path: input.path,
    pathParams: [...input.pathParams],
    queryParams: [...evidence.queryKeys],
    schemaBindings: bound.map((use) => bindingLabel(use.role, use.binding!)),
    bodyKeys: evidence.bodyKeys === 'opaque' ? 'opaque' : [...evidence.bodyKeys],
    ...(evidence.bodyKeys === 'opaque' && bound.length === 0 && evidence.normalizedText !== undefined
      ? { handlerText: evidence.normalizedText }
      : {}),
  });
  const candidate = input.contractModule?.result;
  const entry = candidate?.ok && candidate.kind === 'contract-entry' ? candidate : undefined;
  const assessment = assessResolution(input, interfaceDigest);
  const resolution = assessment.usable;
  const effect = strongerEffect(entry?.effect, resolution?.effect);
  const prose: ToolProseHints = {
    ...(entry?.description ? { contractDescription: entry.description } : {}),
    ...(entry?.module ? { module: entry.module } : {}),
    ...(entry?.usageHints?.length ? { usageHints: entry.usageHints } : {}),
    ...(entry?.presentation ? { presentation: entry.presentation } : {}),
  };
  const base = {
    interfaceDigest,
    prose,
    ...(entry?.id ? { explicitId: entry.id } : {}),
    ...(effect ? { declaredEffect: effect } : {}),
  };
  // A contract module with secret-looking content or unusable metadata is reported on every path, also when another tier wins.
  const moduleFindings = ((): ToolFinding[] => {
    if (!input.contractModule) return [];
    if (isContentRejected(candidate)) return [probeFailureFinding(subject, input.contractModule.module, candidate)];
    return entry ? invalidMetadataFindings(subject, input.contractModule.module, entry) : [];
  })();
  const sideFindings = [...moduleFindings, ...assessment.findings];
  const withModuleFindings = (findings: ToolFinding[]): ToolFinding[] => [
    ...findings,
    ...sideFindings.filter((extra) => !findings.some((finding) => (
      finding.code === extra.code && finding.message === extra.message
    ))),
  ];
  const unresolved = (findings: ToolFinding[]): ResolvedEndpointContract => ({
    ...base,
    inputSchemaDigest: OPAQUE_SCHEMA_DIGEST,
    outputSchemaDigest: OPAQUE_SCHEMA_DIGEST,
    findings: withModuleFindings(findings),
  });
  const output = chooseOutput(input, entry, resolution);
  const finish = (
    source: ToolContract['source'],
    loadBearing: boolean,
    composed: ComposedInput,
    params: ToolContract['params'],
    extraFindings: ToolFinding[],
    schemaDescription: string | undefined,
    binding?: ContractBinding,
  ): ResolvedEndpointContract => {
    const description = schemaDescription ?? output.description;
    return {
      ...base,
      prose: { ...prose, ...(description ? { schemaDescription: description } : {}) },
      contract: {
        source,
        loadBearing,
        input: composed.json,
        output: output.json,
        params,
        interfaceDigest,
        runtime: { input: composed.source, output: output.source },
        ...(binding ? { binding } : {}),
      },
      inputSchemaDigest: composed.digest,
      outputSchemaDigest: output.digest,
      findings: withModuleFindings([...composed.findings, ...output.findings, ...extraFindings]),
    };
  };
  const roleFor = (): InputRole => (READ_METHODS.has(input.method) ? 'query' : 'body');

  // Tier 1: native schemas, including declared handler wrappers.
  const inputUses = evidence.schemaUses.filter((use) => use.role === 'body' || use.role === 'query' || use.role === 'path');
  const readsRequest = evidence.readsBody || evidence.queryKeys.length > 0;
  const nativeApplies = inputUses.length > 0
    || (evidence.schemaUses.some((use) => use.role === 'unclear') && readsRequest);
  let nativeProblems: ToolFinding[] = [];
  if (nativeApplies) {
    const native = nativeParts(input, inputUses);
    if ('parts' in native) {
      const composed = composeInput(subject, native.parts, input.pathParams);
      if ('source' in composed) {
        return finish('native', true, composed, paramsFrom(input.pathParams, native.parts, evidence), [], native.description);
      }
      nativeProblems = composed.findings;
    } else {
      nativeProblems = native.findings;
    }
  }

  // Tier 2: sibling contract module.
  if (entry && input.contractModule) {
    const part: RolePart = {
      role: roleFor(),
      json: entry.input.jsonSchema,
      source: moduleExport({ module: input.contractModule.module, export: 'contract', property: [input.method, 'input'] }),
      digest: entry.input.digest,
      label: `${input.contractModule.module}#contract.${input.method}.input`,
      wholeInput: true,
    };
    const composed = composeInput(subject, [part], input.pathParams);
    if (!('source' in composed)) return unresolved(composed.findings);
    const extra: ToolFinding[] = [];
    let binding: ContractBinding | undefined;
    if (!input.contractModule.loadBearing) {
      const previous = input.previousContract?.binding;
      if (previous && previous.contractModuleDigest === entry.moduleDigest && previous.interfaceDigest !== interfaceDigest) {
        binding = previous;
        extra.push(toolFinding('contract-stale', 'needs_attention', subject,
          'The handler interface changed after its descriptive contract.ts was written.'));
      } else {
        binding = { interfaceDigest, contractModuleDigest: entry.moduleDigest };
      }
    }
    return finish('contract-module', input.contractModule.loadBearing, composed,
      paramsFrom(input.pathParams, [part], evidence), extra, entry.input.description ?? undefined, binding);
  }
  if (candidate && !candidate.ok && candidate.reason !== 'missing' && !nativeApplies && input.contractModule) {
    return unresolved([probeFailureFinding(subject, input.contractModule.module, candidate)]);
  }

  // Tier 4: tool-resolutions.json entry bound to the interface digest. A stale
  // human input schema is not swapped for a weaker one; without an input
  // schema the code contract stays, and `contract-stale` (a side finding)
  // keeps the tool disabled.
  if (assessment.staleHuman && input.resolution?.input) {
    return unresolved([staleResolutionFinding(subject)]);
  }
  const resolutionInput = resolution?.input;
  if (resolutionInput) {
    let part: RolePart;
    if (resolutionInput.schemaRef) {
      const schema = asSchema(input.probes.get(probeKey(probeItemFor(resolutionInput.schemaRef, 'input'))))!;
      part = {
        role: roleFor(), json: schema.jsonSchema, source: moduleExport(resolutionInput.schemaRef), digest: schema.digest,
        label: bindingLabel(roleFor(), resolutionInput.schemaRef), wholeInput: true,
      };
    } else {
      const json = resolutionInput.jsonSchema!;
      part = {
        role: roleFor(), json, source: jsonSource(json), digest: jsonSchemaDigest(json),
        label: 'the tool-resolutions.json input schema', wholeInput: true,
      };
    }
    const composed = composeInput(subject, [part], input.pathParams);
    if (!('source' in composed)) return unresolved(composed.findings);
    return finish('resolution', false, composed, paramsFrom(input.pathParams, [part], evidence), [], undefined);
  }
  if (nativeApplies) return unresolved(nativeProblems);

  // Tier 5: weak contract derived from path params, query keys and closed body keys.
  if (evidence.bodyKeys !== 'opaque') {
    const bodyKeys = [...evidence.bodyKeys];
    const findings: ToolFinding[] = [];
    if (READ_METHODS.has(input.method) && bodyKeys.length > 0) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `The ${input.method} handler reads body fields, which a ${input.method} tool cannot send.`));
    }
    if (!READ_METHODS.has(input.method) && evidence.queryKeys.length > 0) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `The ${input.method} handler reads query parameters, which a ${input.method} tool sends in the body.`));
    }
    const properties: Record<string, JsonSchemaLike> = {};
    const owners = new Map<string, string>();
    const add = (key: string, role: string, schema: JsonSchemaLike) => {
      const owner = owners.get(key);
      if (owner !== undefined && owner !== role) {
        findings.push(toolFinding('parameter-collision', 'needs_attention', subject,
          `Parameter ${key} is used both as ${owner} and as ${role} parameter.`));
        return;
      }
      owners.set(key, role);
      properties[key] = schema;
    };
    for (const name of input.pathParams) add(name, 'path', { type: 'string' });
    for (const key of evidence.queryKeys) {
      add(key, 'query', evidence.repeatedQueryKeys.includes(key)
        ? { type: 'array', items: { type: 'string' } }
        : { type: 'string' });
    }
    for (const key of bodyKeys) add(key, 'body', {});
    if (findings.length > 0) return unresolved(findings);
    const json: JsonSchemaLike = {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).sort(([left], [right]) => compareCodeUnits(left, right))),
      ...(input.pathParams.length ? { required: [...input.pathParams].sort(compareCodeUnits) } : {}),
      additionalProperties: false,
    };
    return finish('derived', false, { source: jsonSource(json), json, digest: jsonSchemaDigest(json), findings: [] },
      { path: [...input.pathParams], query: [...evidence.queryKeys], body: bodyKeys },
      [toolFinding('contract-derived', 'warning', subject,
        'Only parameter names are known; the endpoint keeps validating its own input.')],
      undefined);
  }

  // Tier 6.
  return unresolved([toolFinding('input-contract-unresolved', 'needs_attention', subject,
    'The input of this endpoint could not be determined from the code.')]);
}
