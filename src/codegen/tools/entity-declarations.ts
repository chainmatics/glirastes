/**
 * Declared object identity of the generated endpoint tools, at generation
 * time: where each tool declares its entities, which declaration wins, and
 * the findings about them. Field names and types only; written to
 * tool-contracts.json and the generated module, never sent to the Platform.
 *
 * Levels, highest first: tool code (`outputEntities` / `inputEntities` of a
 * contract.ts entry) > OpenAPI operation (`x-glirastes-entities`,
 * `x-glirastes-entity-ref` on a parameter) > OpenAPI schema
 * (`x-glirastes-entity` on a response schema) > `.glirastes/tools.json`
 * `identity` > nothing (the runtime guesses from field names). A higher
 * level replaces a lower one for the same result path (or argument list).
 * Nothing here disables a tool.
 *
 * @module
 */
import {
  ENTITY_TYPE_PATTERN,
  entityDeclarationIssue,
  entityIdFields,
  inputEntityRefIssue,
  inputRefArgs,
  MAX_TOOL_ENTITIES,
  parseEntityPath,
  type EntityDeclaration,
  type EntityPathStep,
  type InputEntityRef,
  type OutputEntityDeclaration,
} from '../../contracts/entity-declaration.js';
import { anyDepthKeys, outputFieldCovers, outputFieldTree, type OutputFieldStep } from '../../server/core/output-fields.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { JsonSchemaLike, ToolContract, ToolFinding } from './types.js';

export const ENTITY_EXTENSION = 'x-glirastes-entity';
export const ENTITIES_EXTENSION = 'x-glirastes-entities';
export const ENTITY_REF_EXTENSION = 'x-glirastes-entity-ref';
export const ID_KIND_EXTENSION = 'x-glirastes-id-kind';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================================
// Schema sites
// ============================================================================

/** An object schema a result can hold, at a result path as the model sees it. */
export interface EntitySite {
  /** `''` for the result itself, `playlists[]`, `data[]`, `playlists[].items[]`. */
  path: string;
  /** Its property names; undefined when the schema is open (other properties possible). */
  fields?: string[];
  /** The type its component name (or `title`) derives (`PlaylistVersion` → `playlist-version`). */
  type?: string;
  /** The raw `x-glirastes-entity` of the schema, when it has one. */
  extension?: unknown;
}

const MAX_SITE_DEPTH = 6;
const MAX_SITES = 200;

/** `PlaylistVersion`, `playlist_version` → `playlist-version`; undefined when it is no type name. */
export function entityTypeOfName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const type = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
  return ENTITY_TYPE_PATTERN.test(type) ? type : undefined;
}

function pathText(steps: ReadonlyArray<EntityPathStep>): string {
  return steps.map((step) => `${step.key}${step.each ? '[]' : ''}`).join('.');
}

function typesOf(schema: JsonObject): string[] {
  if (typeof schema.type === 'string') return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === 'string') : [];
}

/**
 * The object schemas of a response, by result path. `resolveRef` follows a
 * local `$ref` (and names its component); without it a `$ref` ends the walk.
 * A list or scalar response travels under `data`.
 */
/**
 * The entity observation of a code-defined tool (Next.js, NestJS): its
 * `contract.ts` declarations and the object sites of its output schema;
 * nothing when it has neither.
 */
export function entitiesOf(
  code: ObservedEntities['code'] | undefined,
  output: unknown,
): { entities?: ObservedEntities } {
  const sites = entitySitesOf(output);
  return code || sites.length > 0 ? { entities: { ...(code ? { code } : {}), ...(sites.length > 0 ? { sites } : {}) } } : {};
}

