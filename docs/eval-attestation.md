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
| `suiteDigest` | `sha256:` over the relative path and file digest of every file in `--suite` (see below) |
| `result` | `pass` when `--failed` is 0, otherwise `fail` |
| `total`, `failed`, `ranAt`, `ciRunRef` | the flags and the current time |

No case, input, output, prompt, file name or model name leaves the CI. The body
is `EvalAttestationRequestSchema` from `glirastes/contracts`; the golden vector
is `src/contracts/__vectors__/eval-attestation.v1.json`, including the suite
digest cases.

## Suite digest

- Every regular file below `--suite` counts, hidden files and directories
  included. Only `.DS_Store`, `Thumbs.db` and `desktop.ini` are left out.
- A single file is listed under its base name.
- Each entry is `{ path, sha256 }`: the relative path with `/` separators in
  Unicode NFC, and the sha256 (base64url) of the raw file bytes. Entries are
  sorted by the UTF-8 bytes of the path; the digest is the sha256 of
  `canonicalRuntimeJson({ schemaVersion: 1, files })`.
- Refused (exit 2): symbolic links of any kind, entries that are neither file
  nor directory, two paths equal after NFC normalisation, and a suite without
  files.
- Line endings count; nothing is normalised. A checkout with CRLF has another
  digest than one with LF. Attest from the same commit you deploy, and set
  `* text=auto eol=lf` (or `eol=lf` for the suite's path) in `.gitattributes`
  so every CI runner checks out the same bytes.

## Request

`POST {GLIRASTES_CONTROL_PLANE_URL}/v1/apps/:appId/eval-attestations` with
`x-api-key: GLIRASTES_API_KEY` (the app's CI key). The app id comes from the
setup artifact; the URL defaults to the hosted Platform and must be `https`
(plain `http` only for `localhost`, `127.x.x.x` and `[::1]`). A redirect is
never followed, so the key cannot travel to another origin.

Exit codes: `0` pass recorded; `1` fail recorded, the Platform refused,
redirected or was unreachable (the message names status and code, never the key),
or it answered 2xx with an unreadable body (result unknown, the attestation may
have been recorded); `2` usage or configuration problem (missing key, missing
setup artifact or digest, refused suite), and then nothing was sent. Messages
never name a suite file.

Attest the same commit you deploy: a refresh that changes the setup artifact or
the prompt bundle changes the digests, and the gate finds no matching attest.
