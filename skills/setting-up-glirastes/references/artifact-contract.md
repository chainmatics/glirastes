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

## Bootstrap from app code

Preserve existing identities, prompts and policy. Generate UUIDs once for a
new local app/planner/tool identity; do not regenerate them on each scan. Reuse
the real app identity when connecting an existing Platform application.

The initial local files are distinct:

| File | Contract |
| --- | --- |
| `.glirastes/foundation-execution-inventory.json` | `FoundationExecutionInventorySchema` from `glirastes/codegen`: `schemaVersion: 2`, `targetAppKey`, and source-derived `executions`. |
| `.glirastes/setup-artifact.json` | `AppSetupArtifactSchema` plus `assertAppSetupSemanticParity` from `glirastes/contracts`; `discoveryDigest` must match verified inventory discovery. |
| `.glirastes/prompt-bundle.json` | Local disk input: `schemaVersion: 1`, `appId`, `artifactRef`, and `sections` containing `planner`, `appBehavior`, `responseStyle`, `capabilityFragments`. This contains local prompt text, not Platform metadata. |

Inventory endpoints bind UUID, definition ID, stable method/path key, source
file, source fingerprint and schema digests. UI entries bind a real action ID
and local handler reference. Read the exported schema for exact required fields.
Use `createRouteSourceFingerprint` and `discoverFoundationExecutions` for their
verified Next.js source path; the latter does not verify arbitrary backend
languages. Never fill fingerprints/digests with placeholders or make unknown
input schemas accept everything just to pass validation.

Implement the app's generator against its actual schemas and handlers. It must
preserve curated descriptions and policy while detecting added/changed/removed
capabilities. A file listing hand-maintained tool definitions is not automatic
discovery. Generated files may be committed; provider credentials may not.

Set the package's `glirastes` paths to these local files. Set
`glirastes.principal: "server-verified"` only after implementing and testing the
real server-side resolver. It is a declaration to check, not authorization.
The runtime's `PromptBundleSchema` is a separate execution contract: materialize
it using the actual runtime types rather than passing the local disk `sections`
shape unchanged.

Use `glirastes setup --dry-run --json` to inspect the change plan. Source
fingerprints, discovery and complete prompt content are checked separately by
setup/doctor and application tests, not proved by dry-run alone. If using
`validate-artifact.ts`, resolve its path relative to this
skill's installation, not an assumed `skills/` folder in the target app. That
schema-only check does not replace inventory, principal, build or live testing.
