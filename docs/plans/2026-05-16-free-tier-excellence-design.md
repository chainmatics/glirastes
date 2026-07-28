# Glirastes SDK — Free-Tier Excellence Design

> Superseded for the Foundation Pilot by
> `2026-07-28-glirastes-foundation-design.md`. Retained as historical context.

**Date:** 2026-05-16
**Status:** Design (pre-roadmap)
**Audience:** SDK contributors, design reviewers
**Supersedes:** `glirastes-platform/DISCUSSION.md` (7-point simplification list — partially obsolete since SDK was consolidated into a single `glirastes` package; this document reframes the brief)
**Next:** Roadmap document via `writing-plans`

---

## 1. Thesis

> **Glirastes is the AI integration that meets you where you are.**
> Mode-A first-class: add AI to your existing app via declarative tool definitions and a drop-in chat widget. No platform required. No outbound. No magic.
> The platform exists; it's an additive layer that lights up via an API key. The SDK is excellent on its own.

**Optimised for two user archetypes:**
1. **The agentic-coding developer** — using Claude Code / Cursor / Cline / Windsurf to integrate AI into their app. The primary UX is *skill execution by a coding agent*, not human keystrokes.
2. **The trust-skeptical enterprise developer** — needs a working solution with zero outbound to Chainmatics. Manual code path is excellent, not "good enough".

**Out of scope (separate sessions):**
- Mode B excellence (custom backend agents like LangGraph using only Glirastes UI — e.g. `chaingrow`). Stays supported in code but not promoted, no dedicated skills.
- Pro auto-generation of tool definitions (Code-Connect, scan-driven tool authoring) — separate Pro product, separate design session.
- Test-Story phase 2 (VCR replay, eval-hooks).
- Semantic codemods beyond import renames.

---

## 2. The two modes (framing)

| | **Mode A — "Agentic App"** | **Mode B — "Custom Agent + Glirastes UI"** |
|---|---|---|
| Purpose | Make an existing app AI-accessible | Wire chat UI to a custom agent backend |
| Tools | HTTP routes via `defineTool` / `@AiTool` | LangChain tools inside the backend's own graph |
| Who decides | LLM picks tools per turn | Backend planner / workflow |
| Stateful? | No (chat history only) | Yes (StateGraph etc.) |
| Glirastes server-side | Full (`createChatHandler`, registry, …) | Zero — only wire-protocol compatibility |
| Glirastes client-side | `<AiChat />` zero-config | `<LangGraphAiChat />` with custom transport |
| Example | `get-it-done`, `apps/citadel` | `chaingrow` |

**This document designs Mode A.** Mode B keeps working (the `glirastes/react/langgraph` subpath stays, transports stay pluggable), but is not the optimisation target.

---

## 3. The five Free-Tier moments

Designed end-to-end. Each moment is a choreography that a skill executes on behalf of a coding agent; humans who code manually can follow the same shape.

### Moment 1 — Install: one package

**Today:** `bun add glirastes @ai-sdk/react react-markdown` + optional `wavesurfer.js`. Three packages, peer-warning anxiety, easy to misconfigure.

**Target:** `bun add glirastes`. Done.

**Design:**
- `@ai-sdk/react` and `react-markdown` move from optional peers to **direct dependencies**, behind dynamic imports so backend-only consumers (NestJS pure) don't ship them.
- `wavesurfer.js` remains optional peer (voice is opt-in).
- Bundle budget: **Core <25KB gz**; Markdown lazy-loads on first formatted token (+~30KB); Voice lazy-loads on mic click (+~10KB); Mentions lazy on `@` keystroke (+~5KB).

**Acceptance:**
- Cold `bun add glirastes` in empty Next.js repo → import `AiChat` → works, no peer warning, no extra installs.
- CI fails if Core bundle exceeds 25KB gz.

---

### Moment 2 — First Tool: one place, no duplication

**Today:** A tool requires two files — the route handler (`app/api/tasks/route.ts`) and the tool definition (`ai-tool.ts` with duplicated `method`, `path`, `inputSchema`). Drift is easy.

**Target:** Tool and handler defined together, once.

