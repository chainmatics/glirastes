# Generation-safe shared STT lifecycle

FR-5 continuation of the full MVP requirements and GID reconciliation, not a
replacement for the remaining UI, setup, framework or Platform gates.

## Reproduced boundary

After the retained-window checkpoint (`e5a44ab` / GID `139e6d7`), independent
review demonstrated that two controller `stop()` calls could finalize twice.
One returned while another awaited provider close. Starting a new recording in
that interval let old cleanup read and stop the new microphone, then overwrite
its phase. A Close-only guard prevented one caller but did not fix the common
SDK lifecycle used by other apps and entry points.

Additional public-API tests reproduced stale Cancel and failure completions,
Stop during restart cleanup, immediate disposal during startup, cancellation
errors leaking microphones, and subscriber-triggered disposal during Stop.

## Implementation

- A generation-keyed in-flight Stop promise joins callers through finalization
  and cleanup. Install it before notifying subscribers; do not join an older
  generation's Stop when another recording has started.
- Start invalidates the preceding generation before any asynchronous cleanup
  and immediately reports a pending state. Check ownership before acquiring a
  microphone, connecting a provider or applying subsequent state.
- Resource release detaches the stream, connection and abort controller before
  awaiting provider close. Stop the captured microphone tracks immediately;
  delayed or rejected provider cleanup cannot touch newly acquired resources.
- Stop captures its connection before notifying subscribers and checks
  generation after notification/finalization/cleanup. Late provider segments
  cannot revive a completed or superseded session.
- Cancel captures its own previous draft and checks ownership after each await.
  Provider cancellation failures still release the microphone and become a
  recoverable failed state. Failure cleanup preserves the original error,
  suppresses secondary close errors, and cannot overwrite a newer recording.

Public return contracts remain unchanged: Stop returns recorded speech only;
Cancel returns the draft passed into Start. Combining speech with editor text
and structured mentions remains the UI's responsibility. No second recording
controller, stream, provider dependency or Platform call was introduced.

## Verification

13 additional controller tests cover the lifecycle boundaries; 12 reproduced
failures before repair and one guards existing connecting-subscriber disposal
behavior while removing its internal exception-based short circuit. Tests use
the real controller with deferred provider/media boundaries, no live microphone
or external provider. Original 10 controller cases remain in place.

- SDK full suite: **1,048 tests / 128 files**; typecheck and ESM/CJS build pass.
- Independent review: **23 controller tests** pass and no remaining blocking
  finding in this increment; whitespace audit passes.
- GID compatibility: **989 tests / 60 files**, typecheck and isolated Next
  16.1.6 Webpack production build pass against the rebuilt SDK. Its actual
  controller/UI tests still preserve drafts and task ids across closing.
  Source-copy build produced 47 static pages without `.env` files or a real
  database; only the existing middleware deprecation warning remains.
- Changed-file secret-pattern and whitespace audits pass. No app server, live
  microphone/provider, database, remote write, publication or deployment used.

Open: real browser/microphone/provider parity, route-triggered cleanup, mobile/
sidebar shell, replaced-opener focus behavior and all other full MVP gates.
These tests do not prove an actual novice installation or a live tool action.
