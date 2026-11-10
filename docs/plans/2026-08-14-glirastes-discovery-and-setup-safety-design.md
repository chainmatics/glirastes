# Glirastes Discovery and Setup Safety Design

**Status:** Approved on 2026-08-14

## Goal

Improve Glirastes for operators of agents in enterprise applications and SaaS
products by adopting five proven patterns without weakening the Foundation
trust boundary:

1. hybrid, local tool discovery;
2. a read-only `glirastes setup --dry-run`;
3. monotone semantic updates;
4. stable machine-readable diagnostics; and
5. one semantic registry for runtime routing and user-facing tool metadata.

Generated UI remains outside this increment. Vendo's double-iframe jail is a
future security benchmark if Glirastes later gains generated application
surfaces.

## Product position

Glirastes operates and governs agents in enterprise applications and SaaS
products. Standalone remains the network-silent default. Managed remains an
explicit, signed, fail-closed add-on for governance and hot-swappable runtime
configuration.

## Hybrid tool discovery

The existing local classifier and module router remain the fast path. Their
selected module tools form the initial active set for a turn. A Foundation
`find_tools` meta-tool is also available when the signed manifest contains
additional eligible tools.

The discovery index is built locally at boot from the same validated semantic
artifact and runtime manifest that materialize the registry. Managed mode uses
the verified, signed manifest revision. Standalone uses the locally
materialized, self-signed revision. The index never contacts the Platform or a
remote registry during a turn.

Search is deterministic and bounded. It considers model-facing name,
description, module, shared module memberships, and usage hints. Disabled,
tombstoned, non-allowlisted, role-ineligible, or otherwise unauthorized tools
are absent. Results contain bounded semantic metadata and no schemas, source,
arguments, results, credentials, or business content.

Calling `find_tools` does not authorize or execute a domain tool. Its returned
tool names are added to the active model-visible set for the next model step.
The ordinary managed-turn guard, current principal resolution, signed policy,
revocation check, local binding check, schema validation, budgets, approvals,
and final host endpoint authorization remain unchanged. The loaded set is
turn-local and cannot cross a pinned revision boundary.

## Read-only setup planning

`glirastes setup --dry-run` runs the same planning and validation path as the
normal setup command but performs no writes and no remote mutations. `--json`
returns a stable machine-readable result suitable for agents and CI.

The plan records only bounded technical facts: artifact paths, operation kind,
counts, identifiers, digests, diagnostic codes, and whether an explicit
confirmation is required. It never contains source, prompt content, schemas,
tool inputs or outputs, credentials, or model transcripts.

Normal `glirastes setup` first computes and validates the same plan. Local
artifact changes are then committed atomically as one set. If validation or a
write fails, no partial artifact set becomes authoritative. Remote setup sync
continues to use its existing idempotent app-scoped run and artifact contract;
the local dry run never calls it.

## Monotone semantics

Semantic comparison classifies each proposed change as:

- unchanged;
- hardening;
- neutral presentation change; or
- loosening.

Hardening includes disabling a tool, increasing its risk, adding an approval
requirement, or narrowing roles. It may be applied without an additional
security confirmation. Neutral description, model-name, module, sharing, and
usage-hint edits remain publisher-controlled and cannot alter authorization.
Loosening includes enabling a tool, lowering risk, removing approval, or
widening roles. It requires explicit confirmation and is represented as such
in the plan. Unknown or incomparable changes fail closed instead of being
classified as neutral.

The existing signed revision and granular four-eyes publication paths remain
authoritative in Managed mode. Setup confirmation cannot bypass publication,
approval, signing, deployment, health, activation, or rollback gates.

## Stable diagnostics

Foundation CLI failures gain stable codes grouped by boundary:

- `E-SETUP-*` for setup planning and lifecycle;
- `E-INVENTORY-*` for discovery and source parity;
- `E-SEMANTICS-*` for semantic completeness and monotonicity;
- `E-BINDING-*` for identity and local execution bindings;
- `E-SIGNATURE-*` for signed runtime material; and
- `E-SCOPE-*` for app, environment, tenant, principal, and revision scope.

Human output keeps a concise remediation. JSON output uses a versioned shape
with code, operation, safe path or identifier, and remediation key. Raw
exceptions, response bodies, source snippets, credentials, prompts, arguments,
results, and transcripts are never included.

## One semantic registry

The validated tool-semantics artifact becomes the sole source for:

- model-facing tool names;
- primary and shared module membership;
- descriptions and usage hints;
- runtime discovery search;
- tool labels and approval descriptions; and
- generated module membership consumed by the local pipeline.

Generated files may remain as build artifacts or type surfaces, but they must
be derived from the semantic registry and protected by parity tests. They may
not carry an independently maintained tool-membership list. App-specific
module prompts and classification examples remain application behavior, not
tool authorization, and may stay in the host application.

## Verification

Implementation is test-driven. Required evidence includes:

- discovery ranking, bounds, authorization filtering, next-step activation,
  turn pinning, and network silence;
- identical Standalone and Managed discovery behavior for equivalent
  revisions;
- byte-for-byte unchanged artifacts after every dry run;
- identical plans for dry-run and normal setup before commit;
- atomic local write failure with no partial authoritative state;
- hardening, neutral, loosening, and unknown semantic comparisons;
- stable JSON diagnostics with content- and secret-boundary regression tests;
- generated-module and UI-metadata parity with the semantic artifact;
- SDK and Get It Done focused tests, complete suites, typechecks, production
  builds, diff checks, and secret audits.

No push, merge, release, package publication, production deployment, new
worktree, automatic environment creation, or security-boundary relaxation is
part of this increment.
