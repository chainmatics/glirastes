import {
  entityDeclarationIssue,
  inputEntityRefIssue,
  MAX_TOOL_ENTITIES,
  type InputEntityRef,
  type OutputEntityDeclaration,
} from '../../contracts/entity-declaration.js';
import {
  approvalSubjectIssue,
  entityLookupIssue,
  MAX_ENTITY_LOOKUPS,
  type ApprovalSubjectOption,
  type EntityLookup,
} from '../../contracts/approval-subject.js';
import { z } from 'zod';
import { isSafeAppHref } from '../../browser/navigation.js';
import { MAX_MAX_RESULT_CHARS, MIN_MAX_RESULT_CHARS } from '../../runtime/result-limit.js';
import {
  isValidOutputFields,
  MAX_OUTPUT_FIELD_CHARS,
  MAX_OUTPUT_FIELDS,
  type OutputFieldsName,
} from '../../server/core/output-fields.js';
import { ToolRiskClassSchema } from '../../contracts/index.js';
import { TOOL_POLICY_RULES_VERSION } from '../../contracts/tool-policy.js';
import { LANGUAGE_TAG_PATTERN, MAX_TEXT_LANGUAGES } from '../../contracts/localized-text.js';
import { ExecutionGenerationStateSchema } from '../inventory-generation.js';
import type { ToolContract, ToolContractsEntry } from './types.js';

const digest = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ToolTombstonesFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  tombstones: ExecutionGenerationStateSchema.shape.tombstones,
}).strict();

const RuntimeSchemaSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('module-export'),
    module: z.string().min(1).max(512),
    export: z.string().min(1).max(200),
    property: z.array(z.string().min(1).max(200)).max(8),
  }).strict(),
  z.object({ kind: z.literal('json'), schema: JsonObjectSchema }).strict(),
]);

/**
 * URL parameters one `ui.filter.<view>` tool takes. The `url-filters` source
 * keeps the first ones in code-unit order and reports the rest
 * (`filter-keys-capped`), so refresh never writes a file this schema rejects.
 */
export const MAX_FILTER_KEYS = 50;

/** A static app path a page-bound client action lives on: no query, hash or route parameter. */
export function isClientActionRoute(route: string): boolean {
  return isSafeAppHref(route)
    && !/[?#]/.test(route)
    && !route.split('/').some((segment) => segment.startsWith(':') || segment.startsWith('['));
}

const GeneratedUiActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate') }).strict(),
  z.object({
    kind: z.literal('filter'),
    destination: z.string().min(1).max(2_048),
    keys: z.array(z.object({
      key: z.string().min(1).max(64),
      array: z.enum(['comma', 'repeat']).optional(),
    }).strict()).max(MAX_FILTER_KEYS),
  }).strict(),
  z.object({
    kind: z.literal('client-action'),
    actionId: z.string().min(1).max(200),
    route: z.string().max(2_048).refine(isClientActionRoute).optional(),
  }).strict(),
]);

export const ToolContractSchema = z.object({
  source: z.enum([
    'native', 'contract-module', 'legacy-ai-tool', 'resolution', 'openapi', 'derived', 'ui-bridge',
  ]),
  loadBearing: z.boolean(),
  input: JsonObjectSchema,
  output: JsonObjectSchema.optional(),
  params: z.object({
    path: z.array(z.string()),
    query: z.array(z.string()),
    body: z.union([z.array(z.string()), z.literal('opaque')]),
  }).strict(),
  interfaceDigest: digest,
  runtime: z.object({
    input: RuntimeSchemaSourceSchema,
    output: RuntimeSchemaSourceSchema,
  }).strict(),
  binding: z.object({
    interfaceDigest: digest,
    contractModuleDigest: digest,
  }).strict().optional(),
  uiAction: GeneratedUiActionSchema.optional(),
}).strict();

const ToolPolicyDefaultsSchema = z.object({
  operationGroup: z.enum(['read', 'create', 'update', 'delete', 'ui']),
  riskClass: ToolRiskClassSchema.exclude(['unknown']),
  requiresApproval: z.boolean(),
  rulesVersion: z.literal(TOOL_POLICY_RULES_VERSION),
}).strict();

/** Synonyms bounded like the runtime index; examples are 3–5 sentences in each of two languages. */
const ToolSearchFactsSchema = z.object({
  synonyms: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  examples: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
}).strict();

/** One name an app's MCP server keeps for an endpoint tool: the grant id and the MCP tool name. */
export const McpToolNameSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).strict();

/**
 * `.glirastes/mcp-tool-names.json` (spec 5.2, MCP only): per endpoint tool the
 * names and grant ids the app's MCP clients know. Two names may share a
 * route; every id and every name is used once.
 */
