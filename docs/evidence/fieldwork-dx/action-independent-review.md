# Independent browser-action review

Reviewed server request-only results, model guidance, dispatch return/exception handling, route registration, origin-session cancellation, provider deduplication/stream reconciliation, local receipts, and stored-message migration.

One concrete race reproduced and fixed: navigation could synchronously abort the originating session before the dispatcher's abort listener was installed. The route handler then ran and the dispatch promise resolved successfully. The dispatcher now checks the signal immediately after listener registration. `src/browser/client-actions-cancellation.test.ts` failed against the prior implementation (unexpected fulfilled promise) and passes with zero handler calls after the correction. Before/after logs are adjacent.

Targeted independent run: 6 files, 37 tests passed; test TypeScript check passed. Sanitizer follow-up covers both modern output and legacy tool-result/result shapes without modifying inputs, action payloads or approval bindings. UI summary suppression handles both forms.

No server ACK endpoint was introduced. Browser receipts remain local presentation data, never mutation authorization or server proof. Tool-call deduplication is scoped to provider/history; a newly requested tool call has a new identity. Timeouts/cancellation cannot undo effects of an already-running application handler. Existing free-form historical assistant text is preserved, so this migration cannot retract old natural-language claims.
