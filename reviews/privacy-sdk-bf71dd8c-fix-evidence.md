# Temporal boundary fixes after bf71dd8c

Implementation-author evidence, not independent verification. The independent
source-only report is `privacy-sdk-bf71dd8c-codex-strong-verification.md` and
remains immutable. Its six findings hold for that old SHA.

Changes cover live approval receivers, per-attempt model/classifier dispatch,
explicit refusal of opaque protected router/guardrail callbacks, scoped sync
connection ownership with drained durable writes, immediate refusal floors and
readiness parity for UUID/store-only managed bootstrap. CLI help now names the
explicit privacy binding option. Ordinary unconfigured behavior remains governed
by the fixed f29b3607 upstream parity fixture.

Regression evidence:

- Detached bf71dd8c with copied regression tests:
  `/tmp/privacy-sdk-bf71dd8c-temporal-red.log`: 9 failed, 1 passed, 124 filtered.
  Failures include actual serialized model retries after signed off revocation,
  protected opaque callback HTTP, stale connection reconciliation and delayed
  refusal. These are selected tests, not full-suite skips.
- `/tmp/privacy-sdk-temporal-focused3.log`: 153 passed in six files, no skips,
  with required isolated PostgreSQL. Uses Bun 1.4.5 and the task-owned loopback
  PostgreSQL at port 55432; no remote database or provider.
- Build and test typechecks: `/tmp/privacy-sdk-temporal-build.log` and
  `/tmp/privacy-sdk-temporal-types-final.log`. Egress inventory:
  `/tmp/privacy-sdk-temporal-egress-final.log`, 60 reviewed sites, zero violations.

Retries deliberately allow the first ordinary off request and require zero
additional requests after revocation. Protected refusals require zero requests
in total. Captures use synthetic canaries and mocked HTTP endpoints through real
provider serialization; they are not live provider or staging acceptance.

Full gate `/tmp/privacy-sdk-temporal-full.log` and its JSON report: **8,353
passed, 17 expected failures, 58 skips**, 542 passed files / seven skipped,
173.75 seconds, exit 0. The expected-failure/skip identities are the unchanged
fixed-upstream exceptions documented in `privacy-sdk-f29b3607-baseline-exceptions.md`.
Independent replacement-SHA verification is recorded separately. No package,
image, branch merge or deployment is
authorized by this evidence.
