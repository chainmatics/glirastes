import { compareCodeUnits } from './canonical.js';
import { MAX_FILTER_KEYS } from './files.js';
import type { ToolFinding, ToolFindingSeverity } from './types.js';

const NEXT_ACTIONS: Readonly<Record<string, string>> = {
  'input-contract-unresolved': 'Validate the request with an exported Zod schema, add a sibling contract.ts, or add a .glirastes/tool-resolutions.json entry, then run glirastes tools refresh.',
  'input-role-unclear': 'Parse request.json(), the search params or params directly with the exported schema, or declare your reader in tool-resolutions.json conventions.',
  'input-role-unsupported': 'Send write parameters in the body and read parameters in the query string, or describe the tool in tool-resolutions.json.',
  'parameter-collision': 'Rename the path, query or body parameter so every name has exactly one role.',
  'schema-not-exported': 'Export the schema from an app module (for Next.js a sibling contract.ts) and import it in the handler.',
  'schema-module-unloadable': 'Make the schema module importable without side effects: no database, network or secrets at import time.',
  'schema-content-rejected': 'Remove secret-looking values (defaults, consts, descriptions, hints) from the schema or contract metadata; secrets must never reach committed outputs.',
  'input-schema-not-object': 'Give the tool an object input schema (one object with optional fields, or one field that holds the variants); an internal route can be excluded by the developer instead (glirastes tools policy exclude).',
  'mcp-tool-names-invalid': 'Fix .glirastes/mcp-tool-names.json: per endpoint stable key a list of { id, name }, every id and MCP name (letters, digits, _ and -, at most 64) used once, and not already used by another tool under its generated id or name; MCP clients see the generated names meanwhile.',
  'contract-effect-invalid': 'Use one of read, write, destructive, external or financial as the effect in contract.ts, then run glirastes tools refresh.',
  'contract-presentation-invalid': 'Fix the presentation in contract.ts (locale, singular, plural and approval text, no other keys), then run glirastes tools refresh.',
  'schema-json-unavailable': 'Use zod v4 or install zod-to-json-schema so the schema can be described as JSON Schema.',
  'auth-evidence-missing': 'Call your session helper in the handler or list it in tool-resolutions.json conventions.authHelpers. For an OpenAPI export: declare the security scheme on the operation (FastAPI: a Security dependency such as APIKeyCookie or HTTPBearer).',
  'route-hidden': 'Nothing to do while the route must stay out of the chat. Otherwise remove include_in_schema=False, export the OpenAPI document again and run glirastes tools refresh.',
  'schema-reference-unresolved': 'Optional: replace the recursive or external $ref by an inline schema so the model sees the shape; the server keeps validating meanwhile.',
  'schema-uncompilable': 'Fix the schema keyword the message names in the OpenAPI export (it must be valid JSON Schema), export the document again and run glirastes tools refresh; to keep the operation out of the chat instead, glirastes tools policy exclude "<METHOD> <path>".',
  'contract-stale': 'Update the descriptive contract for the changed interface, then run glirastes tools refresh.',
  'handler-unresolved': 'Export the handler as a function or as a wrapper call around an inline function.',
  'contract-derived': 'Optional: validate the input with an exported Zod schema to give the model typed parameters.',
  'description-templated': 'Optional: add a JSDoc comment to the handler or a description in tool-semantics.json.',
  'output-contract-opaque': 'Optional: return a typed object or validate the response with an exported schema.',
  'resolution-rejected': 'Fix or remove the tool-resolutions.json or tool-semantics.json entry the message names; the tool keeps its fallback meanwhile.',
  'enrichment-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); it uses the contract derived from code meanwhile.',
  'semantics-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); the earlier agent description stays in use meanwhile.',
  'definition-id-invalid': 'Use a tool name like resource.action or list_tasks (starts with a lowercase letter; letters, digits and _, dot-separated) as the contract id or OpenAPI x-glirastes-name, then run glirastes tools refresh.',
  'definition-id-conflict': 'Give one of the tools a distinct contract id or OpenAPI x-glirastes-name, then run glirastes tools refresh.',
  'definition-id-reassigned': 'The name moved to another tool and the earlier holder was renamed. If that is intended, check .glirastes/tool-semantics.json: an entry matched by "name" now describes the new holder, so key the entries of both tools by "stableKey" ("METHOD /path") or move them. Otherwise give this tool a name no other tool holds (contract id or OpenAPI x-glirastes-name). Then run glirastes tools refresh. Policy, resolutions and tool ids are keyed on METHOD /path and are unaffected.',
  'tool-marker-invalid': 'Set x-glirastes-tool to true or false (a JSON boolean) on the operation in the OpenAPI export, export it again and run glirastes tools refresh.',
  'opt-in-excluded': 'The operation is marked x-glirastes-tool: true, but the rule the message names excludes it. Remove the marker if the exclusion is intended; otherwise remove x-glirastes-ignore, the matching exclude entry in .glirastes/tool-policy.json, or make the operation supported (JSON body, GET/POST/PUT/PATCH/DELETE/HEAD, plain path parameters).',
  'tool-group-invalid': 'Set x-glirastes-group on the operation to a non-empty string of at most 200 characters (for example tag), export the OpenAPI document again and run glirastes tools refresh.',
  'max-result-chars-invalid': 'Set x-glirastes-max-result-chars on the operation (or maxResultChars in contract.ts) to an integer from 1000 to 200000, or remove it to keep the handler\'s limit; export the OpenAPI document again and run glirastes tools refresh.',
  'output-allowed-fields-invalid': 'Set x-glirastes-output-allowed-fields on the operation (or outputAllowedFields in contract.ts) to a list of at most 200 field paths such as "data[].name" or "meta" (no index such as [2]), or remove it; export the OpenAPI document again and run glirastes tools refresh. The tool stays disabled until then.',
  'output-denied-fields-invalid': 'Set x-glirastes-output-denied-fields on the operation (or outputDeniedFields in contract.ts) to a list of at most 200 field paths such as "data[].variants[].fileUrl" (no index such as [2]), or remove it; export the OpenAPI document again and run glirastes tools refresh. The tool stays disabled until then.',
  'output-default-fields-invalid': 'Set x-glirastes-output-default-fields on the operation (or outputDefaultFields in contract.ts) to a list of at most 200 field paths such as "data[].name" (no index such as [2]), or remove it; export the OpenAPI document again and run glirastes tools refresh.',
  'output-field-unknown': 'Correct the path the message names to a field of the response schema (a list response travels under data: "data[].name"), or remove it; a misspelt denied path excludes nothing. Export the OpenAPI document again and run glirastes tools refresh.',
  'output-default-fields-outside-allowed': 'List only allowed fields in x-glirastes-output-default-fields (outputDefaultFields), or allow the missing ones in x-glirastes-output-allowed-fields (outputAllowedFields); then run glirastes tools refresh.',
  'output-default-fields-denied': 'Remove the denied paths from x-glirastes-output-default-fields (outputDefaultFields), or stop denying them in x-glirastes-output-denied-fields (outputDeniedFields); then run glirastes tools refresh.',
  'output-denied-key-unmatched': 'Correct the pattern in output.deniedFields of .glirastes/tools.json to the key the responses use (names match exactly, case included), or remove it; then run glirastes tools refresh. Ignore it if the key only occurs in undeclared parts of the responses.',
  'output-schema-unprojected': 'Optional: inline the $ref or replace patternProperties / the open additionalProperties in the response schema so the output contract can be reduced as well; results are reduced either way.',
  'tool-roles-invalid': 'Set x-glirastes-roles on the operation to a list of at most 50 role names (non-empty strings), or [] for no restriction, export the OpenAPI document again and run glirastes tools refresh; the tool stays disabled until then.',
  'policy-roles-disjoint': 'Nobody may call the tool, so it is disabled. In .glirastes/tool-policy.json, set allowedRoles of the tool to roles the code also declares (the entry can only narrow them) or remove allowedRoles; or change x-glirastes-roles in the OpenAPI export. If the tool is meant to be off, set "enabled": false instead. Then run glirastes tools refresh.',
  'semantics-entry-orphaned': 'Re-key the entry in .glirastes/tool-semantics.json to the operation it describes: "stableKey": "METHOD /path" as in the tool report (e.g. "GET /api/tags"), or the tool\'s current "name"; or delete it. Then run glirastes tools refresh. Its texts are not used meanwhile.',
  'semantics-overrides-code': 'Nothing to do if the tool-semantics.json text is the one to keep: since 0.18.0 a maintained entry (written by a person or locked) beats JSDoc, the OpenAPI description and contract.ts. Otherwise delete the field from the entry, or copy the code text into it, then run glirastes tools refresh.',
  'label-translation-missing': 'Add the label in that language: a presentation or title per language in .glirastes/tool-semantics.json, x-glirastes-title on the OpenAPI operation or title in contract.ts; then run glirastes tools refresh. The tools show the fallback (English, else the first language) meanwhile.',
  'tool-semantics-invalid': 'Fix .glirastes/tool-semantics.json; descriptions fall back to code and templates meanwhile.',
  'prompt-bundle-missing': 'Create .glirastes/prompt-bundle.json for this app (glirastes init sets it up).',
  'prompt-bundle-invalid': 'Fix .glirastes/prompt-bundle.json: it must match its schema and this appId.',
  'generation-state-invalid': 'Restore the generated .glirastes file from git, or resolve its merge by keeping both sides, then rerun refresh.',
  'route-declared-twice': 'Declare the route in one controller only (or rename one path), then run glirastes tools refresh; to keep it out of the chat instead, glirastes tools policy exclude "<METHOD> <path>". Every other tool is generated meanwhile.',
  'E-INVENTORY-010': 'Resolve the duplicate tool identity reported above, then rerun glirastes tools refresh.',
  'E-INVENTORY-011': 'Replace export * in route files and fix unreadable or linked sources so every route, page and UI action can be enumerated.',
  'E-POLICY-001': 'Fix .glirastes/tool-policy.json so it matches its schema; policy can only restrict what the code allows.',
  'risk-raised': 'Nothing to do: confirmation is enforced automatically. Review the change in your diff.',
  'override-lapsed-risk-raised': 'Your relaxation no longer applies at the higher risk; review whether you still need it.',
  'risk-lower-available': 'After review, record an acceptedRisk entry in .glirastes/tool-policy.json to adopt the lower risk.',
  'policy-entry-orphaned': 'Remove the entry (glirastes tools policy reset <tool>), restore the tool, or include an excluded route again (glirastes tools policy include <pattern>).',
  'tool-outputs-drift': 'Run glirastes tools refresh locally and commit .glirastes together with the generated module.',
  'tool-output-invalid': 'Regenerate the outputs with glirastes tools refresh; never edit generated files.',
  'generated-output-invalid': 'Nothing was written: the code produced a value past a limit of the generated file (a name, path or list the message names). Shorten or split it in the code, then rerun glirastes tools refresh; if the code is within reason, report it as a Glirastes bug.',
  'integrity-chain-broken': 'Regenerate the outputs with glirastes tools refresh and commit them; never edit generated files.',
  'output-path-linked': 'Replace the linked .glirastes or output folder with a real folder inside the app.',
  'setup-plan-invalid': 'Delete .glirastes/previous-setup-artifact.json left by glirastes setup; git keeps the history.',
  'navigation-bridge-missing': 'Call useGlirastesNavigationBridge({ push: router.push }) (glirastes/react) or registerNavigationBridge({ push }) (glirastes/browser) in code that is always mounted, then run glirastes tools refresh.',
  'page-path-duplicated': 'Keep one page per path; navigation uses the first page file in code-unit order.',
  'filter-domain-open': 'Optional: give the URL parameter a closed domain, e.g. parseAsStringLiteral([...]) or a defineQueryFilters value list.',
  'filter-domain-conflict': 'Read the URL parameter with one parser on the page and its components.',
  'filter-parser-unsupported': 'Use parseAsString, parseAsInteger, parseAsFloat, parseAsBoolean, parseAsStringLiteral or parseAsArrayOf for parameters the chat may set.',
  'filter-path-unrouted': 'Add a route for the path, or correct the path of defineQueryFilters, then run glirastes tools refresh.',
  'filter-definition-unreadable': 'Write the filter key, path and values as literals so glirastes tools refresh can read them.',
  'filter-key-reserved': 'Rename the URL parameter; params is reserved for route parameters of the filtered page.',
  'filter-key-invalid': 'Name the URL parameter with letters, digits, _ or - (starting with a letter or _, at most 64 characters) so the chat can set it; other names are left out of the filter tool.',
  'filter-keys-capped': `A filter tool takes at most ${MAX_FILTER_KEYS} URL parameters per view, the first in code-unit order. Read fewer URL parameters on the page and the components it renders, or move the others to another page, if the chat must set them.`,
  'ui-action-payload-untyped': 'Pass a payload contract (e.g. a Zod object) as the third argument of useAiClientAction or registerAiClientAction, or type the handler parameter.',
  'ui-action-import-unresolved': 'Make the named import resolvable with the tsconfig the message names: add its path alias (paths/baseUrl) there, or name the tsconfig that has it as "tsconfig" of the source in .glirastes/tools.json (by default the nearest tsconfig.json from srcDir up to the app root is used), then run glirastes tools refresh.',
  'ui-action-contract-conflict': 'Register the action with one payload contract wherever it is handled.',
  'ui-action-contract-unprobed': 'Optional: export the zod payload contract from a module of this app that imports nothing but zod (no components, styles or side effects at import time) and pass that export to the registration, then run glirastes tools refresh; the tool keeps the payload type read from TypeScript meanwhile.',
  'ui-action-contract-mismatch': 'Make the TypeScript type of the payload contract match the zod schema (drop the cast or type annotation, or let z.infer type the handler), then run glirastes tools refresh; the tool follows the zod schema meanwhile.',
  'ui-action-id-dynamic': 'Register client actions with a literal id so the chat can call them.',
  'ui-action-id-invalid': 'Use an action id of letters, digits, dots and dashes, e.g. tasks.highlight.',
  'ui-action-id-reserved': 'Ids starting with glirastes. belong to the SDK; choose another action id.',
  'ui-control-unbound': 'Add the proposed useAiClientAction (expected.registration) in expected.file, inside the component that owns the state and stays mounted, with imports from glirastes/react and zod; keep the action id. If the chat must not set it, the developer runs glirastes tools policy exclude-control <file>#<setter> --reason <text>.',
  'ui-control-contract-mismatch': 'Restrict the payload contract of the client action to the values the setter takes, e.g. z.enum of the same const list.',
  'ui-action-route-invalid': 'Pass route as a string literal of a static app path, e.g. { route: \'/templates\' } (one leading slash, no query, hash or :param), or remove it when the action works on every page, then run glirastes tools refresh.',
  'ui-action-route-conflict': 'Register the action with the same route everywhere, or only in the page component that owns the effect, then run glirastes tools refresh.',
  'ui-action-indirect': 'Register the action in the component that owns the effect (the dialog or state it changes) instead of relaying a window event; if that component lives on one page, pass its path as route, e.g. useAiClientAction(id, handler, contract, { route: \'/templates\' }).',
  'ui-action-effect-invalid': 'Write the effect in the options of the registration as a literal: { effect: \'read\' }, \'write\', \'destructive\', \'external\' or \'financial\', then run glirastes tools refresh. The tool stays disabled until then.',
  'ui-action-effect-conflict': 'Declare the same effect wherever the action is registered, then run glirastes tools refresh; the strongest declaration applies meanwhile.',
  'ui-action-effect-contradicted': 'The handler sends a non-GET request, so the tool stays write: correct the declaration to { effect: \'write\' } (or stronger), or stop writing in the handler, then run glirastes tools refresh.',
  'ui-action-write-unproven':'If the handler changes data through a helper, a Server Action or a mutation hook, raise the tool: glirastes tools policy raise <tool> write. Otherwise nothing to do.',
};

