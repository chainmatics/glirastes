# Chat Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional generative UI: the model composes a view from the app's declared component catalog via a built-in `render_view` tool; the server resolves data references into a self-contained view that React (and a text renderer) display.

**Architecture:** Neutral core in `src/chat-views/` (catalog authoring, manifest, validation, resolution, text rendering) on top of a Zod contract in `src/contracts/chat-view.ts`. The Next.js chat handler registers `render_view` only when `chatViews` is configured; React renders the view from the persisted tool part through a versioned component registry with per-element text fallback.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod 4 (`z.toJSONSchema`), AI SDK 6, React, Vitest, Bun.

**Spec:** `docs/plans/2026-11-26-chat-views-design.md` (read it first; it is the source of every rule below).

## Global Constraints

- Feature is off unless `chatViews` is configured: no tool, no prompt text, no request field, byte-identical stream otherwise (assert this in Task 6).
- `src/contracts` imports nothing from engines, providers, React. After any change there: `bun run build`.
- No new package subpath. Neutral API is exported from the root `glirastes` barrel; React API from `glirastes/react`; server config types from `glirastes/server` where handler config types already live.
- Limits (constants in the contract, named exactly): `CHAT_VIEW_LIMITS = { maxElements: 60, maxDepth: 6, maxSpecBytes: 8192, maxLiteralChars: 200, maxTableRows: 50, maxTableColumns: 8, maxNarrowTableColumns: 3, maxProjectionBytes: 65536, maxSourceMemoEntries: 10 }`.
- Tool name: `render_view` (constant `RENDER_VIEW_TOOL_NAME`), added to `NON_DOMAIN_TOOL_NAMES`, excluded from PII argument rehydration like `read_result` (`plainArgsTool`).
- PII: view values stay in the shielded form; never call `rehydrateArgs`/`inbound` on a projection.
- No `className`, `style`, colors, pixel sizes, URLs or HTML in specs or views.
- Every public API change: skill update + `upgrade-notes/unreleased/chat-views.json` (`kind: "optional"`) in this branch (`src/upgrade-notes.test.ts`).
- Commit per task with Conventional Commits; no AI attribution.

## Review Focus

1. A reference to a field cut by `outputDefaultFields`/overview → precise error to the model naming `read_result`, never an empty cell. (Task 4 test `resolve: missing path names read_result`.)
2. Stored message written with component `schemaVersion` 1 rendered after the app only binds version 2 → element falls back to text, rest of the view renders. (Task 7 test `renders old version via text fallback`.)
3. PII shield on → view shows the same pseudonyms as the source tool part, and `render_view` args are not rehydrated. (Task 6 test `pii: projection stays shielded`.)
4. Model writes `$said` in a table cell or action argument → rejected with a message pointing to `$count`/`$sum`. (Task 3 test.)
5. Later turn: the projection (`view`) never appears in model input, also after history compaction. (Task 6 test `history: view stripped from model input`.)

---

### Task 1: Contract `chat-view`

**Files:**
- Create: `src/contracts/chat-view.ts`, `src/contracts/__tests__/chat-view.test.ts`, `src/contracts/__vectors__/chat-view.v1.json`
- Modify: `src/contracts/index.ts` (export)