export function entitySitesOf(
  output: unknown,
  resolveRef?: (ref: string) => { schema: unknown; name: string } | undefined,
): EntitySite[] {
  const sites = new Map<string, EntitySite>();
  const visit = (node: unknown, steps: EntityPathStep[], depth: number, stack: ReadonlyArray<string>, component?: string): void => {
    if (!isObject(node) || depth > MAX_SITE_DEPTH || sites.size >= MAX_SITES) return;
    if (typeof node.$ref === 'string') {
      if (!resolveRef || stack.includes(node.$ref)) return;
      const target = resolveRef(node.$ref);
      if (!target) return;
      const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
      visit({ ...(isObject(target.schema) ? target.schema : {}), ...siblings }, steps, depth, [...stack, node.$ref], target.name);
      return;
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch, steps, depth + 1, stack, component);
    }
    const types = typesOf(node);
    const items = node.items;
    if (isObject(items) || types.includes('array')) {
      if (steps.length === 0) visit(items, [{ key: 'data', each: true }], depth + 1, stack);
      else visit(items, [...steps.slice(0, -1), { key: steps.at(-1)!.key, each: true }], depth + 1, stack);
      return;
    }
    const properties = isObject(node.properties) ? node.properties : undefined;
    if (!properties && !types.includes('object')) return;
    const path = pathText(steps);
    const open = (node.additionalProperties !== undefined && node.additionalProperties !== false)
      || node.patternProperties !== undefined || !properties;
    const known = sites.get(path);
    const fields = open ? undefined : Object.keys(properties!);
    const type = entityTypeOfName(component ?? (typeof node.title === 'string' ? node.title : undefined));
    if (!known) {
      sites.set(path, {
        path,
        ...(fields ? { fields } : {}),
        ...(type ? { type } : {}),
        ...(node[ENTITY_EXTENSION] !== undefined ? { extension: node[ENTITY_EXTENSION] } : {}),
      });
    } else {
      // A union or allOf reaches one path twice: its fields together, open when either is.
      known.fields = known.fields && fields ? [...new Set([...known.fields, ...fields])] : undefined;
      if (!known.type && type) known.type = type;
      if (known.extension === undefined && node[ENTITY_EXTENSION] !== undefined) known.extension = node[ENTITY_EXTENSION];
    }
    for (const [key, child] of Object.entries(properties ?? {})) {
      if (!/^[A-Za-z_$][\w$-]{0,63}$/.test(key)) continue;
      visit(child, [...steps, { key, each: false }], depth + 1, stack);
    }
  };
  visit(output, [], 0, []);
  return [...sites.values()];
}

// ============================================================================
// What a source observed
// ============================================================================

/** The declarations a source read for one tool, by level (already validated: invalid ones are findings). */
export interface ObservedEntities {
  /** contract.ts entry: tool code. */
  code?: { where: string; output?: OutputEntityDeclaration[]; input?: InputEntityRef[] };
  /** OpenAPI operation. */
  operation?: { where: string; output?: OutputEntityDeclaration[]; input?: InputEntityRef[] };
  /** `x-glirastes-entity` of the response schemas, each at its path. */
  schema?: { where: string; output: OutputEntityDeclaration[] };
  /** The response's object schemas, for `entity-field-unknown` and tools.json `identity.entities`. */
  sites?: EntitySite[];
}

/**
 * The schema-level declarations of a response: each site with a valid
 * `x-glirastes-entity` (without `path`), at the site's path, typed by the
 * extension or else by the component name. Invalid ones become findings.
 */
export function schemaEntityDeclarations(
  sites: ReadonlyArray<EntitySite>,
  subject: string,
  where: string,
): { output: OutputEntityDeclaration[]; findings: ToolFinding[] } {
  const output: OutputEntityDeclaration[] = [];
  const findings: ToolFinding[] = [];
  for (const site of sites) {
    if (site.extension === undefined) continue;
    const issue = entityDeclarationIssue(site.extension);
    const type = isObject(site.extension) && typeof site.extension.type === 'string' ? site.extension.type : site.type;
    if (issue || !type) {
      findings.push(toolFinding('entity-declaration-invalid', 'warning', subject,
        `${where} declares an ${ENTITY_EXTENSION} at ${site.path || 'the result'} that ${issue ?? 'has no type and no component name to derive one from'}; it is ignored.`));
      continue;
    }
    output.push({ ...(site.extension as EntityDeclaration), type, path: site.path });
  }
  return { output, findings };
}

