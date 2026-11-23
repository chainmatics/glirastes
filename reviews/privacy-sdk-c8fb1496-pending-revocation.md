# Verified revocation awaiting storage

Implementation-author follow-up to the temporal review. Source c8fb1496 passed
the full 8,353-test gate, but a further actual serialized provider probe found
one ordinary request during a verified signed-off revocation's pending save.
`/tmp/privacy-sdk-c8fb1496-pending-revocation-red.log` has one failed regression,
76 name-filtered cases; expected zero requests, observed one.

The accepted-state wrapper now retains verified revocations by environment before
waiting for persistence, including across connection reattachment. Loading state
merges this retained set so it is durably carried forward. The sync manager saves
each verified revocation before verifying the next one and propagates storage
errors; invalid signatures and foreign scope never enter the retained set.

`/tmp/privacy-sdk-pending-revocation-green.log`: 93 passed in the runtime, sync
manager and managed-sync suites, no skips, required isolated PostgreSQL configured.
The new HTTP case blocks both a previously pinned turn and the current policy
while storage is pending. Its exact full replacement gate and independent strong
review are recorded separately. No real provider, deployment or release action.