/**
 * E-POLICY-002 remediation depends on why the relaxation was rejected: an
 * unpinned tier-2 relaxation can be adopted through a reviewed pin, while a
 * tier-3 relaxation can never be adopted.
 */
const POLICY_RELAXATION_ACTIONS: Readonly<Record<string, string>> = {
  'relaxation-requires-reviewed-pin': 'Add a reviewed pin (glirastes tools policy relax … --yes) to adopt the relaxation, or remove it from .glirastes/tool-policy.json.',
  'tier-3-always-requires-approval': 'Remove the relaxation: delete, financial and external tools always confirm.',
};
const POLICY_RELAXATION_FALLBACK = POLICY_RELAXATION_ACTIONS['tier-3-always-requires-approval']!;

/** Findings that describe a change relative to the previous state; never written to outputs. */
export const TRANSIENT_FINDING_CODES: ReadonlySet<string> = new Set([
  'risk-raised',
  // Relative to the previous inventory: gone once the refresh that reported it wrote the new names.
  'definition-id-reassigned',
  'tool-outputs-drift',
  // The precedence change of 0.18.0 made visible on every refresh, never stored.
  'semantics-overrides-code',
]);

const SEVERITY_ORDER: Readonly<Record<ToolFindingSeverity, number>> = {
  error: 0,
  needs_attention: 1,
  warning: 2,
};

function own(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** `reason` only refines `E-POLICY-002`; every other code ignores it. */
export function nextActionFor(code: string, reason?: string): string {
  if (code === 'E-POLICY-002') {
    return (reason === undefined ? undefined : own(POLICY_RELAXATION_ACTIONS, reason))
      ?? POLICY_RELAXATION_FALLBACK;
  }
  return own(NEXT_ACTIONS, code) ?? 'Fix the reported code, then run glirastes tools refresh.';
}

export function toolFinding(
  code: string,
  severity: ToolFindingSeverity,
  subjectRef: string,
  message: string,
  reason?: string,
): ToolFinding {
  return { code, severity, subjectRef, message, nextAction: nextActionFor(code, reason) };
}

export function sortFindings(findings: ReadonlyArray<ToolFinding>): ToolFinding[] {
  return [...findings].sort((left, right) => (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.subjectRef, right.subjectRef)
    || compareCodeUnits(left.message, right.message)
  ));
}
