# Model shape and runtime handoff corrections

Implementation-author evidence after the independent strong d1ba9fc4 report.
The report's three runtime findings also applied to e860c6ff, whose added CLI
and release delta was independently inspected without a merge-specific finding.

- Stop now keeps per-app ownership until accepted-state writes finish; attempts
  to recreate during that interval refuse with `runtime_stopping`. Callers await
  `stop()` before recreation. This also prevents a concurrent caller from loading
  the backend while the previous writer can still replace it.
- Per-attempt dispatch forwards supported callable and frozen descriptors via a
  fresh target, retaining the original model receiver without immutable-property
  Proxy violations. Generation and stream refusals produce no further HTTP calls.
- The generic pairing regression now stops its standalone instance before the
  connected case and verifies zero versus one connection lookup.
- The inherited worklet diagnostic now omits URL queries and fragments from
  JSON and human output; the source-only low observation has a focused canary test.

Red on e860c6ff implementation: `/tmp/privacy-sdk-e860c6ff-edge-red.log`, three
failed cases and one positive plain-model control passed, 80 name-filtered tests.
Corrected runtime/model selection: `/tmp/privacy-sdk-shapes-lifecycle-green.log`,
84 passed in two files with required isolated PostgreSQL configured. Source
typecheck passed; CLI/release-note focused selection passed101 in five files
(`/tmp/privacy-sdk-shapes-types.log`, `/tmp/privacy-sdk-025-merge-focused.log`).

The unchanged d1ba9fc4 full gate remains 8,354 passed / 17 expected failures /
58 upstream skips. It is not transferred to these changes. Replacement full
gating, build and independent verification are recorded separately. No external
provider, publication, protected merge or deployment has occurred.