export const McpToolNamesFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.record(z.string().min(1).max(2_100), z.array(McpToolNameSchema).min(1).max(10)),
}).strict().superRefine((file, context) => {
  const seen = { id: new Set<string>(), name: new Set<string>() };
  for (const [stableKey, names] of Object.entries(file.tools)) {
    for (const entry of names) {
      for (const field of ['id', 'name'] as const) {
        if (seen[field].has(entry[field])) {
          context.addIssue({ code: 'custom', path: ['tools', stableKey], message: `The MCP ${field} ${entry[field]} is used twice` });
        }
        seen[field].add(entry[field]);
      }
    }
  }
});

/** Declared output fields: valid field paths (local only, never sent to the Platform). */
const outputFieldsSchema = (name: OutputFieldsName) => z.array(z.string().min(1).max(MAX_OUTPUT_FIELD_CHARS))
  .max(MAX_OUTPUT_FIELDS)
  .refine((paths) => isValidOutputFields(paths, name), { message: 'Not a list of output field paths' });

/** Entity declarations (field names and types only; local, never sent to the Platform). */
const OutputEntitiesSchema = z.array(z.unknown()).max(MAX_TOOL_ENTITIES)
  .refine((list) => list.every((entry) => entityDeclarationIssue(entry, { output: true }) === undefined), { message: 'Not a list of entity declarations' })
  .transform((list) => list as OutputEntityDeclaration[]);
const InputEntitiesSchema = z.array(z.unknown()).max(MAX_TOOL_ENTITIES)
  .refine((list) => list.every((entry) => inputEntityRefIssue(entry) === undefined), { message: 'Not a list of entity references' })
  .transform((list) => list as InputEntityRef[]);

/** Approval-subject declarations (field, type and tool names only; local, never sent to the Platform). */
const EntityLookupsSchema = z.array(z.unknown()).min(1).max(MAX_ENTITY_LOOKUPS)
  .refine((list) => list.every((entry) => entityLookupIssue(entry) === undefined)
    && new Set(list.map((entry) => (entry as EntityLookup).type)).size === list.length, { message: 'Not a list of entity lookups' })
  .transform((list) => list as EntityLookup[]);
const ApprovalSubjectSchema = z.unknown()
  .refine((value) => value !== undefined && approvalSubjectIssue(value) === undefined, { message: 'Not an approval subject declaration' })
  .transform((value) => value as ApprovalSubjectOption);

const ToolTitleSchema = z.record(z.string().regex(LANGUAGE_TAG_PATTERN).max(35), z.string().min(1).max(200))
  .refine((title) => Object.keys(title).length <= MAX_TEXT_LANGUAGES, { message: `At most ${MAX_TEXT_LANGUAGES} languages` });

/**
 * The labels of a tool per language for the chat (tools.json `languages`):
 * local only, written to tool-contracts.json and the generated module, never
 * part of the setup artifact the Platform receives.
 */
const ToolLabelsSchema = z.record(z.string().regex(LANGUAGE_TAG_PATTERN).max(35), z.object({
  singular: z.string().min(1).max(200),
  plural: z.string().min(1).max(200),
  approval: z.string().min(1).max(500),
}).strict()).refine((labels) => Object.keys(labels).length >= 1 && Object.keys(labels).length <= MAX_TEXT_LANGUAGES, {
  message: `One to ${MAX_TEXT_LANGUAGES} languages`,
});

export const ToolContractsFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  tools: z.array(z.object({
    toolId: z.uuid(),
    stableKey: z.string().min(1).max(2_100),
    definitionId: z.string().min(1).max(200),
    contract: ToolContractSchema.nullable(),
    defaults: ToolPolicyDefaultsSchema,
    search: ToolSearchFactsSchema.optional(),
    title: ToolTitleSchema.optional(),
    labels: ToolLabelsSchema.optional(),
    mcp: z.array(McpToolNameSchema).min(1).max(10).optional(),
    maxResultChars: z.number().int().min(MIN_MAX_RESULT_CHARS).max(MAX_MAX_RESULT_CHARS).optional(),
    outputAllowedFields: outputFieldsSchema('outputAllowedFields').optional(),
    outputDeniedFields: outputFieldsSchema('outputDeniedFields').optional(),
    outputDefaultFields: outputFieldsSchema('outputDefaultFields').optional(),
    outputEntities: OutputEntitiesSchema.optional(),
    inputEntities: InputEntitiesSchema.optional(),
    entityLookup: EntityLookupsSchema.optional(),
    approvalSubject: ApprovalSubjectSchema.optional(),
    lookupEffect: z.literal('read').optional(),
  }).strict()).max(5_000),
}).strict();

export type ToolTombstonesFile = z.infer<typeof ToolTombstonesFileSchema>;
export type ToolContractsFile = z.infer<typeof ToolContractsFileSchema>;

/** Compile-time proof that the file schemas produce the shared interface types. */
export function toToolContract(contract: z.infer<typeof ToolContractSchema>): ToolContract {
  return contract;
}

export function toToolContractsEntry(entry: ToolContractsFile['tools'][number]): ToolContractsEntry {
  return entry;
}