**Interfaces — Produces:**
- `RENDER_VIEW_TOOL_NAME = 'render_view'`, `CHAT_VIEW_LIMITS` (values above).
- `chatValueRefSchema`: `{ $ref: string; path: string }`; `chatItemRefSchema`: `{ $item: string }`; `chatOperatorSchema`: `{ $count: ChatValueRef } | { $sum: ChatValueRef }`; `chatSaidSchema`: `{ $said: string (≤200); basis: ChatValueRef }`.
- `chatViewSpecSchema` (model input): `{ root: string; elements: Record<string, { type: string; props: Record<string, unknown>; children?: string[] }>; caption?: string (≤200) }`. Element ids match `/^[A-Za-z0-9_-]{1,40}$/`.
- `chatComponentManifestEntrySchema`: `{ id: string; schemaVersion: number (int ≥1); description: string; whenToUse?: string; props: JsonSchemaObject; bindable: string[]; refOnly: string[]; children: 'none' | 'any' | string[]; itemScope?: { rowsProp: string; cellsProp: string }; text: { label?: string; value?: string; rows?: string; columns?: string } }`.
- `chatComponentManifestSchema`: `{ v: 1; components: ChatComponentManifestEntry[] }`; `chatComponentManifestDigest(manifest): string` (sha-256 hex of canonical JSON; use the repo's existing canonical-JSON helper if one exists in `src/contracts`, else a sorted-keys stringify).
- `resolvedChatViewSchema` (browser contract, `v: 1`): `{ v: 1; root: string; caption?: string; elements: Record<string, { type: string; schemaVersion: number; props: Record<string, unknown>; children?: string[]; rows?: Array<Record<string, unknown>>; said?: true }> }`. For `Table`-like components (`itemScope`), `rows` holds per-row resolved cell props keyed by cell element id.
- `chatViewCapabilitiesSchema` (request body): `{ components?: Array<{ id: string; schemaVersion: number }>; surface?: 'narrow' | 'workspace' }`.
- Types inferred with `z.infer` under the same names without `Schema`.

- [ ] Step 1: test `parses vector chat-view.v1.json` (vector holds one valid spec, one manifest, one resolved view; all parse) and `rejects element id with space`, `rejects caption over 200 chars`.
- [ ] Step 2: run `bunx vitest run src/contracts/__tests__/chat-view.test.ts` → FAIL.
- [ ] Step 3: implement; export from `src/contracts/index.ts`.
- [ ] Step 4: tests PASS; `bun run build` succeeds.
- [ ] Step 5: commit `feat(contracts): chat view spec, manifest and resolved view`.

### Task 2: Catalog authoring and starter catalog

**Files:**
- Create: `src/chat-views/define.ts`, `src/chat-views/starter-catalog.ts`, `src/chat-views/describe.ts`, `src/chat-views/index.ts`, `src/chat-views/__tests__/catalog.test.ts`
- Modify: `src/index.ts` (export `./chat-views/index.js`)

**Interfaces — Consumes:** Task 1 types. **Produces:**
- `bindable<T extends z.ZodType>(schema: T)`: marks a prop as accepting a value, `ChatValueRef`, `ChatItemRef` (and, only for `Stat.value`, `ChatOperator | ChatSaid`). `refOnly(schema?)`: prop accepts only `ChatValueRef`/`ChatItemRef`. Marks are read by `defineChatComponent` (store on a WeakMap or zod `meta`).
- `defineChatComponent<P extends z.ZodRawShape>(def: { id: string; schemaVersion: number; description: string; whenToUse?: string; props: z.ZodObject<P>; children?: 'none' | 'any' | string[]; itemScope?: {...}; text: {...} }): ChatComponentDefinition<P>`; throws on invalid id (`/^[A-Z][A-Za-z0-9]{0,39}$/`) or non-integer version.
- `toChatComponentManifest(defs: ChatComponentDefinition[]): ChatComponentManifest` using `z.toJSONSchema`; throws on duplicate `id@schemaVersion` and on schemas that use refinements/transforms (manifest is a JSON Schema subset).
- `starterChatComponents: ChatComponentDefinition[]` — `Group(emphasis: 'none'|'subtle'|'strong')`, `Card(title)`, `Text(text, markdown?: boolean)`, `KeyValue(items: [{label, value: bindable}] ≤12)`, `Table(rows: refOnly, columns: [{header ≤40, cell: elementId}] ≤8)` with `itemScope`, `StatusBadge(label: bindable, tone: 'neutral'|'success'|'warning'|'danger')`, `EntityLink(entity: string, record: refOnly, label: bindable)`, `Money(amount: bindable number, currency: bindable string)`, `DateTime(value: bindable ISO string, mode: 'date'|'datetime')`, `Stat(label, value: bindable incl. operators/$said)`, `Action(label required ≤40, prompt?: string, uiAction?: { id: string; args?: record of refs/literals })` — exactly one of `prompt`/`uiAction`. All `schemaVersion: 1`.
- `describeChatCatalog(manifest: ChatComponentManifest): string` — tool-description text: the usage rules from the spec ("default is text; a view only for ≥ 4 like records, a comparison or a status overview; never for single values, confirmations or questions; never just to wrap a single result that already has its own tool-result renderer; one view per turn"), the reference grammar in 3 lines, then one signature line per component, e.g. `Table(rows:ref[], columns:[{header, cell:#id}]) – <description>. Use when: <whenToUse>`.

- [ ] Step 1: tests `starter manifest is valid against chatComponentManifestSchema`, `duplicate id@version throws`, `refinement in props throws`, `describeChatCatalog(starter) stays under 2400 characters` (≈600 tokens), `describeChatCatalog contains every component id once`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS + `bun run typecheck`.
- [ ] Step 5: commit `feat(chat-views): component definitions and starter catalog`.

### Task 3: Spec validation

**Files:** Create `src/chat-views/validate.ts`, `src/chat-views/__tests__/validate.test.ts`.

**Interfaces — Produces:**
- `effectiveChatManifest(manifest, capabilities?: ChatViewCapabilities): ChatComponentManifest` — intersection by `id@schemaVersion` when `components` given; never adds entries.
- `validateChatViewSpec(spec: unknown, manifest: ChatComponentManifest, options?: { surface?: 'narrow' | 'workspace' }): { ok: true; spec: ChatViewSpec } | { ok: false; errors: string[] }` — structure (contract parse), all limits from `CHAT_VIEW_LIMITS` (narrow → `maxNarrowTableColumns`), root exists, every child id exists, no cycles, depth, children allowed per `children` rule, props valid against the entry's JSON Schema with refs allowed only on `bindable`/`refOnly` props, literal strings ≤200, `$said` only on `Stat.value`, `$item` only inside an `itemScope` cell element, `Action` has exactly one target. Error strings are precise and model-facing (English), e.g. `unknown component "Tabel" (known: Group, Card, …)`, `"$said" is only allowed in Stat.value; use {"$count": …} or {"$sum": …}`.
- JSON Schema validation: use the repo's existing validator in `src/runtime/json-schema.ts` if it validates values; otherwise convert by keeping the Zod definition alongside for starter components and use a minimal subset validator (type, enum, maxLength, maxItems, required, properties, items) — no new dependency.

- [ ] Step 1: tests — valid starter spec passes; unknown component; missing child; cycle; depth 7; 61 elements; 9 table columns; 4 columns on `narrow`; `$said` in table cell rejected with `$count` hint; `$item` outside a row scope; Action with both targets; capability intersection drops `Table` → spec using Table fails with unknown component.
- [ ] Steps 2–4: FAIL → implement → PASS. Step 5: commit `feat(chat-views): validate view specs against the catalog`.

### Task 4: Reference resolution and projection

**Files:** Create `src/chat-views/resolve.ts`, `src/chat-views/__tests__/resolve.test.ts`.

**Interfaces — Produces:**
- `type ChatViewSourceLookup = (toolCallId: string) => Promise<{ toolName: string; value: unknown; truncated: boolean } | undefined>`.
- `resolveChatView(spec: ChatViewSpec, manifest: ChatComponentManifest, lookup: ChatViewSourceLookup): Promise<{ ok: true; view: ResolvedChatView; sources: string[] } | { ok: false; errors: string[] }>`.
- Path grammar identical to `outputAllowedFields`/`read_result` (`data[]`, `data[].total`, `a.b`); reuse the existing path reader of `read_result` (locate it in `src/server/core` / `src/contracts/result-handle.ts`) instead of writing a second one.
- Rules: unknown call id → `no tool result "call_x" in this conversation`; path unresolved and `truncated` → `path "data[].foo" is not in the shown result of call_x; call read_result for these fields first, then reference the read_result call`; table rows capped at 50 (note row cap in `caption` is not invented — set element prop `truncatedRows: n` in the resolved view); `$count` → array length, `$sum` → numeric sum (non-numbers → error); `$said` kept as string with `said: true` on the element after its `basis` resolves; projection JSON size > 65536 → error `view too large; reference fewer fields or rows`.
- Every literal value is copied unchanged; nothing is rehydrated.

- [ ] Step 1: tests — table rows + `$item` cells resolve; `$count`/`$sum`; `$said` keeps text and sets `said`; unknown call id; `resolve: missing path names read_result` (truncated source); 120 rows → 50 + `truncatedRows: 70`; oversize projection; values are not altered (pseudonym string `«PERSON_1»` stays identical).
- [ ] Steps 2–4. Step 5: commit `feat(chat-views): resolve references into a self-contained view`.

### Task 5: Text renderer

**Files:** Create `src/chat-views/text.ts`, `src/chat-views/__tests__/text.test.ts`.

**Interfaces — Produces:** `chatViewToText(view: ResolvedChatView, manifest: ChatComponentManifest, options?: { locale?: string }): string` — deterministic Markdown: caption first; `Table` → Markdown table; `KeyValue` → `label: value` lines; `Stat` → `label: value` with ` (computed by the assistant)` / German ` (vom Assistenten berechnet)` when `said`; `Money`/`DateTime` formatted with `Intl` in `locale` (default `en`); `Action` → omitted; app components → the entry's `text` rule; unknown type → its children's text. Also `chatElementToText(view, elementId, manifest, options)` for per-element fallback (Task 7).

- [ ] Step 1: tests — starter view to exact Markdown snapshot (inline string); `said` marker in `de`; app component via `text.label/value`; unknown type degrades to children.
- [ ] Steps 2–4. Step 5: commit `feat(chat-views): deterministic text rendering of a view`.

### Task 6: `render_view` in the chat handler

**Files:**
- Create: `src/server/adapters/nextjs/render-view.ts`, `src/server/adapters/nextjs/__tests__/render-view.test.ts`
- Modify: `src/server/adapters/nextjs/types.ts` (config), `create-ai-chat-handler.ts` (wiring near `withResultTool` ~line 2095 and the per-request registry ~2215; plain-args exclusion ~2842), `src/runtime/tool-discovery.ts` / `tool-discovery.ts` (`NON_DOMAIN_TOOL_NAMES`), `prepare-model-messages.ts` (history transform + source memo), the AI SDK tool construction (`src/runtime/ai-sdk/engine.ts` `createAiSdkTools` and/or `src/server/core` `toolsToAiTools` — wherever `tool({...})` is built for handler tools) to pass an optional `toModelOutput`.

**Interfaces — Consumes:** Tasks 1–4. **Produces:**
- Config on `AiChatHandlerConfig`: `chatViews?: { catalog: ChatComponentManifest | ChatComponentDefinition[]; maxViewsPerTurn?: 1 }` (only `1` accepted in this cut).
- Request body field `chatViews?: ChatViewCapabilities` (parsed with the contract schema; invalid → ignored, never widening).
- `createRenderViewTool(options: { manifest: ChatComponentManifest; capabilities?: ChatViewCapabilities; lookup: ChatViewSourceLookup }): Tool` — description `describeChatCatalog(effective manifest)`; input schema generic (`chatViewSpecSchema`); `execute` = validate → resolve → `{ shown: true, elements: n, view }` or `{ success: false, error }`; second call in the same turn → `{ success: false, error: 'one view per answer' }`; `toModelOutput` returns `{ shown, elements }` only.
- Lookup: current turn — a per-turn map `toolCallId → { toolName, output, handleId? }` recorded by the existing tool middleware context (it already sees `toolCallId`, `server/core/index.ts` ~1102); when `handleId` exists read the full value through the turn's result store **with the same owner/guard checks as `read_result`**; earlier turns — tool parts of the request messages (`output-available`), `truncated: true` when the output carries the overview/`_truncated` marker.
- Model input: transform `withoutChatViewProjections(messages)` removes `view` from `render_view` outputs in history. Source memo: when `chatViews` is on, append to the existing seen-objects memo block one line per referenceable earlier tool result (`call_7f2 · invoices_list · data[] (23) · fields: id, customer, total, status`), max `CHAT_VIEW_LIMITS.maxSourceMemoEntries`, field names only.

- [ ] Step 1: tests using the existing handler test helpers in `src/server/adapters/nextjs/__tests__` (mock model, no LLM):
  - `off by default: no render_view tool and identical stream` (compare against a run without `chatViews`).
  - `renders a view from a current-turn tool result` (tool part output has `view`, model-facing output has only `shown/elements`).
  - `full result from store when overview was shown` (oversized result + `resultHandles`).
  - `earlier-turn reference resolves from request history`.
  - `history: view stripped from model input`.
  - `capabilities narrow the catalog` (body lists only Card → Table spec rejected).
  - `pii: projection stays shielded` (shield on; view values equal the pseudonyms of the source part; args not rehydrated).
  - `second render_view in a turn is rejected`.
  - `managed turn: lookup through store runs the origin guard` (mirror the `read_result` guard test).
- [ ] Steps 2–4: FAIL → implement → PASS; run `bunx vitest run src/server` fully.
- [ ] Step 5: commit `feat(server): optional render_view tool for chat views`.

### Task 7: React rendering

**Files:**
- Create: `src/react/chat-views/registry.ts`, `src/react/chat-views/starter-bindings.tsx`, `src/react/chat-views/chat-view.tsx`, `src/react/chat-views/__tests__/chat-view.test.tsx`
- Modify: `src/react/components/message-bubble.tsx` (branch in `toolResultNode` before the generic renderer branch, following the clarification reader pattern), `src/react/types.ts` + `src/react/provider/ai-chat-provider.tsx` (option), request body construction in the transport (`src/react/transports`) to send `chatViews` capabilities, `src/react/styles.css`, `src/react/locale-de.ts` (+ English defaults), `src/react/index.ts`.

**Interfaces — Consumes:** Tasks 1, 2, 5. **Produces:**
- `bindChatComponent<P>(def: ChatComponentDefinition<P>, component: ComponentType<ChatComponentProps<P>>): ChatComponentBinding` — `ChatComponentProps<P> = { props: z.infer<P>; children?: ReactNode; said?: boolean; rows?: ...; renderCell(rowIndex, cellId): ReactNode; locale: string; dispatch: { prompt(text): void; uiAction(id, args): void } }`.
- `createChatViewRegistry(bindings: ChatComponentBinding[]): ChatViewRegistry` — resolves `type@schemaVersion`, highest binding whose schema parses the props wins (pattern of `createToolResultRendererRegistry`); `capabilities(): ChatViewCapabilities['components']`.
- `starterChatBindings: ChatComponentBinding[]` — unstyled-capable, `data-component="chat-view"` on the root, `data-element="<component-id-kebab>"` per element; `Stat` with `said` renders the SDK-owned marker `<span data-element="said-marker">` with locale text; `EntityLink` uses the existing entity-link rendering.
- `<ChatView view={ResolvedChatView} registry={...} />` inside the existing renderer boundary; element invalid/unknown → `chatElementToText` output as plain text; root failure → whole-view text.
- Provider option: `chatViews?: { components?: ChatComponentBinding[]; surface?: 'narrow' | 'workspace' }` — merged over `starterChatBindings` by `id@schemaVersion`; when the option is absent nothing is sent and no branch changes rendering (a `render_view` part without the option falls back to text).
- Action `prompt` → the chat's existing send; `uiAction` → the UI action bus with the outcome protocol.

- [ ] Step 1: tests — renders a starter view (table rows, badge, money in `de`); `renders old version via text fallback`; unknown component → text, siblings still render; `said` marker always shown even with `unstyled`; action prompt sends a message; capabilities are sent in the request body only when the option is set.
- [ ] Steps 2–4; also `bun run typecheck` and `bunx vitest run src/react`.
- [ ] Step 5: commit `feat(react): render chat views from the app's components`.

### Task 8: Codegen manifest

**Files:** Create `src/codegen/tools/sources/chat-components.ts` (+ test next to `react-actions` tests); modify `src/codegen/tools/config.ts` (`TOOLS_PATHS.chatComponents = '.glirastes/chat-components.json'`) and the pipeline write step.

**Produces:** scanner finds `defineChatComponent(...)` imported from `glirastes` in the app's TS program (template: `react-actions.ts`), evaluates definitions the way the pipeline already probes Zod schemas (`probe-child.mjs` uses `toJSONSchema`), writes a `ChatComponentManifest` (starter entries excluded; the server merges them). Nothing is written when the app defines none. The handler accepts this JSON directly as `chatViews.catalog` together with the starter manifest (`[...starter, ...app]` merge helper `mergeChatManifests(a, b)` exported from Task 2's module — add it there).

