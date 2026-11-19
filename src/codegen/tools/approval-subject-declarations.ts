/**
 * Server-side approval subjects at generation time: which read tool looks up
 * which entity type (`entityLookup`), how a write tool's approval card is
 * checked (`approvalSubject`), and which non-GET source changes nothing
 * (`lookupEffect`). Where each tool declares them, which declaration wins, and
 * the findings about them. Field names, types and tool names only; written to
 * tool-contracts.json, the generated module and the container artifact, never
 * sent to the Platform.
 *
 * Levels, highest first: tool code (a contract.ts entry) > OpenAPI operation
 * (`x-glirastes-entity-lookup`, `x-glirastes-approval-subject`,
 * `x-glirastes-lookup-effect`, also FastAPI `openapi_extra`) >
 * `.glirastes/tools.json` (`identity.lookups`, `approvalSubjects.tools`). A
 * higher level replaces a lower one for the whole field. An invalid
 * declaration is dropped with a finding; nothing here changes the
 * authorization, approval or enablement of any tool.
 *
 * @module
 */
import {
  approvalPreviewIssue,
  approvalSubjectIssue,
  entityLookupIssue,
  fieldArgsOf,
  lookupEffectAllowed,
  MAX_ENTITY_LOOKUPS,
  type ApprovalPreviewDeclaration,
  type ApprovalSubjectDeclaration,
  type ApprovalSubjectOption,
  type EntityLookup,
  type LookupEffect,
} from '../../contracts/approval-subject.js';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import {
  ENTITY_TYPE_PATTERN,
  entityIdFields,
  inputRefArgs,
  type InputEntityRef,
  type OutputEntityDeclaration,
} from '../../contracts/entity-declaration.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { outputFieldDenial } from './entity-declarations.js';
import { toolFinding } from './findings.js';
import type { ToolContract, ToolFinding } from './types.js';

export const ENTITY_LOOKUP_EXTENSION = 'x-glirastes-entity-lookup';
export const APPROVAL_SUBJECT_EXTENSION = 'x-glirastes-approval-subject';
export const LOOKUP_EFFECT_EXTENSION = 'x-glirastes-lookup-effect';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================================
// Declarations of one level
// ============================================================================

/** The approval-subject declarations of one tool, valid ones only. */
export interface ApprovalDeclarations {
  /** Always a list (one object is read as a list of one). */
  entityLookup?: EntityLookup[];
  approvalSubject?: ApprovalSubjectOption;
  lookupEffect?: LookupEffect;
}

/** The declarations one level (tool code, OpenAPI operation) read, and what was wrong with the others. */
export interface ObservedApprovalLevel extends ApprovalDeclarations {
  /** The contract module or `METHOD /path in <document>`. */
  where: string;
  /** Issues in words without values (`x-glirastes-entity-lookup[1] has no type …`); reported by the resolver. */
  issues?: string[];
}

/** By level, as a source observed them. */
export interface ObservedApprovalDeclarations {
  code?: ObservedApprovalLevel;
  operation?: ObservedApprovalLevel;
}

export interface ApprovalFieldNames {
  entityLookup: string;
  approvalSubject: string;
  lookupEffect: string;
}

export const CODE_FIELD_NAMES: ApprovalFieldNames = {
  entityLookup: 'entityLookup',
  approvalSubject: 'approvalSubject',
  lookupEffect: 'lookupEffect',
};

export const OPENAPI_FIELD_NAMES: ApprovalFieldNames = {
  entityLookup: ENTITY_LOOKUP_EXTENSION,
  approvalSubject: APPROVAL_SUBJECT_EXTENSION,
  lookupEffect: LOOKUP_EFFECT_EXTENSION,
};

const SECRET_ISSUE = 'looks like it holds a secret';

