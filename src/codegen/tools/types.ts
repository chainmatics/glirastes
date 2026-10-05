import type { ToolPresentation } from '../../contracts/index.js';
import type { DeclaredEffect, ToolPolicyDefaults } from '../../contracts/tool-policy.js';
import type { LocalJsonSchema } from '../../runtime/json-schema.js';
import type { ObservedExecution } from '../inventory-generation.js';

/** A plain, serializable JSON Schema object — never a compiled validator. */
export type JsonSchemaLike = LocalJsonSchema;

export type ToolFindingSeverity = 'error' | 'needs_attention' | 'warning';

export interface ToolFinding {
  code: string;
  subjectRef: string;
  severity: ToolFindingSeverity;
  message: string;
  nextAction: string;
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
}

export interface ToolProseHints {
  contractDescription?: string;
  schemaDescription?: string;
  module?: string;
  usageHints?: string[];
  presentation?: ToolPresentation;
}

export interface ObservedTool {
  execution: ObservedExecution;
  contract?: ToolContract;
  evidence: {
    authEvidence: boolean;
    externalCall: boolean;
    declaredEffect?: DeclaredEffect;
    jsDoc?: string;
  };
  findings: ToolFinding[];
  prose?: ToolProseHints;
}

export interface ExcludedTool {
  stableKey: string;
  reason: string;
  /** `code`: the generator itself left the route out, e.g. an `unsupported-method` export. */
  origin: 'default' | 'policy' | 'code';
}

export interface ToolContractsEntry {
  toolId: string;
  stableKey: string;
  definitionId: string;
  contract: ToolContract | null;
  defaults: ToolPolicyDefaults;
}