- [ ] Step 1: tests — fixture app with one `defineChatComponent` → manifest with that entry; fixture without → no file.
- [ ] Steps 2–4. Step 5: commit `feat(codegen): collect chat components into a manifest`.

### Task 9: Docs, skill, upgrade note, support matrix

**Files:** Create `docs/chat-views.md`, `skills/building-glirastes-chat-ui/references/chat-views.md`, `upgrade-notes/unreleased/chat-views.json`; modify `skills/building-glirastes-chat-ui/SKILL.md` (pointer), `skills/integrating-glirastes-nextjs/references/handler-options.md` (`chatViews`), `docs/support-matrix.md` (row: chat views, React binding + text renderer, other bindings not claimed), `README` docs index if it lists docs.

Skill reference must let a coding agent do it alone: enable on the server (starter only), enable in React, add an app component (define → bind → run codegen → pass manifest), test without an LLM (handler test helper), troubleshooting (model never renders: check rules; element shows text: version/binding mismatch; PII shows pseudonyms by design).

Upgrade note: `kind: "optional"`, `skill: "building-glirastes-chat-ui"`, `surface` covering every new export, `adoptedWhen.patterns: ["chatViews\\s*:"]`.

- [ ] Step 1: `bunx vitest run src/upgrade-notes.test.ts src/public-subpaths.test.ts` PASS; skill validation test if present (`grep -r "skills/" src/*.test.ts`).
- [ ] Step 2: full gate `bun run build && bun run typecheck && bun run typecheck:tests && bun run test`.
- [ ] Step 3: commit `docs: chat views guide, skill reference and upgrade note`.