/** The lookups of an `entityLookup` value: valid entries, and an issue per invalid one. */
function readLookups(value: unknown, name: string): { lookups?: EntityLookup[]; issues: string[] } {
  const list = Array.isArray(value) ? value : [value];
  if (!Array.isArray(value) && !isObject(value)) {
    return { issues: [`${name} that is neither one lookup nor a list`] };
  }
  if (list.length === 0 || list.length > MAX_ENTITY_LOOKUPS) {
    return { issues: [`${name} that is not one lookup or a list of 1 to ${MAX_ENTITY_LOOKUPS}`] };
  }
  const lookups: EntityLookup[] = [];
  const issues: string[] = [];
  const types = new Set<string>();
  list.forEach((entry, index) => {
    const label = Array.isArray(value) ? `${name}[${index}]` : name;
    const issue = entityLookupIssue(entry) ?? (findSensitiveStringPath(entry) ? SECRET_ISSUE : undefined);
    if (issue) {
      issues.push(`${label} that ${issue}`);
      return;
    }
    const lookup = entry as EntityLookup;
    if (types.has(lookup.type)) {
      issues.push(`${label} that looks up the type ${lookup.type} a second time`);
      return;
    }
    types.add(lookup.type);
    lookups.push(lookup);
  });
  return { ...(lookups.length > 0 ? { lookups } : {}), issues };
}

/**
 * Reads the three declarations of one level (raw values of contract.ts or
 * an OpenAPI operation): the valid ones, and an issue per invalid one (in
 * words without its values). Pure; never throws.
 */
export function readApprovalDeclarations(
  raw: { entityLookup?: unknown; approvalSubject?: unknown; lookupEffect?: unknown },
  names: ApprovalFieldNames,
): { declarations: ApprovalDeclarations; issues: string[] } {
  const declarations: ApprovalDeclarations = {};
  const issues: string[] = [];
  if (raw.entityLookup !== undefined) {
    const read = readLookups(raw.entityLookup, names.entityLookup);
    issues.push(...read.issues);
    if (read.lookups) declarations.entityLookup = read.lookups;
  }
  if (raw.approvalSubject !== undefined) {
    const issue = approvalSubjectIssue(raw.approvalSubject)
      ?? (findSensitiveStringPath(raw.approvalSubject) ? SECRET_ISSUE : undefined);
    if (issue) issues.push(`${names.approvalSubject} that ${issue}`);
    else declarations.approvalSubject = raw.approvalSubject as ApprovalSubjectOption;
  }
  if (raw.lookupEffect !== undefined) {
    if (raw.lookupEffect === 'read') declarations.lookupEffect = 'read';
    else issues.push(`${names.lookupEffect} that is not the string read`);
  }
  return { declarations, issues };
}

/** The observed level of a source, or undefined when it declares nothing at all. */
export function approvalLevelOf(
  raw: { entityLookup?: unknown; approvalSubject?: unknown; lookupEffect?: unknown },
  names: ApprovalFieldNames,
  where: string,
): ObservedApprovalLevel | undefined {
  if (raw.entityLookup === undefined && raw.approvalSubject === undefined && raw.lookupEffect === undefined) return undefined;
  const { declarations, issues } = readApprovalDeclarations(raw, names);
  return { where, ...declarations, ...(issues.length > 0 ? { issues } : {}) };
}

// ============================================================================
// tools.json
// ============================================================================

/** `.glirastes/tools.json` `identity.lookups`, as the config schema keeps it (entries checked here). */
export type ToolsLookupsConfig = Record<string, unknown>;
/** `.glirastes/tools.json` `approvalSubjects`. */
export interface ToolsApprovalSubjectsConfig {
  tools?: Record<string, unknown>;
}

// ============================================================================
// Resolution
// ============================================================================

export interface ApprovalResolutionTool {
  stableKey: string;
  definitionId: string;
  modelName: string;
  method?: string;
  path?: string;
  params?: ToolContract['params'];
  /** Whether the tool asks for approval when the model calls it (the effective policy). */
  requiresApproval: boolean;
  declarations?: ObservedApprovalDeclarations;
  /** The resolved entity declarations of the tool. */
  outputEntities?: ReadonlyArray<OutputEntityDeclaration>;
  inputEntities?: ReadonlyArray<InputEntityRef>;
  outputAllowedFields?: ReadonlyArray<string>;
  outputDeniedFields?: ReadonlyArray<string>;
}

type Level = 'code' | 'operation' | 'app';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

function isReadMethod(method: string | undefined): boolean {
  return method !== undefined && READ_METHODS.has(method);
}

