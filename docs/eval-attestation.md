# Eval attestation

Evals run in your own CI. `glirastes evals attest` reports their result to the
Platform, which can require a passing attest before it activates, promotes or
starts a canary for a deployment (the environment's eval gate). The attest is a
self-report of your CI; it is a precondition, never an approval.

```bash
glirastes evals attest --suite <file|dir> --total <n> --failed <n> [--run-ref <label>] [--root <dir>] [--json]
```

The command never runs your suite and never calls a model. It sends:

| Field | Source |
|---|---|
| `setupArtifactDigest` | `.glirastes/setup-artifact.json#discoveryDigest`; the Platform stores it on every config revision |
| `promptDigest` | `.glirastes/setup-artifact.json#prompts.bundleDigest`; the deployment's `promptDigest` |
| `suiteDigest` | `sha256:` over the sorted list of relative path and file digest of `--suite` |
| `result` | `pass` when `--failed` is 0, otherwise `fail` |
| `total`, `failed`, `ranAt`, `ciRunRef` | the flags and the current time |

No case, input, output, prompt, file name or model name leaves the CI. The body
is `EvalAttestationRequestSchema` from `glirastes/contracts`; the golden vector
is `src/contracts/__vectors__/eval-attestation.v1.json`, including the suite
digest algorithm. Links inside the suite are refused, not followed.

Request: `POST {GLIRASTES_CONTROL_PLANE_URL}/v1/apps/:appId/eval-attestations`
with `x-api-key: GLIRASTES_API_KEY` (the app's CI key). The app id comes from the
setup artifact; the URL defaults to the hosted Platform.

Exit codes: `0` pass recorded, `1` fail recorded or the Platform refused or was
unreachable (the message names status and code, never the key), `2` usage or
configuration problem (missing key, missing setup artifact or digest), and then
nothing was sent.

Attest the same commit you deploy: a refresh that changes the setup artifact or
the prompt bundle changes the digests, and the gate finds no matching attest.
