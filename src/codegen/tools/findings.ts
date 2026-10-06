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
  'contract-effect-invalid': 'Use one of read, write, destructive, external or financial as the effect in contract.ts, then run glirastes tools refresh.',
  'contract-presentation-invalid': 'Fix the presentation in contract.ts (locale, singular, plural and approval text, no other keys), then run glirastes tools refresh.',
  'schema-json-unavailable': 'Use zod v4 or install zod-to-json-schema so the schema can be described as JSON Schema.',
  'auth-evidence-missing': 'Call your session helper in the handler or list it in tool-resolutions.json conventions.authHelpers.',
  'contract-stale': 'Update the descriptive contract for the changed interface, then run glirastes tools refresh.',
  'handler-unresolved': 'Export the handler as a function or as a wrapper call around an inline function.',
  'contract-derived': 'Optional: validate the input with an exported Zod schema to give the model typed parameters.',
  'description-templated': 'Optional: add a JSDoc comment to the handler or a description in tool-semantics.json.',
  'output-contract-opaque': 'Optional: return a typed object or validate the response with an exported schema.',
  'resolution-rejected': 'Fix or remove the tool-resolutions.json or tool-semantics.json entry the message names; the tool keeps its fallback meanwhile.',
  'enrichment-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); it uses the contract derived from code meanwhile.',
  'semantics-stale': 'Optional: describe the changed tool again (glirastes tools describe --print <tool>); the earlier agent description stays in use meanwhile.',
  'definition-id-invalid': 'Use a contract id like resource.action (letters and digits, dot-separated).',
  'definition-id-conflict': 'Give one of the tools a distinct contract id.',
  'tool-semantics-invalid': 'Fix .glirastes/tool-semantics.json; descriptions fall back to code and templates meanwhile.',
  'prompt-bundle-missing': 'Create .glirastes/prompt-bundle.json for this app (glirastes init sets it up).',
  'prompt-bundle-invalid': 'Fix .glirastes/prompt-bundle.json: it must match its schema and this appId.',
  'generation-state-invalid': 'Restore the generated .glirastes file from git, or resolve its merge by keeping both sides, then rerun refresh.',
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
  'filter-definition-unreadable': 'Write the filter key, path and values as literals so glirastes tools refresh can read them.',
  'filter-key-reserved': 'Rename the URL parameter; params is reserved for route parameters of the filtered page.',
  'filter-key-invalid': 'Name the URL parameter with letters, digits, _ or - (starting with a letter or _, at most 64 characters) so the chat can set it; other names are left out of the filter tool.',
  'filter-keys-capped': `A filter tool takes at most ${MAX_FILTER_KEYS} URL parameters per view, the first in code-unit order. Read fewer URL parameters on the page and the components it renders, or move the others to another page, if the chat must set them.`,
  'ui-action-payload-untyped': 'Pass a payload contract (e.g. a Zod object) as the third argument of useAiClientAction or registerAiClientAction, or type the handler parameter.',
  'ui-action-contract-conflict': 'Register the action with one payload contract wherever it is handled.',
  'ui-action-id-dynamic': 'Register client actions with a literal id so the chat can call them.',
  'ui-action-id-invalid': 'Use an action id of letters, digits, dots and dashes, e.g. tasks.highlight.',
  'ui-action-id-reserved': 'Ids starting with glirastes. belong to the SDK; choose another action id.',
  'ui-action-write-unproven': 'If the handler changes data through a helper, a Server Action or a mutation hook, raise the tool: glirastes tools policy raise <tool> write. Otherwise nothing to do.',
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
  'tool-outputs-drift',
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
