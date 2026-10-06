import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import type { ToolsPipelineResult, ToolsPipelineTool } from './pipeline.js';
import type { ToolFinding } from './types.js';

/**
 * Work lists for the developer's own coding agent (spec 4.6 "Local und
 * Free"). The CLI never calls a model: it names what is open, where the
 * evidence is, which file the answer goes to and in which format. The skills
 * `maintaining-glirastes-tools` and `describing-glirastes-tools` explain how
 * to work through them; the next `glirastes tools refresh` checks every
 * answer with the same rules, whoever wrote it.
 */
export const WORKLIST_SCHEMA_VERSION = 1;

/** Placeholder the agent replaces with its model slug or name, e.g. `claude-code`. */
export const MODEL_PLACEHOLDER = '<your model or coding agent, e.g. claude-code>';

export type WorklistTarget =
  /** The agent writes data into a `.glirastes` input file. */
  | { kind: 'file'; file: string; key: string }
  /** The agent changes app code (never a route handler's logic, never generated files). */
  | { kind: 'app-code'; files: string[] }
  /** Only the developer may do this; the agent shows the command and stops. */
  | { kind: 'developer'; command: string };

export interface WorklistEvidence {
  route: string;
  executionKind: 'endpoint' | 'ui';
  params: ToolsPipelineTool['params'];
  interfaceDigest: string | null;
  riskClass: string;
  requiresApproval: boolean;
  enabled: boolean;
  contractSource: string | null;
  schemaQuality: string;
  descriptionOrigin: string;
}

export interface ResolveWorkItem {
  /** The name `glirastes tools status` prints; the stable key when no tool carries the finding. */
  tool: string;
  stableKey: string;
  toolId: string | null;
  code: string;
  severity: ToolFinding['severity'];
  message: string;
  owner: 'agent' | 'developer';
  files: string[];
  evidence: WorklistEvidence | null;
  target: WorklistTarget;
  expected?: unknown;
  nextAction: string;
}

export interface BlockingFinding {
  code: string;
  subjectRef: string;
  message: string;
  nextAction: string;
}

export interface ResolveWorklist {
  schemaVersion: typeof WORKLIST_SCHEMA_VERSION;
  kind: 'resolve';
  /** False when the committed outputs lag behind the code; run glirastes tools refresh. */
  outputsCurrent: boolean;
  /** Findings that stop the whole refresh; fix them first. */
  blocking: BlockingFinding[];
  items: ResolveWorkItem[];
  next: string;
}

/** Stage-1 codes a coding agent resolves with an entry in tool-resolutions.json. */
const RESOLUTION_CODES: ReadonlySet<string> = new Set([
  'input-contract-unresolved',
  'input-role-unclear',
  'input-role-unsupported',
  'schema-json-unavailable',
]);

/** Stage-1 codes resolved in app code next to the handler or registration. */
const APP_CODE_CODES: ReadonlySet<string> = new Set([
  'parameter-collision',
  'schema-not-exported',
  'schema-module-unloadable',
  'schema-content-rejected',
  'contract-effect-invalid',
  'handler-unresolved',
  'navigation-bridge-missing',
  'ui-action-payload-untyped',
  'ui-action-contract-conflict',
  'filter-keys-capped',
]);

/**
 * Warnings about code stage 1 had to leave out or ignore (a client action
 * with a computed or reserved id, a contract id or presentation it cannot
 * use). They name a file, not always a tool, and are fixed in app code.
 */
const DROPPED_CODES: ReadonlySet<string> = new Set([
  'ui-action-id-dynamic',
  'ui-action-id-invalid',
  'ui-action-id-reserved',
  'definition-id-invalid',
  'contract-presentation-invalid',
]);

/** Codes only the developer resolves, through `glirastes tools policy`. */
const DEVELOPER_CODES: ReadonlySet<string> = new Set([
  'ui-action-write-unproven',
  'risk-lower-available',
  'policy-entry-orphaned',
  'override-lapsed-risk-raised',
  'E-POLICY-002',
]);