**Design — `defineTool` as combined route handler + tool definition:**

```ts
// app/api/tasks/route.ts
import { defineTool } from 'glirastes/server/nextjs';
import { z } from 'zod';

export const GET = defineTool({
  description: 'List tasks with optional status filter.',
  input: z.object({ status: z.enum(['open', 'done']).optional() }),
  handler: async ({ input }) => {
    return await db.tasks.findMany({ where: input });
  },
});
```

- `defineTool` returns a Next.js Route Handler **and** registers the tool for autodiscovery.
- HTTP method = export name (`GET`/`POST`/...).
- URL path = filesystem location (Next.js convention).
- Tool name = inferred from path+method (`get_tasks`), overridable via `name` option.
- Handler input is typed from the Zod schema; return type flows to the AI as the tool result.

**End-to-end type-safety (Challenge #4):**
```ts
const listTasks = defineTool({ ... });
// listTasks.$types.input  → fully typed
// listTasks.$types.output → fully typed
```
Frontend code reacting to tool results can use `onToolResult<typeof listTasks>` for typed handlers. **tRPC-level inference across the HTTP boundary, without a tRPC server.**

**NestJS path unchanged:** `@AiTool()` decorator on existing controller method — same principle (one place per tool).

**Acceptance:**
- A `defineTool`-authored route is callable both by the AI and by HTTP clients identically.
- Removing/renaming the file removes/renames the tool with zero additional edits.
- TS strict mode catches mismatched payload shapes at compile time.

---

### Moment 3 — First Chat: zero config

**Today:** `<VercelAiChat endpoint="/api/chat" />` with `'use client'` and CSS import.

**Target:** A single `<AiChat />` import. No required props.

**Design:**

```tsx
// app/layout.tsx
import { AiChat } from 'glirastes/react';
import 'glirastes/react/styles.css';

export default function Layout({ children }) {
  return <html><body>{children}<AiChat /></body></html>;
}
```

Defaults:
- `endpoint`: `/api/chat` (convention).
- Transport: Vercel AI SDK (default). LangGraph etc. via `<AiChat transport={...} />`.
- Position: floating bottom-right bubble; inline panel when rendered inside `<main>`.
- Locale: **icons-first** for buttons (Send, Stop, Approve, Reject, Clear). Text strings (empty-state, error-message) ship in English by default; overridable via `locale` prop.
- Action dispatch: built-in `navigate` handler for UI-tools that route; custom via `onAction` prop.

**Acceptance:**
- TTFTC (time-to-first-tool-call) in empty Next.js repo, with a coding agent driving setup: **<60s**.
- Manual setup by reading docs: **<3min**.

---

### Moment 4 — Many Tools: kill the codegen cliff

**Today:** README warns the manual `endpointToolsToRegistry([t1, t2, t3])` list stops scaling around 5–10 tools and requires a `predev` codegen hook. This is the single biggest free-tier friction.

**Target:** No codegen for the happy path. Build-time tool discovery is automatic.

**Design — `autoTools()` via build-time scan:**

```ts
// app/api/chat/route.ts
import { createChatHandler, autoTools } from 'glirastes/server/nextjs';

export const POST = createChatHandler({
  tools: autoTools(),
});
```

Implementation:
- Next.js (Turbopack + Webpack): `autoTools()` is implemented as a macro / build-time helper backed by `import.meta.glob('app/api/**/route.ts')` (or `require.context` on Webpack). Resolves at build time; no runtime filesystem access.
- NestJS path unchanged: `scanNestJsControllers()` already runtime-discovers via decorator metadata.
- Express / generic Node: `tools: [listTasks, createTask]` remains as the manual fallback.

**Effect:** The CLI codegen suite (`generate-tools`, `generate-endpoint-tools`, etc.) is no longer required for the happy path. It remains available for setups with strict CI requirements (separated artefacts, deterministic dist files).

**Acceptance:**
- A new Next.js project can add 30 tools without ever touching a codegen step.
- Build time impact: <100ms for `autoTools()` over a 50-tool project.

---

### Moment 5 — Eject + Debug + Trust

**The eject ladder** (Challenge #7):

```
<AiChat />                          ← zero config
   ↓
<AiChat panel={MyPanel}             ← swap UI parts via slots
        classNames={...}
        components={...} />
   ↓
useChat({ endpoint }) /              ← headless hooks, work without provider
useApprovals(...)
   ↓
fetch('/api/chat', ...)              ← raw HTTP, you own everything
```

**Headless-hook rule:** Every hook (`useChat`, `useApprovals`, `useMentions`, `useSuggestions`) has two operating modes:
- (a) pulls config from `<AiChatProvider>` if present (sugar mode);
- (b) accepts full config as an argument (standalone mode).

Today only (a) exists. This is a one-time refactor.

**Debug overlay** (Challenge #9):
- Activation: `?glirastes_debug=1` query param OR `localStorage.glirastes_debug=1`. No code change.
- Floating inspector shows: last 50 SSE events, tool calls with latencies, payloads (collapsible), errors, current transport, loaded tools.
- Server-side: `GLIRASTES_VERBOSE=1` env → structured logs with prefixes (`[glirastes:tool]`, `[glirastes:llm]`).
- Default: **completely silent**.

**Error-DX** (Challenge #3) — every thrown SDK error is a `GlirastesError`:
```
GlirastesError [tool/handler-threw]
  Tool "list_tasks" threw during execution.

  where: app/api/tasks/route.ts (handler)
  cause: TypeError: Cannot read properties of undefined (reading 'findMany')
  hint:  Make sure your `db` is initialised before the handler runs.
         Common cause: module-level db client in Next.js dev mode.
  docs:  https://glirastes.dev/errors/tool-handler-threw
```
Fields: `code`, `where`, `hint`, `docs`. Machine-readable; Cursor/Claude can react to error codes.

**No-magic mode** (Challenge #12):
- `bunx glirastes explain app/api/chat/route.ts` → prints the fully expanded config (all defaults resolved, all auto-discovered tools listed, transport identified).

**Trust manifest:**
- `MANIFEST.md` ships with the package; tabulates every host the SDK contacts in each of the three states (see §4).
- CI check: if a `fetch(...)` lands in `src/` that isn't already through the SDK's allowlist machinery, build breaks.

---

## 4. The Triple-State model

A single import surface; three operating modes determined by the presence and tier of `GLIRASTES_API_KEY`.

| State | `GLIRASTES_API_KEY` | Plan tier | SDK behaviour |
|---|---|---|---|
| **No-key** | unset | n/a | Zero outbound to Chainmatics. Local-baseline implementations for every Pro feature (naive PII regex, no classifier, no warden, no model-selector). |
| **Free-key** | set | Free | Telemetry forwarded to `api.glirastes.dev`. Dashboard / audit / observability active. Premium feature calls (`createPiiShield`, etc.) hit the platform and receive `402 not-in-plan` → automatic fallback to local baseline. Logged once at startup. |
| **Pro-key** | set | Pro | Full premium features active. |

**The SDK does not introspect the key.** It optimistically attempts platform calls; the platform decides per-feature whether to serve or refuse with `402`. Refusal triggers graceful degradation to the local baseline. **This is the architecture.**

**Consequence:** the same source code works in all three states. Setting the env var is the only switch.

---

## 5. Public API — radical simplification

**Lancer disappears from the user-facing API.** It survives as an internal HTTP client (pool, retry, cache); users never construct it.

### Removed from public API

| Removed | Reason |
|---|---|
| `createLancer({ apiKey })` | Implementation detail. Replaced by env-var auto-detect inside SDK internals. |
| `createAiPipeline({ lancer, ... })` | Two-entry-point split with `createAiChatHandler` was confusing. Folded into one. |
| `ServiceBlockedError` | Internal-only now. Maps to a `GlirastesError` for user-facing paths. |
| `Lancer` (class export) | Internal. |

### Kept, but with new semantics

| Symbol | New behaviour |
|---|---|
| `createChatHandler` | Sole server-side entry point. Pipeline features (PII, classifier, warden, model-selector) become optional fields. Env-var auto-detect determines whether features hit the platform or the local baseline. |
| `createPiiShield` | Same factory, but Lancer construction is internal. Accepts `detector` for Replace/Extend/Compose pattern (see §6). |
| `defineTool` (new) | Combined route-handler + tool definition (Moment 2). |
| `autoTools` (new) | Build-time tool discovery (Moment 4). |
| `<AiChat />` (new) | Zero-config widget; default-transport Vercel AI SDK; default-endpoint `/api/chat`. |
| All React hooks | Refactored to support standalone mode (no provider required). |

### CLI consolidation

Today: 16 commands across `generate-*`, `validate-*`, `scaffold`, `test`, `check-upgrade`, `install-skills`, `sync`.

After:

| Command | Status | Purpose |
|---|---|---|
| `install-skills` | **promoted** | Setup primary entry point. Multi-target (Claude Code / Cursor / Cline / Windsurf / `AGENTS.md`). |
| `scaffold-tool`, `scaffold-ui-tool`, `scaffold-pii-*` | **new** | Deterministic CLI building blocks called by skills. |
| `explain` | **new** | Prints fully resolved config. |
| `validate-tools`, `coverage` | retained | Optional; useful in CI. |
| `generate-tools`, `generate-endpoint-tools`, etc. | retained but deprioritised | Only needed when `autoTools()` cannot be used (rare CI scenarios). |
| `sync` | retained, requires Pro key | Uploads tool schemas to the platform — no-op without a Pro plan. |
| `check-upgrade` | retained | Major-version upgrade analysis. |

---

## 6. Pluggable Strategy Pattern — every Pro feature is swappable

Every "Pro" capability in the SDK has a corresponding interface. Users may **Replace**, **Extend**, or **Compose** the default implementation. This is the cornerstone of the trust story.

### Pattern

```ts
import { createPiiShield, naiveDetector, extendDetector, composeDetectors } from 'glirastes/server';

// REPLACE — user provides their own detector entirely
const shield = createPiiShield({ detector: myPresidioDetector });

// EXTEND — keep the SDK default, add patterns
const shield = createPiiShield({
  detector: extendDetector(naiveDetector(), {
    patterns: {
      employeeId: /EMP-\d{6}/g,
      customerNumber: /CUST-[A-Z]{3}-\d{4}/g,
    },
  }),
});

// COMPOSE — multiple detectors, results merged
const shield = createPiiShield({
  detector: composeDetectors([
    naiveDetector(),
    myDomainSpecificDetector,
    aegisDetector(),
  ]),
});

// EXTEND the state-aware auto-pick — keeps SDK choosing default per state
const shield = createPiiShield({
  detector: extendDetector(undefined, {
    patterns: { employeeId: /EMP-\d{6}/g },
  }),
});
```

### Precedence (when both user and platform-available)

1. User-supplied implementation **wins always**.
2. Otherwise, if Pro key in plan: platform implementation (e.g. Aegis).
3. Otherwise: local naive baseline.

### Detector contract — deliberately minimal

```ts
interface PiiDetector {
  detect(text: string): Promise<PiiMatch[]>;
}

interface PiiMatch {
  type: string;           // 'email', 'phone', 'iban', or any custom
  start: number;          // char index
  end: number;            // exclusive
  value: string;
  confidence?: number;    // optional 0..1
}
```

One method, one shape. A user with Presidio running locally is finished in ~20 lines.

### Generalises across all Pro features

| Capability | Naive Free default | Platform Pro default | User-pluggable |
|---|---|---|---|
| PII detector | Regex (email/phone/iban/cc/ip) | Aegis | ✅ Replace / Extend / Compose |
| Intent classifier | Stemmer-based local | Primus | ✅ |
| Guardrails | Regex blocklist | Warden | ✅ |
| Model selector | Configured single model | Adaptive | ✅ (already a function today) |
| Followups | Off | Platform-driven | ✅ Function |

**Trust statement:** *"Every Pro component may be replaced with your own implementation. When you do, no outbound to Chainmatics occurs for that component — even with a Pro key."*

---

## 7. Skill-First UX

**Premise:** the primary audience for the SDK is developers using coding agents. Skill quality matters more than micro-optimising human-keystroke counts.

### Skill type: orchestration in Markdown, determinism in CLI

Skills are Markdown that drive a coding agent. For deterministic operations (stack detection, file scaffolding, validation), skills invoke `bunx glirastes <subcommand>`. The CLI is the determinism layer; the skill is the choreography layer.

Example: `add-glirastes-tool` skill
```
1. Ask the user: endpoint tool or UI tool?
2. If endpoint:
   a. Determine app/api/<resource>/route.ts path and HTTP method.
   b. Run: bunx glirastes scaffold-tool --path … --method … --name …
3. If UI:
   a. Run: bunx glirastes scaffold-ui-tool --action … --schema …
4. Read the generated file, ask the user for the business logic.
5. Run: bunx glirastes validate-tools — fix any issues.
```

### Multi-agent targets

Today: Claude Code only (`.claude/skills/`).

Target: every major agentic IDE.

| Target | Path / format |
|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Cursor | `.cursor/rules/<name>.mdc` |
| Cline | `.clinerules/<name>.md` |
| Windsurf | `.windsurf/rules/<name>.md` |
| Codex / generic | `AGENTS.md` (project root, single file with sections) |

`bunx glirastes install-skills` detects which agent target(s) are present in the project and installs accordingly. Skills are authored in one canonical source format; the install command transpiles per target.

### The skill set

**Task skills (action-oriented):**
- `setup-glirastes-app` — stack detection, dependency install, scaffold chat route + layout + .env hint.
- `add-glirastes-tool` — endpoint or UI tool, scaffold + business-logic prompt + validate.
- `add-glirastes-pii-shield` — choose between built-in / extend with patterns / custom detector / compose.
- `add-glirastes-guardrails` — same Replace/Extend/Compose model.
- `customize-glirastes-ui` — walk the eject ladder.
- `debug-glirastes-tool-call` — systematic decision-tree for "AI doesn't call my tool".
- `audit-glirastes-tools` — coverage, drift, description-quality.
- `connect-glirastes-platform` — register a free key; light up dashboard/telemetry; non-invasive.
- `enable-glirastes-pro-features` — toggle PII / classifier / warden; works in fallback mode without Pro key.
- `upgrade-glirastes` — major-version migration via `check-upgrade` + targeted edits.

**Reference skills (knowledge base, loaded on demand):**
- `glirastes-architecture-overview`
- `glirastes-tool-author-reference`
- `glirastes-chat-ui-reference`
- `glirastes-nextjs-conventions`
- `glirastes-nestjs-conventions`

### Skill delivery

- `bun add glirastes` prints a one-time hint: *"Glirastes ships agent skills. Run: `bunx glirastes install-skills`"*. Nothing is installed without consent.
- `install-skills` auto-detects target IDE(s) and installs to all detected paths.
- `--symlink` mode (already exists) keeps skills in sync with the SDK version on subsequent installs.
- Skills carry the SDK version they were authored against; mismatch warns on load.

---

## 8. The 12 Excellence Challenges — final scoping

| # | Challenge | Decision in this design |
|---|---|---|
| 1 | TTFTC <60s | Achievable **only** via skill-driven setup. Manual scaffold (`bunx glirastes setup`) is a deterministic, non-interactive generator (different from the killed wizard `init`). |
| 2 | Default resilience | LLM 429 retry-with-backoff (max 3); tool timeout 30s default; page refresh → `sessionStorage` resume; connection loss <5s → client-side replay; context-overflow → oldest-first truncation with explicit marker; parallel tabs → distinct session IDs. **No server-side resume tokens.** |
| 3 | Error-DX | `GlirastesError { code, where, hint, docs }`. Cheap, high-leverage. |
| 4 | End-to-end type-safety | `defineTool` returns typed input/output. `onToolResult<typeof t>` typed. **tRPC-level inference within Mode A.** |
| 5 | AI-readability | `llms.txt`, `AGENTS.md`, JSDoc `@example` on every public export, **Cursor-empty-project setup test in CI**. The strategic challenge. |
| 6 | Test story | MVP: `MockLanguageModel` + `createTestChat()` helper. VCR replay and eval-hooks: **deferred**. |
| 7 | Eject path | Headless hooks refactored to be standalone-capable. |
| 8 | Migrations / codemods | **Only for import renames.** Semantic migrations get hand-written guides. |
| 9 | Free-tier observability | `?glirastes_debug=1` overlay; `GLIRASTES_VERBOSE=1` server logs; silent by default. |
| 10 | Bundle size <25KB gz | **Core only.** Markdown / Voice / Mentions lazy-loaded. CI gate. |
| 11 | Streaming resilience | Client-side replay only. **No server-state resume tokens** (conflicts with no-platform ethos). |
| 12 | No-magic mode | `bunx glirastes explain` + `GLIRASTES_VERBOSE=1`. |

**Additional challenges (not in original list, added):**

| # | Challenge | Decision |
|---|---|---|
| 13 | Skill quality | Empty-project end-to-end test per stack in CI; multi-target skills (Claude / Cursor / Cline / Windsurf / `AGENTS.md`). |
| 14 | A11y / keyboard / screen-reader | WAI-ARIA chat pattern; full keyboard nav; tested with NVDA + VoiceOver. Differentiator. |
| 15 | CSP / inline-style-free | All styling via CSS variables on a single root element; no inline styles in the component tree. Audited in CI. |
| 16 | SSR / RSC discipline | `'use client'` boundaries documented and enforced; server-component imports never pull client-only code. |
| 17 | Trust manifest | `MANIFEST.md` per release lists every outbound host per state. Validated in CI. |
| 18 | API surface tracking | `api-extractor` snapshot in PR diffs; every public-symbol change is reviewed. |

---

## 9. What stays, what changes, what's removed publicly

### Internals: unchanged (mostly)

- `src/server/pii-shield/{deep-walk,session-mapping,leakage}.ts` — substitution engine, generic.
- `src/server/lancer/` — now internal-only.
- `src/server/core/{intent-classifier,model-selector,module-router,followup-tool}.ts` — internal, called by `createChatHandler` when key + plan permit.
- Codegen pipeline — retained for CI-strict setups.

### New surface

- `defineTool` (Next.js): combined handler + tool definition.
- `autoTools()` (Next.js): build-time tool discovery.
- `<AiChat />` (React): zero-config widget.
- `extendDetector` / `composeDetectors`: pluggable detector pattern.
- `naiveDetector` / `naiveClassifier` / `naiveGuardrails`: explicit baseline factories.
- `GlirastesError` class.
- `bunx glirastes explain` command.
- `bunx glirastes scaffold-{tool,ui-tool,pii-*}` commands.

### Removed from public API (still present internally)

- `createLancer`, `Lancer` class export.
- `createAiPipeline` (functionality folded into `createChatHandler` with optional fields).
- `ServiceBlockedError` (replaced by `GlirastesError`).

### Behaviour changes

- `createAiPipeline` (if anyone is still calling it during the deprecation window) no longer throws without a Lancer; it falls back to local baseline.
- `createPiiShield()` works without a Lancer argument; auto-picks naive / Aegis based on env-var state.

### Skills (refactored)

- Task skills (10) — new orientation.
- Reference skills (5) — knowledge base.
- Multi-target installation (Claude / Cursor / Cline / Windsurf / `AGENTS.md`).

---

## 10. Trust Manifest (template)

Ships as `MANIFEST.md` in the published package. Validated in CI.

```
Glirastes SDK — Outbound Manifest (version 0.5.0)

State: no-key (GLIRASTES_API_KEY unset)
  Outbound hosts: only the LLM provider you configured (e.g. api.openai.com).
  No telemetry. No audit. No platform contact.

State: free-key (GLIRASTES_API_KEY set, plan: Free)
  Outbound hosts:
    - your LLM provider
    - api.glirastes.dev (telemetry events, audit log)
  Data sent to api.glirastes.dev: tool name, latency, success/error, token counts.
  Data NOT sent: tool input payloads, tool output payloads, chat content.
  Premium features (PII, classifier, warden) → not in plan → local baseline used.

State: pro-key (GLIRASTES_API_KEY set, plan: Pro)
  Outbound hosts: as Free-key, plus:
    - aegis.glirastes.dev (PII detection, when enabled)
    - warden.glirastes.dev (guardrail evaluation, when enabled)
    - primus.glirastes.dev (intent classification, when enabled)
  Data sent: chat content for enabled features only, per platform privacy policy.

User-pluggable: when you Replace a Pro component with your own implementation,
no outbound occurs for that component — even with a Pro key.
```

---

## 11. Open items / risks

1. **`defineTool` is a breaking change for current `defineEndpointTool` users.** Mitigation: `defineEndpointTool` stays as a deprecated alias for one major version; codemod for import rename.
2. **`autoTools()` Turbopack edge cases.** Turbopack's `import.meta.glob` is newer; may need a Webpack-only path initially with a Turbopack follow-up. Acceptance test must run on both.
3. **Headless-hooks refactor (Moment 5 eject) is invasive.** All hook consumers may need migration. Codemod can handle most cases.
4. **Naive detectors are intentionally weak.** Need clear documentation that they are baselines, not production-grade. Skill explicitly surfaces this when user picks the naive path.
5. **Multi-target skills require maintaining one skill source that compiles to 5 formats.** Engineering cost. Alternative: maintain only `AGENTS.md` + `.claude/skills` initially, add others by demand.
6. **Bundle <25KB gz is tight.** Requires conscious effort: every dependency review, every component lazy boundary. CI gate is non-negotiable.
7. **Pro tier detection via `402` graceful degradation creates silent fallback paths.** Logged once at startup; could still surprise users in production. Mitigation: `GLIRASTES_VERBOSE=1` and dashboard surface.

---

## 12. Out of scope for this design

Documented to prevent scope drift:

- **Pro auto-generation of tool definitions** (Code-Connect). Separate session, separate product, separate document.
- **Mode B (custom-agent + Glirastes UI) excellence**. Stays supported, not promoted, not skill-supported.
- **Test-story phase 2** (VCR, eval hooks). MVP only here (`MockLanguageModel`, `createTestChat`).
- **Semantic codemods**. Only import renames.
- **Consumer migration** (`get-it-done`, `apps/citadel` from `@chainmatics/agentic-*` 0.18 to `glirastes`). Separate work item.

---

## 13. Next step

Hand off to `writing-plans` to produce the executable roadmap:
- Version targeting (0.4 / 0.5 / 0.6 phasing)
- Ordering (what depends on what)
- Breaking-change markers per task
- CI gates per challenge
- Consumer-migration sequencing

---

## Appendix A — Decisions log (for future reviewers)

| Question | Decision | Rationale |
|---|---|---|
| Are the 7 DISCUSSION.md points still current? | Mostly obsolete | 3/7 already shipped, 2/7 cosmetic. Real friction is elsewhere. |
| Mode A or Mode B as primary? | Mode A | Confirmed by user. Chaingrow stays supported but not promoted. |
| Excellence thesis? | "Meets you where you are" + manual-path excellence | Trust-first + agentic-coding-first. |
| Pro split as separate package(s)? | No — single `glirastes` package | One install. Env-var gates Pro features. Stripe / Resend model. |
| Naive PII detector in SDK? | Yes, baseline | Trust-story requires *something* even without platform. |
| `Lancer` as public API? | No, internal-only | Leaky abstraction. Users only ever care about the key. |
| Free-pipeline vs. Pro-pipeline two entry points? | No — single `createChatHandler` | Triple-state model (no-key / free-key / pro-key) collapses to one API surface. |
| Resume tokens (Challenge #11)? | Client-side only | Server-state conflicts with no-platform ethos. |
| PII detector user-pluggable? | Yes: Replace / Extend / Compose | Critical for no-outbound enterprise. Generalises to all Pro features. |
| Skill type? | C — Markdown orchestration + CLI building blocks | Determinism in CLI (testable), choreography in skill (LLM-friendly). |
| Skill targets? | Multi-target (Claude / Cursor / Cline / Windsurf / AGENTS.md) | Primary audience uses agentic-coding tools heterogeneously. |
| Where does this doc live? | `glirastes/docs/plans/` | Design-of-record colocated with the code it describes. |
