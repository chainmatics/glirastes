# Resource-retention correction

Independent strong Codex verification of a60a2f16 closed the failed-save handoff
and immutable-handle findings, including cross-format scope and stale-turn probes.
Its remaining Low finding concerned retained consumer backend and deployment
references after stop. After draining writes and metrics, stop now clears those
references while retaining the same restricted floor/revocation wrapper needed
for handoff. A small content-free entry may remain per previously bound scope;
this is intentional process-local security memory, not a live backend graph.

Author verification: `/tmp/privacy-sdk-release-resources-green.log`, 90 runtime
and dispatch cases passed. It includes failed-save/revocation handoff, newer off,
stale turns, immutable handles and direct absence of retained backend/deployment
references after shutdown. The preceding a60a2f16 full isolated-PG gate was 8,378
passed, 17 expected failures and 58 upstream skips, 184.27 seconds. Its build,
source/test types and 60-site/zero-violation inventory passed. Replacement full
gate and independent Low-fix verification are recorded separately.