/** Drift of the committed outputs is reported by `outputsCurrent`, so it is no blocking finding. */
const IGNORED_FOR_LISTS: ReadonlySet<string> = new Set(['tool-outputs-drift']);

function evidenceOf(tool: ToolsPipelineTool): WorklistEvidence {
  return {
    route: tool.route,
    executionKind: tool.executionKind,
    params: tool.params,
    interfaceDigest: tool.interfaceDigest,
    riskClass: tool.riskClass,
    requiresApproval: tool.requiresApproval,
    enabled: tool.enabled,
    contractSource: tool.contract?.source ?? null,
    schemaQuality: tool.schemaQuality,
    descriptionOrigin: tool.descriptionOrigin,
  };
}

/** `tools["<stableKey>"]`: the key path inside `tool-resolutions.json` and `tool-policy.json`. */
export function toolKey(stableKey: string): string {
  return `tools[${JSON.stringify(stableKey)}]`;
}

/** `tools[stableKey="<stableKey>"]`: `tool-semantics.json` holds a list, so an entry is named by its stable key. */
export function semanticsKey(stableKey: string): string {
  return `tools[stableKey=${JSON.stringify(stableKey)}]`;
}

/** An input schema skeleton from the code evidence: every parameter the handler reads, types left to the agent. */
export function inputSchemaSkeleton(tool: ToolsPipelineTool): Record<string, unknown> {
  const params = tool.params ?? tool.contract?.params;
  const names = params
    ? [...params.path, ...params.query, ...(params.body === 'opaque' ? [] : params.body)]
    : [];
  const properties = Object.fromEntries([...new Set(names)].sort(compareCodeUnits)
    .map((name) => [name, { description: `<what ${name} means; add type, format, enum or bounds the code shows>` }]));
  return {
    type: 'object',
    properties,
    ...(params && params.path.length > 0 ? { required: [...params.path].sort(compareCodeUnits) } : {}),
    additionalProperties: false,
  };
}

/** The entry an agent writes into tool-resolutions.json for one tool. */
export function resolutionEntryTemplate(tool: ToolsPipelineTool): Record<string, unknown> {
  return {
    origin: 'agent',
    model: MODEL_PLACEHOLDER,
    interfaceDigest: tool.interfaceDigest ?? '<run glirastes tools refresh first>',
    input: { jsonSchema: inputSchemaSkeleton(tool) },
  };
}

function layoutFiles(tool: ToolsPipelineTool): string[] {
  return tool.files.length > 0 ? tool.files : ['src/app/layout.tsx'];
}

/** The entry a rejected or invalid finding names, in the file and notation it lives in. */
function entryTarget(finding: ToolFinding): WorklistTarget {
  const semantics = finding.code === 'tool-semantics-invalid' || finding.message.includes('tool-semantics.json')
    || finding.subjectRef.startsWith(TOOLS_PATHS.semantics);
  const file = semantics ? TOOLS_PATHS.semantics : TOOLS_PATHS.resolutions;
  if (finding.subjectRef.startsWith('.glirastes/')) return { kind: 'file', file, key: finding.subjectRef };
  return { kind: 'file', file, key: semantics ? semanticsKey(finding.subjectRef) : toolKey(finding.subjectRef) };
}

function developerCommand(code: string, tool: ToolsPipelineTool | undefined, subject: string): string {
  const name = tool?.definitionId ?? subject;
  switch (code) {
    case 'ui-action-write-unproven':
      return `glirastes tools policy raise ${name} write`;
    case 'risk-lower-available':
      return `glirastes tools policy accept ${name}`;
    case 'policy-entry-orphaned':
      return `glirastes tools policy reset ${JSON.stringify(subject)}`;
    default:
      return `glirastes tools policy show ${name}`;
  }
}

