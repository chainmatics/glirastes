---
name: maintaining-glirastes-tools
description: Use when a scanned endpoint or local UI action changes, fails sync, needs review, or must be enabled, renamed, revoked, or removed.
---

# Maintaining Glirastes Tools

## Source of truth

- App code owns executable schemas, endpoint/navigation/filter handlers,
  current capabilities and final authorization. Local generated artifacts bind
  those capabilities to stable identities and reviewed metadata.
- Local prompt files remain local. Preserve curated descriptions, policy and
  identities when regenerating; code changes do not authorize policy loosening.
- Optional Platform connection stores technical metadata/revisions, not source,
  executable schemas, prompts or business content. Sync never creates missing
  app code. Preserve existing app/environment scope and Managed configuration.

Use `setting-up-glirastes` for the initial artifact contract. The developer
must not maintain a second tool catalogue. Do not accept a Platform definition
as executable without a matching local handler/schema/fingerprint.

## Change workflow

1. Change the real endpoint, schema or UI action. Run the app's source-derived
   regeneration command from its package/build configuration. Route-only scan
   does not discover navigation/filter behavior. If no generator covers the
   change, implement and test it; do not hand-edit tool lists or claim universal
   language parsing is already available.
2. Inspect added/changed/removed capabilities and assessment evidence. Preserve
   UUIDs for unchanged identities, tuned prompts and approved policy. Unknown
   effects remain disabled pending actual code inspection or a material question.
3. Run `glirastes setup --dry-run --json` to inspect the change plan, not to
   claim full validation. Apply `glirastes setup`, then `glirastes doctor`;
   policy-loosening confirmation requires the exact reviewed plan digest.
   Never automatically approve loosening to clear a failure.
4. In Standalone, restart the local application to load the new snapshot. No
   Platform account or sync is required. Connected apps may sync the validated
   result with `glirastes sync`; this uploads, not reassesses or activates.
   Existing Managed apps retain `--managed` for dry-run, setup and Doctor and
   their actual verified revision source; never silently downgrade them.
5. Verify every enabled UUID has exactly one compatible local executor. Test
   endpoint, navigation and filter add/change/delete through regeneration and
   the real execution path. Removed capabilities must not execute, including
   after rollout/rollback; a Platform configuration cannot restore missing code.
6. Run contract, authorization, behavior and browser tests. CI must report
   stale/incomplete generation as a failure, not keep obsolete tools silently.
   Evaluate discovery findings explicitly: `ui-action-handler-not-found` must
   fail generation/CI even if the inventory still contains that execution.
   Setup/Doctor also reject that missing-handler finding. Static source matching
   does not prove that a handler mounts or executes; retain the behavior tests.

Managed publication/activation remain separate approved operations. Compatible
updates only affect subsequent turns; existing turns retain their pinned
snapshot. Method/path/schema/auth changes need compatible regenerated local
bindings and review. Removed tools become tombstones where the revision
protocol requires them. A label-only rename preserves identity. A real identity
change uses a reviewed project-specific migration if one exists; otherwise
obtain the actual decision and implement/test that migration. Do not invent a
generic SDK rename command or guess identity from the new label.

## Safety checks

- Re-resolve `resolvePrincipal` before every tool call.
- Effective permission is current user rights intersected with agent allowlist
  and tenant/tool policy.
- Treat GET as unknown until side effects, data class, external calls, limits,
  auth, and schemas are proven safe.
- Writing, deleting, financial, personal-data, external, or unclear tools
  always need review.
- A security revocation blocks before the next tool call, even during a pinned
  turn.

## Common failures

| Symptom | Check |
|---|---|
| fingerprint mismatch | Generated inventory and deployed source differ |
| binding missing | Source generation did not bind every enabled local executor |
| tool disabled | Structural change still awaits approval |
| wrong tenant or role | Principal was derived from client input |
| duplicate action | Idempotency key or durable tool evidence is missing |
| update not visible | Standalone needs restart; Managed needs compatible signed activation |
