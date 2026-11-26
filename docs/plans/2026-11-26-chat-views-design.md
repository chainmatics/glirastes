# Chat Views: generative UI from the app's own components

Status: approved concept (2026-11-26), discussed with Fable in three rounds.
Optional feature. Off by default; an app that never enables it sees no new
tool, no new part and no new prompt text.

## Intent

The model can show results inside the chat as a small composed view
(a card with a table, a few key figures, a status overview) built from
**granular components the app itself provides**, instead of only text or a
fixed per-tool renderer. The composition is generative; the data is not:
every business value in a view comes from a real tool result.

A coding agent must be able to set the feature up end to end from the
packaged skill (`building-glirastes-chat-ui`) and the upgrade note.

## Goals

- The model composes a view from a declared component catalog via one
  built-in tool, `render_view`.
- Values are **references** to tool results; the server resolves them and
  ships a self-contained, resolved view to the client.
- The contract is framework- and medium-neutral: React is the first binding,
  a deterministic text renderer is the second (also the fallback for every
  client without a binding).
- App components are first-class; the SDK starter catalog is optional.
- Persisted messages keep rendering after the catalog evolves (versioned
  components, per-element fallback, never a crash).

## Non-goals (this cut)

Free HTML/CSS/JS; `className`, colors, pixel sizes in a spec; an expression
language; forms and two-way binding; live data or refetch; partial streaming
render; Charts; tool-run actions (approval path) from a view; Platform
governance of the catalog; Web Components and native bindings; a shadcn
registry distribution. Each of these is a later, separate step.

## Anti-goals

- A view that shows a value no tool returned and does not say so.
- A view button that grants anything the typed request would not.
- Real (de-pseudonymized) values in a view while the PII shield is on: the
  browser gets the shielded form, exactly like every tool part, overview and
  approval card today (`docs/concepts.md`, `approval-subject-lookup.ts`).
- Projection data flowing back into model input.

## Approaches considered

| | What the model emits | Verdict |
|---|---|---|
| **A: spec with data references** (chosen) | Layout + references into tool results | Values cannot be hallucinated; few tokens; PII shield and field filters apply because the source already passed them |
| B: spec with inline data | Layout + values written by the model | Hallucination of amounts/ids, double token cost, a second data path that must be filtered again |
| C: curated templates only | Template id + source | Robust but not generative; it is today's tool-result renderer with a picker |

C survives inside A: existing tool-result renderers can later be offered as
composite components.

## Architecture: three layers

1. **Contract** (`src/contracts/chat-view.ts`, Zod, no React):
   the spec the model writes, the catalog manifest, the resolved view, limits,
   and the reference grammar. Conformance vectors under
   `src/contracts/__vectors__/`.
2. **Resolved view**: produced by the server; its own versioned shape
   (`v: 1`), not "the spec with values pasted in". Clients depend only on it.
3. **Bindings**: map `type` → a component of the host. React binding in
   `glirastes/react`; text renderer in a neutral module (usable on server,
   browser, CLI).

## The catalog

Authoring (TypeScript): `defineChatComponent({ id, schemaVersion,
description, whenToUse?, props, children?, text })` with Zod props.
`bindable()` marks props that accept references; id-like and list props
accept **only** references.

The **source of truth at runtime is a JSON manifest** (JSON Schema subset, no
Zod refinements or transforms) so a non-TypeScript host or the runtime
container can validate. The SDK ships the starter catalog's manifest entries;
an app adds its own. Each entry carries a `text` rule (which prop is the
label, which the value / rows) so the server can derive the text fallback
for app components too.

Starter catalog (semantic, not visual): `Group` (`emphasis`), `Card`
(`title`), `Text`, `KeyValue`, `Table` (rows by reference, ≤ 8 columns, cell
element per column), `StatusBadge` (`tone` enum), `EntityLink` (declared
entity type + record reference), `Money` (amount + currency, typed),
`DateTime` (ISO, typed), `Stat` (one figure, see "Model statements"),
`Action`.

Formatting (currency, date, locale) happens in the binding with the page
language, never as pre-formatted strings in the view.

**Prompt budget.** The tool's input schema stays generic
(`elements: Record<id, { type, props, children? }>` + `root`). The catalog
goes into the tool description as one signature line per component plus
`whenToUse`; a test caps the catalog text (target ≤ 600 tokens for the
starter catalog). Strict validation is the server's job.

## The `render_view` tool

Built-in UI tool, registered only when `chatViews` is configured, listed in
`NON_DOMAIN_TOOL_NAMES`, kept through scoping like the other built-ins, and
excluded from argument rehydration (like `read_result`).

Input: `{ root, elements, caption? }`. Flat element map (makes depth and
cycle checks trivial). Limits: ≤ 60 elements, depth ≤ 6, spec ≤ 8 KB,
literal strings ≤ 200 chars, ≤ 50 table rows, projection ≤ 64 KB.

`execute` (server):