/** Why a tool is no lookup or preview source; undefined when it provably changes nothing. */
function notReadOnly(tool: ApprovalResolutionTool, effect: LookupEffect | undefined): string | undefined {
  if (effect === 'read' && lookupEffectAllowed(tool.method)) return undefined;
  if (!isReadMethod(tool.method)) {
    return `is a ${tool.method ?? 'non-GET'} tool without lookupEffect: 'read' (${LOOKUP_EFFECT_EXTENSION}: read)`;
  }
  if (tool.requiresApproval) return `requires approval, so it is not provably read-only without lookupEffect: 'read'`;
  return undefined;
}

function paramNames(params: ToolContract['params'] | undefined): Set<string> | undefined {
  if (!params || params.body === 'opaque') return undefined;
  return new Set([...params.path, ...params.query, ...params.body]);
}

/** The lookups' result kind: explicit, else `list` when the entity's declared path reads entries. */
function lookupResult(lookup: EntityLookup, declaration: OutputEntityDeclaration): 'one' | 'list' {
  return lookup.result ?? (lookup.complete === true || declaration.path?.includes('[]') ? 'list' : 'one');
}

/**
 * Resolves the approval-subject declarations of every endpoint tool:
 * levels, precedence, the tools.json entries, and the checks against the
 * resolved entity declarations of the source and write tools. Pure and
 * deterministic (tools in code-unit order of their definition id).
 */