/** `x-glirastes-entities` of an operation: the valid entries; each invalid one is a finding. */
export function operationEntityDeclarations(
  value: unknown,
  subject: string,
  where: string,
): { output?: OutputEntityDeclaration[]; findings: ToolFinding[] } {
  if (value === undefined) return { findings: [] };
  if (!Array.isArray(value) || value.length > MAX_TOOL_ENTITIES) {
    return {
      findings: [toolFinding('entity-declaration-invalid', 'warning', subject,
        `${where} declares an ${ENTITIES_EXTENSION} that is not a list of at most ${MAX_TOOL_ENTITIES} declarations; it is ignored.`)],
    };
  }
  const output: OutputEntityDeclaration[] = [];
  const findings: ToolFinding[] = [];
  value.forEach((entry, index) => {
    const issue = entityDeclarationIssue(entry, { output: true });
    if (issue) {
      findings.push(toolFinding('entity-declaration-invalid', 'warning', subject,
        `${where} ${ENTITIES_EXTENSION}[${index}] ${issue}; it is ignored.`));
    } else {
      output.push(entry as OutputEntityDeclaration);
    }
  });
  return { ...(output.length > 0 ? { output } : {}), findings };
}

/**
 * The input reference of one parameter (or body property): its
 * `x-glirastes-entity-ref` (`{ type, role?, idKind? }`) on the parameter or
 * its schema, with `x-glirastes-id-kind` as the id kind when the reference
 * names none. Undefined without a reference; invalid values are findings.
 */
export function parameterEntityRef(
  name: string,
  carriers: ReadonlyArray<unknown>,
  subject: string,
  where: string,
): { ref?: InputEntityRef; findings: ToolFinding[] } {
  const findings: ToolFinding[] = [];
  let raw: unknown;
  let idKind: unknown;
  for (const carrier of carriers) {
    if (!isObject(carrier)) continue;
    raw ??= carrier[ENTITY_REF_EXTENSION];
    idKind ??= carrier[ID_KIND_EXTENSION];
  }
  if (idKind !== undefined && idKind !== 'opaque' && idKind !== 'speaking') {
    findings.push(toolFinding('entity-ref-invalid', 'warning', subject,
      `${where} parameter ${name} declares an ${ID_KIND_EXTENSION} that is neither opaque nor speaking; it is ignored.`));
    idKind = undefined;
  }
  if (raw === undefined) return { findings };
  const candidate = isObject(raw)
    ? { ...raw, args: name, ...(raw.idKind === undefined && idKind !== undefined ? { idKind } : {}) }
    : raw;
  const issue = isObject(raw) && raw.args !== undefined ? 'has args, which the parameter itself gives' : inputEntityRefIssue(candidate);
  if (issue) {
    findings.push(toolFinding('entity-ref-invalid', 'warning', subject,
      `${where} parameter ${name} declares an ${ENTITY_REF_EXTENSION} that ${issue}; it is ignored.`));
    return { findings };
  }
  return { ref: candidate as InputEntityRef, findings };
}

// ============================================================================
// tools.json `identity`
// ============================================================================

/** `.glirastes/tools.json` `identity`, as the config schema keeps it (entries checked here). */
export interface ToolsIdentityConfig {
  /** App-wide declarations by type, without `type` and `path`. */
  entities?: Record<string, unknown>;
  /** Per tool (definition id `playlists.list` or model name `playlists_list`). */
  tools?: Record<string, { output?: unknown[]; input?: unknown[] }>;
}

// ============================================================================
// Resolution
// ============================================================================

export interface EntityResolutionTool {
  stableKey: string;
  definitionId: string;
  modelName: string;
  method?: string;
  path?: string;
  params?: ToolContract['params'];
  entities?: ObservedEntities;
  outputAllowedFields?: ReadonlyArray<string>;
  outputDeniedFields?: ReadonlyArray<string>;
}

export interface ResolvedToolEntities {
  outputEntities?: OutputEntityDeclaration[];
  inputEntities?: InputEntityRef[];
}

type Level = 'code' | 'operation' | 'schema' | 'app';
const LEVEL_NAMES: Readonly<Record<Level, string>> = {
  code: 'the tool code (contract.ts)',
  operation: 'the OpenAPI operation',
  schema: `the response schema (${ENTITY_EXTENSION})`,
  app: `${TOOLS_PATHS.config} identity`,
};

const SINGULAR_RULES: ReadonlyArray<[RegExp, string]> = [[/ies$/, 'y'], [/(ss|x|ch|sh)es$/, '$1'], [/([^s])s$/, '$1']];