function resolveItem(finding: ToolFinding, tool: ToolsPipelineTool | undefined): ResolveWorkItem | undefined {
  const { code } = finding;
  const base = {
    tool: tool?.definitionId ?? finding.subjectRef,
    stableKey: tool?.stableKey ?? finding.subjectRef,
    toolId: tool?.toolId ?? null,
    code,
    severity: finding.severity,
    message: finding.message,
    files: tool?.files ?? [],
    evidence: tool ? evidenceOf(tool) : null,
    nextAction: finding.nextAction,
  };
  if (DEVELOPER_CODES.has(code)) {
    // A reviewed local entry already answers the D4 question for this tool.
    if (code === 'ui-action-write-unproven' && tool?.localPolicy) return undefined;
    return { ...base, owner: 'developer', target: { kind: 'developer', command: developerCommand(code, tool, finding.subjectRef) } };
  }
  if (code === 'resolution-rejected' || code === 'tool-semantics-invalid') {
    return { ...base, owner: 'agent', target: entryTarget(finding) };
  }
  if (code === 'auth-evidence-missing') {
    return {
      ...base,
      owner: 'agent',
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: 'conventions.authHelpers' },
      expected: { conventions: { authHelpers: ['<name of the session or auth helper this handler calls>'] } },
    };
  }
  if (DROPPED_CODES.has(code)) {
    // `src/a.tsx:12` or `src/a.tsx` when no tool exists for the registration.
    const files = tool ? tool.files : [finding.subjectRef.replace(/:\d+$/, '')];
    return { ...base, owner: 'agent', target: { kind: 'app-code', files } };
  }
  if (!tool) return undefined;
  if (code === 'contract-stale') {
    return tool.contract?.source === 'contract-module'
      ? { ...base, owner: 'agent', target: { kind: 'app-code', files: tool.files } }
      : { ...base, owner: 'agent', target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: toolKey(tool.stableKey) }, expected: resolutionEntryTemplate(tool) };
  }
  if (RESOLUTION_CODES.has(code)) {
    return {
      ...base,
      owner: 'agent',
      target: { kind: 'file', file: TOOLS_PATHS.resolutions, key: toolKey(tool.stableKey) },
      expected: resolutionEntryTemplate(tool),
    };
  }
  if (APP_CODE_CODES.has(code)) {
    const files = code === 'navigation-bridge-missing' ? layoutFiles(tool) : tool.files;
    return { ...base, owner: 'agent', target: { kind: 'app-code', files } };
  }
  return undefined;
}

function compareItems(left: ResolveWorkItem, right: ResolveWorkItem): number {
  return compareCodeUnits(left.tool, right.tool) || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.message, right.message);
}

/** Everything stage 1 could not decide, for `glirastes tools resolve --print`. */
export function buildResolveWorklist(result: ToolsPipelineResult): ResolveWorklist {
  const tools = new Map((result.tools ?? []).map((tool) => [tool.stableKey, tool] as const));
  const blocking = result.findings
    .filter((finding) => finding.severity === 'error' && !IGNORED_FOR_LISTS.has(finding.code)
      && !DEVELOPER_CODES.has(finding.code))
    .map(({ code, subjectRef, message, nextAction }) => ({ code, subjectRef, message, nextAction }));
  const seen = new Set<string>();
  const items: ResolveWorkItem[] = [];
  for (const finding of result.findings) {
    const key = `${finding.code}|${finding.subjectRef}|${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = resolveItem(finding, tools.get(finding.subjectRef));
    if (item) items.push(item);
  }
  return {
    schemaVersion: WORKLIST_SCHEMA_VERSION,
    kind: 'resolve',
    outputsCurrent: result.driftPaths.length === 0 && blocking.length === 0,
    blocking,
    items: items.sort(compareItems),
    next: 'Work through items owned by "agent", show items owned by "developer" to the developer, then run glirastes tools refresh and glirastes tools resolve --print again until no item is left.',
  };
}
