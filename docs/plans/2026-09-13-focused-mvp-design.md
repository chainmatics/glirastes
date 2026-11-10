# Focused Glirastes MVP

Status: Product direction confirmed by Philip on 2026-09-13. Incremental implementation; no release approval.

Scope clarification from the subsequent product discussion: [MVP scope and requirements](2026-09-13-mvp-scope-and-requirements.md). This records what to retain, add, change and defer, agent-led setup, runtime discovery, and Local/Free/Pro boundaries. It does not authorize broad source deletion.

## Confirmed product

- One-command installation orchestrates setup through an available coding agent. The agent creates explicit app UI/auth integration and capability bindings; developers should not manually maintain a second tool catalogue. Ask only about genuinely unresolved decisions. Do not claim this end-to-end flow is already implemented.
- Automatic capability discovery/build on additions, changes and removals; no separately maintained duplicate tool catalogue.
- Generic web-app architecture is part of the MVP, confirmed in the subsequent discussion: common contracts and a shared runtime with thin agent-generated integrations. Prove integrated Next.js, React with a separate backend (Omnify/NestJS reference), and a non-React/non-TypeScript fixture. Framework recognition alone is not a support guarantee; do not build a separate full SDK for every language.
- Very fast intent routing, chat and responses, measured by successful tasks as well as latency/tokens.
- The existing Get It Done Foundation integration is the reference. Reconcile it with the latest upstream default branch (`master`, not `main`) without losing new app features or existing Foundation fixes.
- Platform is an optional, simple operational complement: environment/build/instance visibility, technical logs, tokens and costs. Different environments can run different code: each instance must expose only its own executable capabilities. Shared app configuration does not mean identical feature inventories.
- Local SDK remains fully useful without Platform. Connected Free: one app/one environment. Pro: additional apps/environments/teams and managed operations, consistent with the accepted earlier split. Multi-environment support belongs to the MVP; complex promotion UX is not a prerequisite.
- App authorization remains authoritative. No security mechanism is removed merely because it exists; unnecessary duplicated configuration and blanket approval UX are candidates for a separate, explicit simplification.
- Landingpage optimization follows the verified product. No unsupported features or unpublished package behavior presented as available.

## Approaches and decision

1. Build a generic initializer, universal parser and advanced governance together: too much scope and too little reference-app proof.
2. Hardcode another working Get It Done integration: quick demo, but preserves duplicate maintenance.
3. Improve the common SDK against small reproducible cases, then reconcile Get It Done and use it as the primary MVP acceptance app. Selected and subsequently expanded: three distinct integration forms must prove the generic contracts. Exhaustive framework coverage and special features remain on the roadmap.

## First implementation increment

Fix focused local intent routing end-to-end before changing installer architecture. Ambiguous/unknown/low-confidence intent must not automatically expose every tool schema. The model can clarify or use the existing bounded local `find_tools` mechanism. Known intent retains its own tools and explicit shared dependencies. Medium-confidence expansion is restricted to declared related modules, not every module's shared tools.

Preserve broad router/legacy pipeline behavior through an explicit compatibility path. Local Foundation pipeline defaults to focused selection and declares that its selection is authoritative, including an empty selection; older custom pipelines keep their previous empty-selection convention. No authorization changes. Technical routing metrics contain counts/strategy, never user input.

Implemented in the first increment: a shared AST-based route export recognizer for scanning and inventory verification, including constant exports and local aliases, with unsupported forms visible and no auto-approval. This does not yet deliver automatic end-to-end capability updates; see the implementation evidence and scope clarification.

## Subsequent MVP gates

1. Get It Done upstream reconciliation, latest chat/provider/UI retained, Foundation API/STT/principal fixes preserved; no production merge/deployment.
2. Fresh setup and endpoint/filter/navigation add/change/delete corpus across all three reference integration forms; no hidden prebuilt artifacts in the installation-time measurement. Declare additional runtime processes required by non-Node hosts.
3. Stable default chat modes, sessions, generic slash/mention providers and a framework-independent embedding path alongside React; one microphone controller/stream.
4. Content-free metrics pipeline: environment + build + instance + revision identifiers, latency/errors/tool counts/token usage; cost carries model/pricing provenance and missing values are not reported as zero. No business payloads in Platform logs.
5. Distinct dev/prod capability inventories; stale/missing local bindings never become executable merely through Platform configuration.
6. Landing hero/root readability, reduced motion, responsive performance and truthful install/docs/tariffs.

## Roadmap, not immediate scope

Exhaustive framework adapters/native SDKs and universal source parsers, richer managed widget catalogue, advanced evaluations, automatic prompt optimization, MCP/skill generation as a product, additional model engines, enterprise compliance UI, complex approval workflows, canary/promotion UI, generated UI. The bounded NestJS/Omnify reference is now in MVP scope; this does not automatically restore historical package exports. Preserve existing compatibility code unless its removal is separately decided. No TTS/duplex.

## Current reconciliation evidence

2026-09-13: fetched Get It Done `origin/master`. A non-checkout `git merge-tree` probe reports conflicts across chat, auth, deployment, package/build configuration and removed/generated legacy tool files. No merge or rebase was applied. Existing `.glirastes` connection/binding changes were preserved and must not be mistaken for the reference app's identity.