export function resolveApprovalSubjects(input: {
  tools: ReadonlyArray<ApprovalResolutionTool>;
  lookups?: ToolsLookupsConfig;
  approvalSubjects?: ToolsApprovalSubjectsConfig;
}): { byKey: Map<string, ApprovalDeclarations>; findings: ToolFinding[] } {
  const findings: ToolFinding[] = [];
  const config = TOOLS_PATHS.config;
  const tools = [...input.tools].sort((left, right) => compareCodeUnits(left.definitionId, right.definitionId));
  const byName = new Map<string, ApprovalResolutionTool>();
  for (const tool of tools) {
    byName.set(tool.definitionId, tool);
    if (!byName.has(tool.modelName)) byName.set(tool.modelName, tool);
  }
  const invalid = (subject: string, message: string) => findings.push(toolFinding('approval-subject-invalid', 'error', subject, message));
  const unused = (subject: string, message: string) => findings.push(toolFinding('approval-subject-unused', 'warning', subject, message));

  // tools.json identity.lookups: `<type>: { tool, params, const?, result?, complete? }`.
  const appLookups = new Map<string, Array<{ key: string; lookup: EntityLookup }>>();
  for (const [type, raw] of Object.entries(input.lookups ?? {}).sort(([a], [b]) => compareCodeUnits(a, b))) {
    const label = `${config} identity.lookups.${type.slice(0, 64)}`;
    if (!ENTITY_TYPE_PATTERN.test(type)) {
      invalid(config, `${label} is no lower-case type name; it is ignored.`);
      continue;
    }
    if (!isObject(raw)) {
      invalid(config, `${label} is not an object { tool, params, const?, result?, complete? }; it is ignored.`);
      continue;
    }
    if (raw.type !== undefined) {
      invalid(config, `${label} names a type inside the entry (the key is the type); it is ignored.`);
      continue;
    }
    if (typeof raw.tool !== 'string' || raw.tool === '' || raw.tool.length > 200) {
      invalid(config, `${label} has no tool: the definition id or model name of the read tool; it is ignored.`);
      continue;
    }
    const { tool: toolName, ...rest } = raw;
    const lookup = { type, ...rest };
    const issue = entityLookupIssue(lookup) ?? (findSensitiveStringPath(lookup) ? SECRET_ISSUE : undefined);
    if (issue) {
      invalid(config, `${label} ${issue}; it is ignored.`);
      continue;
    }
    const target = byName.get(toolName);
    if (!target) {
      unused(config, `${label} names no generated endpoint tool.`);
      continue;
    }
    const list = appLookups.get(target.stableKey) ?? [];
    list.push({ key: label, lookup: lookup as EntityLookup });
    appLookups.set(target.stableKey, list);
  }

  // tools.json approvalSubjects.tools: `<tool>: ApprovalSubjectDeclaration | false`.
  const appSubjects = new Map<string, ApprovalSubjectOption>();
  const appSubjectTools = input.approvalSubjects?.tools ?? {};
  for (const key of Object.keys(appSubjectTools).sort(compareCodeUnits)) {
    const label = `${config} approvalSubjects.tools.${key.slice(0, 200)}`;
    const raw = appSubjectTools[key];
    const issue = approvalSubjectIssue(raw) ?? (findSensitiveStringPath(raw) ? SECRET_ISSUE : undefined);
    if (issue) {
      invalid(config, `${label} ${issue}; it is ignored.`);
      continue;
    }
    const target = byName.get(key);
    if (!target) {
      unused(config, `${label} names no generated endpoint tool.`);
      continue;
    }
    if (appSubjects.has(target.stableKey)) {
      unused(config, `${label} names a tool another entry already configures (by its definition id or model name); it is ignored.`);
      continue;
    }
    appSubjects.set(target.stableKey, raw as ApprovalSubjectOption);
  }

  // Pass 1: the chosen declaration of each field, the highest valid level.
  const chosen = new Map<string, ApprovalDeclarations>();
  for (const tool of tools) {
    const observed = tool.declarations ?? {};
    for (const level of [observed.code, observed.operation]) {
      for (const issue of level?.issues ?? []) {
        invalid(tool.stableKey, `${level!.where} declares an ${issue}; it is ignored, the tool stays enabled.`);
      }
    }
    const app = appLookups.get(tool.stableKey);
    const levelLookups: Array<[Level, EntityLookup[] | undefined]> = [
      ['code', observed.code?.entityLookup],
      ['operation', observed.operation?.entityLookup],
      ['app', app?.map((entry) => entry.lookup)],
    ];
    const lookupLevel = levelLookups.find(([, list]) => list !== undefined);
    if (app && lookupLevel && lookupLevel[0] !== 'app') {
      for (const entry of app) {
        unused(config, `${entry.key} is replaced by the entityLookup ${lookupLevel[0] === 'code' ? 'the tool code' : 'the OpenAPI operation'} of ${tool.definitionId} declares.`);
      }
    }
    const appSubject = appSubjects.get(tool.stableKey);
    const subject = observed.code?.approvalSubject ?? observed.operation?.approvalSubject ?? appSubject;
    const effect = observed.code?.lookupEffect ?? observed.operation?.lookupEffect;
    chosen.set(tool.stableKey, {
      ...(lookupLevel?.[1] ? { entityLookup: lookupLevel[1].slice(0, MAX_ENTITY_LOOKUPS) } : {}),
      ...(subject !== undefined ? { approvalSubject: subject } : {}),
      ...(effect ? { lookupEffect: effect } : {}),
    });
  }

  // lookupEffect stands only on a POST (or GET/HEAD): on a DELETE, PUT or PATCH it is refused, never written.
  for (const tool of tools) {
    const declared = chosen.get(tool.stableKey)!;
    if (declared.lookupEffect && !lookupEffectAllowed(tool.method)) {
      invalid(tool.stableKey, `The tool declares lookupEffect: 'read' on ${tool.method}; only a POST (a dry-run) can state it, so it is dropped and the tool is no lookup source.`);
      delete declared.lookupEffect;
    }
  }

  // Pass 2: lookups against their source tool.
  const lookupTypes = new Set<string>();
  const lookupIds = new Map<string, string[][]>();
  for (const tool of tools) {
    const declared = chosen.get(tool.stableKey)!;
    if (!declared.entityLookup) continue;
    const subject = tool.stableKey;
    const blocked = notReadOnly(tool, declared.lookupEffect);
    if (blocked) {
      invalid(subject, `The tool declares an entityLookup but ${blocked}; the lookups are dropped, the tool stays enabled.`);
      delete declared.entityLookup;
      continue;
    }
    const names = paramNames(tool.params);
    const kept: EntityLookup[] = [];
    for (const lookup of declared.entityLookup) {
      const at = `The entityLookup of type ${lookup.type}`;
      const declaration = (tool.outputEntities ?? []).find((entry) => entry.type === lookup.type);
      if (!declaration) {
        invalid(subject, `${at} names a type the tool's outputEntities do not declare, so its answer cannot be read; the lookup is dropped.`);
        continue;
      }
      const ids = entityIdFields(declaration);
      const notId = Object.values(lookup.params).filter((source): source is string => typeof source === 'string' && !ids.includes(source));
      if (notId.length > 0) {
        invalid(subject, `${at} maps a parameter to ${notId.join(', ')}, which is no id field of the declared entity (${ids.join(', ')}); the lookup is dropped.`);
        continue;
      }
      const missing = names
        ? [...Object.keys(lookup.params), ...Object.keys(lookup.const ?? {})].filter((name) => !names.has(name.split('.')[0]!))
        : [];
      if (missing.length > 0) {
        invalid(subject, `${at} fills ${missing.join(', ')}, which the tool has no parameter for; the lookup is dropped.`);
        continue;
      }
      if (lookupResult(lookup, declaration) === 'list' && Object.keys(lookup.params).length === 0
        && lookup.complete !== true && Object.keys(lookup.const ?? {}).length === 0) {
        findings.push(toolFinding('approval-subject-unbounded-list', 'warning', subject,
          `${at} searches one page of a list without parameters, page size or complete: true; a record beyond that page is "not checkable".`));
      }
      kept.push(lookup);
      lookupTypes.add(lookup.type);
      lookupIds.set(lookup.type, [...(lookupIds.get(lookup.type) ?? []), ids]);
    }
    if (kept.length > 0) declared.entityLookup = kept;
    else delete declared.entityLookup;
  }

  // Pass 3: approval subjects of the write tools; types the write tools reference.
  const referenced = new Set<string>();
  for (const tool of tools) {
    const isWrite = !isReadMethod(tool.method) || tool.requiresApproval;
    if (isWrite) for (const ref of tool.inputEntities ?? []) referenced.add(ref.type);
    const declared = chosen.get(tool.stableKey)!;
    // A composite key whose arguments cannot be mapped to the source's id fields by name is never guessed by position.
    if (isWrite && declared.approvalSubject !== false) {
      for (const ref of tool.inputEntities ?? []) {
        const args = inputRefArgs(ref);
        const sources = (lookupIds.get(ref.type) ?? []).filter((ids) => ids.length === args.length);
        if (sources.length > 0 && !sources.some((ids) => fieldArgsOf(args, ids) !== undefined)) {
          invalid(tool.stableKey, `The reference ${args.join(',')} of type ${ref.type} names its key parts other than the id fields `
            + `${sources[0]!.join(', ')} of its lookup, so they cannot be matched by name; the server does not look it up ("not checkable"). `
            + 'Name the arguments like the id fields.');
        }
      }
    }
    const option = declared.approvalSubject;
    if (option === undefined || option === false) continue;
    const subject = tool.stableKey;
    const refArgs = new Set((tool.inputEntities ?? []).map((ref) => inputRefArgs(ref).join(',')));
    const unknownRefs = (option.refs ?? []).filter((ref) => !refArgs.has(ref));
    if (unknownRefs.length > 0) {
      // Never dropped silently, never fail-open: a blocking error, and the declaration stays in force as `block`.
      findings.push(toolFinding('approval-subject-refs-unmatched', 'error', subject,
        `The approvalSubject names the refs ${unknownRefs.join(', ')}, which no inputEntities of the tool declare. `
        + 'Until it is fixed the tool keeps its declaration without them and refuses a call it cannot check (onUnavailable: block).'));
      declared.approvalSubject = { ...option, refs: option.refs!.filter((ref) => refArgs.has(ref)), onUnavailable: 'block' };
      continue;
    }
    if (!option.preview) continue;
    const preview = checkPreview(tool, option.preview, byName, chosen, findings);
    if (preview === option.preview) continue;
    const { preview: _dropped, ...rest } = option;
    declared.approvalSubject = preview ? { ...rest, preview } : rest as ApprovalSubjectDeclaration;
  }

  for (const tool of tools) {
    for (const lookup of chosen.get(tool.stableKey)!.entityLookup ?? []) {
      if (!referenced.has(lookup.type)) {
        unused(tool.stableKey, `The entityLookup of type ${lookup.type} is used by no approval card: no write tool's inputEntities name that type.`);
      }
    }
  }

  // Suggestions: a write route and a read route with the same path template, never applied.
  for (const tool of tools) {
    if (isReadMethod(tool.method) || chosen.get(tool.stableKey)!.approvalSubject === false) continue;
    const suggested = new Set<string>();
    for (const ref of tool.inputEntities ?? []) {
      if ((ref.role ?? 'target') === 'reference' || lookupTypes.has(ref.type) || suggested.has(ref.type)) continue;
      const source = tools.find((candidate) => candidate.method === 'GET' && !candidate.requiresApproval && candidate.path === tool.path
        && (candidate.outputEntities ?? []).some((entry) => entry.type === ref.type));
      if (!source) continue;
      const declaration = source.outputEntities!.find((entry) => entry.type === ref.type)!;
      const ids = entityIdFields(declaration);
      const pathParams = source.params?.path ?? [];
      if (!ids.every((field) => pathParams.includes(field))) continue;
      suggested.add(ref.type);
      const snippet = JSON.stringify({ type: ref.type, params: Object.fromEntries(ids.map((field) => [field, field])) });
      findings.push(toolFinding('approval-subject-suggested', 'warning', tool.stableKey,
        `No tool looks up the ${ref.type} this tool names, so its approval card is not checked by the server. `
        + `${source.stableKey} returns it: declare on that operation ${ENTITY_LOOKUP_EXTENSION}: ${snippet} `
        + `(entityLookup in contract.ts, or identity.lookups.${ref.type} in ${config}).`));
    }
  }

  const byKey = new Map<string, ApprovalDeclarations>();
  for (const tool of tools) {
    const declared = chosen.get(tool.stableKey)!;
    if (declared.entityLookup || declared.approvalSubject !== undefined || declared.lookupEffect) byKey.set(tool.stableKey, declared);
  }
  return { byKey, findings };
}

