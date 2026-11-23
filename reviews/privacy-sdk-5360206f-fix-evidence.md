# Retained restrictions across orderly replacement

Implementation-author evidence correcting the independent Codex strong review
of 5360206f26a3ed07d6be8ca5b5f07c9829ddebef (archived alongside this ledger).

Verified floors and revocations now survive orderly same-process replacement
under the same app/environment binding. A replacement clears current acceptance
and requires fresh bootstrap; it cannot discard an earlier failed-save restriction.
Stopped managed turns remain blocked even after a replacement reconciles.
Stopping ownership lives in a private WeakSet, so sealed/frozen public handles
can shut down normally. Test fixture teardown clears the retained registry only
between independent synthetic authorities that reuse fixture identifiers.

Red: `/tmp/privacy-sdk-5360206f-handoff-red.log`, three failing cases on the
reviewed implementation (including immutable-handle cleanup failures).
Green: `/tmp/privacy-sdk-retained-handoff-green3.log`, 89 cases in two files,
including signed protection, newer explicit off, retained revocation, stale
turn HTTP 503 with zero provider requests, and both immutable-handle variants.
The initial additional revocation assertion expected a specific revoked error;
fresh bootstrap correctly refuses the revoked snapshot as unavailable instead.

The 5360206f full gate (8,373 passed, 17 expected failures, 58 upstream skips)
is historical evidence only. Full replacement gating and independent verification
must be attributed to the new commit. No release or deployed acceptance is claimed.