1. Validate structure against the manifest **filtered by what the client can
   render** (see Capabilities). Unknown component, bad prop, missing path →
   `success: false` with a precise message so the model can correct once;
   loop detection applies as for any tool.
2. Resolve every reference:
   - current turn: against the full result where the turn's result store
     holds it (owner-bound and guarded exactly like `read_result`), else
     against the tool output of that call;
   - earlier turns: against the tool parts the client sent in this request
     (unique ids are already enforced by `assertUnambiguousToolHistory`).
   A path that does not resolve is an error to the model, not an empty cell.
3. Build the **projection**: only referenced fields, row-limited, size-capped.
   Values stay in the shielded form they have everywhere else; a projection
   taken from the store is marked as issued so it is not sealed twice.
4. The tool output is `{ shown: true, elements: n, view }`: the browser
   reads the resolved view from the persisted tool part. The model never sees
   `view`: in the current turn through the AI SDK's `toModelOutput` on this
   tool (the engine gains optional `toModelOutput` support for tools that
   declare it), in later turns through a model-input transform in
   `prepare-model-messages` (next to `stripUiActionsFromToolResults`).
   (Implementation decision 2026-11-26: simpler than a separate
   `data-chat-view` part, which would need a stream writer inside `execute`.)

One view per turn. Rule text in the tool description: default is text; a view
only for ≥ 4 like records, a comparison or a status overview; never for single
values, confirmations or questions; never just to wrap a single result that
already has its own tool-result renderer. (The server does not know the
browser's renderers, so this last rule is prose only in this cut.)

## Data binding

- `{ "$ref": "<toolCallId>", "path": "data[]" }` — same path grammar as
  `outputAllowedFields` / `read_result`; no second language.
- `{ "$item": "total" }` inside a per-row element.
- Operators (deterministic, resolved on the server): `$count`, `$sum`
  (more later only by need).
- **Model statements:** only `Stat.value` may be `{ "$said": "12.400 €",
  "basis": { "$ref": … } }`. The binding must mark it ("computed by the
  assistant"); the mark lives in the SDK wrapper, not in app CSS. Forbidden
  in table cells, ids and action arguments. The server error points to
  `$count` / `$sum` when the value is expressible that way.
- References to earlier turns are allowed while the part is in the loaded
  history. To let the model know what is referenceable after history
  compaction, the model input gets a content-free **source memo** (call id,
  tool, row count, field names; ≤ 10 entries) next to the seen-objects memo.

## Capabilities (client → server)

Each request may carry the client's bound components
(`[{ id, schemaVersion }]`) and a `surface` hint (`narrow` | `workspace`).
Both only **restrict**: the server offers the model the intersection of
manifest and client list, and narrow surfaces get tighter limits (≤ 3 table
columns). No list → the server offers the full manifest (React default).
Not trusted for anything but narrowing.

## Interactivity (this cut)

`Action` with exactly two targets, both existing paths:

- `prompt`: sends a prepared user message;
- `uiAction`: a registered client action id through the UI action bus with the
  outcome protocol.

Labels are mandatory. Tool runs from a view (approval card, RBAC, budget) are
the next step and require a client capability flag.

## Rendering and robustness

- React: `message-bubble` gets a branch for the `render_view` tool part that
  reads the matching `data-chat-view` part and renders through a component
  registry (`createChatViewRegistry`, versioned resolution like
  `createToolResultRendererRegistry`) inside the renderer boundary.
  Default implementations are unstyled-capable (`data-component` /
  `data-element` attributes, honouring `unstyled`).
- Browser re-validates props of each element against its schema version.
  Unknown component or invalid props → that element falls back to its text
  rendering; the root failing → the text rendering of the whole view.
- The view is a snapshot; it shows no live data.
- Text renderer: `chatViewToText(view, manifest)`; deterministic Markdown
  (table / list / key-value lines). Derived, never persisted separately.

## Setup for a coding agent

- Server: `chatViews: { catalog }` in the handler config (`createGlirastes`
  spread and container `chat.chatViews` follow the existing option paths).
- Codegen: a scanner (template: `codegen/tools/sources/react-actions.ts`)
  collects `defineChatComponent` definitions into
  `.glirastes/chat-components.json`.
- React: `<AiChatProvider chatViews={{ components: [...bindings] }}>` or the
  equivalent provider option; starter bindings work without any app code.
- Skill: new reference `skills/building-glirastes-chat-ui/references/chat-views.md`
  (enable, add a component, bind, test), handler-options entry, and an
  upgrade note with `kind: "optional"` and `adoptedWhen` so
  `glirastes upgrade` offers it.
- Docs: `docs/chat-views.md`, support matrix row.

## Left to the builder

Exact option names and file placement within the conventions above; how the
current-turn result is looked up by tool call id (a per-turn id → handle/output
map recorded in the tool middleware is the expected route); default styles;
whether the turn ends after a successful `render_view` (only if the engine
supports a stop condition cleanly; otherwise the model may add a short text).