/** The preview as it may be used (fields that the source denies dropped), or undefined when it is dropped. */
function checkPreview(
  tool: ApprovalResolutionTool,
  preview: ApprovalPreviewDeclaration,
  byName: ReadonlyMap<string, ApprovalResolutionTool>,
  chosen: ReadonlyMap<string, ApprovalDeclarations>,
  findings: ToolFinding[],
): ApprovalPreviewDeclaration | undefined {
  const subject = tool.stableKey;
  const drop = (reason: string): undefined => {
    findings.push(toolFinding('approval-subject-invalid', 'error', subject,
      `The approvalSubject preview ${reason}; the preview is dropped, the tool stays enabled.`));
    return undefined;
  };
  const source = byName.get(preview.tool);
  if (!source) return drop(`names ${preview.tool.slice(0, 200)}, which is no generated endpoint tool`);
  const blocked = notReadOnly(source, chosen.get(source.stableKey)?.lookupEffect);
  if (blocked) return drop(`source ${source.definitionId} ${blocked}`);
  const sourceNames = paramNames(source.params);
  const missing = sourceNames ? Object.keys(preview.params).filter((name) => !sourceNames.has(name.split('.')[0]!)) : [];
  if (missing.length > 0) return drop(`fills ${missing.join(', ')}, which ${source.definitionId} has no parameter for`);
  const ownNames = paramNames(tool.params);
  const unknownArgs = ownNames
    ? Object.values(preview.params).filter((value): value is string => typeof value === 'string' && !ownNames.has(value.split('.')[0]!))
    : [];
  if (unknownArgs.length > 0) return drop(`reads ${unknownArgs.join(', ')}, which is no parameter of this tool`);
  // A denied field or ancestor hides it; the allow-list is checked at the full path only (`impact.devices` allows it).
  const isDeniedStep = outputFieldDenial({ ...(source.outputDeniedFields ? { outputDeniedFields: source.outputDeniedFields } : {}) });
  const isOutsideAllowed = outputFieldDenial({ ...(source.outputAllowedFields ? { outputAllowedFields: source.outputAllowedFields } : {}) });
  const fields = preview.fields.filter((field) => {
    const parts = field.path.split('.');
    const parent = (index: number) => (index === 0 ? '' : parts.slice(0, index).join('.'));
    const denied = parts.some((part, index) => isDeniedStep(parent(index), part))
      || isOutsideAllowed(parent(parts.length - 1), parts.at(-1)!);
    if (denied) {
      findings.push(toolFinding('approval-subject-field-denied', 'warning', subject,
        `The approvalSubject preview shows ${field.path}, which the output fields of ${source.definitionId} deny; the field is dropped.`));
    }
    return !denied;
  });
  if (fields.length === 0) {
    findings.push(toolFinding('approval-subject-field-denied', 'warning', subject,
      'The approvalSubject preview has no field left that its source may show; the preview is dropped.'));
    return undefined;
  }
  if (fields.length === preview.fields.length) return preview;
  const reduced = { ...preview, fields };
  return approvalPreviewIssue(reduced) === undefined ? reduced : undefined;
}
