import type { ToolPresentation } from '../../contracts/index.js';
import type { LocalizedText } from '../../contracts/localized-text.js';
import type { InputEntityRef, OutputEntityDeclaration } from '../../contracts/entity-declaration.js';
import type { ObservedEntities } from './entity-declarations.js';
import type { ApprovalSubjectOption, EntityLookup, LookupEffect } from '../../contracts/approval-subject.js';
import type { ObservedApprovalDeclarations } from './approval-subject-declarations.js';
import type { DeclaredEffect, ToolPolicyDefaults, ToolPolicyFile } from '../../contracts/tool-policy.js';
import type { LocalJsonSchema } from '../../runtime/json-schema.js';
import type { GeneratedUiAction } from '../../server/core/generated-ui-tool.js';
import type { ExecutionGenerationState, ObservedExecution } from '../inventory-generation.js';
import type { ToolsConfig } from './config.js';
import type { ToolResolutions } from './resolutions.js';
import type { SchemaProbe } from './schema-probe.js';

/** A plain, serializable JSON Schema object — never a compiled validator. */
export type JsonSchemaLike = LocalJsonSchema;

export type ToolFindingSeverity = 'error' | 'needs_attention' | 'warning';

export interface ToolFinding {
  code: string;
  subjectRef: string;
  severity: ToolFindingSeverity;
  message: string;
  nextAction: string;
  /** What the worklist hands the agent as `expected`, e.g. a proposed registration; never written to outputs. */
  expected?: unknown;
}

export type ContractSource =
  | 'native'
  | 'contract-module'
  | 'legacy-ai-tool'
  | 'resolution'
  | 'openapi'
  | 'derived'
  | 'ui-bridge';

/** An exported value inside the app; `module` is an app-relative POSIX path. */
export interface SchemaBindingRef {
  module: string;
  export: string;
  property: string[];
}

/** How the generated module obtains a runtime schema. */
export type RuntimeSchemaSource =
  | ({ kind: 'module-export' } & SchemaBindingRef)
  | { kind: 'json'; schema: JsonSchemaLike };

/** The interface a descriptive contract module was written for. */
export interface ContractBinding {
  interfaceDigest: string;
  contractModuleDigest: string;
}

export interface ToolContract {
  source: ContractSource;
  loadBearing: boolean;
  input: JsonSchemaLike;
  output?: JsonSchemaLike;
  params: { path: string[]; query: string[]; body: string[] | 'opaque' };
  interfaceDigest: string;
  runtime: { input: RuntimeSchemaSource; output: RuntimeSchemaSource };
  binding?: ContractBinding;
  /** UI tools only: what the generated tool asks the app's browser bridge to do. */
  uiAction?: GeneratedUiAction;
}

export interface ToolProseHints {
  /** contract.ts `description`: one text, or one per language tag. */
  contractDescription?: LocalizedText;
  schemaDescription?: string;
  /** The endpoint's own description per language (OpenAPI `x-glirastes-description`); above its plain description. */
  declaredDescription?: LocalizedText;
  module?: string;
  usageHints?: string[];
  presentation?: ToolPresentation;
  /** contract.ts `presentation` given per language tag. */
  presentations?: Readonly<Record<string, { singular: string; plural: string; approval: string }>>;
  /** The endpoint's title (OpenAPI `x-glirastes-title`): one text, or one per language tag. */
  title?: LocalizedText;
  /** contract.ts `title`, below the OpenAPI one per language (a language-free one stays for the languages it lacks). */
  contractTitle?: LocalizedText;
  /** The endpoint's synonyms and example requests per language (search only). */
  synonyms?: Readonly<Record<string, ReadonlyArray<string>>>;
  examples?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * Set by the openapi source only: a name without a dot there comes from
   * `x-glirastes-name` (`list_tags`) and carries its verb, so module and
   * template label take the resource from method and path. Every other
   * source leaves it unset and keeps the part of the name before the first dot.
   */
  resourceFromRoute?: true;
}

/** The interface a tool has now, also when no contract could be resolved. */
export interface ObservedInterface {
  digest: string;
  params: ToolContract['params'];
}

