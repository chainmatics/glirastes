# Limit cleanup to retained bound stores

The independent source review of a58d6a03 found a collateral regression: clearing
a private unbound store could forget signed-off authority on a stopped handle.
The corrected cleanup runs only for valid environment bindings, which are the
stores retained in the global registry. Private stores are collected with their
handle and keep authority while a caller retains it. Ordinary no-policy behavior
and bound resource cleanup remain covered by existing controls.

Author red: `/tmp/privacy-sdk-a58-stopped-unbound-transport-red.log`, one regression
with three failed assertions: the stopped policy returned ordinary, the public
handler returned200, and one serialized synthetic provider request was captured.
Green: `/tmp/privacy-sdk-scoped-stop-green.log`, 91 runtime/model cases passed;
the new case returns503 and captures zero provider requests. This is a fixture
transport, not a live external provider.

The a58d6a03 full gate passed8,379 with17 expected failures and58 upstream skips,
179.24s, but did not contain this newly discovered negative case and is not
release acceptance. Replacement exact-source full gating and independent review
are required and recorded separately. Original reports remain immutable.
