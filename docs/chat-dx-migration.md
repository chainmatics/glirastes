# Chat integration changes after 0.14.0

## Stops and continuation

The standard chat shows a localized safety-budget notice outside collapsed activity details, including model-step count and configured step limit. Stored `data-pipeline-state` parts retain this explanation on reload. Completed plan items remain checked; pending and interrupted items remain visibly open. No budget defaults increased.

Plan guidance now batches status changes rather than requiring a model call for each start/end transition, and asks for a final summary. This reduces avoidable planning overhead but is guidance, not a measured provider-token guarantee. The independent Fieldwork run needed seven model steps for its three-read/checklist request, exceeding its default six. Configure `managedRuntime` budgets for your workload (for example `maxModelSteps: 10`, `maxToolCalls: 16`) while preserving timeout and cost ceilings. Measure `onFinish` step/usage data before changing defaults.

Continuation is an ordinary new user turn with preserved history, not automatic replay. Ask for the remaining read or summary rather than rerunning the whole request. The SDK does not automatically repeat mutations at a budget stop. Existing approval checks remain mandatory; applications must reconcile uncertain outcomes and use business idempotency keys for mutations. A prompt cannot provide exactly-once execution across separate model-generated requests.

## Approval details

`collectEntityNames` reads finished assistant tool results, including short string IDs such as `job-107`; it ignores tool inputs, user messages, unfinished calls and failed outputs. UUID matching is case insensitive; short identifiers remain case sensitive. Globally collected UUID names can replace ID values for `id`, `…Id` and `…_id` fields. Short IDs require an explicit argument-path association using `entityNames`, for example `{ technicianId: new Map([['1', 'Mara']]), 'job.id': jobsById }`. Supply only authorized records. Human-readable `nameLabels` do not establish entity identity. Original approval arguments and identifiers remain unchanged.

Use `createApprovalDescriptionGenerator({ fieldLabels, nameLabels, valueTranslations })` for domain wording. Example: `fieldLabels: { technicianId: 'Techniker', notes: 'Notizen' }`, `valueTranslations: { status: { scheduled: 'Eingeplant' } }`. These are presentation mappings, never argument rewrites. The SDK cannot infer the intended business translation of arbitrary schema values. Only records returned under the user's current permissions should enter the conversation; scope session storage per app, tenant and user.

## Sessions, theme and results

The local session store inherits `locale.newChatLabel` for unnamed empty conversations. Explicit `newTitle`, derived conversation titles and user renames retain precedence. Custom session stores can implement the optional `setDefaultTitle` localization hook.

Standalone assistant toggle/bubble buttons inherit provider CSS variables, as the shell and panel already do. Custom `renderButton` implementations should forward the supplied `style` together with labels and actions. At narrow widths the shell keeps controls fixed-width and allows the session title to shrink; host sidebars still need an appropriate responsive layout.

When result renderers are registered and no `toolResults` policy is provided, only their definition/model names are shown. This avoids exposing unrelated discovery/read JSON blocks. To retain the previous behavior explicitly use `toolResults={{ mode: 'default' }}`. An invalid result schema for an allowed renderer still uses its safe fallback.

## Independent routing measurement

`routing-paraphrases.test.ts` adds eight held-out German/English requests and four ambiguous phrases against the existing 101-tool fixture, without changing its synonyms. Seven requests include the desired tool initially; the English customer-follow-up request needs `find_tools` with `create task`, which recovers it. Average start set: 10.125 tools, maximum 11. This measures availability and deterministic search recovery, not final model choices. No provider calls were made and no token savings are claimed. The machine-readable report is in `docs/evidence/fieldwork-dx/routing-paraphrases.json`.

Globally collected short IDs are never automatically substituted into approval arguments, even when only one record is known. Short IDs that occur with conflicting names are treated as ambiguous for the entire conversation scan and are never automatically substituted. A subsequent repeat of either name does not resolve this ambiguity. Explicit `hiddenFields` suppress automatic name substitution, including nested containers. The pre-existing explicit `nameLabels` opt-in still permits displaying a known name for a hidden ID field; omit that opt-in when the name itself must remain hidden.
