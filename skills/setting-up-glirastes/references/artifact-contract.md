# Setup artifact contract

Create one JSON document accepted by `AppSetupArtifactSchema` from
`glirastes/contracts`.

Required top-level fields:

- `schemaVersion: 1`
- UUIDs: `artifactId`, `runId`, `appId`
- `discoveryDigest`
- `assessmentMode`: `autonomous` or `interview`
- `status`: `review` or `ready`
- `tools`, `planner`, `prompts`, `warnings`, `generatedAt`

Each tool carries its stable UUID, definition name, execution kind, operation
group, risk class, enabled/approval flags, source fingerprint, and input/output
schema digests. Reference every planner tool from the same artifact.

Prompt metadata carries artifact and group digests plus a local or
customer-controlled `artifactRef`. Do not embed prompt text.

Forbidden content includes source, raw credentials, authorization values,
business payloads, tool arguments/results, raw prompts, model transcripts, and
secret-shaped values. Validation errors may identify a field path but must not
echo a rejected value.
