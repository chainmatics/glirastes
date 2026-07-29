---
name: maintaining-glirastes-tools
description: Use when a scanned endpoint or local UI action changes, fails sync, needs review, or must be enabled, renamed, revoked, or removed.
---

# Maintaining Glirastes Tools

## Source of truth

- Target app: executable input/output schemas, method/path or UI binding,
  source fingerprint, secrets, and final authorization.
- Platform: permanent tool UUID, name, description, purpose, risk/data class,
  roles, approval rules, and immutable revisions.

Never duplicate Platform semantics in application source. Never accept a
Platform-supplied executable schema without matching it to the local digest.

## Change workflow

1. Change the real endpoint, schema, or UI action.
2. Run `glirastes scan`.
3. Inspect changed fingerprints and risk evidence.
4. Review critical ambiguity in the Platform interviewer.
5. Run the project’s `glirastes:sync`.
6. Verify the signed manifest binds every enabled UUID to exactly one local
   executor.
7. Run contract, authorization, behavior, and browser tests.

Description-only changes publish a policy revision and activate at the next
turn boundary. Method, path, schema, or auth changes create a new manifest
revision and remain disabled until reviewed. Removed tools become tombstones.
An intentional rename keeps a UUID only through an explicit reviewed rename
migration.

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
| binding missing | `glirastes:sync` did not return every local executor |
| tool disabled | Structural change still awaits approval |
| wrong tenant or role | Principal was derived from client input |
| duplicate action | Idempotency key or durable tool evidence is missing |