export interface ObservedTool {
  execution: ObservedExecution;
  contract?: ToolContract;
  /** Endpoints always; UI tools when their payload is typed. Read by the work lists. */
  interface?: ObservedInterface;
  /** App-relative files a coding agent reads to resolve or describe this tool. */
  files?: string[];
  evidence: {
    authEvidence: boolean;
    externalCall: boolean;
    declaredEffect?: DeclaredEffect;
    jsDoc?: string;
    /** UI tools only: the handler provably writes, e.g. a non-GET fetch. */
    uiMutation?: boolean;
  };
  findings: ToolFinding[];
  prose?: ToolProseHints;
  /**
   * Roles the code declares (OpenAPI `x-glirastes-roles`), any of which may
   * call the tool. The code default of `allowedRoles`: local policy and
   * Platform only narrow it. Absent or empty: no additional restriction.
   */
  codeRoles?: string[];
  /**
   * Upper bound of the tool's serialized result the code declares (OpenAPI
   * `x-glirastes-max-result-chars`, contract.ts `maxResultChars`); already
   * validated. Local only: written to tool-contracts.json, never sent to the
   * Platform.
   */
  maxResultChars?: number;
  /**
   * Output fields the code declares (OpenAPI `x-glirastes-output-allowed-fields`,
   * `-denied-fields`, `-default-fields`; contract.ts `outputAllowedFields`,
   * `outputDeniedFields`, `outputDefaultFields`); effective and normalized.
   * Local only: written to tool-contracts.json, never sent to the Platform.
   */
  outputAllowedFields?: string[];
  outputDeniedFields?: string[];
  outputDefaultFields?: string[];
  /**
   * App-wide patterns (`output.deniedFields` of tools.json) whose key this
   * tool's declared output schema names, and declared keys that differ from
   * one only by case. Only for the warning about a pattern that matches no
   * tool; never written to an output.
   */
  appDeniedHits?: string[];
  appDeniedNearKeys?: string[];
  /**
   * Entity declarations by level (tool code, OpenAPI operation, response
   * schema) and the response's object schemas; resolved by the pipeline with
   * tools.json `identity`. Local only.
   */
  entities?: ObservedEntities;
  /**
   * Approval-subject declarations by level (tool code, OpenAPI operation):
   * `entityLookup`, `approvalSubject`, `lookupEffect`, the valid ones and
   * the issues of the others; resolved by the pipeline with tools.json.
   * Local only.
   */
  approvalDeclarations?: ObservedApprovalDeclarations;
}

export interface ExcludedTool {
  stableKey: string;
  reason: string;
  /**
   * `code`: the generator itself left the route out, e.g. an
   * `unsupported-method` export, or an OpenAPI operation that is `opted-out`
   * (`x-glirastes-tool: false`) or `not-opted-in` (selection `opt-in`).
   */
  origin: 'default' | 'policy' | 'code';
}

/** Checked stage-2 search data: both rank `find_tools` and the start set; examples are also the `tools eval` corpus. */
export interface ToolSearchFacts {
  synonyms?: string[];
  examples?: string[];
}

/** A name an app's MCP server keeps for an endpoint tool (`.glirastes/mcp-tool-names.json`). */
export interface McpToolName {
  /** The id MCP grants and the app's classification refer to. */
  id: string;
  /** The MCP tool name its clients call. */
  name: string;
}

/** A tool's title per BCP-47 language tag (`de`, `en`, `pl-PL`). */
export interface ToolTitle {
  readonly de?: string;
  readonly en?: string;
  readonly [language: string]: string | undefined;
}

export interface ToolContractsEntry {
  toolId: string;
  stableKey: string;
  definitionId: string;
  contract: ToolContract | null;
  defaults: ToolPolicyDefaults;
  search?: ToolSearchFacts;
  title?: ToolTitle;
  /**
   * Labels per language for the chat (tools.json `languages`). Local only:
   * the generated module and the container artifact carry them, the setup
   * artifact keeps its one `presentation`.
   */
  labels?: Record<string, { singular: string; plural: string; approval: string }>;
  mcp?: McpToolName[];
  /** Upper bound of the serialized result the code declares; the generated module passes it on. */
  maxResultChars?: number;
  /** Output fields the code declares (see `ObservedTool`); the generated module passes them on. */
  outputAllowedFields?: string[];
  outputDeniedFields?: string[];
  outputDefaultFields?: string[];
  /** Resolved entity declarations (field names only); the generated module passes them on. */
  outputEntities?: OutputEntityDeclaration[];
  inputEntities?: InputEntityRef[];
  /** Resolved approval-subject declarations (field and tool names only); the generated module passes them on. */
  entityLookup?: EntityLookup[];
  approvalSubject?: ApprovalSubjectOption;
  lookupEffect?: LookupEffect;
}

export interface ToolSourceContext {
  /** Real path of the app root. */
  root: string;
  config: ToolsConfig;
  resolutions: ToolResolutions;
  policy: ToolPolicyFile;
  previous?: ExecutionGenerationState;
  /** Previous contracts by stable key (descriptive bindings live here). */
  previousContracts: ReadonlyMap<string, ToolContract>;
  probe: SchemaProbe;
}

export interface ToolSourceObservation {
  observations: ObservedTool[];
  findings: ToolFinding[];
  /** false ⇒ enumeration incomplete; the pipeline writes nothing. */
  complete: boolean;
  excluded?: ExcludedTool[];
}

export interface ToolSource {
  kind: string;
  observe(ctx: ToolSourceContext): Promise<ToolSourceObservation>;
}
