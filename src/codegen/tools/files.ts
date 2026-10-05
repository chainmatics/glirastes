import { z } from 'zod';
import { ToolRiskClassSchema } from '../../contracts/index.js';
import { TOOL_POLICY_RULES_VERSION } from '../../contracts/tool-policy.js';
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
  z.object({ kind: z.literal('client-action'), actionId: z.string().min(1).max(200) }).strict(),
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

export const ToolContractsFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  tools: z.array(z.object({
    toolId: z.uuid(),
    stableKey: z.string().min(1).max(2_100),
    definitionId: z.string().min(1).max(200),
    contract: ToolContractSchema.nullable(),
    defaults: ToolPolicyDefaultsSchema,
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
