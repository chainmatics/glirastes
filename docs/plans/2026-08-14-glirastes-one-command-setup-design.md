# Glirastes One-Command Setup Design

**Status:** Approved on 2026-08-14

## Goal

Make the safe path the short path:

```bash
npx glirastes setup --dry-run
npx glirastes setup
npx glirastes doctor
```

The flow targets developers embedding governed agents in enterprise
applications and SaaS products. It must not trade setup convenience for guessed
authorization, implicit Managed activation, source rewriting, or weaker
runtime validation.

## Approaches considered

1. **Polish the existing wizard.** This preserves the current architecture but
   still pauses for a separately invoked setup skill and repeats facts already
   present in local artifacts. It does not produce a one-command result.
2. **Rewrite application source like an initializer.** This can look fast in a
   demo, but reliable auth, principal resolution, and final endpoint
   authorization cannot be inferred safely. It also conflicts with the
   existing preservation-first installer boundary.
3. **Conservative local bootstrap.** Detect verifiable facts, plan and apply
   only the `.glirastes` artifact set, and report unresolved application wiring
   as bounded Doctor diagnostics. This is the selected approach.

## Setup profile detection

One local detector reads only bounded project metadata and Glirastes artifacts.
It reports:

- framework markers, initially Next.js;
- supported authentication package markers without claiming that auth is
  correctly wired;
- the positive execution inventory and execution count;
- setup and prompt artifacts plus their app identity;
- Standalone or explicitly requested Managed mode; and
- existing runtime build artifacts.

Detection never reads credential values, source bodies, prompts, tool schemas,
arguments, results, or business data into CLI output. Package names and local
relative paths are technical metadata. Conflicting app identities or ambiguous
artifact candidates fail closed.

Standalone is the default. Managed setup is entered only with `--managed` and
requires the existing control-plane URL, app ID, and app-scoped API key. Merely
finding a URL or credential in the environment never upgrades a Standalone
setup to Managed, and the command never creates an app or environment.

## Dry run and apply

`setup --dry-run` works without remote credentials and performs no writes or
network requests. It resolves the current proposed setup artifact, validates
semantic and execution parity, identifies the exact local files that normal
setup would replace, classifies semantic changes, and emits one stable digest.

Normal `setup` recomputes the same plan immediately before applying it. If the
plan contains a semantic loosening, the operator must provide
`--confirm-loosening --plan-digest <exact-digest>`. The CLI then atomically:

1. adopts the validated setup artifact as the canonical local artifact;
2. preserves the previous canonical artifact as the comparison baseline;
3. builds the local runtime and prompt manifests; and
4. records a bounded setup receipt used by Doctor.

All authoritative replacements use the existing staged, fsynced artifact-set
writer. A failure restores the previous complete set. Standalone performs no
network request and finishes by instructing the operator to restart the app.
Managed performs the existing idempotent app-scoped sync only after the local
transaction and only when `--managed` is explicit. Publication, approval,
deployment, health, activation, and rollback remain separate governed server
operations.

The CLI does not synthesize executable bindings or claim an auth integration it
cannot prove. If a positive inventory, prompt bundle, setup artifact, or
server-side principal binding is absent, setup stops with a stable remediation
instead of generating permissive placeholders.

## Doctor

`glirastes doctor` is read-only and network-silent by default. It returns a
versioned list of checks in text or with `--json`:

- project/framework detected;
- application identity consistent;
- positive inventory present and source fingerprints current;
- setup semantics complete and in parity;
- prompt bundle valid and app-scoped;
- local bindings and built manifests present and current;
- server-side principal/auth wiring declared;
- runtime mode internally consistent; and
- restart required after a newer setup receipt.

Each check is `pass`, `warn`, or `fail`, carries a stable diagnostic code and a
bounded remediation key, and contains no raw exception or secret. Any failed
security, scope, binding, semantic, or signature check makes Doctor exit
non-zero. Warnings may describe optional UX or framework integration. Managed
remote health is deliberately not part of the default command; a future
explicit remote probe may be added without changing local Doctor semantics.

## Output

Human output is concise and action-oriented:

```text
Glirastes setup
  93 tools validated
  Standalone artifacts installed
  Security policy unchanged

Restart the application, then run: glirastes doctor
```

JSON output is deterministic and contains only counts, modes, relative paths,
digests, diagnostic codes, and remediation keys.

## Testing and boundaries

Implementation is test-driven. Tests prove identical dry-run/apply plans,
zero dry-run and Doctor writes, zero Standalone network calls, rollback after a
mid-transaction failure, exact loosening confirmation, app-scope conflicts,
safe output, deterministic JSON, Doctor exit status, Managed explicitness, and
consumer compatibility in Get It Done.

No new worktree, push, merge, release, package publication, production
deployment, automatic app/environment creation, source rewrite, credential
output, or weakening of auth, scoping, signing, approval, or fail-closed
behavior is included.