/** The type a route names: its last static segment, singular (`/api/playlists/:id/versions` → `version`). */
export function routeEntityType(path: string | undefined): string | undefined {
  const segment = path?.split('/').filter((part) => part && !part.startsWith(':') && !part.startsWith('{')).at(-1);
  if (!segment) return undefined;
  let word = segment;
  for (const [pattern, replacement] of SINGULAR_RULES) {
    if (pattern.test(word)) {
      word = word.replace(pattern, replacement);
      break;
    }
  }
  return entityTypeOfName(word);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => (isObject(child)
    ? Object.fromEntries(Object.keys(child).sort(compareCodeUnits).map((key) => [key, child[key]]))
    : child));
}

function fieldSteps(path: string | undefined, field: string): OutputFieldStep[] | undefined {
  if (path === undefined) return undefined;
  const steps = parseEntityPath(path);
  if (!steps) return undefined;
  const result: OutputFieldStep[] = [];
  for (const step of steps) {
    result.push({ kind: 'key', key: step.key });
    if (step.each) result.push({ kind: 'each' });
  }
  result.push({ kind: 'key', key: field });
  return result;
}

/**
 * Resolves the entity declarations of every endpoint tool: levels,
 * precedence, the output bound and the tools.json `identity`. Pure and
 * deterministic (tools in code-unit order of their definition id).
 */
export function resolveToolEntities(input: {
  tools: ReadonlyArray<EntityResolutionTool>;
  identity?: ToolsIdentityConfig;
}): { byKey: Map<string, ResolvedToolEntities>; findings: ToolFinding[] } {
  const findings: ToolFinding[] = [];
  const byKey = new Map<string, ResolvedToolEntities>();
  const config = TOOLS_PATHS.config;

  // tools.json: app-wide entities by type, validated once.
  const appEntities = new Map<string, EntityDeclaration>();
  for (const [type, raw] of Object.entries(input.identity?.entities ?? {}).sort(([a], [b]) => compareCodeUnits(a, b))) {
    const issue = !ENTITY_TYPE_PATTERN.test(type)
      ? 'is no lower-case type name'
      : isObject(raw) && (raw.type !== undefined || raw.path !== undefined)
        ? 'names a type or path inside the entry (the key is the type; a path belongs to identity.tools)'
        : entityDeclarationIssue(raw);
    if (issue) {
      findings.push(toolFinding('entity-declaration-invalid', 'warning', config,
        `${config} identity.entities.${type.slice(0, 64)} ${issue}; it is ignored.`));
      continue;
    }
    appEntities.set(type, { ...(raw as EntityDeclaration), type });
  }
  const usedTypes = new Set<string>();
  const usedToolKeys = new Set<string>();
  const appTools = input.identity?.tools ?? {};

  const tools = [...input.tools].sort((left, right) => compareCodeUnits(left.definitionId, right.definitionId));
  const typeIds = new Map<string, { ids: string; tool: string }>();

  for (const tool of tools) {
    const subject = tool.stableKey;
    const observed = tool.entities ?? {};
    const toolKey = Object.prototype.hasOwnProperty.call(appTools, tool.definitionId)
      ? tool.definitionId
      : Object.prototype.hasOwnProperty.call(appTools, tool.modelName) ? tool.modelName : undefined;
    if (toolKey !== undefined) usedToolKeys.add(toolKey);
    const appTool = toolKey !== undefined ? appTools[toolKey] : undefined;

    // App level: identity.tools output, then identity.entities by the type of a schema site or the route.
    const appOutput: OutputEntityDeclaration[] = [];
    (appTool?.output ?? []).forEach((entry, index) => {
      const issue = entityDeclarationIssue(entry, { output: true });
      if (issue) {
        findings.push(toolFinding('entity-declaration-invalid', 'warning', subject,
          `${config} identity.tools.${toolKey} output[${index}] ${issue}; it is ignored.`));
      } else {
        appOutput.push(entry as OutputEntityDeclaration);
      }
    });
    const schemaPaths = new Set((observed.schema?.output ?? []).map((entry) => entry.path ?? ''));
    let typedSite = false;
    for (const site of observed.sites ?? []) {
      const declared = site.type ? appEntities.get(site.type) : undefined;
      if (!declared || schemaPaths.has(site.path)) continue;
      typedSite = true;
      usedTypes.add(site.type!);
      appOutput.push({ ...declared, path: site.path });
    }
    const routeType = routeEntityType(tool.path);
    const readTool = tool.method === 'GET' || tool.method === 'HEAD';
    if (!typedSite && (observed.sites ?? []).length === 0 && readTool && routeType && appEntities.has(routeType)) {
      usedTypes.add(routeType);
      appOutput.push({ ...appEntities.get(routeType)! });
    }

    // Output: one declaration per path, the highest level wins.
    const layers: Array<[Level, ReadonlyArray<OutputEntityDeclaration>]> = [
      ['code', observed.code?.output ?? []],
      ['operation', observed.operation?.output ?? []],
      ['schema', observed.schema?.output ?? []],
      ['app', appOutput],
    ];
    const chosen = new Map<string, { declaration: OutputEntityDeclaration; level: Level }>();
    for (const [level, list] of layers) {
      const own = new Map<string, OutputEntityDeclaration>();
      for (const declaration of list) {
        const key = declaration.path ?? '*';
        const first = own.get(key);
        if (first) {
          if (canonical(first) !== canonical(declaration)) {
            findings.push(toolFinding('entity-id-conflict', 'error', subject,
              `${LEVEL_NAMES[level]} declares two different entities at ${key === '*' ? 'the default path' : key || 'the result'}; the first is used, the tool stays enabled.`));
          }
          continue;
        }
        own.set(key, declaration);
        const higher = chosen.get(key);
        if (higher) {
          if (canonical(higher.declaration) !== canonical(declaration)) {
            findings.push(toolFinding('entity-declaration-overridden', 'warning', subject,
              `${LEVEL_NAMES[higher.level]} replaces the entity ${LEVEL_NAMES[level]} declares at ${key === '*' ? 'the default path' : key || 'the result'}.`));
          }
          continue;
        }
        chosen.set(key, { declaration, level });
      }
    }

    // The output bound wins: a denied id drops the declaration, a denied name or fallback that field.
    const denied = tool.outputDeniedFields ?? [];
    const deniedKeys = anyDepthKeys(denied);
    const deniedTree = outputFieldTree(denied.filter((path) => !path.startsWith('**.')));
    const allowedTree = tool.outputAllowedFields ? outputFieldTree(tool.outputAllowedFields) : undefined;
    const isDenied = (path: string | undefined, field: string): boolean => {
      if (deniedKeys.has(field)) return true;
      const steps = fieldSteps(path, field);
      if (!steps) return false;
      if (outputFieldCovers(deniedTree, steps)) return true;
      return allowedTree !== undefined && !outputFieldCovers(allowedTree, steps);
    };
    const sites = new Map((observed.sites ?? []).map((site) => [site.path, site] as const));
    const output: OutputEntityDeclaration[] = [];
    for (const { declaration } of chosen.values()) {
      const at = declaration.path === undefined ? 'the default path' : declaration.path || 'the result';
      const deniedIds = entityIdFields(declaration).filter((field) => isDenied(declaration.path, field));
      if (deniedIds.length > 0) {
        findings.push(toolFinding('entity-field-denied', 'warning', subject,
          `The entity at ${at} names the id field ${deniedIds.join(', ')}, which the output fields deny; the declaration is dropped.`));
        continue;
      }
      let kept: OutputEntityDeclaration = declaration;
      for (const key of ['name', 'fallback'] as const) {
        const field = kept[key];
        if (field !== undefined && isDenied(declaration.path, field)) {
          findings.push(toolFinding('entity-field-denied', 'warning', subject,
            `The entity at ${at} names the ${key} field ${field}, which the output fields deny; the ${key} is dropped.`));
          const { [key]: _dropped, ...rest } = kept;
          kept = rest as OutputEntityDeclaration;
        }
      }
      const site = declaration.path !== undefined ? sites.get(declaration.path) : undefined;
      if (site?.fields) {
        const fields = [...entityIdFields(kept), ...(kept.name ? [kept.name] : []), ...(kept.fallback ? [kept.fallback] : [])];
        const unknown = fields.filter((field) => !site.fields!.includes(field));
        if (unknown.length > 0) {
          findings.push(toolFinding('entity-field-unknown', 'warning', subject,
            `The entity at ${at} names ${unknown.join(', ')}, which the response schema does not have there; the runtime finds no such field.`));
        }
      }
      output.push(kept);
    }

    // Input: one reference per argument list, the highest level wins.
    const appInput: InputEntityRef[] = [];
    (appTool?.input ?? []).forEach((entry, index) => {
      const issue = inputEntityRefIssue(entry);
      if (issue) {
        findings.push(toolFinding('entity-ref-invalid', 'warning', subject,
          `${config} identity.tools.${toolKey} input[${index}] ${issue}; it is ignored.`));
      } else {
        appInput.push(entry as InputEntityRef);
      }
    });
    const params = tool.params;
    const names = params
      ? new Set([...params.path, ...params.query, ...(params.body === 'opaque' ? [] : params.body)])
      : undefined;
    const chosenRefs = new Map<string, { ref: InputEntityRef; level: Level }>();
    for (const [level, list] of [
      ['code', observed.code?.input ?? []],
      ['operation', observed.operation?.input ?? []],
      ['app', appInput],
    ] as Array<[Level, ReadonlyArray<InputEntityRef>]>) {
      for (const ref of list) {
        const args = inputRefArgs(ref);
        const missing = names && params?.body !== 'opaque'
          ? args.filter((arg) => !names.has(arg.split('.')[0]!))
          : [];
        if (missing.length > 0) {
          findings.push(toolFinding('entity-ref-invalid', 'warning', subject,
            `${LEVEL_NAMES[level]} declares an entity reference on ${missing.join(', ')}, which the tool has no parameter for; it is ignored.`));
          continue;
        }
        const key = args.join(',');
        const higher = chosenRefs.get(key);
        if (higher) {
          if (higher.level !== level && canonical(higher.ref) !== canonical(ref)) {
            findings.push(toolFinding('entity-declaration-overridden', 'warning', subject,
              `${LEVEL_NAMES[higher.level]} replaces the entity reference ${LEVEL_NAMES[level]} declares on ${key}.`));
          }
          continue;
        }
        chosenRefs.set(key, { ref, level });
      }
    }
    const inputRefs = [...chosenRefs.values()].map(({ ref }) => ref);
    // Bounded like a hand-written list: the first in path (argument) order stay, deterministic.
    if (output.length > MAX_TOOL_ENTITIES) {
      output.sort((left, right) => compareCodeUnits(left.path ?? '', right.path ?? ''));
      findings.push(toolFinding('entity-declaration-invalid', 'warning', subject,
        `The tool has ${output.length} entity declarations; the first ${MAX_TOOL_ENTITIES} in path order are kept.`));
      output.length = MAX_TOOL_ENTITIES;
    }
    if (inputRefs.length > MAX_TOOL_ENTITIES) {
      inputRefs.sort((left, right) => compareCodeUnits(inputRefArgs(left).join(','), inputRefArgs(right).join(',')));
      findings.push(toolFinding('entity-ref-invalid', 'warning', subject,
        `The tool has ${inputRefs.length} entity references; the first ${MAX_TOOL_ENTITIES} in argument order are kept.`));
      inputRefs.length = MAX_TOOL_ENTITIES;
    }

    // One type, one id across tools: a contradiction is an error, each tool keeps its own declaration.
    for (const declaration of output) {
      if (!declaration.type) continue;
      const ids = entityIdFields(declaration).join(',');
      const first = typeIds.get(declaration.type);
      if (!first) typeIds.set(declaration.type, { ids, tool: tool.definitionId });
      else if (first.ids !== ids) {
        findings.push(toolFinding('entity-id-conflict', 'error', subject,
          `The entity type ${declaration.type} has the id ${ids} here but ${first.ids} in ${first.tool}; each tool keeps its own declaration, the tool stays enabled.`));
      }
    }

    if (output.length > 0 || inputRefs.length > 0) {
      byKey.set(tool.stableKey, {
        ...(output.length > 0 ? { outputEntities: output } : {}),
        ...(inputRefs.length > 0 ? { inputEntities: inputRefs } : {}),
      });
    }
  }

  for (const type of appEntities.keys()) {
    if (!usedTypes.has(type)) {
      findings.push(toolFinding('entity-declaration-unused', 'warning', config,
        `${config} identity.entities.${type} applies to no tool: no response schema of that type and no read route of that resource.`));
    }
  }
  for (const key of Object.keys(appTools).sort(compareCodeUnits)) {
    if (!usedToolKeys.has(key)) {
      findings.push(toolFinding('entity-declaration-unused', 'warning', config,
        `${config} identity.tools.${key.slice(0, 200)} names no generated endpoint tool.`));
    }
  }
  return { byKey, findings };
}
