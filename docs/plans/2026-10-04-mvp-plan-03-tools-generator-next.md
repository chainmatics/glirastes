# Generator-Kern, Next.js-Endpunkte und CLI refresh/check/status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `glirastes tools refresh|check|status` derives executable, policy-bounded endpoint tools for Next.js apps deterministically from the app code and writes byte-reproducible, committed outputs that the runtime boots from.

**Architecture:** A source (`next-app`) enumerates routes via the existing `scanNextAppRoutes` source-discovery mode, analyses each handler with one bounded `ts.Program` (contract tiers 1, 2, 4, 5, 6), probes exported schemas in a scrubbed child process and hands `ObservedTool`s to a pipeline that reuses `reconcileExecutionInventory`, `discoverFoundationExecutions`, the P02 policy contract and the existing setup-plan/manifest/atomic-write building blocks. The runtime consumes the generated module through `createContractBindings`, which recomputes schema digests at boot and disables only mismatching tools. Work continues in the worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools` on branch `codex/mvp-tools` (created by P02 Task 0 from `codex/glirastes-foundation-runtime`), after all P02 tasks are committed there; P03 builds on P02's `src/contracts/tool-policy.ts`, its `added` classification in `setup-plan.ts` (P02 Task 10) and its `E-POLICY-*` diagnostic family.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict), Node ≥ 20.6 (`module.register` for the probe loader), Zod v4, Ajv 8, Vitest 4, Bun.

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (sections 4.1, 4.2, 4.3, 4.4, 4.5 consumed via P02, 4.8, 4.11 Next fixture, 4.12 Next endpoint part of the change corpus)

## Global Constraints

- Mode resolution: flag → `GLIRASTES_TOOLS_MODE` (`write`/`frozen`/`integrity`) → `CI` set ⇒ `frozen` → otherwise `write`.
- `glirastes tools` never loads `.env` implicitly; `src/cli/index.ts` must not contain the literal `'generate'` (guard `src/public-subpaths.test.ts`).
- `.glirastes/tools.json` = `{schemaVersion, appId, targetAppKey, locale, sources:[…], emit:{module?, mcpCatalog?}, enrich:{managed?, model?, writeContracts?}, ci:{strict?, requireEnrichment?}}` and never contains a key.
- `refresh` never overwrites inputs (`tools.json`, `tool-policy.json`, `tool-resolutions.json`, `tool-semantics.json`, `prompt-bundle.json`).
- Outputs: `foundation-execution-inventory.json` (v2 + optional `sourceKind`), `tool-tombstones.json`, `tool-contracts.json`, `tool-report.json` (content-free), `setup-artifact.json`, `build/runtime-manifest.json` (+`policyDigest`), `build/prompt-manifest.json`, `setup-receipt.json`, generated module `src/generated/glirastes/tools.generated.ts` with `toolCatalog`, `createToolBindings`, `GeneratedToolId`.
- Reproducibility: `artifactId`/`runId` = UUIDv5 from app and content digest; `generatedAt` carried when content is unchanged; canonically sorted JSON plus newline; `check` uses no clock, randomness or network.
- Whole refresh fails and writes nothing on incomplete enumeration (`E-INVENTORY-011`), identity conflict or invalid policy; with `--keep-going` in dev: exit 0 and old outputs stay.
- Contract tiers (first match wins): 1 native Zod (`parse`/`safeParse`/`parseAsync`/`safeParseAsync`, role by data flow, declared `handlerWrappers`/`bodyReaders`), 2 contract module (load-bearing if the handler imports it), 3 legacy (P11), 4 `tool-resolutions.json`, 5 derived weak contract (warning `contract-derived`), 6 `needs_attention: input-contract-unresolved`.
- Descriptive contracts are bound to `interfaceDigest` (method, path, parameters, query keys, schema bindings, body keys; fallback handler text); mismatch ⇒ `contract-stale`, tool disabled; cosmetic changes never make a contract stale.
- Schema probe: child process, environment reduced to `PATH`/`NODE_ENV`/`TZ`, 10 s timeout, no shell; JSON Schema via the app's Zod (v4 `toJSONSchema`, v3 `zod-to-json-schema`).
- Output schema: explicit schema, else checker inference of the response argument (depth ≤ 6), else `{}` with warning `output-contract-opaque`.
- Defaults come only from P02 `deriveToolPolicyDefaults`: GET/HEAD `read`/`safe-read`/no confirmation, POST `create`/`write`/confirmation, PUT/PATCH `update`/`write`/confirmation, DELETE `delete`/`delete`/confirmation; tier 3 always confirmation; `allowedRoles` empty by default.
- Default exclusions: `/api/auth/**`, webhooks, cron, callbacks, health, catch-all, chat and STT handlers (a `chat`/`chat-vN` or `stt`/`speech…`/`transcribe` segment anywhere in the path, e.g. Get It Done's `/api/ai/chat` and `/api/ai/speech-*`, or any `…ChatHandler` import from a Glirastes/agentic module); every enumerated element ends as tool, disabled `needs_attention` tool with kept identity, or reasoned exclusion.
- Identity: `toolId` only from `reconcileExecutionInventory` (UUIDv5 incl. tombstone generation; reappearance ⇒ new ID); `definitionId`: contract ID → previous inventory → derived `<resource>.list|get|create|update|delete`; a known, still enumerated but unresolved tool keeps its ID with `enabled:false`.
- Prose fallback: JSDoc → contract → `.describe()` → `tool-semantics.json` → locale template (warning `description-templated`); local policy description wins over code prose.
- `compareArtifacts` classifies a new tool at its defaults as `added` without confirmation (implemented by P02 Task 10; P03 only exports it and reuses the plan core); a committed relaxation stays a `loosening`.
- `tool-resolutions.json` entries pass a basic gate (strict schema, Ajv strict, input object with `additionalProperties:false`, ≤ 32 KB, no keys without code evidence, no secret-looking content); a rejected entry ⇒ warning `resolution-rejected`, the tool keeps its fallback.
- `check` fails on byte drift, incomplete enumeration, invalid policy (`E-POLICY-001`) or an unconfirmed loosening (`E-POLICY-002`); `--strict` (or `tools.json ci.strict`, default off) additionally fails on `needs_attention` tools.
- Deploy (`integrity`) verifies only the chain inventory → discovery `inventoryDigest` → artifact `discoveryDigest` → runtime manifest (`runtimeDigest`, `policyDigest`) → receipt plus generated-module bytes; no model, no Platform call, no writes, no source observation.
- Runtime: digests recomputed at boot; a missing or mismatching binding disables only that tool.
- No push, merge, publish or deploy; Omnify untouched; commits in Conventional Commits, lowercase imperative ≤ 72 chars, no AI attribution.

## Review Focus

1. **Wrapper-exported handlers** (`export const POST = withAuth(async (req) => …)`) must still become tools, never a silent drop and never a fatal `E-INVENTORY-011`. Pinned in Task 3 (inventory verification accepts the export), Task 6 (locator finds the inner function) and Task 14 (the `next-app` source turns `export const GET = withLogging(async (request) => …)` into an enabled tool with auth evidence).
2. **Schema modules with import-time side effects or secret requirements** must fail closed per tool (`schema-module-unloadable`), must not hang refresh and must never see app secrets. Pinned in Task 10 (throwing module, scrubbed environment, timeout).
3. **Git merge conflict markers in generated `.glirastes` files** must resolve by rerunning refresh, deterministically, without reviving tombstoned IDs and without silently switching a managed app's receipt to standalone. Pinned in Task 4 (inventory, tombstones, artifact, contracts and receipt-mode conflicts).
4. **TypeScript path aliases and `.js`-suffixed or extensionless imports of `.ts` schema modules** must resolve in both the checker and the probe. Pinned in Task 5 (checker alias), Task 7 (binding through alias) and Task 10 (probe through alias and `.js` suffix).
5. **`check` right after `refresh` must be byte-identical**, even after a risk raise or with a previous artifact: nothing relative to the previous state may leak into outputs. Pinned in Task 20 (byte-identical rerun, frozen check right after write, risk raise without drift) and Task 21 (integrity right after write).

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/diagnostics/foundation-diagnostic.ts` | Modify | Add the `E-TOOLS-*` diagnostic prefix |
| `src/codegen/tools/config.ts` | Create | `tools.json` schema, loader, input/output path constants |
| `src/codegen/tools/mode.ts` | Create | `write`/`frozen`/`integrity` resolution |
| `src/codegen/tools/types.ts` | Create | Shared generator types (findings, contracts, observations, sources) |
| `src/codegen/tools/findings.ts` | Create | Finding factory, next safe actions, transient codes, ordering |
| `src/codegen/tools/canonical.ts` | Create | Canonical JSON, digests, deterministic UUIDs, JSON-schema digest |
| `src/codegen/tools/interface-digest.ts` | Create | `computeInterfaceDigest` |
| `src/codegen/execution-inventory.ts` | Modify | Optional `sourceKind`, dispatch, accept unresolved-body exports |
| `src/codegen/route-scanner.ts` | Modify | Export `AUTH_PATTERNS` and `toRoutePath` |
| `src/codegen/tools/files.ts` | Create | Zod schemas of `tool-tombstones.json` and `tool-contracts.json` |
| `src/codegen/tools/state.ts` | Create | Previous state reader with merge-conflict recovery; inventory/tombstone renderers |
| `src/codegen/tools/__tests__/app-fixture.ts` | Create | Test-only temporary app fixture under the SDK root |
| `src/codegen/tools/program.ts` | Create | One bounded `ts.Program` per app `tsconfig.json` |
| `src/codegen/tools/handler-locator.ts` | Create | Exported handler, JSDoc, parameters, normalized text |
| `src/codegen/tools/input-roles.ts` | Create | Data-flow role classification, query keys, closed body keys |
| `src/codegen/tools/handler-analysis.ts` | Create | Schema bindings via checker, wrappers, body readers, response arguments |
| `src/codegen/tools/evidence.ts` | Create | Auth and external-call evidence, transitive depth 2 |
| `src/codegen/tools/exclusions.ts` | Create | Default and policy exclusions |
| `src/codegen/tools/identity.ts` | Create | `definitionId` derivation and sticky assignment |
| `src/codegen/tools/schema-probe.ts` | Create | Child-process schema probe client |
| `src/codegen/tools/probe-child.mjs` | Create | Probe child: imports modules, digests, JSON Schema |
| `src/codegen/tools/probe-loader.mjs` | Create | Loader hooks: TS transpile, `.js`→`.ts`, tsconfig aliases |
| `src/codegen/tools/output-inference.ts` | Create | Checker-based response schema inference (depth ≤ 6) |
| `src/codegen/tools/resolutions.ts` | Create | `tool-resolutions.json` reader and basic validation |
| `src/codegen/tools/contract-tiers.ts` | Create | Tier selection and `ToolContract` construction |
| `src/codegen/tools/sources/next-endpoints.ts` | Create | The `next-app` `ToolSource` |
| `src/codegen/tools/prose.ts` | Create | `tool-semantics.json` reader and prose fallback |
| `src/cli/commands/setup-plan.ts` | Modify | Export P02's `compareArtifacts` (`added`/`classifyNewTool` unchanged), pure `createSetupPlanFromContents` |
| `src/cli/commands/validate-build.ts` | Modify | Export `LocalPromptBundleSchema`, pure `renderManifestContents`, `computePolicyDigest` |
| `src/codegen/tools/artifact.ts` | Create | Setup artifact, `tool-contracts.json`, `tool-report.json` |
| `src/codegen/tools/emit-module.ts` | Create | Generated module renderer (TS or JS) |
| `src/codegen/tools/inputs.ts` | Create | Reads policy, resolutions, semantics, prompt bundle |
| `src/codegen/tools/pipeline.ts` | Create | `runToolsPipeline` for write, frozen and integrity |
| `src/runtime/contract-bindings.ts` | Create | `createContractBindings`, `createGeneratedRuntimeSource` |
| `src/runtime/index.ts` | Modify | Export the contract-binding API |
| `src/cli/commands/tools/args.ts` | Create | Flag parsing for the tools subcommands |
| `src/cli/commands/tools/format.ts` | Create | Human and JSON output |
| `src/cli/commands/tools/refresh.ts` | Create | `tools refresh` |
| `src/cli/commands/tools/check.ts` | Create | `tools check` |
| `src/cli/commands/tools/status.ts` | Create | `tools status` |
| `src/cli/commands/tools/index.ts` | Create | `runToolsCommand` dispatch and usage |
| `src/cli/index.ts` | Modify | `CommandName` `'tools'`, usage, dispatch |
| `src/cli/environment-loading.ts` | Modify | `tools` never loads dotenv |
| `src/public-subpaths.test.ts` | Modify | Assert `'tools'` command, keep `generate` absent |
| `package.json` | Modify | Build copies the two probe `.mjs` files to `dist` |
| `tsconfig.cjs.json` | Modify | Exclude `src/codegen/tools/**` (ESM-only, uses `import.meta`) |
| `.gitignore` | Modify | Ignore `.tool-fixtures/` |
| `examples/source-driven-next/native/.glirastes/*.json` | Create | `tools.json`, `tool-resolutions.json`, `prompt-bundle.json` |
| `tests/support/tool-runtime.ts` | Create | Copy, refresh and boot helpers for fixture runtime tests |
| `tests/source-driven-next.test.ts` | Modify (rewrite) | Endpoint security assertions through `tools refresh` |
| `tests/source-driven-build.test.ts` | Modify (one line) | Link test removes the copied `native/.glirastes` before creating its symlink |
| `tests/tool-sync-next.test.ts` | Create | Next endpoint change corpus (add/change/delete) |
| `examples/source-driven-next/README.md`, `adapter.mjs` | Modify | Document the endpoint migration; adapter header only |
| Unit tests (Create): `src/codegen/tools/{config,mode,canonical,findings,interface-digest,state,program,handler-locator,input-roles,handler-analysis,evidence,exclusions,identity,schema-probe,output-inference,resolutions,contract-tiers,prose,artifact,emit-module,pipeline,pipeline-integrity}.test.ts`, `src/codegen/tools/sources/next-endpoints.test.ts`, `src/cli/commands/manifest-contents.test.ts`, `src/runtime/contract-bindings.test.ts`, `src/cli/commands/tools/tools-command.test.ts` | Create | One test file per module, co-located |
| Existing tests (Modify, append only): `src/codegen/execution-inventory.test.ts`, `src/codegen/route-scanner.test.ts`, `src/cli/commands/setup-plan.test.ts`, `src/cli/environment-loading.test.ts` | Modify | New cases beside the existing ones |

Unchanged until P04 (they still need one combined endpoint+UI runtime for the browser proof): `examples/source-driven-next/adapter.mjs` (logic), `ui-adapter.mjs`, `build.mjs`, `prepare-browser.mjs`, `ui-bridge.js`, `native-ui/*`, `browser-shell/*`, `tests/source-driven-ui.test.tsx`, `tests/source-driven-browser.test.mjs`; `tests/source-driven-build.test.ts` only receives the one-line link-test fix in Task 23.

All commands run from `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools`; agent shells reset their working directory between calls, so every command below starts with an absolute `cd`.

### Task 1: Tools config, mode resolution and `E-TOOLS` diagnostics

**Files:**
- Modify: `src/diagnostics/foundation-diagnostic.ts:1-10` (diagnostic code union as left by P02 Task 3, which appended `E-POLICY-${string}`)
- Create: `src/codegen/tools/config.ts`
- Create: `src/codegen/tools/mode.ts`
- Test: `src/codegen/tools/config.test.ts`, `src/codegen/tools/mode.test.ts`

**Interfaces:**
- Consumes: `findSensitiveStringPath` (`src/contracts/content-boundary.ts`), `FoundationDiagnosticError`.
- Produces:
  - `export const TOOLS_PATHS: { readonly config: '.glirastes/tools.json'; …; readonly receipt: '.glirastes/setup-receipt.json' }`
  - `export const DEFAULT_GENERATED_MODULE = 'src/generated/glirastes/tools.generated.ts'`
  - `export const ToolSourceKindSchema: z.ZodEnum<['next-app']>`; `export const ToolsConfigSchema`; `export type ToolsConfig = z.infer<typeof ToolsConfigSchema>`
  - `export interface ToolSourceConfig { kind: 'next-app'; apiDir?: string }`
  - `export function loadToolsConfig(root: string): ToolsConfig`
  - `export function normalizeSources(config: ToolsConfig): ToolSourceConfig[]`
  - `export function generatedModulePath(config: ToolsConfig): string`
  - `export type ToolsMode = 'write' | 'frozen' | 'integrity'`; `export function isToolsMode(value: string): value is ToolsMode`; `export function resolveToolsMode(input: { flag?: ToolsMode; env: NodeJS.ProcessEnv }): ToolsMode`

- [ ] **Step 1: Write the failing tests**

`src/codegen/tools/config.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATED_MODULE,
  generatedModulePath,
  loadToolsConfig,
  normalizeSources,
  ToolsConfigSchema,
} from './config.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';
const minimal = {
  schemaVersion: 1,
  appId: APP_ID,
  targetAppKey: 'fixture',
  locale: 'en-US',
  sources: ['next-app'],
};
const roots: string[] = [];

async function emptyApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-tools-config-'));
  roots.push(root);
  return root;
}

async function appWith(config: unknown): Promise<string> {
  const root = await emptyApp();
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(
    join(root, '.glirastes/tools.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
  );
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('tools config', () => {
  it('loads a minimal config with empty emit, enrich and ci sections', async () => {
    const config = loadToolsConfig(await appWith(minimal));
    expect(config).toEqual({ ...minimal, emit: {}, enrich: {}, ci: {} });
    expect(normalizeSources(config)).toEqual([{ kind: 'next-app' }]);
    expect(generatedModulePath(config)).toBe(DEFAULT_GENERATED_MODULE);
  });

  it('accepts object sources, a JavaScript module target and ci flags', async () => {
    const config = loadToolsConfig(await appWith({
      ...minimal,
      sources: [{ kind: 'next-app', apiDir: 'app/api' }],
      emit: { module: 'src/generated/glirastes/tools.generated.js', mcpCatalog: false },
      enrich: { managed: false, writeContracts: false },
      ci: { strict: true, requireEnrichment: false },
    }));
    expect(normalizeSources(config)).toEqual([{ kind: 'next-app', apiDir: 'app/api' }]);
    expect(generatedModulePath(config)).toBe('src/generated/glirastes/tools.generated.js');
    expect(config.ci.strict).toBe(true);
  });

  it.each([
    ['an unknown key', { ...minimal, openrouterApiKey: 'value' }],
    ['a secret-looking value', { ...minimal, enrich: { model: `sk-or-v1-${'a'.repeat(32)}` } }],
    ['a module outside the app', { ...minimal, emit: { module: '../outside/tools.generated.ts' } }],
    ['an absolute module path', { ...minimal, emit: { module: '/tmp/tools.generated.ts' } }],
    ['an unsupported module extension', { ...minimal, emit: { module: 'src/tools.generated.tsx' } }],
    ['an unknown source kind', { ...minimal, sources: ['rails'] }],
    ['an empty source list', { ...minimal, sources: [] }],
  ])('rejects %s', (_label, value) => {
    expect(ToolsConfigSchema.safeParse(value).success).toBe(false);
  });

  it('reports a missing config with E-TOOLS-001', async () => {
    const root = await emptyApp();
    expect(() => loadToolsConfig(root)).toThrowError(expect.objectContaining({
      code: 'E-TOOLS-001',
      path: '.glirastes/tools.json',
    }));
  });

  it('reports unreadable JSON and schema violations with E-TOOLS-002', async () => {
    expect(() => loadToolsConfig(await appWith('{ not json')))
      .toThrowError(expect.objectContaining({ code: 'E-TOOLS-002' }));
    expect(() => loadToolsConfig(await appWith({ ...minimal, schemaVersion: 2 })))
      .toThrowError(expect.objectContaining({ code: 'E-TOOLS-002' }));
  });
});
```

`src/codegen/tools/mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isToolsMode, resolveToolsMode } from './mode.js';

describe('resolveToolsMode', () => {
  it('prefers the explicit flag over environment and CI', () => {
    expect(resolveToolsMode({
      flag: 'integrity',
      env: { GLIRASTES_TOOLS_MODE: 'write', CI: 'true' },
    })).toBe('integrity');
  });

  it('uses GLIRASTES_TOOLS_MODE before CI', () => {
    expect(resolveToolsMode({ env: { GLIRASTES_TOOLS_MODE: 'integrity', CI: 'true' } }))
      .toBe('integrity');
    expect(resolveToolsMode({ env: { GLIRASTES_TOOLS_MODE: ' write ', CI: 'true' } }))
      .toBe('write');
  });

  it.each(['true', '1', 'yes'])('checks frozen when CI=%s', (ci) => {
    expect(resolveToolsMode({ env: { CI: ci } })).toBe('frozen');
  });

  it.each(['', '0', 'false', 'FALSE'])('writes locally when CI=%j', (ci) => {
    expect(resolveToolsMode({ env: { CI: ci } })).toBe('write');
  });

  it('writes when nothing is configured', () => {
    expect(resolveToolsMode({ env: {} })).toBe('write');
  });

  it('rejects an unknown GLIRASTES_TOOLS_MODE with E-TOOLS-003', () => {
    expect(() => resolveToolsMode({ env: { GLIRASTES_TOOLS_MODE: 'dry' } }))
      .toThrowError(expect.objectContaining({ code: 'E-TOOLS-003' }));
  });

  it('recognizes only the three mode names', () => {
    expect(isToolsMode('frozen')).toBe(true);
    expect(isToolsMode('check')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/mode.test.ts`
Expected: FAIL — `Failed to resolve import "./config.js"` and `"./mode.js"`.

- [ ] **Step 3: Add the diagnostic prefix**

In `src/diagnostics/foundation-diagnostic.ts` replace the union (lines 1–10, ending with P02's `` | `E-POLICY-${string}`; ``) with:

```ts
export type FoundationDiagnosticCode =
  | `E-SETUP-${string}`
  | `E-INVENTORY-${string}`
  | `E-SEMANTICS-${string}`
  | `E-BINDING-${string}`
  | `E-SIGNATURE-${string}`
  | `E-SCOPE-${string}`
  | `E-SYNC-${string}`
  | `E-CONNECT-${string}`
  | `E-POLICY-${string}`
  | `E-TOOLS-${string}`;
```

- [ ] **Step 4: Implement `config.ts`**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';

/** Every file the tools generator reads (inputs) or owns (outputs), app-relative. */
export const TOOLS_PATHS = {
  config: '.glirastes/tools.json',
  policy: '.glirastes/tool-policy.json',
  resolutions: '.glirastes/tool-resolutions.json',
  semantics: '.glirastes/tool-semantics.json',
  promptBundle: '.glirastes/prompt-bundle.json',
  inventory: '.glirastes/foundation-execution-inventory.json',
  tombstones: '.glirastes/tool-tombstones.json',
  contracts: '.glirastes/tool-contracts.json',
  report: '.glirastes/tool-report.json',
  setupArtifact: '.glirastes/setup-artifact.json',
  previousSetupArtifact: '.glirastes/previous-setup-artifact.json',
  runtimeManifest: '.glirastes/build/runtime-manifest.json',
  promptManifest: '.glirastes/build/prompt-manifest.json',
  receipt: '.glirastes/setup-receipt.json',
} as const;

export const DEFAULT_GENERATED_MODULE = 'src/generated/glirastes/tools.generated.ts';

function insideApp(value: string): boolean {
  return !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.split(/[\\/]/).includes('..');
}

const appPath = z.string().trim().min(1).max(512)
  .refine(insideApp, 'Path must stay inside the app');
const modulePath = z.string().trim().min(1).max(512)
  .regex(/\.(?:ts|js|mjs)$/, 'The generated module must end in .ts, .js or .mjs')
  .refine(insideApp, 'Path must stay inside the app');

export const ToolSourceKindSchema = z.enum(['next-app']);

const SourceSchema = z.union([
  ToolSourceKindSchema,
  z.object({ kind: ToolSourceKindSchema, apiDir: appPath.optional() }).strict(),
]);

export const ToolsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  targetAppKey: z.string().trim().min(1).max(200),
  locale: z.string().trim().min(2).max(35)
    .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/),
  sources: z.array(SourceSchema).min(1).max(20),
  emit: z.object({
    module: modulePath.optional(),
    /** Accepted now; emitted by the MCP catalogue work in P11. */
    mcpCatalog: z.boolean().optional(),
  }).strict().default({}),
  /** Accepted now; consumed by the agentic plans P05 and P10. */
  enrich: z.object({
    managed: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    writeContracts: z.boolean().optional(),
  }).strict().default({}),
  ci: z.object({
    strict: z.boolean().optional(),
    /** Accepted now; enforced by P05. */
    requireEnrichment: z.boolean().optional(),
  }).strict().default({}),
}).strict().superRefine((config, context) => {
  const sensitive = findSensitiveStringPath(config);
  if (sensitive) {
    context.addIssue({
      code: 'custom',
      path: sensitive,
      message: 'tools.json must never contain a key or secret',
    });
  }
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export interface ToolSourceConfig {
  kind: z.infer<typeof ToolSourceKindSchema>;
  apiDir?: string;
}

function invalidConfig(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-TOOLS-002',
    operation: 'tools.config',
    message: 'The Glirastes tools configuration is invalid.',
    remediation: 'repair-tools-config',
    path: TOOLS_PATHS.config,
  });
}

export function loadToolsConfig(root: string): ToolsConfig {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, TOOLS_PATHS.config), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FoundationDiagnosticError({
        code: 'E-TOOLS-001',
        operation: 'tools.config',
        message: 'Glirastes tools are not configured for this app.',
        remediation: 'create-tools-config',
        path: TOOLS_PATHS.config,
      });
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalidConfig();
  }
  const parsed = ToolsConfigSchema.safeParse(json);
  if (!parsed.success) throw invalidConfig();
  return parsed.data;
}

export function normalizeSources(config: ToolsConfig): ToolSourceConfig[] {
  return config.sources.map((source) => (
    typeof source === 'string' ? { kind: source } : { ...source }
  ));
}

export function generatedModulePath(config: ToolsConfig): string {
  return config.emit.module ?? DEFAULT_GENERATED_MODULE;
}
```

- [ ] **Step 5: Implement `mode.ts`**

```ts
import { FoundationDiagnosticError } from '../../diagnostics/index.js';

export type ToolsMode = 'write' | 'frozen' | 'integrity';

const MODES: ReadonlySet<string> = new Set(['write', 'frozen', 'integrity']);

export function isToolsMode(value: string): value is ToolsMode {
  return MODES.has(value);
}

/** Flag → GLIRASTES_TOOLS_MODE → CI set ⇒ frozen → write. */
export function resolveToolsMode(input: {
  flag?: ToolsMode;
  env: NodeJS.ProcessEnv;
}): ToolsMode {
  if (input.flag) return input.flag;
  const configured = input.env.GLIRASTES_TOOLS_MODE?.trim();
  if (configured) {
    if (!isToolsMode(configured)) {
      throw new FoundationDiagnosticError({
        code: 'E-TOOLS-003',
        operation: 'tools.mode',
        message: 'GLIRASTES_TOOLS_MODE must be write, frozen or integrity.',
        remediation: 'set-valid-tools-mode',
      });
    }
    return configured;
  }
  const ci = input.env.CI?.trim().toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return 'frozen';
  return 'write';
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/config.test.ts src/codegen/tools/mode.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/diagnostics/foundation-diagnostic.ts src/codegen/tools/config.ts src/codegen/tools/mode.ts src/codegen/tools/config.test.ts src/codegen/tools/mode.test.ts
git commit -m "feat(codegen): add tools config and mode resolution"
```

### Task 2: Shared types, finding catalogue, canonical helpers and interface digest

**Files:**
- Create: `src/codegen/tools/types.ts`
- Create: `src/codegen/tools/findings.ts`
- Create: `src/codegen/tools/canonical.ts`
- Create: `src/codegen/tools/interface-digest.ts`
- Test: `src/codegen/tools/canonical.test.ts`, `src/codegen/tools/findings.test.ts`, `src/codegen/tools/interface-digest.test.ts`

**Interfaces:**
- Consumes: `LocalJsonSchema`, `createJsonSchemaLike` (`src/runtime/json-schema.ts`), `createLocalSchemaDigest` (`src/runtime/local-tool-bindings.ts`), `ObservedExecution` (`src/codegen/inventory-generation.ts`), P02 `DeclaredEffect`, `ToolPolicyDefaults` (`src/contracts/tool-policy.ts`), `ToolPresentation`.
- Produces (pinned names from the shared contract plus the P03 additions marked below):
  - `export type JsonSchemaLike = LocalJsonSchema` (a plain, serializable JSON Schema object)
  - `export type ToolFindingSeverity = 'error' | 'needs_attention' | 'warning'`
  - `export interface ToolFinding { code: string; subjectRef: string; severity: ToolFindingSeverity; message: string; nextAction: string }`
  - `export type ContractSource = 'native' | 'contract-module' | 'legacy-ai-tool' | 'resolution' | 'openapi' | 'derived' | 'ui-bridge'`
  - `export interface SchemaBindingRef { module: string; export: string; property: string[] }` (P03 addition)
  - `export type RuntimeSchemaSource = ({ kind: 'module-export' } & SchemaBindingRef) | { kind: 'json'; schema: JsonSchemaLike }` (P03 addition)
  - `export interface ContractBinding { interfaceDigest: string; contractModuleDigest: string }` (P03 addition)
  - `export interface ToolContract { source; loadBearing; input; output?; params: { path: string[]; query: string[]; body: string[] | 'opaque' }; interfaceDigest; runtime: { input: RuntimeSchemaSource; output: RuntimeSchemaSource }; binding?: ContractBinding }` (`runtime`, `binding` are P03 additions)
  - `export interface ToolProseHints { contractDescription?; schemaDescription?; module?; usageHints?; presentation? }` (P03 addition)
  - `export interface ObservedTool { execution: ObservedExecution; contract?: ToolContract; evidence: { authEvidence: boolean; externalCall: boolean; declaredEffect?: DeclaredEffect; jsDoc?: string }; findings: ToolFinding[]; prose?: ToolProseHints }` (`prose` is a P03 addition)
  - `export interface ExcludedTool { stableKey: string; reason: string; origin: 'default' | 'policy' }`
  - `export interface ToolContractsEntry { toolId: string; stableKey: string; definitionId: string; contract: ToolContract | null; defaults: ToolPolicyDefaults }`
  - `export function toolFinding(code: string, severity: ToolFindingSeverity, subjectRef: string, message: string): ToolFinding`; `export function nextActionFor(code: string): string`; `export function sortFindings(findings: ReadonlyArray<ToolFinding>): ToolFinding[]`; `export const TRANSIENT_FINDING_CODES: ReadonlySet<string>`
  - `export function compareCodeUnits(left: string, right: string): number`; `export function sortKeysDeep(value: unknown): unknown`; `export function canonicalJson(value: unknown): string`; `export function sha256Digest(value: string): string`; `export function deterministicUuid(appId: string, parts: ReadonlyArray<string>): string`; `export const OPAQUE_JSON_SCHEMA: JsonSchemaLike`; `export function jsonSchemaDigest(schema: JsonSchemaLike): string`
  - `export function computeInterfaceDigest(input: { method?: string; path?: string; pathParams: string[]; queryParams: string[]; schemaBindings: string[]; bodyKeys: string[] | 'opaque'; handlerText?: string }): string`

- [ ] **Step 1: Write the failing tests**

`src/codegen/tools/canonical.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createJsonSchemaLike } from '../../runtime/json-schema.js';
import { createLocalSchemaDigest } from '../../runtime/local-tool-bindings.js';
import {
  canonicalJson,
  compareCodeUnits,
  deterministicUuid,
  jsonSchemaDigest,
  OPAQUE_JSON_SCHEMA,
  sha256Digest,
} from './canonical.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';

describe('canonical helpers', () => {
  it('sorts object keys deeply by code unit and ends with a newline', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], B: true } }))
      .toBe('{\n  "a": {\n    "B": true,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
    expect(['b', 'B', 'a'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b']);
  });

  it('creates stable RFC 4122 version 5 identifiers scoped to app and parts', () => {
    const first = deterministicUuid(APP_ID, ['setup-artifact', 'sha256:x']);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicUuid(APP_ID, ['setup-artifact', 'sha256:x'])).toBe(first);
    expect(deterministicUuid(APP_ID, ['setup-run', 'sha256:x'])).not.toBe(first);
    expect(deterministicUuid('019fb007-0000-7000-8000-0000000000a2', ['setup-artifact', 'sha256:x']))
      .not.toBe(first);
  });

  it('digests text as sha256 base64url', () => {
    expect(sha256Digest('abc')).toBe('sha256:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('digests JSON schemas exactly like a runtime JsonSchemaLike binding', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false };
    expect(jsonSchemaDigest(schema)).toBe(createLocalSchemaDigest(createJsonSchemaLike(schema)));
    expect(jsonSchemaDigest({ additionalProperties: false, properties: { id: { type: 'string' } }, type: 'object' }))
      .toBe(jsonSchemaDigest(schema));
    expect(jsonSchemaDigest(OPAQUE_JSON_SCHEMA)).toBe(createLocalSchemaDigest(createJsonSchemaLike({})));
  });
});
```

`src/codegen/tools/findings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextActionFor, sortFindings, toolFinding, TRANSIENT_FINDING_CODES } from './findings.js';

describe('tool findings', () => {
  it('attaches the next safe action for known codes and a generic one otherwise', () => {
    expect(toolFinding('auth-evidence-missing', 'needs_attention', 'GET /api/x', 'No session call.'))
      .toEqual({
        code: 'auth-evidence-missing',
        severity: 'needs_attention',
        subjectRef: 'GET /api/x',
        message: 'No session call.',
        nextAction: nextActionFor('auth-evidence-missing'),
      });
    expect(nextActionFor('auth-evidence-missing')).toContain('authHelpers');
    expect(nextActionFor('something-new')).toContain('glirastes tools refresh');
  });

  it('orders errors before attention items before warnings, then by code and subject', () => {
    const sorted = sortFindings([
      toolFinding('contract-derived', 'warning', 'GET /a', 'w'),
      toolFinding('input-contract-unresolved', 'needs_attention', 'POST /b', 'n'),
      toolFinding('E-INVENTORY-011', 'error', 'next-app', 'e'),
      toolFinding('contract-derived', 'warning', 'GET /0', 'w'),
    ]);
    expect(sorted.map((finding) => `${finding.severity}:${finding.subjectRef}`)).toEqual([
      'error:next-app', 'needs_attention:POST /b', 'warning:GET /0', 'warning:GET /a',
    ]);
  });

  it('marks change-relative findings as transient so they never reach committed outputs', () => {
    expect([...TRANSIENT_FINDING_CODES].sort()).toEqual([
      'override-lapsed-risk-raised', 'risk-raised', 'tool-outputs-drift',
    ]);
  });
});
```

`src/codegen/tools/interface-digest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeInterfaceDigest } from './interface-digest.js';

const base = {
  method: 'POST',
  path: '/api/tasks/:id',
  pathParams: ['id'],
  queryParams: ['b', 'a'],
  schemaBindings: ['body:src/app/api/tasks/schemas.ts#createTask'],
  bodyKeys: ['title', 'due'] as string[] | 'opaque',
};

describe('computeInterfaceDigest', () => {
  it('is a sha256 base64url digest independent of list order and duplicates', () => {
    const digest = computeInterfaceDigest(base);
    expect(digest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(computeInterfaceDigest({
      ...base, queryParams: ['a', 'b', 'a'], bodyKeys: ['due', 'title'],
    })).toBe(digest);
  });

  it('changes with every interface fact', () => {
    const digest = computeInterfaceDigest(base);
    for (const change of [
      { method: 'PUT' },
      { path: '/api/tasks/:taskId' },
      { pathParams: ['taskId'] },
      { queryParams: ['a'] },
      { schemaBindings: [] },
      { bodyKeys: 'opaque' as const },
      { bodyKeys: ['title'] },
    ]) {
      expect(computeInterfaceDigest({ ...base, ...change })).not.toBe(digest);
    }
  });

  it('ignores whitespace-only differences in the handler text fallback', () => {
    const opaque = { ...base, schemaBindings: [], bodyKeys: 'opaque' as const };
    expect(computeInterfaceDigest({ ...opaque, handlerText: 'return  save(\n body);' }))
      .toBe(computeInterfaceDigest({ ...opaque, handlerText: 'return save( body);' }));
    expect(computeInterfaceDigest({ ...opaque, handlerText: 'return save(body);' }))
      .not.toBe(computeInterfaceDigest({ ...opaque, handlerText: 'return drop(body);' }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/canonical.test.ts src/codegen/tools/findings.test.ts src/codegen/tools/interface-digest.test.ts`
Expected: FAIL — `Failed to resolve import "./canonical.js"`, `"./findings.js"`, `"./interface-digest.js"`.

- [ ] **Step 3: Implement `types.ts`**

```ts
import type { ToolPresentation } from '../../contracts/index.js';
import type { DeclaredEffect, ToolPolicyDefaults } from '../../contracts/tool-policy.js';
import type { LocalJsonSchema } from '../../runtime/json-schema.js';
import type { ObservedExecution } from '../inventory-generation.js';

/** A plain, serializable JSON Schema object — never a compiled validator. */
export type JsonSchemaLike = LocalJsonSchema;

export type ToolFindingSeverity = 'error' | 'needs_attention' | 'warning';

export interface ToolFinding {
  code: string;
  subjectRef: string;
  severity: ToolFindingSeverity;
  message: string;
  nextAction: string;
}

export type ContractSource =
  | 'native'
  | 'contract-module'
  | 'legacy-ai-tool'
  | 'resolution'
  | 'openapi'
  | 'derived'
  | 'ui-bridge';

/** An exported value inside the app; `module` is an app-relative POSIX path. */
export interface SchemaBindingRef {
  module: string;
  export: string;
  property: string[];
}

/** How the generated module obtains a runtime schema. */
export type RuntimeSchemaSource =
  | ({ kind: 'module-export' } & SchemaBindingRef)
  | { kind: 'json'; schema: JsonSchemaLike };

/** The interface a descriptive contract module was written for. */
export interface ContractBinding {
  interfaceDigest: string;
  contractModuleDigest: string;
}

export interface ToolContract {
  source: ContractSource;
  loadBearing: boolean;
  input: JsonSchemaLike;
  output?: JsonSchemaLike;
  params: { path: string[]; query: string[]; body: string[] | 'opaque' };
  interfaceDigest: string;
  runtime: { input: RuntimeSchemaSource; output: RuntimeSchemaSource };
  binding?: ContractBinding;
}

export interface ToolProseHints {
  contractDescription?: string;
  schemaDescription?: string;
  module?: string;
  usageHints?: string[];
  presentation?: ToolPresentation;
}

export interface ObservedTool {
  execution: ObservedExecution;
  contract?: ToolContract;
  evidence: {
    authEvidence: boolean;
    externalCall: boolean;
    declaredEffect?: DeclaredEffect;
    jsDoc?: string;
  };
  findings: ToolFinding[];
  prose?: ToolProseHints;
}

export interface ExcludedTool {
  stableKey: string;
  reason: string;
  origin: 'default' | 'policy';
}

export interface ToolContractsEntry {
  toolId: string;
  stableKey: string;
  definitionId: string;
  contract: ToolContract | null;
  defaults: ToolPolicyDefaults;
}
```

- [ ] **Step 4: Implement `canonical.ts`**

```ts
import { createHash } from 'node:crypto';
import { createJsonSchemaLike, type LocalJsonSchema } from '../../runtime/json-schema.js';
import { createLocalSchemaDigest } from '../../runtime/local-tool-bindings.js';

/** Locale-independent ordering so outputs are byte-identical across Node versions. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]));
}

/** Canonical file form for every generator-owned JSON output. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export function sha256Digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('base64url')}`;
}

/** UUIDv5-shaped identifier scoped to the app; same inputs, same identifier. */
export function deterministicUuid(appId: string, parts: ReadonlyArray<string>): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(appId.replaceAll('-', ''), 'hex'))
    .update(JSON.stringify(['glirastes.tools.v1', ...parts]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const OPAQUE_JSON_SCHEMA: LocalJsonSchema = Object.freeze({});

/** Must equal what the runtime computes for `createJsonSchemaLike(schema)` at boot. */
export function jsonSchemaDigest(schema: LocalJsonSchema): string {
  return createLocalSchemaDigest(createJsonSchemaLike(schema));
}
```

- [ ] **Step 5: Implement `findings.ts`**

```ts
import { compareCodeUnits } from './canonical.js';
import type { ToolFinding, ToolFindingSeverity } from './types.js';

const NEXT_ACTIONS: Readonly<Record<string, string>> = {
  'input-contract-unresolved': 'Validate the request with an exported Zod schema, add a sibling contract.ts, or add a .glirastes/tool-resolutions.json entry, then run glirastes tools refresh.',
  'input-role-unclear': 'Parse request.json(), the search params or params directly with the exported schema, or declare your reader in tool-resolutions.json conventions.',
  'input-role-unsupported': 'Send write parameters in the body and read parameters in the query string, or describe the tool in tool-resolutions.json.',
  'parameter-collision': 'Rename the path, query or body parameter so every name has exactly one role.',
  'schema-not-exported': 'Export the schema from an app module (for Next.js a sibling contract.ts) and import it in the handler.',
  'schema-module-unloadable': 'Make the schema module importable without side effects: no database, network or secrets at import time.',
  'schema-json-unavailable': 'Use zod v4 or install zod-to-json-schema so the schema can be described as JSON Schema.',
  'auth-evidence-missing': 'Call your session helper in the handler or list it in tool-resolutions.json conventions.authHelpers.',
  'contract-stale': 'Update the descriptive contract for the changed interface, then run glirastes tools refresh.',
  'handler-unresolved': 'Export the handler as a function or as a wrapper call around an inline function.',
  'contract-derived': 'Optional: validate the input with an exported Zod schema to give the model typed parameters.',
  'description-templated': 'Optional: add a JSDoc comment to the handler or a description in tool-semantics.json.',
  'output-contract-opaque': 'Optional: return a typed object or validate the response with an exported schema.',
  'resolution-rejected': 'Fix the tool-resolutions.json entry; the tool keeps its fallback contract meanwhile.',
  'definition-id-invalid': 'Use a contract id like resource.action (letters and digits, dot-separated).',
  'definition-id-conflict': 'Give one of the tools a distinct contract id.',
  'tool-semantics-invalid': 'Fix .glirastes/tool-semantics.json; descriptions fall back to code and templates meanwhile.',
  'prompt-bundle-missing': 'Create .glirastes/prompt-bundle.json for this app (glirastes init sets it up).',
  'prompt-bundle-invalid': 'Fix .glirastes/prompt-bundle.json: it must match its schema and this appId.',
  'generation-state-invalid': 'Restore the generated .glirastes file from git, or resolve its merge by keeping both sides, then rerun refresh.',
  'E-INVENTORY-010': 'Resolve the duplicate tool identity reported above, then rerun glirastes tools refresh.',
  'E-INVENTORY-011': 'Replace export * in route files and fix unreadable sources so every route can be enumerated.',
  'E-POLICY-001': 'Fix .glirastes/tool-policy.json so it matches its schema; policy can only restrict what the code allows.',
  'E-POLICY-002': 'Remove the relaxation: confirmation for delete, financial and external tools cannot be turned off.',
  'risk-raised': 'Nothing to do: confirmation is enforced automatically. Review the change in your diff.',
  'override-lapsed-risk-raised': 'Your relaxation no longer applies at the higher risk; review whether you still need it.',
  'risk-lower-available': 'After review, record an acceptedRisk entry in .glirastes/tool-policy.json to adopt the lower risk.',
  'policy-entry-orphaned': 'Remove the entry from .glirastes/tool-policy.json or restore the tool.',
  'tool-outputs-drift': 'Run glirastes tools refresh locally and commit .glirastes together with the generated module.',
  'tool-output-invalid': 'Regenerate the outputs with glirastes tools refresh; never edit generated files.',
  'integrity-chain-broken': 'Regenerate the outputs with glirastes tools refresh and commit them; never edit generated files.',
  'output-path-linked': 'Replace the linked .glirastes or output folder with a real folder inside the app.',
  'setup-plan-invalid': 'Delete .glirastes/previous-setup-artifact.json left by glirastes setup; git keeps the history.',
};

/** Findings that describe a change relative to the previous state; never written to outputs. */
export const TRANSIENT_FINDING_CODES: ReadonlySet<string> = new Set([
  'risk-raised',
  'override-lapsed-risk-raised',
  'tool-outputs-drift',
]);

const SEVERITY_ORDER: Readonly<Record<ToolFindingSeverity, number>> = {
  error: 0,
  needs_attention: 1,
  warning: 2,
};

export function nextActionFor(code: string): string {
  return NEXT_ACTIONS[code] ?? 'Fix the reported code, then run glirastes tools refresh.';
}

export function toolFinding(
  code: string,
  severity: ToolFindingSeverity,
  subjectRef: string,
  message: string,
): ToolFinding {
  return { code, severity, subjectRef, message, nextAction: nextActionFor(code) };
}

export function sortFindings(findings: ReadonlyArray<ToolFinding>): ToolFinding[] {
  return [...findings].sort((left, right) => (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.subjectRef, right.subjectRef)
    || compareCodeUnits(left.message, right.message)
  ));
}
```

- [ ] **Step 6: Implement `interface-digest.ts`**

```ts
import { compareCodeUnits, sha256Digest } from './canonical.js';

function uniqueSorted(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/**
 * Binds descriptive contracts to the code-visible interface. The handler text
 * is only a fallback for handlers without structured evidence and is
 * whitespace-normalized here; callers pass comment-free printer output.
 */
export function computeInterfaceDigest(input: {
  method?: string;
  path?: string;
  pathParams: string[];
  queryParams: string[];
  schemaBindings: string[];
  bodyKeys: string[] | 'opaque';
  handlerText?: string;
}): string {
  return sha256Digest(JSON.stringify({
    version: 1,
    method: input.method ?? null,
    path: input.path ?? null,
    pathParams: uniqueSorted(input.pathParams),
    queryParams: uniqueSorted(input.queryParams),
    schemaBindings: uniqueSorted(input.schemaBindings),
    bodyKeys: input.bodyKeys === 'opaque' ? 'opaque' : uniqueSorted(input.bodyKeys),
    handlerText: input.handlerText === undefined
      ? null
      : input.handlerText.replace(/\s+/g, ' ').trim(),
  }));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/canonical.test.ts src/codegen/tools/findings.test.ts src/codegen/tools/interface-digest.test.ts && bun run typecheck`
Expected: PASS, typecheck clean (types.ts compiles against the P02 `tool-policy.ts` exports).

- [ ] **Step 8: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/types.ts src/codegen/tools/findings.ts src/codegen/tools/canonical.ts src/codegen/tools/interface-digest.ts src/codegen/tools/canonical.test.ts src/codegen/tools/findings.test.ts src/codegen/tools/interface-digest.test.ts
git commit -m "feat(codegen): add tool generator types, findings and digests"
```

### Task 3: Inventory `sourceKind` and verification of wrapper-exported handlers

**Files:**
- Modify: `src/codegen/execution-inventory.ts:24-29` (`endpointExecution`), `:116-163` (`verifyEndpoint`)
- Modify: `src/codegen/route-scanner.ts:63-69` (`AUTH_PATTERNS`), `:81-112` (`toRoutePath`)
- Test: `src/codegen/execution-inventory.test.ts`, `src/codegen/route-scanner.test.ts`

**Interfaces:**
- Consumes: `readRouteExports` (`src/codegen/route-exports.ts`).
- Produces:
  - `FoundationExecutionInventorySchema` endpoint executions accept `sourceKind?: 'next-app'` (reconcile observations inherit it).
  - `export const AUTH_PATTERNS: Array<[string, RegExp]>`
  - `export function toRoutePath(apiDir: string, routeFile: string): { path: string; pathParams: string[] }`
  - `discoverFoundationExecutions` accepts an endpoint whose export the route reader reports as `route-export-unresolved` (it exists, its body is wrapped), still rejects undeclared methods.

- [ ] **Step 1: Write the failing tests**

Append to `src/codegen/execution-inventory.test.ts` (after the existing `describe`; it reuses the file's `fixture`, `endpoint`, `id` helpers):

```ts
describe('endpoint source kinds', () => {
  it('verifies a wrapper-exported handler the route reader cannot resolve to a body', async () => {
    const source = 'import { withAuth } from "@/lib/auth";\n'
      + 'export const GET = withAuth(async () => Response.json([]));\n';
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': source });
    const result = await discoverFoundationExecutions({
      rootDir,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [{ ...endpoint({ source }), sourceKind: 'next-app' }],
      },
    });
    expect(result.executions[0]).toMatchObject({
      sourceKind: 'next-app',
      sourceLocator: { exportName: 'GET' },
    });
  });

  it('still rejects a method the route does not declare', async () => {
    const source = 'export const POST = withAuth(async () => Response.json([]));\n';
    const rootDir = await fixture({ 'src/app/api/tasks/route.ts': source });
    await expect(discoverFoundationExecutions({
      rootDir,
      inventory: { schemaVersion: 2, targetAppKey: 'fixture', executions: [endpoint({ source })] },
    })).rejects.toThrow(/missing route export/);
  });

  it('rejects unknown endpoint source kinds', () => {
    const parsed = FoundationExecutionInventorySchema.safeParse({
      schemaVersion: 2,
      targetAppKey: 'fixture',
      executions: [{ ...endpoint({ source: 'x' }), sourceKind: 'rails' }],
    });
    expect(parsed.success).toBe(false);
  });
});
```

and extend the import at the top of the file to:

```ts
import {
  discoverFoundationExecutions,
  FoundationExecutionInventorySchema,
  type FoundationExecutionInventory,
} from './execution-inventory.js';
```

Append to `src/codegen/route-scanner.test.ts`:

```ts
describe('route scanner exports for the tools generator', () => {
  it('maps app-router files to stable paths without route groups', () => {
    const apiDir = join('/app', 'src/app/api');
    expect(toRoutePath(apiDir, join(apiDir, '(admin)', 'tasks', '[id]', 'route.ts')))
      .toEqual({ path: '/api/tasks/:id', pathParams: ['id'] });
    expect(toRoutePath(apiDir, join(apiDir, 'files', '[...slug]', 'route.ts')))
      .toEqual({ path: '/api/files/*slug', pathParams: ['slug'] });
  });

  it('exposes the default auth helper names', () => {
    expect(AUTH_PATTERNS.map(([name]) => name)).toEqual([
      'resolvePrincipal', 'resolveUser', 'getServerSession', 'getSession', 'auth',
    ]);
  });
});
```

and extend that file's existing `./route-scanner.js` import (`join` is already imported there):

```ts
import {
  AUTH_PATTERNS,
  createRouteSourceFingerprint,
  scanNextAppRoutes,
  toRoutePath,
  writeNextAppRouteScan,
} from './route-scanner.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/execution-inventory.test.ts src/codegen/route-scanner.test.ts`
Expected: FAIL — wrapper test rejects with `missing route export` (sourceKind is also stripped/refused by the strict schema), `toRoutePath`/`AUTH_PATTERNS` are not exported (`undefined is not a function`).

- [ ] **Step 3: Implement the inventory change**

In `src/codegen/execution-inventory.ts` replace `endpointExecution`:

```ts
const endpointExecution = executionBase.extend({
  executionKind: z.literal('endpoint'),
  /**
   * The deterministic source that enumerated the endpoint. Absent on
   * inventories written before the tools generator; treated as next-app.
   */
  sourceKind: z.enum(['next-app']).optional(),
  sourceFile: z.string().trim().min(1).max(2_048),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
}).strict();
```

Replace the whole existing `verifyEndpoint` function (lines 116–163) with the following two functions — `verifyNextEndpoint` (the old body with the relaxed export check) and the `verifyEndpoint` dispatcher that `discoverFoundationExecutions` keeps calling:

```ts
async function verifyNextEndpoint(
  rootDir: string,
  execution: z.infer<typeof endpointExecution>,
): Promise<DiscoveredFoundationExecution> {
  let source: string;
  try {
    source = await readFile(resolve(rootDir, execution.sourceFile), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Foundation inventory references a missing route: ${execution.stableKey}`,
      );
    }
    throw error;
  }

  // A wrapper export (`export const GET = withAuth(…)`) exists even though the
  // reader cannot resolve its body; the fingerprint below still pins the file.
  const routeExports = readRouteExports(source, execution.sourceFile);
  const declared = routeExports.exports.some(({ method }) => method === execution.method)
    || routeExports.findings.some((finding) => (
      finding.code === 'route-export-unresolved' && finding.exportName === execution.method
    ));
  if (!declared) {
    throw new Error(
      `Foundation inventory references a missing route export: ${execution.stableKey}`,
    );
  }

  const expectedStableKey = `${execution.method} ${execution.path}`;
  if (execution.stableKey !== expectedStableKey) {
    throw new Error(
      `Foundation inventory stable key mismatch: ${execution.stableKey}`,
    );
  }

  const currentFingerprint = createRouteSourceFingerprint(
    source,
    execution.method,
    execution.path,
  );
  if (currentFingerprint !== execution.sourceFingerprint) {
    throw new Error(
      `Foundation route fingerprint mismatch: ${execution.stableKey}`,
    );
  }

  return {
    ...execution,
    sourceLocator: {
      sourceFile: execution.sourceFile,
      exportName: execution.method,
    },
  };
}

async function verifyEndpoint(
  rootDir: string,
  execution: z.infer<typeof endpointExecution>,
): Promise<DiscoveredFoundationExecution> {
  const kind = execution.sourceKind ?? 'next-app';
  if (kind === 'next-app') return verifyNextEndpoint(rootDir, execution);
  throw new Error(`Unsupported endpoint source kind: ${String(kind)}`);
}
```

- [ ] **Step 4: Export the scanner helpers**

In `src/codegen/route-scanner.ts` change the two declarations to exports (bodies unchanged):

```ts
export const AUTH_PATTERNS: Array<[string, RegExp]> = [
```

```ts
export function toRoutePath(
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/execution-inventory.test.ts src/codegen/route-scanner.test.ts src/codegen/inventory-generation.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/execution-inventory.ts src/codegen/route-scanner.ts src/codegen/execution-inventory.test.ts src/codegen/route-scanner.test.ts
git commit -m "feat(codegen): record endpoint source kind and verify wrapper exports"
```

### Task 4: Generation state persistence with merge-conflict recovery

**Files:**
- Create: `src/codegen/tools/files.ts`
- Create: `src/codegen/tools/state.ts`
- Test: `src/codegen/tools/state.test.ts`

**Interfaces:**
- Consumes: `FoundationExecutionInventorySchema`, `ExecutionGenerationStateSchema`, `reconcileExecutionInventory`, `AppSetupArtifactSchema`, `ToolRiskClassSchema`, P02 `riskTier`, `TOOL_POLICY_RULES_VERSION`, `canonicalJson`, `compareCodeUnits`, `TOOLS_PATHS`, `ToolsConfig`.
- Produces:
  - `export const ToolTombstonesFileSchema`, `ToolContractSchema`, `ToolContractsFileSchema`; `export type ToolTombstonesFile`, `ToolContractsFile`; `export function toToolContract(contract: z.infer<typeof ToolContractSchema>): ToolContract`; `export function toToolContractsEntry(entry: ToolContractsFile['tools'][number]): ToolContractsEntry`
  - `export class ToolStateError extends Error { readonly path: string }`
  - `export interface PreviousArtifactView { artifact?: AppSetupArtifact; planner?: AppSetupArtifact['planner']; riskByToolId: ReadonlyMap<string, ToolRiskClass> }`
  - `export interface PreviousToolState { state?: ExecutionGenerationState; artifact?: PreviousArtifactView; contracts: ReadonlyMap<string, ToolContract>; receiptMode?: 'standalone' | 'managed' }`
  - `export function splitMergeConflict(text: string): [string, string] | undefined`
  - `export function mergeGenerationState(config: Pick<ToolsConfig, 'appId' | 'targetAppKey'>, inventories: ReadonlyArray<FoundationExecutionInventory>, tombstones: ReadonlyArray<ExecutionGenerationState['tombstones'][number]>): ExecutionGenerationState | undefined`
  - `export async function readPreviousToolState(root: string, config: ToolsConfig, options?: { adoptInventoryPath?: string }): Promise<PreviousToolState>`
  - `export function renderInventory(state: ExecutionGenerationState): string`; `export function renderTombstones(state: ExecutionGenerationState): string`

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/state.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileExecutionInventory } from '../inventory-generation.js';
import { canonicalJson } from './canonical.js';
import { ToolsConfigSchema } from './config.js';
import {
  readPreviousToolState,
  renderInventory,
  renderTombstones,
  splitMergeConflict,
  ToolStateError,
} from './state.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';
const TOOL_A = '019fb007-0000-7000-8000-0000000000b1';
const TOOL_B = '019fb007-0000-7000-8000-0000000000b2';
const TOOL_C = '019fb007-0000-7000-8000-0000000000b3';
const config = ToolsConfigSchema.parse({
  schemaVersion: 1, appId: APP_ID, targetAppKey: 'fixture', locale: 'en-US', sources: ['next-app'],
});
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const roots: string[] = [];

function execution(toolId: string, stableKey: string, definitionId: string) {
  const [method, path] = stableKey.split(' ') as ['GET', string];
  return {
    toolId,
    definitionId,
    stableKey,
    executionKind: 'endpoint' as const,
    sourceKind: 'next-app' as const,
    sourceFile: `src/app${path}/route.ts`,
    method,
    path,
    sourceFingerprint: `sha256:${createHash('sha256').update(stableKey).digest('base64url')}`,
    inputSchemaDigest: digest('A'),
    outputSchemaDigest: digest('B'),
  };
}

function inventory(executions: unknown[]) {
  return { schemaVersion: 2, targetAppKey: 'fixture', executions };
}

function tombstones(entries: Array<{ toolId: string; stableKey: string; definitionId: string }>) {
  return { schemaVersion: 1, appId: APP_ID, tombstones: entries };
}

/** A realistic git hunk conflict between two canonical JSON files. */
function conflict(ours: string, theirs: string): string {
  const left = ours.split('\n');
  const right = theirs.split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (
    end < left.length - start && end < right.length - start
    && left[left.length - 1 - end] === right[right.length - 1 - end]
  ) end += 1;
  return [
    ...left.slice(0, start),
    '<<<<<<< HEAD',
    ...left.slice(start, left.length - end),
    '=======',
    ...right.slice(start, right.length - end),
    '>>>>>>> feature',
    ...left.slice(left.length - end),
  ].join('\n');
}

function artifact(riskClass: 'safe-read' | 'write') {
  return {
    schemaVersion: 1,
    artifactId: '019fb007-0000-7000-8000-0000000000c1',
    runId: '019fb007-0000-7000-8000-0000000000c2',
    appId: APP_ID,
    discoveryDigest: digest('D'),
    assessmentMode: 'autonomous',
    status: 'ready',
    tools: [{
      toolId: TOOL_A,
      sourceFingerprint: digest('F'),
      name: 'tasks.list',
      description: 'List tasks.',
      modelName: 'tasks_list',
      module: 'tasks',
      sharedWith: [],
      usageHints: ['List tasks.'],
      presentation: { locale: 'en-US', singular: 'List tasks', plural: 'List tasks', approval: 'List tasks' },
      executionKind: 'endpoint',
      method: 'GET',
      path: '/api/tasks',
      operationGroup: 'read',
      riskClass,
      enabled: true,
      requiresApproval: riskClass === 'write',
      inputSchemaDigest: digest('A'),
      outputSchemaDigest: digest('B'),
    }],
    planner: {
      plannerId: '019fb007-0000-7000-8000-0000000000c3',
      modelBindingRef: 'default',
      promptBindingRef: 'prompt:fixture',
      budgetProfileRef: 'default',
      toolIds: [TOOL_A],
    },
    prompts: {
      bundleDigest: digest('E'),
      artifactRef: 'local://fixture/prompts',
      plannerDigest: digest('G'),
      appBehaviorDigest: digest('H'),
      responseStyleDigest: digest('I'),
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-10-04T08:00:00.000Z',
  };
}

function contracts(bindingInterfaceDigest: string) {
  return {
    schemaVersion: 1,
    appId: APP_ID,
    tools: [{
      toolId: TOOL_A,
      stableKey: 'GET /api/tasks',
      definitionId: 'tasks.list',
      contract: {
        source: 'contract-module',
        loadBearing: false,
        input: { type: 'object' },
        output: {},
        params: { path: [], query: [], body: [] },
        interfaceDigest: digest('N'),
        runtime: { input: { kind: 'json', schema: { type: 'object' } }, output: { kind: 'json', schema: {} } },
        binding: { interfaceDigest: bindingInterfaceDigest, contractModuleDigest: digest('M') },
      },
      defaults: { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, rulesVersion: 1 },
    }],
  };
}

async function app(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-tool-state-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('previous tool state', () => {
  it('is empty for a fresh app', async () => {
    const state = await readPreviousToolState(await app({}), config);
    expect(state.state).toBeUndefined();
    expect(state.artifact).toBeUndefined();
    expect(state.contracts.size).toBe(0);
  });

  it('combines the inventory and the tombstone file into one generation state', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': canonicalJson(inventory([execution(TOOL_B, 'GET /api/tasks', 'tasks.list')])),
      '.glirastes/tool-tombstones.json': canonicalJson(tombstones([{ toolId: TOOL_A, stableKey: 'GET /api/old', definitionId: 'old.list' }])),
      '.glirastes/setup-receipt.json': JSON.stringify({ mode: 'managed' }),
    });
    const state = await readPreviousToolState(root, config);
    expect(state.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_B]);
    expect(state.state?.tombstones.map((entry) => entry.toolId)).toEqual([TOOL_A]);
    expect(state.receiptMode).toBe('managed');
  });

  it('resolves a merge conflict without reviving a tombstoned identity', async () => {
    const ours = canonicalJson(inventory([execution(TOOL_A, 'GET /api/tasks', 'tasks.list')]));
    const theirs = canonicalJson(inventory([
      execution(TOOL_B, 'GET /api/tasks', 'tasks.list'),
      execution(TOOL_C, 'GET /api/notes', 'notes.list'),
    ]));
    const marked = conflict(ours, theirs);
    expect(splitMergeConflict(marked)).toEqual([ours, theirs]);
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': marked,
      '.glirastes/tool-tombstones.json': canonicalJson(tombstones([{ toolId: TOOL_A, stableKey: 'GET /api/tasks', definitionId: 'tasks.list' }])),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_B, TOOL_C]);
    const observed = previous.state!.inventory.executions.map(({ toolId: _toolId, ...rest }) => rest);
    const next = reconcileExecutionInventory({
      appId: APP_ID, targetAppKey: 'fixture', previous: previous.state, observed: { complete: true, executions: observed },
    });
    expect(next.state.inventory.executions.find((entry) => entry.stableKey === 'GET /api/tasks')?.toolId).toBe(TOOL_B);
    expect(next.state.tombstones.map((entry) => entry.toolId)).toContain(TOOL_A);
  });

  it('keeps the smaller identity and tombstones the other when both sides are live', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': conflict(
        canonicalJson(inventory([execution(TOOL_B, 'GET /api/tasks', 'tasks.list')])),
        canonicalJson(inventory([execution(TOOL_A, 'GET /api/tasks', 'tasks.list')])),
      ),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_A]);
    expect(previous.state?.tombstones.map((entry) => entry.toolId)).toEqual([TOOL_B]);
  });

  it('drops the later of two keys that merged onto the same definition id', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': conflict(
        canonicalJson(inventory([execution(TOOL_A, 'PATCH /api/tasks', 'tasks.update')])),
        canonicalJson(inventory([execution(TOOL_B, 'PUT /api/tasks', 'tasks.update')])),
      ),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.state?.inventory.executions.map((entry) => entry.stableKey)).toEqual(['PATCH /api/tasks']);
  });

  it('keeps the managed receipt mode across a merge conflict', async () => {
    const root = await app({
      '.glirastes/setup-receipt.json': conflict(
        `${JSON.stringify({ schemaVersion: 1, mode: 'standalone' }, null, 2)}\n`,
        `${JSON.stringify({ schemaVersion: 1, mode: 'managed' }, null, 2)}\n`,
      ),
    });
    expect((await readPreviousToolState(root, config)).receiptMode).toBe('managed');
  });

  it('reports unreadable or foreign state with the offending path', async () => {
    await expect(readPreviousToolState(await app({ '.glirastes/foundation-execution-inventory.json': '{' }), config))
      .rejects.toEqual(expect.objectContaining({ name: 'ToolStateError', path: '.glirastes/foundation-execution-inventory.json' }));
    await expect(readPreviousToolState(await app({
      '.glirastes/foundation-execution-inventory.json': JSON.stringify({ ...inventory([]), targetAppKey: 'other' }),
    }), config)).rejects.toBeInstanceOf(ToolStateError);
    await expect(readPreviousToolState(await app({
      '.glirastes/tool-tombstones.json': JSON.stringify({ ...tombstones([]), appId: '019fb007-0000-7000-8000-0000000000ff' }),
    }), config)).rejects.toBeInstanceOf(ToolStateError);
  });

  it('adopts an explicit inventory instead of the committed one', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': canonicalJson(inventory([])),
      'pilot/inventory.json': canonicalJson(inventory([execution(TOOL_C, 'GET /api/notes', 'notes.list')])),
    });
    const previous = await readPreviousToolState(root, config, { adoptInventoryPath: 'pilot/inventory.json' });
    expect(previous.state?.inventory.executions.map((entry) => entry.toolId)).toEqual([TOOL_C]);
  });

  it('keeps the strictest previous risk and the stale contract binding across a conflict', async () => {
    const root = await app({
      '.glirastes/setup-artifact.json': conflict(canonicalJson(artifact('safe-read')), canonicalJson(artifact('write'))),
      '.glirastes/tool-contracts.json': conflict(canonicalJson(contracts(digest('N'))), canonicalJson(contracts(digest('O')))),
    });
    const previous = await readPreviousToolState(root, config);
    expect(previous.artifact?.artifact).toBeUndefined();
    expect(previous.artifact?.riskByToolId.get(TOOL_A)).toBe('write');
    expect(previous.artifact?.planner?.plannerId).toBe('019fb007-0000-7000-8000-0000000000c3');
    expect(previous.contracts.get('GET /api/tasks')?.binding?.interfaceDigest).toBe(digest('O'));
  });

  it('renders inventory and tombstones canonically', async () => {
    const root = await app({
      '.glirastes/foundation-execution-inventory.json': JSON.stringify(inventory([execution(TOOL_B, 'GET /api/tasks', 'tasks.list')])),
      '.glirastes/tool-tombstones.json': JSON.stringify(tombstones([])),
    });
    const { state } = await readPreviousToolState(root, config);
    expect(renderInventory(state!)).toBe(canonicalJson(state!.inventory));
    expect(renderTombstones(state!)).toBe(canonicalJson({ schemaVersion: 1, appId: APP_ID, tombstones: [] }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/state.test.ts`
Expected: FAIL — `Failed to resolve import "./state.js"`.

- [ ] **Step 3: Implement `files.ts`**

```ts
import { z } from 'zod';
import { ToolRiskClassSchema } from '../../contracts/index.js';
import { TOOL_POLICY_RULES_VERSION } from '../../contracts/tool-policy.js';
import { ExecutionGenerationStateSchema } from '../inventory-generation.js';
import type { ToolContract, ToolContractsEntry } from './types.js';

const digest = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ToolTombstonesFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  tombstones: ExecutionGenerationStateSchema.shape.tombstones,
}).strict();

const RuntimeSchemaSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('module-export'),
    module: z.string().min(1).max(512),
    export: z.string().min(1).max(200),
    property: z.array(z.string().min(1).max(200)).max(8),
  }).strict(),
  z.object({ kind: z.literal('json'), schema: JsonObjectSchema }).strict(),
]);

export const ToolContractSchema = z.object({
  source: z.enum([
    'native', 'contract-module', 'legacy-ai-tool', 'resolution', 'openapi', 'derived', 'ui-bridge',
  ]),
  loadBearing: z.boolean(),
  input: JsonObjectSchema,
  output: JsonObjectSchema.optional(),
  params: z.object({
    path: z.array(z.string()),
    query: z.array(z.string()),
    body: z.union([z.array(z.string()), z.literal('opaque')]),
  }).strict(),
  interfaceDigest: digest,
  runtime: z.object({
    input: RuntimeSchemaSourceSchema,
    output: RuntimeSchemaSourceSchema,
  }).strict(),
  binding: z.object({
    interfaceDigest: digest,
    contractModuleDigest: digest,
  }).strict().optional(),
}).strict();

const ToolPolicyDefaultsSchema = z.object({
  operationGroup: z.enum(['read', 'create', 'update', 'delete', 'ui']),
  riskClass: ToolRiskClassSchema.exclude(['unknown']),
  requiresApproval: z.boolean(),
  rulesVersion: z.literal(TOOL_POLICY_RULES_VERSION),
}).strict();

export const ToolContractsFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  tools: z.array(z.object({
    toolId: z.uuid(),
    stableKey: z.string().min(1).max(2_100),
    definitionId: z.string().min(1).max(200),
    contract: ToolContractSchema.nullable(),
    defaults: ToolPolicyDefaultsSchema,
  }).strict()).max(5_000),
}).strict();

export type ToolTombstonesFile = z.infer<typeof ToolTombstonesFileSchema>;
export type ToolContractsFile = z.infer<typeof ToolContractsFileSchema>;

/** Compile-time proof that the file schemas produce the shared interface types. */
export function toToolContract(contract: z.infer<typeof ToolContractSchema>): ToolContract {
  return contract;
}

export function toToolContractsEntry(entry: ToolContractsFile['tools'][number]): ToolContractsEntry {
  return entry;
}
```

- [ ] **Step 4: Implement `state.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import {
  AppSetupArtifactSchema,
  type AppSetupArtifact,
  type ToolRiskClass,
} from '../../contracts/index.js';
import { riskTier } from '../../contracts/tool-policy.js';
import {
  FoundationExecutionInventorySchema,
  type FoundationExecutionInventory,
} from '../execution-inventory.js';
import {
  ExecutionGenerationStateSchema,
  type ExecutionGenerationState,
} from '../inventory-generation.js';
import { canonicalJson, compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS, type ToolsConfig } from './config.js';
import {
  ToolContractsFileSchema,
  ToolTombstonesFileSchema,
  toToolContract,
  type ToolContractsFile,
} from './files.js';
import type { ToolContract } from './types.js';

type Execution = FoundationExecutionInventory['executions'][number];
type Tombstone = ExecutionGenerationState['tombstones'][number];

export class ToolStateError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ToolStateError';
    this.path = path;
  }
}

export interface PreviousArtifactView {
  /** Present only when the committed artifact is not conflicted. */
  artifact?: AppSetupArtifact;
  planner?: AppSetupArtifact['planner'];
  /** Strictest previous risk per tool across all merge sides. */
  riskByToolId: ReadonlyMap<string, ToolRiskClass>;
}

export interface PreviousToolState {
  state?: ExecutionGenerationState;
  artifact?: PreviousArtifactView;
  contracts: ReadonlyMap<string, ToolContract>;
  receiptMode?: 'standalone' | 'managed';
}

/** Splits a file with git merge markers into its two sides (diff3 base dropped). */
export function splitMergeConflict(text: string): [string, string] | undefined {
  if (!/^<{7} /m.test(text)) return undefined;
  const ours: string[] = [];
  const theirs: string[] = [];
  let section: 'both' | 'ours' | 'base' | 'theirs' = 'both';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('<<<<<<< ')) { section = 'ours'; continue; }
    if (line.startsWith('||||||| ') && section === 'ours') { section = 'base'; continue; }
    if (line === '=======' && (section === 'ours' || section === 'base')) { section = 'theirs'; continue; }
    if (line.startsWith('>>>>>>> ') && section === 'theirs') { section = 'both'; continue; }
    if (section === 'both' || section === 'ours') ours.push(rawLine);
    if (section === 'both' || section === 'theirs') theirs.push(rawLine);
  }
  return [ours.join('\n'), theirs.join('\n')];
}

async function readSides(root: string, path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(resolve(root, path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const sides = splitMergeConflict(text) ?? [text];
  try {
    return sides.map((side) => JSON.parse(side) as unknown);
  } catch {
    throw new ToolStateError(path, `${path} is not valid JSON.`);
  }
}

function parseSides<T>(path: string, sides: ReadonlyArray<unknown>, schema: z.ZodType<T>): T[] {
  return sides.map((side) => {
    const parsed = schema.safeParse(side);
    if (!parsed.success) throw new ToolStateError(path, `${path} does not match its schema.`);
    return parsed.data;
  });
}

function byToolId(left: { toolId: string }, right: { toolId: string }): number {
  return compareCodeUnits(left.toolId, right.toolId);
}

function preferExecution(
  left: Execution,
  right: Execution,
  tombstones: ReadonlyMap<string, Tombstone>,
): Execution {
  const leftDead = tombstones.has(left.toolId);
  const rightDead = tombstones.has(right.toolId);
  if (leftDead !== rightDead) return leftDead ? right : left;
  if (left.toolId !== right.toolId) {
    return compareCodeUnits(left.toolId, right.toolId) <= 0 ? left : right;
  }
  return compareCodeUnits(canonicalJson(left), canonicalJson(right)) <= 0 ? left : right;
}

/**
 * Deterministic union of all inventory and tombstone sides. A tombstoned
 * identity never becomes live again; a losing identity for the same key is
 * tombstoned so it cannot come back either.
 */
export function mergeGenerationState(
  config: Pick<ToolsConfig, 'appId' | 'targetAppKey'>,
  inventories: ReadonlyArray<FoundationExecutionInventory>,
  tombstoneList: ReadonlyArray<Tombstone>,
): ExecutionGenerationState | undefined {
  if (inventories.length === 0 && tombstoneList.length === 0) return undefined;
  const tombstones = new Map<string, Tombstone>();
  for (const tombstone of [...tombstoneList].sort(byToolId)) {
    if (!tombstones.has(tombstone.toolId)) tombstones.set(tombstone.toolId, tombstone);
  }
  const chosen = new Map<string, Execution>();
  for (const execution of inventories.flatMap((inventory) => inventory.executions)) {
    const current = chosen.get(execution.stableKey);
    if (!current) {
      chosen.set(execution.stableKey, execution);
      continue;
    }
    const winner = preferExecution(current, execution, tombstones);
    const loser = winner === current ? execution : current;
    chosen.set(execution.stableKey, winner);
    if (loser.toolId !== winner.toolId && !tombstones.has(loser.toolId)) {
      tombstones.set(loser.toolId, {
        toolId: loser.toolId,
        stableKey: loser.stableKey,
        definitionId: loser.definitionId,
      });
    }
  }
  for (const [stableKey, execution] of [...chosen]) {
    if (tombstones.has(execution.toolId)) chosen.delete(stableKey);
  }
  // Two branches may each have derived the same name for different routes.
  // Dropping the later key re-derives its name; its UUIDv5 identity is
  // recomputed from app, key and tombstone generation by reconcile.
  const definitionIds = new Set<string>();
  for (const execution of [...chosen.values()].sort((left, right) => (
    compareCodeUnits(left.stableKey, right.stableKey)
  ))) {
    if (definitionIds.has(execution.definitionId)) {
      chosen.delete(execution.stableKey);
      continue;
    }
    definitionIds.add(execution.definitionId);
  }
  return ExecutionGenerationStateSchema.parse({
    schemaVersion: 1,
    appId: config.appId,
    inventory: {
      schemaVersion: 2,
      targetAppKey: config.targetAppKey,
      executions: [...chosen.values()].sort(byToolId),
    },
    tombstones: [...tombstones.values()].sort(byToolId),
  });
}

function artifactView(artifacts: ReadonlyArray<AppSetupArtifact>): PreviousArtifactView {
  const riskByToolId = new Map<string, ToolRiskClass>();
  for (const tool of artifacts.flatMap((artifact) => artifact.tools)) {
    const current = riskByToolId.get(tool.toolId);
    if (!current || riskTier(tool.riskClass) > riskTier(current)) {
      riskByToolId.set(tool.toolId, tool.riskClass);
    }
  }
  return {
    ...(artifacts.length === 1 ? { artifact: artifacts[0] } : {}),
    planner: artifacts[0]!.planner,
    riskByToolId,
  };
}

function isStaleBound(contract: ToolContract): boolean {
  return contract.binding !== undefined
    && contract.binding.interfaceDigest !== contract.interfaceDigest;
}

function mergeContracts(
  entries: ReadonlyArray<ToolContractsFile['tools'][number]>,
): Map<string, ToolContract> {
  const contracts = new Map<string, ToolContract>();
  for (const entry of entries) {
    if (!entry.contract) continue;
    const next = toToolContract(entry.contract);
    const current = contracts.get(entry.stableKey);
    if (!current) {
      contracts.set(entry.stableKey, next);
      continue;
    }
    if (isStaleBound(current) !== isStaleBound(next)) {
      if (isStaleBound(next)) contracts.set(entry.stableKey, next);
      continue;
    }
    if (compareCodeUnits(canonicalJson(next), canonicalJson(current)) < 0) {
      contracts.set(entry.stableKey, next);
    }
  }
  return contracts;
}

/** Only the mode is read; a conflicted receipt keeps `managed` if either side was managed. */
async function readReceiptMode(root: string): Promise<'standalone' | 'managed' | undefined> {
  let text: string;
  try {
    text = await readFile(resolve(root, TOOLS_PATHS.receipt), 'utf8');
  } catch {
    return undefined;
  }
  let mode: 'standalone' | 'managed' | undefined;
  for (const side of splitMergeConflict(text) ?? [text]) {
    try {
      const parsed = JSON.parse(side) as { mode?: unknown };
      if (parsed.mode === 'managed') return 'managed';
      if (parsed.mode === 'standalone') mode = 'standalone';
    } catch {
      // An unreadable side carries no mode.
    }
  }
  return mode;
}

export async function readPreviousToolState(
  root: string,
  config: ToolsConfig,
  options: { adoptInventoryPath?: string } = {},
): Promise<PreviousToolState> {
  const inventoryPath = options.adoptInventoryPath ?? TOOLS_PATHS.inventory;
  const inventories = parseSides(
    inventoryPath,
    await readSides(root, inventoryPath),
    FoundationExecutionInventorySchema,
  );
  for (const inventory of inventories) {
    if (inventory.targetAppKey !== config.targetAppKey) {
      throw new ToolStateError(inventoryPath, `${inventoryPath} belongs to target app key ${inventory.targetAppKey}.`);
    }
  }
  const tombstoneFiles = parseSides(
    TOOLS_PATHS.tombstones,
    await readSides(root, TOOLS_PATHS.tombstones),
    ToolTombstonesFileSchema,
  );
  for (const file of tombstoneFiles) {
    if (file.appId !== config.appId) {
      throw new ToolStateError(TOOLS_PATHS.tombstones, `${TOOLS_PATHS.tombstones} belongs to a different app.`);
    }
  }
  const state = mergeGenerationState(
    config,
    inventories,
    tombstoneFiles.flatMap((file) => file.tombstones),
  );
  const artifacts = parseSides(
    TOOLS_PATHS.setupArtifact,
    await readSides(root, TOOLS_PATHS.setupArtifact),
    AppSetupArtifactSchema,
  ).filter((artifact) => artifact.appId === config.appId);
  const contractFiles = parseSides(
    TOOLS_PATHS.contracts,
    await readSides(root, TOOLS_PATHS.contracts),
    ToolContractsFileSchema,
  ).filter((file) => file.appId === config.appId);
  const receiptMode = await readReceiptMode(root);
  return {
    ...(state ? { state } : {}),
    ...(artifacts.length ? { artifact: artifactView(artifacts) } : {}),
    contracts: mergeContracts(contractFiles.flatMap((file) => file.tools)),
    ...(receiptMode ? { receiptMode } : {}),
  };
}

export function renderInventory(state: ExecutionGenerationState): string {
  return canonicalJson(state.inventory);
}

export function renderTombstones(state: ExecutionGenerationState): string {
  return canonicalJson({ schemaVersion: 1, appId: state.appId, tombstones: state.tombstones });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/state.test.ts && bun run typecheck`
Expected: PASS, typecheck clean (the `toToolContract`/`toToolContractsEntry` identity functions prove schema/interface compatibility).

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/files.ts src/codegen/tools/state.ts src/codegen/tools/state.test.ts
git commit -m "feat(codegen): persist tool generation state and recover merges"
```

### Task 5: Test app fixture and bounded TypeScript program

**Files:**
- Modify: `.gitignore` (append `.tool-fixtures/`)
- Create: `src/codegen/tools/__tests__/app-fixture.ts` (test-only helper; `__tests__` is excluded from the build)
- Create: `src/codegen/tools/program.ts`
- Test: `src/codegen/tools/program.test.ts`

**Interfaces:**
- Consumes: `typescript`, `FoundationDiagnosticError`.
- Produces:
  - `export const SDK_ROOT: string`; `export const FIXTURE_APP_ID: string`; `export const FIXTURE_PROMPT_BUNDLE`; `export interface AppFixture { root: string; path(relativePath: string): string; write(relativePath: string, content: string): Promise<void>; read(relativePath: string): Promise<string>; remove(relativePath: string): Promise<void> }`; `export async function createAppFixture(files?: Readonly<Record<string, string>>, options?: { toolsConfig?: Readonly<Record<string, unknown>>; withoutToolsConfig?: boolean; withoutPromptBundle?: boolean }): Promise<AppFixture>`; `export async function removeAppFixtures(): Promise<void>`
  - `export interface AppProgram { readonly root: string; readonly program: ts.Program; readonly checker: ts.TypeChecker; sourceFile(absolutePath: string): ts.SourceFile | undefined; appRelative(fileName: string): string | undefined }`
  - `export function readAppCompilerOptions(root: string): ts.CompilerOptions`
  - `export function createAppProgram(input: { root: string; rootNames: ReadonlyArray<string> }): AppProgram`

Fixture apps live in `<sdk>/.tool-fixtures/app-*` so bare imports such as `zod` resolve to the SDK's `node_modules` without installing anything.

- [ ] **Step 1: Ignore fixture apps**

Append to `.gitignore`:

```gitignore

# Temporary app fixtures created by the tools generator tests.
.tool-fixtures/
```

- [ ] **Step 2: Create the fixture helper**

`src/codegen/tools/__tests__/app-fixture.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SDK_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const FIXTURE_APP_ID = '019fb007-0000-7000-8000-0000000000a1';
export const FIXTURE_PROMPT_BUNDLE = {
  schemaVersion: 1,
  appId: FIXTURE_APP_ID,
  artifactRef: 'local://tool-fixture/prompts',
  sections: {
    planner: 'Use the available tools; ask when the target is unclear.',
    appBehavior: 'Help with the fixture app.',
    responseStyle: 'Be concise.',
    capabilityFragments: {},
  },
};

export interface AppFixture {
  root: string;
  path(relativePath: string): string;
  write(relativePath: string, content: string): Promise<void>;
  read(relativePath: string): Promise<string>;
  remove(relativePath: string): Promise<void>;
}

const created: string[] = [];

export async function createAppFixture(
  files: Readonly<Record<string, string>> = {},
  options: {
    toolsConfig?: Readonly<Record<string, unknown>>;
    withoutToolsConfig?: boolean;
    withoutPromptBundle?: boolean;
  } = {},
): Promise<AppFixture> {
  const parent = join(SDK_ROOT, '.tool-fixtures');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'app-'));
  created.push(root);
  const fixture: AppFixture = {
    root,
    path: (relativePath) => join(root, relativePath),
    async write(relativePath, content) {
      await mkdir(dirname(join(root, relativePath)), { recursive: true });
      await writeFile(join(root, relativePath), content, 'utf8');
    },
    read: (relativePath) => readFile(join(root, relativePath), 'utf8'),
    remove: (relativePath) => rm(join(root, relativePath), { recursive: true, force: true }),
  };
  await fixture.write('package.json', `${JSON.stringify({ name: 'tool-fixture', private: true, type: 'module' })}\n`);
  if (!options.withoutToolsConfig) {
    await fixture.write('.glirastes/tools.json', `${JSON.stringify({
      schemaVersion: 1,
      appId: FIXTURE_APP_ID,
      targetAppKey: 'tool-fixture',
      locale: 'en-US',
      sources: ['next-app'],
      ...options.toolsConfig,
    })}\n`);
  }
  if (!options.withoutPromptBundle) {
    await fixture.write('.glirastes/prompt-bundle.json', `${JSON.stringify(FIXTURE_PROMPT_BUNDLE)}\n`);
  }
  for (const [relativePath, content] of Object.entries(files)) {
    await fixture.write(relativePath, content);
  }
  return fixture;
}

export async function removeAppFixtures(): Promise<void> {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
}
```

- [ ] **Step 3: Write the failing test**

`src/codegen/tools/program.test.ts`:

```ts
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { createAppProgram, readAppCompilerOptions } from './program.js';

afterEach(removeAppFixtures);

function moduleOfFirstImport(program: ReturnType<typeof createAppProgram>, file: string): string | undefined {
  const sourceFile = program.sourceFile(file)!;
  const declaration = sourceFile.statements.find(ts.isImportDeclaration)!;
  const symbol = program.checker.getSymbolAtLocation(declaration.moduleSpecifier);
  const target = symbol?.valueDeclaration;
  return target && ts.isSourceFile(target) ? program.appRelative(target.fileName) : undefined;
}

describe('createAppProgram', () => {
  it('resolves tsconfig path aliases to app files and keeps libraries outside', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string() });\n",
      'src/app/api/tasks/route.ts': "import { createTask } from '@/lib/schemas';\n"
        + 'export async function POST(request: Request) {\n'
        + '  return Response.json(createTask.parse(await request.json()));\n}\n',
    });
    const routeFile = join(app.root, 'src/app/api/tasks/route.ts');
    const program = createAppProgram({ root: app.root, rootNames: [routeFile] });
    expect(moduleOfFirstImport(program, routeFile)).toBe('src/lib/schemas.ts');
    const zodFile = program.program.getSourceFiles()
      .find((file) => file.fileName.includes('/node_modules/zod/'));
    expect(zodFile).toBeDefined();
    expect(program.appRelative(zodFile!.fileName)).toBeUndefined();
    expect(program.appRelative(routeFile)).toBe('src/app/api/tasks/route.ts');
  });

  it('reads JavaScript apps without a tsconfig', async () => {
    const app = await createAppFixture({
      'src/schemas.js': "import { z } from 'zod';\nexport const listInput = z.object({ q: z.string().optional() });\n",
      'src/app/api/items/route.js': "import { listInput } from '../../../schemas.js';\n"
        + 'export async function GET(request) {\n'
        + '  return Response.json(listInput.parse(Object.fromEntries(new URL(request.url).searchParams)));\n}\n',
    });
    const routeFile = join(app.root, 'src/app/api/items/route.js');
    const program = createAppProgram({ root: app.root, rootNames: [routeFile] });
    expect(moduleOfFirstImport(program, routeFile)).toBe('src/schemas.js');
    expect(readAppCompilerOptions(app.root).allowJs).toBeUndefined();
  });

  it('refuses unbounded programs instead of analysing a partial app', async () => {
    const app = await createAppFixture();
    const rootNames = Array.from({ length: 5_001 }, (_, index) => join(app.root, `src/app/api/r${index}/route.ts`));
    expect(() => createAppProgram({ root: app.root, rootNames }))
      .toThrowError(expect.objectContaining({ code: 'E-INVENTORY-011' }));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/program.test.ts`
Expected: FAIL — `Failed to resolve import "./program.js"`.

- [ ] **Step 5: Implement `program.ts`**

```ts
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';

export interface AppProgram {
  readonly root: string;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  sourceFile(absolutePath: string): ts.SourceFile | undefined;
  /** App-relative POSIX path, or undefined for libraries, declarations and outside files. */
  appRelative(fileName: string): string | undefined;
}

const MAX_ROOT_FILES = 5_000;
const MAX_PROGRAM_FILES = 30_000;

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    types: [],
  };
}

/** Only the app's own tsconfig.json counts; parent configs never apply. */
export function readAppCompilerOptions(root: string): ts.CompilerOptions {
  const configPath = join(root, 'tsconfig.json');
  if (!existsSync(configPath)) return defaultCompilerOptions();
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return defaultCompilerOptions();
  return ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath).options;
}

function unbounded(): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code: 'E-INVENTORY-011',
    operation: 'tools.program',
    message: 'The app is too large for one bounded TypeScript program.',
    remediation: 'complete-source-discovery',
  });
}

/** One bounded, read-only program per app tsconfig. Never emits, never executes. */
export function createAppProgram(input: {
  root: string;
  rootNames: ReadonlyArray<string>;
}): AppProgram {
  if (input.rootNames.length > MAX_ROOT_FILES) throw unbounded();
  const options: ts.CompilerOptions = {
    ...readAppCompilerOptions(input.root),
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };
  const program = ts.createProgram({ rootNames: [...input.rootNames].sort(), options });
  if (program.getSourceFiles().length > MAX_PROGRAM_FILES) throw unbounded();
  const checker = program.getTypeChecker();
  return {
    root: input.root,
    program,
    checker,
    sourceFile: (absolutePath) => program.getSourceFile(absolutePath),
    appRelative(fileName) {
      if (fileName.endsWith('.d.ts')) return undefined;
      const local = relative(input.root, fileName);
      if (!local || local.startsWith('..') || isAbsolute(local)) return undefined;
      const segments = local.split(/[\\/]/);
      if (segments.includes('node_modules')) return undefined;
      return segments.join('/');
    },
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/program.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add .gitignore src/codegen/tools/__tests__/app-fixture.ts src/codegen/tools/program.ts src/codegen/tools/program.test.ts
git commit -m "feat(codegen): add bounded typescript program for tool analysis"
```

### Task 6: Handler location and input-role data flow

**Files:**
- Create: `src/codegen/tools/handler-locator.ts`
- Create: `src/codegen/tools/input-roles.ts`
- Test: `src/codegen/tools/handler-locator.test.ts`, `src/codegen/tools/input-roles.test.ts`

**Interfaces:**
- Consumes: `typescript`, `EndpointMethod`, `compareCodeUnits`, `createAppProgram`, `createAppFixture`.
- Produces:
  - `export type HandlerFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction`
  - `export interface LocatedHandler { scope: ts.Node; fn?: HandlerFunction; jsDoc?: string; requestName?: string; contextName?: string; paramsName?: string }`
  - `export function locateRouteHandler(sourceFile: ts.SourceFile, method: EndpointMethod): LocatedHandler | undefined`
  - `export function unwrapExpression(node: ts.Expression): ts.Expression`
  - `export function bindingKey(element: ts.BindingElement): string | undefined`
  - `export function normalizedNodeText(node: ts.Node, sourceFile: ts.SourceFile): string`
  - `export type InputRole = 'body' | 'query' | 'path'`
  - `export interface RoleContext { readonly requestName?: string; readonly contextName?: string; readonly paramsName?: string; readonly declarations: ReadonlyMap<string, LocalBinding>; isBodyReaderCall(call: ts.CallExpression): boolean }`
  - `export function createRoleContext(handler: LocatedHandler, isBodyReaderCall: (call: ts.CallExpression) => boolean): RoleContext`
  - `export function isRequestBodyRead(node: ts.Expression, ctx: RoleContext): boolean`
  - `export function isSearchParamsExpression(node: ts.Expression, ctx: RoleContext, depth?: number): boolean`
  - `export function classifyInputExpression(node: ts.Expression, ctx: RoleContext, depth?: number): InputRole | 'unclear'`
  - `export function collectQueryKeys(scope: ts.Node, ctx: RoleContext): { keys: string[]; repeated: string[] }`
  - `export function collectBodyKeys(fn: HandlerFunction | undefined, ctx: RoleContext, checker: ts.TypeChecker): { readsBody: boolean; keys: string[] | 'opaque' }`

- [ ] **Step 1: Write the failing tests**

`src/codegen/tools/handler-locator.test.ts`:

```ts
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { locateRouteHandler, normalizedNodeText } from './handler-locator.js';

function locate(source: string, method: EndpointMethod) {
  const sourceFile = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  return { sourceFile, located: locateRouteHandler(sourceFile, method) };
}

describe('locateRouteHandler', () => {
  it('reads an exported function declaration with JSDoc and parameters', () => {
    const { located } = locate(
      '/**\n * GET /api/things/:id\n * Shows one thing\n * for the caller.\n */\n'
      + 'export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {\n'
      + '  return Response.json({ id: (await params).id });\n}\n',
      'GET',
    );
    expect(located).toMatchObject({
      jsDoc: 'Shows one thing for the caller.',
      requestName: 'request',
      paramsName: 'params',
    });
    expect(located?.fn !== undefined && ts.isFunctionDeclaration(located.fn)).toBe(true);
  });

  it('finds the inline handler inside a wrapper export', () => {
    const { located } = locate(
      "import { withAuth } from './auth';\n/** Creates a thing. */\n"
      + 'export const POST = withAuth(async (req: Request, ctx: { params: Promise<{ id: string }> }) => '
      + 'Response.json(await req.json()));\n',
      'POST',
    );
    expect(located).toMatchObject({ jsDoc: 'Creates a thing.', requestName: 'req', contextName: 'ctx' });
    expect(located?.fn !== undefined && ts.isArrowFunction(located.fn)).toBe(true);
    expect(located?.scope !== undefined && ts.isCallExpression(located.scope)).toBe(true);
  });

  it('follows a local handler exported under an alias', () => {
    const { located } = locate(
      'const handler = async (request: Request) => Response.json([]);\nexport { handler as DELETE };\n',
      'DELETE',
    );
    expect(located?.requestName).toBe('request');
  });

  it('keeps an unreadable export locatable but without a function', () => {
    const { located } = locate(
      "import { handlers } from './handlers';\nexport const PATCH = handlers.PATCH;\n",
      'PATCH',
    );
    expect(located).toBeDefined();
    expect(located?.fn).toBeUndefined();
  });

  it('returns undefined for a method the route does not export', () => {
    expect(locate('export async function GET() { return Response.json([]); }\n', 'PUT').located)
      .toBeUndefined();
  });

  it('normalizes comments and whitespace out of the handler text', () => {
    const first = locate('export async function GET() {\n  // list\n  return Response.json([]);\n}\n', 'GET');
    const second = locate('export async function GET() { return   Response.json([]); }\n', 'GET');
    expect(normalizedNodeText(first.located!.scope, first.sourceFile))
      .toBe(normalizedNodeText(second.located!.scope, second.sourceFile));
  });
});
```

`src/codegen/tools/input-roles.test.ts`:

```ts
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { locateRouteHandler } from './handler-locator.js';
import {
  classifyInputExpression,
  collectBodyKeys,
  collectQueryKeys,
  createRoleContext,
} from './input-roles.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

const DEFAULT_SIGNATURE = 'request: Request, { params }: { params: Promise<{ id: string }> }';

async function handler(body: string, options: { bodyReader?: string; signature?: string } = {}) {
  const route = 'src/app/api/things/[id]/route.ts';
  const app = await createAppFixture({
    [route]: "import { readJsonBody } from './reader';\nimport { Schema } from './schema';\n"
      + `export async function POST(${options.signature ?? DEFAULT_SIGNATURE}) {\n${body}\n}\n`,
    'src/app/api/things/[id]/reader.ts': 'export async function readJsonBody(request: Request): Promise<unknown> { return request.json(); }\n',
    'src/app/api/things/[id]/schema.ts': "import { z } from 'zod';\nexport const Schema = z.object({ title: z.string() });\n",
  });
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  const located = locateRouteHandler(program.sourceFile(app.path(route))!, 'POST')!;
  const ctx = createRoleContext(located, (call) => (
    ts.isIdentifier(call.expression) && call.expression.text === options.bodyReader
  ));
  const parsed: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'parse' && node.arguments[0]) parsed.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(located.fn!.body!);
  return { program, located, ctx, roles: parsed.map((argument) => classifyInputExpression(argument, ctx)) };
}

describe('input roles', () => {
  it.each([
    ['a direct body read', 'return Response.json(Schema.parse(await request.json()));', 'body'],
    ['a body variable', 'const body = await request.json();\nreturn Response.json(Schema.parse(body));', 'body'],
    ['search params entries', 'return Response.json(Schema.parse(Object.fromEntries(new URL(request.url).searchParams)));', 'query'],
    ['destructured search params', "const { searchParams } = new URL(request.url);\nreturn Response.json(Schema.parse(Object.fromEntries(searchParams.entries())));", 'query'],
    ['an object of search param reads', "const url = new URL(request.url);\nreturn Response.json(Schema.parse({ title: url.searchParams.get('title') ?? undefined }));", 'query'],
    ['awaited route params', 'return Response.json(Schema.parse(await params));', 'path'],
    ['an untraceable value', 'return Response.json(Schema.parse(compute()));\nfunction compute() { return {}; }', 'unclear'],
  ])('classifies %s', async (_label, body, role) => {
    expect((await handler(body)).roles).toEqual([role]);
  });

  it('classifies a context params property', async () => {
    const result = await handler('return Response.json(Schema.parse(await ctx.params));', {
      signature: 'req: Request, ctx: { params: Promise<{ id: string }> }',
    });
    expect(result.roles).toEqual(['path']);
  });

  it('honours declared body readers', async () => {
    const body = 'return Response.json(Schema.parse(await readJsonBody(request)));';
    expect((await handler(body, { bodyReader: 'readJsonBody' })).roles).toEqual(['body']);
    expect((await handler(body)).roles).toEqual(['unclear']);
  });

  it('collects literal query keys and marks repeated ones', async () => {
    const { located, ctx } = await handler(
      "const { searchParams } = new URL(request.url);\nconst status = searchParams.getAll('status');\n"
      + "const q = searchParams.get('q');\nreturn Response.json({ status, q });",
    );
    expect(collectQueryKeys(located.scope, ctx)).toEqual({ keys: ['q', 'status'], repeated: ['status'] });
  });

  it.each([
    ['closed destructuring', 'const { title, dueDate } = await request.json();\nreturn Response.json({ title, dueDate });', { readsBody: true, keys: ['dueDate', 'title'] }],
    ['property reads', "const body = await request.json();\nreturn Response.json({ a: body.title, b: body['due'] });", { readsBody: true, keys: ['due', 'title'] }],
    ['a rest element', 'const { title, ...rest } = await request.json();\nreturn Response.json({ title, rest });', { readsBody: true, keys: 'opaque' }],
    ['a body passed on whole', 'const body = await request.json();\nreturn Response.json(save(body));\nfunction save(value: unknown) { return value; }', { readsBody: true, keys: 'opaque' }],
    ['no body read', 'return Response.json({});', { readsBody: false, keys: [] }],
  ])('derives body keys from %s', async (_label, body, expected) => {
    const { located, ctx, program } = await handler(body);
    expect(collectBodyKeys(located.fn, ctx, program.checker)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/handler-locator.test.ts src/codegen/tools/input-roles.test.ts`
Expected: FAIL — `Failed to resolve import "./handler-locator.js"` and `"./input-roles.js"`.

- [ ] **Step 3: Implement `handler-locator.ts`**

```ts
import ts from 'typescript';
import type { EndpointMethod } from '../../types.js';

export type HandlerFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

export interface LocatedHandler {
  /** The exported declaration or initializer, including any wrapper call around the handler. */
  scope: ts.Node;
  fn?: HandlerFunction;
  jsDoc?: string;
  requestName?: string;
  contextName?: string;
  paramsName?: string;
}

const ROUTE_LINE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/\S*$/;
const printer = ts.createPrinter({ removeComments: true });

export function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isAwaitExpression(current)
      || ts.isAsExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

export function bindingKey(element: ts.BindingElement): string | undefined {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** Comment- and formatting-free text, so cosmetic edits never change a digest. */
export function normalizedNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, ' ').trim();
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isHandlerFunction(node: ts.Node): node is HandlerFunction {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
    && node.body !== undefined;
}

function localDeclarations(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const locals = new Map<string, ts.Node>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      locals.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          locals.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return locals;
}

function functionOf(
  node: ts.Node,
  locals: ReadonlyMap<string, ts.Node>,
  depth = 0,
): HandlerFunction | undefined {
  if (depth > 4) return undefined;
  const target = ts.isExpression(node) ? unwrapExpression(node) : node;
  if (isHandlerFunction(target)) return target;
  if (ts.isIdentifier(target)) {
    const local = locals.get(target.text);
    return local ? functionOf(local, locals, depth + 1) : undefined;
  }
  if (ts.isCallExpression(target)) {
    for (const argument of target.arguments) {
      const found = functionOf(argument, locals, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function jsDocOf(host: ts.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(host).filter(ts.isJSDoc);
  const last = docs[docs.length - 1];
  const text = last ? ts.getTextOfJSDocComment(last.comment) : undefined;
  if (!text) return undefined;
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !ROUTE_LINE.test(line));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, 1_000) : undefined;
}

function hostStatement(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  return current;
}

export function locateRouteHandler(
  sourceFile: ts.SourceFile,
  method: EndpointMethod,
): LocatedHandler | undefined {
  const locals = localDeclarations(sourceFile);
  const located = (scope: ts.Node, host: ts.Node): LocatedHandler => {
    const fn = functionOf(scope, locals);
    const [request, context] = fn?.parameters ?? [];
    const contextPattern = context && ts.isObjectBindingPattern(context.name) ? context.name : undefined;
    const paramsElement = contextPattern?.elements.find((element) => bindingKey(element) === 'params');
    const jsDoc = jsDocOf(host);
    return {
      scope,
      ...(fn ? { fn } : {}),
      ...(jsDoc ? { jsDoc } : {}),
      ...(request && ts.isIdentifier(request.name) ? { requestName: request.name.text } : {}),
      ...(context && ts.isIdentifier(context.name) ? { contextName: context.name.text } : {}),
      ...(paramsElement && ts.isIdentifier(paramsElement.name) ? { paramsName: paramsElement.name.text } : {}),
    };
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) && statement.name?.text === method
      && statement.body && hasExportModifier(statement)
    ) {
      return located(statement, statement);
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === method && declaration.initializer) {
          return located(declaration.initializer, statement);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly
      && statement.exportClause && ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly || element.name.text !== method) continue;
        const local = locals.get((element.propertyName ?? element.name).text);
        if (local) return located(local, hostStatement(local));
      }
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Implement `input-roles.ts`**

```ts
import ts from 'typescript';
import { compareCodeUnits } from './canonical.js';
import {
  bindingKey,
  unwrapExpression,
  type HandlerFunction,
  type LocatedHandler,
} from './handler-locator.js';

export type InputRole = 'body' | 'query' | 'path';

export type LocalBinding =
  | { kind: 'init'; expression: ts.Expression }
  | { kind: 'destructured'; from: ts.Expression; property: string };

export interface RoleContext {
  readonly requestName?: string;
  readonly contextName?: string;
  readonly paramsName?: string;
  readonly declarations: ReadonlyMap<string, LocalBinding>;
  isBodyReaderCall(call: ts.CallExpression): boolean;
}

const MAX_DEPTH = 6;

export function createRoleContext(
  handler: LocatedHandler,
  isBodyReaderCall: (call: ts.CallExpression) => boolean,
): RoleContext {
  const declarations = new Map<string, LocalBinding>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        if (!declarations.has(node.name.text)) {
          declarations.set(node.name.text, { kind: 'init', expression: node.initializer });
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = bindingKey(element);
          if (!element.dotDotDotToken && property && ts.isIdentifier(element.name)
            && !declarations.has(element.name.text)) {
            declarations.set(element.name.text, { kind: 'destructured', from: node.initializer, property });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (handler.fn?.body) visit(handler.fn.body);
  return {
    requestName: handler.requestName,
    contextName: handler.contextName,
    paramsName: handler.paramsName,
    declarations,
    isBodyReaderCall,
  };
}

function isRequestExpression(node: ts.Expression, ctx: RoleContext, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isIdentifier(target)) {
    if (ctx.requestName && target.text === ctx.requestName) return true;
    const binding = ctx.declarations.get(target.text);
    return binding?.kind === 'init' && isRequestExpression(binding.expression, ctx, depth + 1);
  }
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
    && target.expression.name.text === 'clone') {
    return isRequestExpression(target.expression.expression, ctx, depth + 1);
  }
  return false;
}

export function isRequestBodyRead(node: ts.Expression, ctx: RoleContext): boolean {
  const target = unwrapExpression(node);
  if (!ts.isCallExpression(target)) return false;
  if (ctx.isBodyReaderCall(target)) return true;
  return ts.isPropertyAccessExpression(target.expression)
    && target.expression.name.text === 'json'
    && isRequestExpression(target.expression.expression, ctx);
}

function isUrlExpression(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isNewExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'URL') {
    const first = target.arguments?.[0];
    const value = first ? unwrapExpression(first) : undefined;
    return Boolean(value && ts.isPropertyAccessExpression(value) && value.name.text === 'url'
      && isRequestExpression(value.expression, ctx, depth + 1));
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'nextUrl') {
    return isRequestExpression(target.expression, ctx, depth + 1);
  }
  if (ts.isIdentifier(target)) {
    const binding = ctx.declarations.get(target.text);
    return binding?.kind === 'init' && isUrlExpression(binding.expression, ctx, depth + 1);
  }
  return false;
}

export function isSearchParamsExpression(node: ts.Expression, ctx: RoleContext, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'searchParams') {
    return isUrlExpression(target.expression, ctx, depth + 1);
  }
  if (ts.isIdentifier(target)) {
    const binding = ctx.declarations.get(target.text);
    if (binding?.kind === 'init') return isSearchParamsExpression(binding.expression, ctx, depth + 1);
    if (binding?.kind === 'destructured') {
      return binding.property === 'searchParams' && isUrlExpression(binding.from, ctx, depth + 1);
    }
  }
  return false;
}

function isSearchParamsLike(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  const target = unwrapExpression(node);
  if (isSearchParamsExpression(target, ctx, depth + 1)) return true;
  return (ts.isIdentifier(target) && target.text === 'searchParams')
    || (ts.isPropertyAccessExpression(target) && target.name.text === 'searchParams');
}

function searchParamRead(
  node: ts.Expression,
  ctx: RoleContext,
  depth: number,
): { key: string; repeated: boolean } | undefined {
  let target = unwrapExpression(node);
  if (ts.isBinaryExpression(target) && (
    target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    || target.operatorToken.kind === ts.SyntaxKind.BarBarToken
  )) {
    target = unwrapExpression(target.left);
  }
  if (!ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression)) return undefined;
  const method = target.expression.name.text;
  if (method !== 'get' && method !== 'getAll') return undefined;
  const key = target.arguments[0];
  if (!key || !ts.isStringLiteralLike(key)) return undefined;
  if (!isSearchParamsLike(target.expression.expression, ctx, depth)) return undefined;
  return { key: key.text, repeated: method === 'getAll' };
}

function isSearchParamsObject(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  const target = unwrapExpression(node);
  if (
    ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
    && ts.isIdentifier(target.expression.expression) && target.expression.expression.text === 'Object'
    && target.expression.name.text === 'fromEntries'
  ) {
    const argument = target.arguments[0];
    if (!argument) return false;
    const inner = unwrapExpression(argument);
    if (isSearchParamsExpression(inner, ctx, depth + 1)) return true;
    return ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)
      && inner.expression.name.text === 'entries'
      && isSearchParamsExpression(inner.expression.expression, ctx, depth + 1);
  }
  if (ts.isObjectLiteralExpression(target) && target.properties.length > 0) {
    return target.properties.every((property) => (
      ts.isPropertyAssignment(property) && searchParamRead(property.initializer, ctx, depth) !== undefined
    ));
  }
  return false;
}

function isContextExpression(node: ts.Expression, ctx: RoleContext): boolean {
  const target = unwrapExpression(node);
  return Boolean(ctx.contextName) && ts.isIdentifier(target) && target.text === ctx.contextName;
}

function isParamsExpression(node: ts.Expression, ctx: RoleContext, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const target = unwrapExpression(node);
  if (ts.isIdentifier(target)) {
    if (ctx.paramsName && target.text === ctx.paramsName) return true;
    const binding = ctx.declarations.get(target.text);
    if (binding?.kind === 'init') return isParamsExpression(binding.expression, ctx, depth + 1);
    if (binding?.kind === 'destructured') {
      return binding.property === 'params' && isContextExpression(binding.from, ctx);
    }
    return false;
  }
  return ts.isPropertyAccessExpression(target) && target.name.text === 'params'
    && isContextExpression(target.expression, ctx);
}

/** Data flow inside one handler: where does the value a schema parses come from? */
export function classifyInputExpression(
  node: ts.Expression,
  ctx: RoleContext,
  depth = 0,
): InputRole | 'unclear' {
  if (depth > MAX_DEPTH) return 'unclear';
  const target = unwrapExpression(node);
  if (isRequestBodyRead(target, ctx)) return 'body';
  if (isSearchParamsObject(target, ctx, depth)) return 'query';
  if (isParamsExpression(target, ctx, depth)) return 'path';
  if (ts.isIdentifier(target)) {
    const binding = ctx.declarations.get(target.text);
    if (binding?.kind === 'init') return classifyInputExpression(binding.expression, ctx, depth + 1);
  }
  return 'unclear';
}

export function collectQueryKeys(
  scope: ts.Node,
  ctx: RoleContext,
): { keys: string[]; repeated: string[] } {
  const keys = new Set<string>();
  const repeated = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const read = searchParamRead(node, ctx, 0);
      if (read) {
        keys.add(read.key);
        if (read.repeated) repeated.add(read.key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return {
    keys: [...keys].sort(compareCodeUnits),
    repeated: [...repeated].sort(compareCodeUnits),
  };
}

/** Body keys from closed destructuring and literal property reads; anything else is opaque. */
export function collectBodyKeys(
  fn: HandlerFunction | undefined,
  ctx: RoleContext,
  checker: ts.TypeChecker,
): { readsBody: boolean; keys: string[] | 'opaque' } {
  let readsBody = false;
  let opaque = false;
  const keys = new Set<string>();
  const body = fn?.body;
  if (!body) return { readsBody, keys: [] };

  const addPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      const key = bindingKey(element);
      if (element.dotDotDotToken || key === undefined) {
        opaque = true;
        continue;
      }
      keys.add(key);
    }
  };
  const followVariable = (name: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) {
      opaque = true;
      return;
    }
    const visitReferences = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== name && checker.getSymbolAtLocation(node) === symbol) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          keys.add(parent.name.text);
        } else if (ts.isElementAccessExpression(parent) && parent.expression === node
          && ts.isStringLiteralLike(parent.argumentExpression)) {
          keys.add(parent.argumentExpression.text);
        } else if (ts.isVariableDeclaration(parent) && parent.initializer === node
          && ts.isObjectBindingPattern(parent.name)) {
          addPattern(parent.name);
        } else {
          opaque = true;
        }
      }
      ts.forEachChild(node, visitReferences);
    };
    visitReferences(body);
  };
  const consume = (read: ts.Node): void => {
    let consumer = read;
    while (consumer.parent && (
      ts.isAwaitExpression(consumer.parent) || ts.isParenthesizedExpression(consumer.parent)
      || ts.isAsExpression(consumer.parent) || ts.isNonNullExpression(consumer.parent)
      || ts.isSatisfiesExpression(consumer.parent)
    )) {
      consumer = consumer.parent;
    }
    const parent = consumer.parent;
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === consumer) {
      if (ts.isObjectBindingPattern(parent.name)) {
        addPattern(parent.name);
        return;
      }
      if (ts.isIdentifier(parent.name)) {
        followVariable(parent.name);
        return;
      }
    }
    opaque = true;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRequestBodyRead(node, ctx)) {
      readsBody = true;
      consume(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { readsBody, keys: opaque ? 'opaque' : [...keys].sort(compareCodeUnits) };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/handler-locator.test.ts src/codegen/tools/input-roles.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/handler-locator.ts src/codegen/tools/input-roles.ts src/codegen/tools/handler-locator.test.ts src/codegen/tools/input-roles.test.ts
git commit -m "feat(codegen): locate next handlers and classify input roles"
```

### Task 7: Schema bindings, wrappers, body readers and response arguments

**Files:**
- Create: `src/codegen/tools/handler-analysis.ts`
- Test: `src/codegen/tools/handler-analysis.test.ts`

**Interfaces:**
- Consumes: `locateRouteHandler`, `normalizedNodeText`, `unwrapExpression`, `createRoleContext`, `classifyInputExpression`, `collectQueryKeys`, `collectBodyKeys` (Task 6), `AppProgram` (Task 5), `AUTH_PATTERNS` (Task 3), `SchemaBindingRef`.
- Produces:
  - `export interface ModuleExportRef { module: string; export: string }`
  - `export interface HandlerWrapperConvention extends ModuleExportRef { inputArg?: number; queryArg?: number; outputArg?: number }`
  - `export interface HandlerConventions { handlerWrappers: ReadonlyArray<HandlerWrapperConvention>; bodyReaders: ReadonlyArray<ModuleExportRef>; authHelpers: ReadonlyArray<string> }`
  - `export type SchemaRole = InputRole | 'output' | 'unclear'`
  - `export interface SchemaUse { role: SchemaRole; via: 'parse' | 'wrapper'; binding?: SchemaBindingRef; problem?: 'not-exported' }`
  - `export interface HandlerAnalysis { located?: LocatedHandler; schemaUses: SchemaUse[]; queryKeys: string[]; repeatedQueryKeys: string[]; bodyKeys: string[] | 'opaque'; readsBody: boolean; normalizedText?: string; responseArguments: ts.Expression[]; importedModules: string[] }`
  - `export function sameModule(left: string, right: string): boolean`
  - `export function resolveCallTarget(app: AppProgram, expression: ts.Expression): ModuleExportRef | undefined`
  - `export function analyzeRouteHandler(input: { app: AppProgram; sourceFile: ts.SourceFile; method: EndpointMethod; conventions: HandlerConventions }): HandlerAnalysis`

Rules pinned here: an input parse whose argument flows from the request is an input use even when returned; an otherwise unclear parse whose result is returned through `Response.json`/`NextResponse.json` is the explicit output schema; for POST/PUT/PATCH a request object handed to an unknown function makes the body opaque (never a silently empty derived contract).

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/handler-analysis.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { analyzeRouteHandler, sameModule, type HandlerConventions } from './handler-analysis.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

const NO_CONVENTIONS: HandlerConventions = { handlerWrappers: [], bodyReaders: [], authHelpers: [] };
const ALIAS_TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
});

async function analyze(
  files: Record<string, string>,
  route: string,
  method: EndpointMethod,
  conventions: HandlerConventions = NO_CONVENTIONS,
) {
  const app = await createAppFixture(files);
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  return analyzeRouteHandler({
    app: program, sourceFile: program.sourceFile(app.path(route))!, method, conventions,
  });
}

describe('analyzeRouteHandler', () => {
  it('binds a native body schema through a path alias and the explicit output schema', async () => {
    const route = 'src/app/api/notes/route.ts';
    const analysis = await analyze({
      'tsconfig.json': ALIAS_TSCONFIG,
      'src/lib/notes.ts': "import { z } from 'zod';\n"
        + 'export const createNote = z.object({ title: z.string() }).strict();\n'
        + 'export const noteOutput = z.object({ id: z.string(), title: z.string() });\n',
      [route]: "import { createNote, noteOutput } from '@/lib/notes';\n"
        + 'export async function POST(request: Request) {\n'
        + '  const input = createNote.safeParse(await request.json());\n'
        + "  if (!input.success) return Response.json({ error: 'invalid' }, { status: 400 });\n"
        + "  return Response.json(noteOutput.parse({ id: '1', title: input.data.title }), { status: 201 });\n}\n",
    }, route, 'POST');
    expect(analysis.schemaUses).toEqual([
      { role: 'body', via: 'parse', binding: { module: 'src/lib/notes.ts', export: 'createNote', property: [] } },
      { role: 'output', via: 'parse', binding: { module: 'src/lib/notes.ts', export: 'noteOutput', property: [] } },
    ]);
    expect(analysis.responseArguments).toHaveLength(1);
    expect(analysis.importedModules).toEqual(['src/lib/notes.ts']);
    expect(analysis.readsBody).toBe(true);
  });

  it('binds contract-module properties and namespace imports', async () => {
    const route = 'src/app/api/tasks/route.ts';
    const files = {
      'src/app/api/tasks/contract.ts': "import { z } from 'zod';\n"
        + 'export const contract = { POST: { input: z.object({ title: z.string() }) } };\n',
      'src/app/api/tasks/schemas.ts': "import { z } from 'zod';\n"
        + 'export const listQuery = z.object({ q: z.string().optional() });\n',
      [route]: "import { contract } from './contract';\nimport * as schemas from './schemas';\n"
        + 'export async function POST(request: Request) {\n'
        + '  return Response.json(contract.POST.input.parse(await request.json()));\n}\n'
        + 'export async function GET(request: Request) {\n'
        + '  return Response.json(schemas.listQuery.parse(Object.fromEntries(new URL(request.url).searchParams)));\n}\n',
    };
    expect((await analyze(files, route, 'POST')).schemaUses).toEqual([{
      role: 'body', via: 'parse',
      binding: { module: 'src/app/api/tasks/contract.ts', export: 'contract', property: ['POST', 'input'] },
    }]);
    expect((await analyze(files, route, 'GET')).schemaUses).toEqual([{
      role: 'query', via: 'parse',
      binding: { module: 'src/app/api/tasks/schemas.ts', export: 'listQuery', property: [] },
    }]);
  });

  it('reports a schema declared only inside the route as not exported and ignores JSON.parse', async () => {
    const route = 'src/app/api/items/route.ts';
    const analysis = await analyze({
      [route]: "import { z } from 'zod';\nconst local = z.object({ title: z.string() });\n"
        + 'export async function POST(request: Request) {\n'
        + '  const raw = JSON.parse(await request.text());\n'
        + '  const input = local.parse(await request.json());\n'
        + '  return Response.json({ input, raw });\n}\n',
    }, route, 'POST');
    expect(analysis.schemaUses).toEqual([{ role: 'body', via: 'parse', problem: 'not-exported' }]);
  });

  it('applies a declared handler wrapper only for the declared module', async () => {
    const route = 'src/app/api/tasks/route.js';
    const files = {
      'src/query.js': 'export async function query(request, inputSchema, outputSchema, execute) {\n'
        + '  return Response.json(outputSchema.parse(await execute(inputSchema.parse({}))));\n}\n',
      'src/app/api/tasks/contract.js': "import { z } from 'zod';\n"
        + 'export const inputSchema = z.object({ status: z.string().optional() });\n'
        + 'export const outputSchema = z.object({ tasks: z.array(z.string()) });\n',
      [route]: "import { inputSchema, outputSchema } from './contract.js';\n"
        + "import { query } from '../../../query.js';\n"
        + 'export async function GET(request) {\n'
        + '  return query(request, inputSchema, outputSchema, () => ({ tasks: [] }));\n}\n',
    };
    const declared = await analyze(files, route, 'GET', {
      ...NO_CONVENTIONS,
      handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
    });
    expect(declared.schemaUses).toEqual([
      { role: 'query', via: 'wrapper', binding: { module: 'src/app/api/tasks/contract.js', export: 'inputSchema', property: [] } },
      { role: 'output', via: 'wrapper', binding: { module: 'src/app/api/tasks/contract.js', export: 'outputSchema', property: [] } },
    ]);
    const other = await analyze(files, route, 'GET', {
      ...NO_CONVENTIONS,
      handlerWrappers: [{ module: 'src/other.js', export: 'query', queryArg: 1 }],
    });
    expect(other.schemaUses).toEqual([]);
  });

  it('treats declared body readers as body reads and unknown request consumers as opaque bodies', async () => {
    const route = 'src/app/api/tasks/route.ts';
    const files = {
      'src/lib/body.ts': 'export async function readJsonBody(request: Request): Promise<unknown> { return request.json(); }\n',
      'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string() });\n",
      'src/lib/session.ts': 'export async function getSession(request: Request) { return request.headers.get("cookie"); }\n',
      [route]: "import { readJsonBody } from '../../../lib/body';\nimport { createTask } from '../../../lib/schemas';\n"
        + "import { getSession } from '../../../lib/session';\n"
        + 'export async function POST(request: Request) {\n'
        + '  await getSession(request);\n'
        + '  const input = createTask.parse(await readJsonBody(request));\n'
        + '  return Response.json(input);\n}\n',
    };
    const declared = await analyze(files, route, 'POST', {
      ...NO_CONVENTIONS, bodyReaders: [{ module: 'src/lib/body.ts', export: 'readJsonBody' }],
    });
    expect(declared.schemaUses).toEqual([
      { role: 'body', via: 'parse', binding: { module: 'src/lib/schemas.ts', export: 'createTask', property: [] } },
    ]);
    expect(declared.bodyKeys).toBe('opaque');
    const undeclared = await analyze(files, route, 'POST');
    expect(undeclared.readsBody).toBe(true);
    expect(undeclared.bodyKeys).toBe('opaque');
    expect(undeclared.schemaUses.some((use) => use.role === 'body')).toBe(false);
  });

  it('compares convention modules without extensions', () => {
    expect(sameModule('src/query.js', './src/query.ts')).toBe(true);
    expect(sameModule('src/query.js', 'src/app/query.js')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/handler-analysis.test.ts`
Expected: FAIL — `Failed to resolve import "./handler-analysis.js"`.

- [ ] **Step 3: Implement `handler-analysis.ts`**

```ts
import ts from 'typescript';
import type { EndpointMethod } from '../../types.js';
import { AUTH_PATTERNS } from '../route-scanner.js';
import { compareCodeUnits } from './canonical.js';
import {
  locateRouteHandler,
  normalizedNodeText,
  unwrapExpression,
  type LocatedHandler,
} from './handler-locator.js';
import {
  classifyInputExpression,
  collectBodyKeys,
  collectQueryKeys,
  createRoleContext,
  type InputRole,
  type RoleContext,
} from './input-roles.js';
import type { AppProgram } from './program.js';
import type { SchemaBindingRef } from './types.js';

export interface ModuleExportRef {
  module: string;
  export: string;
}

export interface HandlerWrapperConvention extends ModuleExportRef {
  inputArg?: number;
  queryArg?: number;
  outputArg?: number;
}

export interface HandlerConventions {
  handlerWrappers: ReadonlyArray<HandlerWrapperConvention>;
  bodyReaders: ReadonlyArray<ModuleExportRef>;
  authHelpers: ReadonlyArray<string>;
}

export type SchemaRole = InputRole | 'output' | 'unclear';

export interface SchemaUse {
  role: SchemaRole;
  via: 'parse' | 'wrapper';
  binding?: SchemaBindingRef;
  problem?: 'not-exported';
}

export interface HandlerAnalysis {
  located?: LocatedHandler;
  schemaUses: SchemaUse[];
  queryKeys: string[];
  repeatedQueryKeys: string[];
  bodyKeys: string[] | 'opaque';
  readsBody: boolean;
  normalizedText?: string;
  responseArguments: ts.Expression[];
  importedModules: string[];
}

const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const BODY_METHODS = new Set<EndpointMethod>(['POST', 'PUT', 'PATCH']);
const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const DEFAULT_AUTH_NAMES = AUTH_PATTERNS.map(([name]) => name);

export function sameModule(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(MODULE_EXTENSION, '');
  return normalize(left) === normalize(right);
}

function importDeclarationOf(node: ts.Node): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current;
}

function moduleOfImport(app: AppProgram, declaration: ts.ImportDeclaration | undefined): string | undefined {
  if (!declaration) return undefined;
  const target = app.checker.getSymbolAtLocation(declaration.moduleSpecifier)?.valueDeclaration;
  return target && ts.isSourceFile(target) ? app.appRelative(target.fileName) : undefined;
}

function importedAppModules(app: AppProgram, sourceFile: ts.SourceFile): string[] {
  const modules = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const module = moduleOfImport(app, statement);
    if (module) modules.add(module);
  }
  return [...modules].sort(compareCodeUnits);
}

/** Module and export name of a called function, when it is imported from the app. */
export function resolveCallTarget(app: AppProgram, expression: ts.Expression): ModuleExportRef | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    const declaration = app.checker.getSymbolAtLocation(target)?.declarations?.[0];
    if (declaration && ts.isImportSpecifier(declaration)) {
      const module = moduleOfImport(app, importDeclarationOf(declaration));
      return module ? { module, export: (declaration.propertyName ?? declaration.name).text } : undefined;
    }
    if (declaration && ts.isImportClause(declaration)) {
      const module = moduleOfImport(app, importDeclarationOf(declaration));
      return module ? { module, export: 'default' } : undefined;
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
    const declaration = app.checker.getSymbolAtLocation(target.expression)?.declarations?.[0];
    if (declaration && ts.isNamespaceImport(declaration)) {
      const module = moduleOfImport(app, importDeclarationOf(declaration));
      return module ? { module, export: target.name.text } : undefined;
    }
  }
  return undefined;
}

function exportNameOf(app: AppProgram, sourceFile: ts.SourceFile, symbol: ts.Symbol | undefined): string | undefined {
  if (!symbol) return undefined;
  const moduleSymbol = app.checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return undefined;
  const exportSymbol = app.checker.getExportSymbolOfSymbol(symbol);
  for (const exported of app.checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? app.checker.getAliasedSymbol(exported) : exported;
    if (exported === exportSymbol || target === exportSymbol || target === symbol) return exported.name;
  }
  return undefined;
}

function resolveSchemaBinding(
  app: AppProgram,
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): Pick<SchemaUse, 'binding' | 'problem'> {
  const property: string[] = [];
  let node = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(node)) {
    property.unshift(node.name.text);
    node = unwrapExpression(node.expression);
  }
  if (!ts.isIdentifier(node)) return { problem: 'not-exported' };
  const symbol = app.checker.getSymbolAtLocation(node);
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return { problem: 'not-exported' };
  if (ts.isImportSpecifier(declaration)) {
    const module = moduleOfImport(app, importDeclarationOf(declaration));
    return module
      ? { binding: { module, export: (declaration.propertyName ?? declaration.name).text, property } }
      : { problem: 'not-exported' };
  }
  if (ts.isImportClause(declaration)) {
    const module = moduleOfImport(app, importDeclarationOf(declaration));
    return module ? { binding: { module, export: 'default', property } } : { problem: 'not-exported' };
  }
  if (ts.isNamespaceImport(declaration)) {
    const module = moduleOfImport(app, importDeclarationOf(declaration));
    const [exportName, ...rest] = property;
    return module && exportName
      ? { binding: { module, export: exportName, property: rest } }
      : { problem: 'not-exported' };
  }
  const module = app.appRelative(sourceFile.fileName);
  const exported = exportNameOf(app, sourceFile, symbol);
  return module && exported ? { binding: { module, export: exported, property } } : { problem: 'not-exported' };
}

function isSchemaExpression(app: AppProgram, expression: ts.Expression): boolean {
  const type = app.checker.getTypeAtLocation(expression);
  return Boolean(type.getProperty('_zod') ?? type.getProperty('_def'));
}

function isResponseJsonCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'json' && ts.isIdentifier(node.expression.expression)
    && (node.expression.expression.text === 'Response' || node.expression.expression.text === 'NextResponse');
}

function isErrorResponse(call: ts.CallExpression): boolean {
  const init = call.arguments[1];
  if (!init || !ts.isObjectLiteralExpression(init)) return false;
  return init.properties.some((property) => (
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'status'
    && ts.isNumericLiteral(property.initializer) && Number(property.initializer.text) >= 300
  ));
}

function collectResponseArguments(scope: ts.Node): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (isResponseJsonCall(node) && node.arguments[0] && !isErrorResponse(node)) found.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function isResponsePayload(app: AppProgram, body: ts.Node, call: ts.CallExpression): boolean {
  let consumer: ts.Node = call;
  while (consumer.parent && (
    ts.isAwaitExpression(consumer.parent) || ts.isParenthesizedExpression(consumer.parent)
    || ts.isAsExpression(consumer.parent) || ts.isNonNullExpression(consumer.parent)
  )) {
    consumer = consumer.parent;
  }
  const parent = consumer.parent;
  if (parent && isResponseJsonCall(parent) && parent.arguments[0] === consumer) return true;
  if (!parent || !ts.isVariableDeclaration(parent) || parent.initializer !== consumer
    || !ts.isIdentifier(parent.name)) return false;
  const symbol = app.checker.getSymbolAtLocation(parent.name);
  if (!symbol) return false;
  let returned = false;
  const visit = (node: ts.Node): void => {
    if (isResponseJsonCall(node) && node.arguments[0]) {
      let value = unwrapExpression(node.arguments[0]);
      if (ts.isPropertyAccessExpression(value)) value = unwrapExpression(value.expression);
      if (ts.isIdentifier(value) && app.checker.getSymbolAtLocation(value) === symbol) returned = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returned;
}

function parseUses(app: AppProgram, sourceFile: ts.SourceFile, located: LocatedHandler, ctx: RoleContext): SchemaUse[] {
  const body = located.fn?.body;
  if (!body) return [];
  const uses: SchemaUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && PARSE_METHODS.has(node.expression.name.text) && node.arguments[0]
      && isSchemaExpression(app, node.expression.expression)) {
      let role: SchemaRole = classifyInputExpression(node.arguments[0], ctx);
      if (role === 'unclear' && isResponsePayload(app, body, node)) role = 'output';
      uses.push({ role, via: 'parse', ...resolveSchemaBinding(app, sourceFile, node.expression.expression) });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return uses;
}

function wrapperUses(
  app: AppProgram,
  sourceFile: ts.SourceFile,
  located: LocatedHandler,
  conventions: HandlerConventions,
): SchemaUse[] {
  const uses: SchemaUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = resolveCallTarget(app, node.expression);
      const convention = target && conventions.handlerWrappers.find((wrapper) => (
        wrapper.export === target.export && sameModule(wrapper.module, target.module)
      ));
      if (convention) {
        const slots = [
          ['body', convention.inputArg],
          ['query', convention.queryArg],
          ['output', convention.outputArg],
        ] as const;
        for (const [role, index] of slots) {
          if (index === undefined) continue;
          const argument = node.arguments[index];
          uses.push(argument
            ? { role, via: 'wrapper', ...resolveSchemaBinding(app, sourceFile, argument) }
            : { role, via: 'wrapper', problem: 'not-exported' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(located.scope);
  return uses;
}

/** A write handler that hands the request to unknown code may read its body there. */
function requestEscapes(
  app: AppProgram,
  located: LocatedHandler,
  conventions: HandlerConventions,
): boolean {
  const body = located.fn?.body;
  const name = located.requestName;
  if (!body || !name) return false;
  const safeNames = new Set([...DEFAULT_AUTH_NAMES, ...conventions.authHelpers]);
  const isSafe = (call: ts.CallExpression): boolean => {
    const callee = unwrapExpression(call.expression);
    const calleeName = ts.isIdentifier(callee) ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    if (calleeName && safeNames.has(calleeName)) return true;
    const target = resolveCallTarget(app, call.expression);
    return Boolean(target && [...conventions.handlerWrappers, ...conventions.bodyReaders].some((entry) => (
      entry.export === target.export && sameModule(entry.module, target.module)
    )));
  };
  let escapes = false;
  const visit = (node: ts.Node): void => {
    if (escapes) return;
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (node.arguments ?? []).some((argument) => {
      const value = unwrapExpression(argument);
      return ts.isIdentifier(value) && value.text === name;
    }) && !(ts.isCallExpression(node) && isSafe(node))) {
      escapes = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return escapes;
}

export function analyzeRouteHandler(input: {
  app: AppProgram;
  sourceFile: ts.SourceFile;
  method: EndpointMethod;
  conventions: HandlerConventions;
}): HandlerAnalysis {
  const { app, sourceFile, conventions } = input;
  const importedModules = importedAppModules(app, sourceFile);
  const located = locateRouteHandler(sourceFile, input.method);
  if (!located) {
    return {
      schemaUses: [], queryKeys: [], repeatedQueryKeys: [], bodyKeys: [], readsBody: false,
      responseArguments: [], importedModules,
    };
  }
  const ctx = createRoleContext(located, (call) => {
    const target = resolveCallTarget(app, call.expression);
    return Boolean(target && conventions.bodyReaders.some((reader) => (
      reader.export === target.export && sameModule(reader.module, target.module)
    )));
  });
  const query = collectQueryKeys(located.scope, ctx);
  let body = collectBodyKeys(located.fn, ctx, app.checker);
  if (BODY_METHODS.has(input.method) && !body.readsBody && requestEscapes(app, located, conventions)) {
    body = { readsBody: true, keys: 'opaque' };
  }
  return {
    located,
    schemaUses: [
      ...parseUses(app, sourceFile, located, ctx),
      ...wrapperUses(app, sourceFile, located, conventions),
    ],
    queryKeys: query.keys,
    repeatedQueryKeys: query.repeated,
    bodyKeys: body.keys,
    readsBody: body.readsBody,
    normalizedText: normalizedNodeText(located.scope, sourceFile),
    responseArguments: collectResponseArguments(located.scope),
    importedModules,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/handler-analysis.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/handler-analysis.ts src/codegen/tools/handler-analysis.test.ts
git commit -m "feat(codegen): bind handler schemas, wrappers and body readers"
```

### Task 8: Auth and external-call evidence

**Files:**
- Create: `src/codegen/tools/evidence.ts`
- Test: `src/codegen/tools/evidence.test.ts`

**Interfaces:**
- Consumes: `AUTH_PATTERNS` (Task 3), `unwrapExpression`, `locateRouteHandler` (Task 6), `AppProgram`, `createAppProgram` (Task 5).
- Produces:
  - `export const EVIDENCE_DEPTH = 2`
  - `export interface HandlerEvidence { authEvidence: string[]; externalCall: boolean }`
  - `export function collectHandlerEvidence(input: { app: AppProgram; scope: ts.Node; authHelpers: ReadonlyArray<string> }): HandlerEvidence`

Auth evidence = a call to an `AUTH_PATTERNS` name or a declared `conventions.authHelpers` name in the handler scope or in app functions it calls, up to depth 2. External evidence = child processes (imports from `child_process`/`node:child_process`) or dynamic code (`eval`, `Function`); `fetch` alone is not external.

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/evidence.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { collectHandlerEvidence } from './evidence.js';
import { locateRouteHandler } from './handler-locator.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

const LIB = {
  'src/lib/session.ts': "export async function getSession() { return { id: 'u1' }; }\n",
  'src/lib/auth.ts': "export function resolveSession(request: Request) { return request.headers.get('cookie'); }\n",
  'src/lib/guard.ts': "import { resolveSession } from './auth';\n"
    + 'export function requireUser(request: Request) { return resolveSession(request); }\n',
  'src/lib/outer.ts': "import { requireUser } from './guard';\n"
    + 'export function withUser(request: Request) { return requireUser(request); }\n',
  'src/lib/outermost.ts': "import { withUser } from './outer';\n"
    + 'export function viaThree(request: Request) { return withUser(request); }\n',
};

async function evidenceFor(
  source: string,
  method: EndpointMethod = 'GET',
  authHelpers: string[] = [],
) {
  const route = 'src/app/api/things/route.ts';
  const app = await createAppFixture({ ...LIB, [route]: source });
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  const located = locateRouteHandler(program.sourceFile(app.path(route))!, method)!;
  return collectHandlerEvidence({ app: program, scope: located.scope, authHelpers });
}

describe('collectHandlerEvidence', () => {
  it('finds a default auth helper called in the handler', async () => {
    expect(await evidenceFor(
      "import { getSession } from '../../../lib/session';\n"
      + 'export async function GET() {\n  const session = await getSession();\n  return Response.json({ id: session.id });\n}\n',
    )).toEqual({ authEvidence: ['getSession'], externalCall: false });
  });

  it('follows app functions up to depth two for declared helpers', async () => {
    const helper = ['resolveSession'];
    expect((await evidenceFor(
      "import { requireUser } from '../../../lib/guard';\n"
      + 'export async function GET(request: Request) { requireUser(request); return Response.json([]); }\n',
      'GET', helper,
    )).authEvidence).toEqual(['resolveSession']);
    expect((await evidenceFor(
      "import { withUser } from '../../../lib/outer';\n"
      + 'export async function GET(request: Request) { withUser(request); return Response.json([]); }\n',
      'GET', helper,
    )).authEvidence).toEqual(['resolveSession']);
    expect((await evidenceFor(
      "import { viaThree } from '../../../lib/outermost';\n"
      + 'export async function GET(request: Request) { viaThree(request); return Response.json([]); }\n',
      'GET', helper,
    )).authEvidence).toEqual([]);
  });

  it('accepts a declared wrapper around the exported handler as auth evidence', async () => {
    expect((await evidenceFor(
      "import { withAuth } from '../../../lib/with-auth';\n"
      + 'export const GET = withAuth(async () => Response.json([]));\n',
      'GET', ['withAuth'],
    )).authEvidence).toEqual(['withAuth']);
  });

  it.each([
    ["import { execFile } from 'node:child_process';\nexport async function POST() { execFile('ls'); return Response.json({}); }\n", true],
    ["import * as cp from 'child_process';\nexport async function POST() { cp.spawn('ls'); return Response.json({}); }\n", true],
    ["export async function POST() { const value = eval('1'); return Response.json({ value }); }\n", true],
    ["export async function POST() { const make = new Function('return 1'); return Response.json({ v: make() }); }\n", true],
    ["export async function POST() { const match = /a/.exec('a'); const data = await fetch('https://example.com');\n"
      + '  return Response.json({ match, ok: data.ok }); }\n', false],
  ])('flags external evidence only for child processes and dynamic code (%#)', async (source, external) => {
    expect((await evidenceFor(source, 'POST')).externalCall).toBe(external);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/evidence.test.ts`
Expected: FAIL — `Failed to resolve import "./evidence.js"`.

- [ ] **Step 3: Implement `evidence.ts`**

```ts
import ts from 'typescript';
import { AUTH_PATTERNS } from '../route-scanner.js';
import { unwrapExpression } from './handler-locator.js';
import type { AppProgram } from './program.js';

export const EVIDENCE_DEPTH = 2;

const DEFAULT_AUTH_HELPERS = AUTH_PATTERNS.map(([name]) => name);
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

export interface HandlerEvidence {
  authEvidence: string[];
  externalCall: boolean;
}

function calleeName(expression: ts.Expression): string | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function importModuleOf(declaration: ts.Node): string | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : undefined;
}

function isChildProcessCall(app: AppProgram, expression: ts.Expression): boolean {
  const target = unwrapExpression(expression);
  const identifier = ts.isIdentifier(target)
    ? target
    : ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)
      ? target.expression
      : undefined;
  if (!identifier) return false;
  const declaration = app.checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration || !(
    ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)
  )) return false;
  const module = importModuleOf(declaration);
  return module !== undefined && CHILD_PROCESS_MODULES.has(module);
}

function appFunctionBody(app: AppProgram, expression: ts.Expression): ts.Node | undefined {
  const target = unwrapExpression(expression);
  const identifier = ts.isIdentifier(target)
    ? target
    : ts.isPropertyAccessExpression(target) ? target.name : undefined;
  if (!identifier) return undefined;
  let symbol = app.checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = app.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !app.appRelative(declaration.getSourceFile().fileName)) return undefined;
  if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) {
    return declaration.body;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = unwrapExpression(declaration.initializer);
    if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body) {
      return initializer.body;
    }
  }
  return undefined;
}

/** Static evidence only; the endpoint stays the authorization boundary. */
export function collectHandlerEvidence(input: {
  app: AppProgram;
  scope: ts.Node;
  authHelpers: ReadonlyArray<string>;
}): HandlerEvidence {
  const helpers = new Set([...DEFAULT_AUTH_HELPERS, ...input.authHelpers]);
  const auth = new Set<string>();
  let externalCall = false;
  const visited = new Set<ts.Node>();
  const queue: Array<{ node: ts.Node; depth: number }> = [{ node: input.scope, depth: 0 }];
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
        const name = calleeName(child.expression);
        if (name && helpers.has(name)) auth.add(name);
        const callee = unwrapExpression(child.expression);
        if (ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) {
          externalCall = true;
        }
        if (isChildProcessCall(input.app, child.expression)) externalCall = true;
        if (depth < EVIDENCE_DEPTH) {
          const body = appFunctionBody(input.app, child.expression);
          if (body) queue.push({ node: body, depth: depth + 1 });
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  return { authEvidence: [...auth].sort(), externalCall };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/evidence.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/evidence.ts src/codegen/tools/evidence.test.ts
git commit -m "feat(codegen): collect auth and external-call evidence for handlers"
```

### Task 9: Default and policy exclusions; definition identity

**Files:**
- Create: `src/codegen/tools/exclusions.ts`
- Create: `src/codegen/tools/identity.ts`
- Test: `src/codegen/tools/exclusions.test.ts`, `src/codegen/tools/identity.test.ts`

**Interfaces:**
- Consumes: `ExcludedTool`, `ToolFinding`, `toolFinding`, `compareCodeUnits`, `sha256Digest`, `TOOL_NAME_PATTERN`, `modelFacingToolName` (`src/runtime/local-tool-bindings.ts`).
- Produces:
  - `export interface ExclusionSubject { stableKey: string; method: string; path: string; chatHandler: boolean }`
  - `export interface PolicyExcludeRule { match: string; reason: string }`
  - `export function importsChatHandler(source: string): boolean`
  - `export function matchesExcludePattern(pattern: string, subject: Pick<ExclusionSubject, 'method' | 'path'>): boolean`
  - `export function findExclusion(subject: ExclusionSubject, policyExcludes: ReadonlyArray<PolicyExcludeRule>): ExcludedTool | undefined`
  - `export function deriveDefinitionId(input: { method: EndpointMethod; path: string }): string`
  - `export interface DefinitionIdRequest { stableKey: string; method: EndpointMethod; path: string; explicitId?: string }`
  - `export function assignDefinitionIds(entries: ReadonlyArray<DefinitionIdRequest>, previousByKey: ReadonlyMap<string, string>): { ids: Map<string, string>; findings: ToolFinding[] }`

- [ ] **Step 1: Write the failing tests**

`src/codegen/tools/exclusions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findExclusion, importsChatHandler, matchesExcludePattern } from './exclusions.js';

const subject = (method: string, path: string, chatHandler = false) => ({
  stableKey: `${method} ${path}`, method, path, chatHandler,
});

describe('tool exclusions', () => {
  it.each([
    ['POST', '/api/auth/login', 'auth-route'],
    ['GET', '/api/auth', 'auth-route'],
    ['POST', '/api/webhooks/stripe', 'webhook'],
    ['POST', '/api/stripe-webhook', 'webhook'],
    ['GET', '/api/cron/daily', 'cron'],
    ['GET', '/api/oauth/callback', 'callback'],
    ['GET', '/api/health', 'health'],
    ['GET', '/api/files/*slug', 'catch-all'],
    ['POST', '/api/chat', 'chat-handler'],
    ['POST', '/api/ai/chat', 'chat-handler'],
    ['POST', '/api/ai/chat-v2', 'chat-handler'],
    ['POST', '/api/stt/token', 'stt-handler'],
    ['POST', '/api/transcribe', 'stt-handler'],
    ['GET', '/api/ai/speech-token', 'stt-handler'],
    ['GET', '/api/ai/speech-stream', 'stt-handler'],
    ['POST', '/api/ai/speech-transcribe', 'stt-handler'],
  ])('excludes %s %s by default (%s)', (method, path, reason) => {
    expect(findExclusion(subject(method, path), [])).toEqual({
      stableKey: `${method} ${path}`, reason, origin: 'default',
    });
  });

  it('excludes chat handlers wherever they live and keeps ordinary routes', () => {
    expect(findExclusion(subject('POST', '/api/assistant', true), [])?.reason).toBe('chat-handler');
    expect(findExclusion(subject('GET', '/api/tasks'), [])).toBeUndefined();
    expect(findExclusion(subject('GET', '/api/authors'), [])).toBeUndefined();
    expect(findExclusion(subject('GET', '/api/meetings/:id/transcript'), [])).toBeUndefined();
    expect(findExclusion(subject('GET', '/api/teams/:id/chat-messages'), [])).toBeUndefined();
  });

  it('detects chat handler imports from the SDK, app wrappers around it and the legacy agentic packages only', () => {
    expect(importsChatHandler("import { createAiChatHandler } from 'glirastes/server/nextjs';")).toBe(true);
    expect(importsChatHandler("import { foo, createAiChatHandler } from '@chainmatics/agentic-server';")).toBe(true);
    expect(importsChatHandler("import { createGetItDoneChatHandler } from '@/lib/glirastes/chat-handler';")).toBe(true);
    expect(importsChatHandler("import type { createAiChatHandler } from 'glirastes/server/nextjs';")).toBe(false);
    expect(importsChatHandler("import { createAiChatHandler } from './local';")).toBe(false);
  });

  it('applies policy patterns with an optional method and segment globs', () => {
    const rules = [{ match: 'POST /api/internal/**', reason: 'internal' }, { match: '/api/admin/*', reason: 'admin only' }];
    expect(findExclusion(subject('POST', '/api/internal/jobs/:id'), rules))
      .toEqual({ stableKey: 'POST /api/internal/jobs/:id', reason: 'internal', origin: 'policy' });
    expect(findExclusion(subject('GET', '/api/internal/jobs'), rules)).toBeUndefined();
    expect(findExclusion(subject('DELETE', '/api/admin/users'), rules)?.reason).toBe('admin only');
    expect(findExclusion(subject('GET', '/api/admin/users/:id'), rules)).toBeUndefined();
    expect(matchesExcludePattern('* /api/**', { method: 'PUT', path: '/api/x' })).toBe(true);
    expect(matchesExcludePattern('not a pattern', { method: 'GET', path: '/api/x' })).toBe(false);
  });
});
```

`src/codegen/tools/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EndpointMethod } from '../../types.js';
import { assignDefinitionIds, deriveDefinitionId } from './identity.js';

const request = (stableKey: string, explicitId?: string) => {
  const [method, path] = stableKey.split(' ') as [EndpointMethod, string];
  return { stableKey, method, path, ...(explicitId ? { explicitId } : {}) };
};

describe('definition identity', () => {
  it.each([
    ['GET', '/api/tasks', 'tasks.list'],
    ['GET', '/api/tasks/:id', 'tasks.get'],
    ['POST', '/api/tasks/:id/comments', 'tasksComments.create'],
    ['PATCH', '/api/tasks/:id', 'tasks.update'],
    ['DELETE', '/api/tasks/:id', 'tasks.delete'],
    ['GET', '/api/tasks-by-date', 'tasksByDate.list'],
    ['POST', '/api/2fa/setup', 'api2faSetup.create'],
    ['GET', '/api', 'root.list'],
  ] as const)('derives %s %s as %s', (method, path, expected) => {
    expect(deriveDefinitionId({ method, path })).toBe(expected);
  });

  it('prefers contract ids, then previous names, then derived names', () => {
    const { ids, findings } = assignDefinitionIds([
      request('GET /api/tasks', 'tasks.search'),
      request('POST /api/tasks'),
      request('GET /api/notes'),
    ], new Map([['GET /api/tasks', 'tasks.list'], ['POST /api/tasks', 'tasks.add']]));
    expect(Object.fromEntries(ids)).toEqual({
      'GET /api/tasks': 'tasks.search',
      'POST /api/tasks': 'tasks.add',
      'GET /api/notes': 'notes.list',
    });
    expect(findings).toEqual([]);
  });

  it('disambiguates colliding derived names by method and keeps earlier names sticky', () => {
    const fresh = assignDefinitionIds([request('PATCH /api/tasks/:id'), request('PUT /api/tasks/:id')], new Map());
    expect(Object.fromEntries(fresh.ids)).toEqual({
      'PATCH /api/tasks/:id': 'tasks.updatePatch',
      'PUT /api/tasks/:id': 'tasks.updatePut',
    });
    const sticky = assignDefinitionIds(
      [request('PATCH /api/tasks/:id'), request('PUT /api/tasks/:id')],
      new Map([['PATCH /api/tasks/:id', 'tasks.update']]),
    );
    expect(Object.fromEntries(sticky.ids)).toEqual({
      'PATCH /api/tasks/:id': 'tasks.update',
      'PUT /api/tasks/:id': 'tasks.updatePut',
    });
  });

  it('reports conflicting contract ids as errors and invalid ones as warnings', () => {
    const conflict = assignDefinitionIds([
      request('GET /api/a', 'shared.list'),
      request('GET /api/b', 'shared.list'),
    ], new Map());
    expect(conflict.findings.map((finding) => [finding.code, finding.severity, finding.subjectRef]))
      .toEqual([['definition-id-conflict', 'error', 'GET /api/b']]);
    const invalid = assignDefinitionIds([request('GET /api/a', 'Not Valid')], new Map());
    expect(invalid.ids.get('GET /api/a')).toBe('a.list');
    expect(invalid.findings.map((finding) => finding.code)).toEqual(['definition-id-invalid']);
  });

  it('reports names that collide after model-safe encoding', () => {
    const { findings } = assignDefinitionIds([
      request('GET /api/tasks'),
      request('GET /api/other', 'tasks_list'),
    ], new Map());
    expect(findings.map((finding) => finding.code)).toEqual(['definition-id-conflict']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/exclusions.test.ts src/codegen/tools/identity.test.ts`
Expected: FAIL — `Failed to resolve import "./exclusions.js"` and `"./identity.js"`.

- [ ] **Step 3: Implement `exclusions.ts`**

```ts
import type { ExcludedTool } from './types.js';

export interface ExclusionSubject {
  stableKey: string;
  method: string;
  path: string;
  chatHandler: boolean;
}

export interface PolicyExcludeRule {
  match: string;
  reason: string;
}

/** `createAiChatHandler` or an app wrapper such as `createGetItDoneChatHandler` from a Glirastes/agentic module. */
const CHAT_HANDLER_IMPORT = /import\s*\{[^}]*\b\w*ChatHandler\b[^}]*\}\s*from\s*['"][^'"]*(?:glirastes|agentic)[^'"]*['"]/;

export function importsChatHandler(source: string): boolean {
  return CHAT_HANDLER_IMPORT.test(source);
}

function apiSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  return segments[0] === 'api' ? segments.slice(1) : segments;
}

const DEFAULT_RULES: ReadonlyArray<{
  reason: string;
  test(subject: ExclusionSubject, segments: ReadonlyArray<string>): boolean;
}> = [
  { reason: 'auth-route', test: (_subject, segments) => segments[0] === 'auth' },
  { reason: 'webhook', test: (_subject, segments) => segments.some((segment) => /webhook/i.test(segment)) },
  { reason: 'cron', test: (_subject, segments) => segments.some((segment) => /^crons?$/i.test(segment)) },
  { reason: 'callback', test: (_subject, segments) => segments.some((segment) => /callbacks?$/i.test(segment)) },
  {
    reason: 'health',
    test: (_subject, segments) => segments.some((segment) => /^(?:health|healthz|healthcheck|livez|readyz)$/i.test(segment)),
  },
  { reason: 'catch-all', test: (_subject, segments) => segments.some((segment) => segment.startsWith('*')) },
  // Any segment: chat and speech handlers often live under a namespace such as /api/ai/.
  {
    reason: 'chat-handler',
    test: (subject, segments) => subject.chatHandler || segments.some((segment) => /^chat(?:-v\d+)?$/i.test(segment)),
  },
  {
    reason: 'stt-handler',
    test: (_subject, segments) => segments.some((segment) => (
      /^(?:stt|speech(?:-[a-z]+)*|transcribe|transcriptions?)$/i.test(segment)
    )),
  },
];

function globMatches(pattern: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === '**') {
    for (let index = 0; index <= path.length; index += 1) {
      if (globMatches(rest, path.slice(index))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  return (head === '*' || head === path[0]) && globMatches(rest, path.slice(1));
}

/** `[METHOD|*] /path/glob` with `*` for one segment and `**` for any number of segments. */
export function matchesExcludePattern(
  pattern: string,
  subject: Pick<ExclusionSubject, 'method' | 'path'>,
): boolean {
  const match = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|\*)\s+)?(\/\S*)$/.exec(pattern.trim());
  if (!match) return false;
  const [, method, glob] = match;
  if (method && method !== '*' && method !== subject.method) return false;
  return globMatches(glob!.split('/').filter(Boolean), subject.path.split('/').filter(Boolean));
}

export function findExclusion(
  subject: ExclusionSubject,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
): ExcludedTool | undefined {
  const segments = apiSegments(subject.path);
  const rule = DEFAULT_RULES.find((candidate) => candidate.test(subject, segments));
  if (rule) return { stableKey: subject.stableKey, reason: rule.reason, origin: 'default' };
  const policy = policyExcludes.find((entry) => matchesExcludePattern(entry.match, subject));
  return policy ? { stableKey: subject.stableKey, reason: policy.reason, origin: 'policy' } : undefined;
}
```

- [ ] **Step 4: Implement `identity.ts`**

```ts
import { modelFacingToolName, TOOL_NAME_PATTERN } from '../../runtime/local-tool-bindings.js';
import type { EndpointMethod } from '../../types.js';
import { compareCodeUnits, sha256Digest } from './canonical.js';
import { toolFinding } from './findings.js';
import type { ToolFinding } from './types.js';

const OPERATIONS: Readonly<Record<EndpointMethod, string>> = {
  GET: 'list',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

function words(segment: string): string[] {
  return segment.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function camel(parts: ReadonlyArray<string>): string {
  return parts.map((part, index) => (
    index === 0
      ? part.charAt(0).toLowerCase() + part.slice(1)
      : part.charAt(0).toUpperCase() + part.slice(1)
  )).join('');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** `<resource>.list|get|create|update|delete` from method and path. */
export function deriveDefinitionId(input: { method: EndpointMethod; path: string }): string {
  const segments = input.path.split('/').filter(Boolean);
  const rest = segments[0] === 'api' ? segments.slice(1) : segments;
  const statics = rest.filter((segment) => !segment.startsWith(':') && !segment.startsWith('*'));
  let resource = camel(statics.flatMap(words)) || 'root';
  if (!/^[a-z]/.test(resource)) {
    resource = `api${resource.charAt(0).toUpperCase()}${resource.slice(1)}`;
  }
  const last = rest[rest.length - 1];
  const operation = input.method === 'GET' && last?.startsWith(':') ? 'get' : OPERATIONS[input.method];
  return `${resource}.${operation}`;
}

export interface DefinitionIdRequest {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  explicitId?: string;
}

/** Contract id → previous inventory name → derived name, collision-free and order-independent. */
export function assignDefinitionIds(
  entries: ReadonlyArray<DefinitionIdRequest>,
  previousByKey: ReadonlyMap<string, string>,
): { ids: Map<string, string>; findings: ToolFinding[] } {
  const ids = new Map<string, string>();
  const owners = new Map<string, string>();
  const findings: ToolFinding[] = [];
  const sorted = [...entries].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
  const claim = (entry: DefinitionIdRequest, id: string) => {
    ids.set(entry.stableKey, id);
    owners.set(id, entry.stableKey);
  };

  for (const entry of sorted) {
    if (entry.explicitId === undefined) continue;
    if (!TOOL_NAME_PATTERN.test(entry.explicitId)) {
      findings.push(toolFinding('definition-id-invalid', 'warning', entry.stableKey,
        `Contract id ${JSON.stringify(entry.explicitId)} is not a valid tool name; a derived name is used.`));
      continue;
    }
    const owner = owners.get(entry.explicitId);
    if (owner !== undefined) {
      findings.push(toolFinding('definition-id-conflict', 'error', entry.stableKey,
        `Contract id ${entry.explicitId} is already used by ${owner}.`));
      continue;
    }
    claim(entry, entry.explicitId);
  }

  for (const entry of sorted) {
    if (ids.has(entry.stableKey)) continue;
    const previous = previousByKey.get(entry.stableKey);
    if (previous && TOOL_NAME_PATTERN.test(previous) && !owners.has(previous)) claim(entry, previous);
  }

  const groups = new Map<string, DefinitionIdRequest[]>();
  for (const entry of sorted.filter((candidate) => !ids.has(candidate.stableKey))) {
    const base = deriveDefinitionId(entry);
    groups.set(base, [...groups.get(base) ?? [], entry]);
  }
  for (const base of [...groups.keys()].sort(compareCodeUnits)) {
    const group = groups.get(base)!;
    if (group.length === 1 && !owners.has(base)) {
      claim(group[0]!, base);
      continue;
    }
    for (const entry of group) {
      const withMethod = `${base}${capitalize(entry.method)}`;
      const suffix = sha256Digest(entry.stableKey).slice(7, 15).replace(/[^A-Za-z0-9]/g, 'x');
      claim(entry, owners.has(withMethod) ? `${withMethod}${suffix}` : withMethod);
    }
  }

  const modelOwners = new Map<string, string>();
  for (const [stableKey, id] of [...ids].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const modelName = modelFacingToolName(id);
    const owner = modelOwners.get(modelName);
    if (owner !== undefined) {
      findings.push(toolFinding('definition-id-conflict', 'error', stableKey,
        `${id} collides with the tool of ${owner} after model-safe encoding.`));
    } else {
      modelOwners.set(modelName, stableKey);
    }
  }
  return { ids, findings };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/exclusions.test.ts src/codegen/tools/identity.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/exclusions.ts src/codegen/tools/identity.ts src/codegen/tools/exclusions.test.ts src/codegen/tools/identity.test.ts
git commit -m "feat(codegen): add tool exclusions and definition identity"
```

### Task 10: Schema probe child process

**Files:**
- Create: `src/codegen/tools/schema-probe.ts`
- Create: `src/codegen/tools/probe-child.mjs`
- Create: `src/codegen/tools/probe-loader.mjs`
- Modify: `package.json` (`scripts.build`, `engines.node`), `tsconfig.cjs.json` (`exclude`)
- Test: `src/codegen/tools/schema-probe.test.ts`

**Interfaces:**
- Consumes: `createLocalSchemaDigest` (loaded inside the child from the SDK: `dist/runtime/local-tool-bindings.js`, or `src/runtime/local-tool-bindings.ts` through the loader when running from source), `ToolPresentationSchema`, P02 `DeclaredEffect`, `sha256Digest`, `sortKeysDeep`.
- Produces:
  - `export interface SchemaProbeItem { kind: 'schema' | 'contract-entry'; io: 'input' | 'output'; module: string; export: string; property: string[] }`
  - `export interface ProbedSchema { ok: true; kind: 'schema'; digest: string; jsonSchema: JsonSchemaLike | null; description: string | null }`
  - `export interface ProbedContractEntry { ok: true; kind: 'contract-entry'; input: ProbedSchema; output: ProbedSchema | null; description: string | null; effect: DeclaredEffect | null; id: string | null; module: string | null; usageHints: string[] | null; presentation: ToolPresentation | null; moduleDigest: string }`
  - `export type ProbeFailureReason = 'missing' | 'import-failed' | 'not-a-schema' | 'invalid-entry' | 'timeout' | 'probe-failed'`; `export interface ProbeFailure { ok: false; reason: ProbeFailureReason }`
  - `export type SchemaProbeResult = ProbedSchema | ProbedContractEntry | ProbeFailure`
  - `export interface SchemaProbe { probe(root: string, items: ReadonlyArray<SchemaProbeItem>): Promise<SchemaProbeResult[]> }`
  - `export const PROBE_TIMEOUT_MS = 10_000`; `export function createSchemaProbe(options?: { timeoutMs?: number; chunkSize?: number }): SchemaProbe`

`src/codegen/tools/**` uses `import.meta` and is ESM-only: it is excluded from the CommonJS build (nothing in the CJS graph imports it; the CLI already is ESM-only).

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/schema-probe.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { z as zodV3 } from 'zod-v3';
import { createLocalSchemaDigest } from '../../runtime/local-tool-bindings.js';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { createSchemaProbe, type SchemaProbeItem } from './schema-probe.js';

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeAppFixtures();
});

const schemaItem = (module: string, exportName = 'schema', io: 'input' | 'output' = 'input'): SchemaProbeItem => ({
  kind: 'schema', io, module, export: exportName, property: [],
});

describe('schema probe', () => {
  it('probes TypeScript schemas through a tsconfig alias and .js-suffixed imports', async () => {
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/lib/fields.ts': "import { z } from 'zod';\nexport const title = z.string().min(1).describe('Note title');\n",
      'src/lib/notes.ts': "import { z } from 'zod';\nimport { title } from '@/lib/fields';\n"
        + "export const createNote = z.object({ title }).strict().describe('Create a note');\n",
      'src/app/api/notes/schemas.ts': "export { createNote } from '../../../lib/notes.js';\n",
    });
    const [result] = await createSchemaProbe().probe(app.root, [schemaItem('src/app/api/notes/schemas.ts', 'createNote')]);
    const expected = z.object({ title: z.string().min(1).describe('Note title') }).strict().describe('Create a note');
    expect(result).toMatchObject({
      ok: true, kind: 'schema', digest: createLocalSchemaDigest(expected), description: 'Create a note',
    });
    const json = result?.ok && result.kind === 'schema' ? result.jsonSchema : null;
    expect(json).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: { title: { type: 'string', minLength: 1 } },
    });
    expect(json).not.toHaveProperty('$schema');
  }, 30_000);

  it('reads contract entries and reports a missing method entry', async () => {
    const app = await createAppFixture({
      'src/app/api/notes/contract.ts': "import { z } from 'zod';\nexport const contract = {\n"
        + "  POST: { input: z.object({ title: z.string() }), output: z.object({ id: z.string() }),\n"
        + "    description: 'Create a note', effect: 'write', id: 'notes.add', usageHints: ['Use to add a note'] },\n};\n",
    });
    const entry = (method: string): SchemaProbeItem => ({
      kind: 'contract-entry', io: 'input', module: 'src/app/api/notes/contract.ts', export: 'contract', property: [method],
    });
    const [post, get] = await createSchemaProbe().probe(app.root, [entry('POST'), entry('GET')]);
    expect(post).toMatchObject({
      ok: true, kind: 'contract-entry', description: 'Create a note', effect: 'write', id: 'notes.add',
      usageHints: ['Use to add a note'], input: { ok: true, kind: 'schema' }, output: { ok: true, kind: 'schema' },
    });
    expect(post?.ok && post.kind === 'contract-entry' ? post.moduleDigest : '').toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(get).toEqual({ ok: false, reason: 'missing' });
  }, 30_000);

  it('fails closed per module and never hands app secrets to the child', async () => {
    vi.stubEnv('GLIRASTES_PROBE_SECRET', 'super-secret');
    const app = await createAppFixture({
      'src/value.ts': 'export const value = 42;\n',
      'src/broken.ts': "throw new Error('database unavailable');\nexport const schema = 1;\n",
      'src/secret-aware.ts': "import { z } from 'zod';\n"
        + "if (process.env.GLIRASTES_PROBE_SECRET !== undefined) throw new Error('secret leaked');\n"
        + 'export const schema = z.object({ q: z.string() });\n',
      'src/app/api/items/contract.js': "import { z } from 'zod';\nexport const inputSchema = z.object({ status: z.string().optional() });\n",
    });
    const results = await createSchemaProbe().probe(app.root, [
      schemaItem('src/value.ts', 'value'),
      schemaItem('src/broken.ts'),
      schemaItem('src/secret-aware.ts'),
      schemaItem('src/app/api/items/contract.js', 'inputSchema'),
    ]);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason)))
      .toEqual(['not-a-schema', 'import-failed', 'ok', 'ok']);
  }, 30_000);

  it('times out a hanging module without losing the other modules of its batch', async () => {
    const app = await createAppFixture({
      'src/hangs.ts': 'setInterval(() => {}, 1_000);\nawait new Promise(() => {});\nexport const schema = 1;\n',
      'src/fine.ts': "import { z } from 'zod';\nexport const schema = z.object({ q: z.string() });\n",
    });
    const results = await createSchemaProbe({ timeoutMs: 1_500 }).probe(app.root, [
      schemaItem('src/hangs.ts'),
      schemaItem('src/fine.ts'),
    ]);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual(['timeout', 'ok']);
  }, 30_000);

  it('digests zod v3 schemas and leaves JSON Schema empty without zod-to-json-schema', async () => {
    const app = await createAppFixture({
      'src/legacy.ts': "import { z } from 'zod-v3';\nexport const schema = z.object({ q: z.string() });\n",
    });
    const [result] = await createSchemaProbe().probe(app.root, [schemaItem('src/legacy.ts')]);
    expect(result).toEqual({
      ok: true,
      kind: 'schema',
      digest: createLocalSchemaDigest(zodV3.object({ q: zodV3.string() })),
      jsonSchema: null,
      description: null,
    });
  }, 30_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/schema-probe.test.ts`
Expected: FAIL — `Failed to resolve import "./schema-probe.js"`.

- [ ] **Step 3: Create the loader `probe-loader.mjs`**

```js
// ESM loader hooks for the glirastes tools schema probe child only. Transpiles
// app TypeScript/JSX with the SDK's TypeScript, maps `.js` imports to `.ts`
// sources and resolves tsconfig path aliases. Never used by the app runtime.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts'];
let ts;
let appRoot;
let sdkSourceRoot;
let compilerOptions;

function readCompilerOptions(root) {
  const fallback = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
  };
  const configPath = join(root, 'tsconfig.json');
  if (!existsSync(configPath)) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return fallback;
  return { ...ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath).options, allowJs: true };
}

export async function initialize(data) {
  ts = (await import(data.typescriptUrl)).default;
  appRoot = data.appRoot;
  sdkSourceRoot = data.sdkSourceRoot ?? undefined;
  compilerOptions = readCompilerOptions(appRoot);
}

function inside(base, path) {
  if (!base) return false;
  const local = relative(base, path);
  return Boolean(local) && !local.startsWith('..') && !isAbsolute(local) && !local.split(sep).includes('node_modules');
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveRelative(specifier, parentPath) {
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) return undefined;
  const base = isAbsolute(specifier) ? specifier : join(dirname(parentPath), specifier);
  const stem = base.replace(/\.(?:js|jsx|mjs)$/, '');
  return [
    base,
    ...SCRIPT_EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...SCRIPT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ].find(isFile);
}

function resolveWithCompiler(specifier, parentPath) {
  const resolved = ts.resolveModuleName(specifier, parentPath, compilerOptions, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (!resolved || resolved.endsWith('.d.ts') || !inside(appRoot, resolved)) return undefined;
  return resolved;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const parentPath = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined;
    if (!parentPath || !(inside(appRoot, parentPath) || inside(sdkSourceRoot, parentPath))) throw error;
    const resolved = resolveRelative(specifier, parentPath) ?? resolveWithCompiler(specifier, parentPath);
    if (!resolved) throw error;
    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const path = fileURLToPath(url);
  const extension = extname(path);
  const typescriptSource = TYPESCRIPT_EXTENSIONS.includes(extension) && !path.endsWith('.d.ts');
  const appScript = inside(appRoot, path) && SCRIPT_EXTENSIONS.includes(extension);
  const sdkSource = inside(sdkSourceRoot, path) && typescriptSource;
  if (!appScript && !sdkSource) return nextLoad(url, context);
  const source = readFileSync(path, 'utf8');
  if (!typescriptSource && extension !== '.jsx' && !/^\s*(?:import|export)\b/m.test(source)) {
    return nextLoad(url, context);
  }
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      allowJs: true,
      isolatedModules: true,
      sourceMap: false,
    },
  });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
```

- [ ] **Step 4: Create the child `probe-child.mjs`**

```js
// Probe child for glirastes tools: imports app schema modules with a scrubbed
// environment and reports digests and JSON Schemas on stdout. Never used by
// the app runtime and never contacts the network on its own.
import { createRequire, register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_TEXT = 1_000;

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isSchema(value) {
  return value !== null && typeof value === 'object' && typeof value.safeParse === 'function';
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : null;
}

function jsonObject(value) {
  try {
    const copy = JSON.parse(JSON.stringify(value));
    return copy !== null && typeof copy === 'object' && !Array.isArray(copy) ? copy : null;
  } catch {
    return null;
  }
}

async function main() {
  const request = await readRequest();
  register(new URL('./probe-loader.mjs', import.meta.url), {
    data: {
      typescriptUrl: request.typescriptUrl,
      appRoot: request.appRoot,
      sdkSourceRoot: request.sdkSourceRoot,
    },
  });
  const { createLocalSchemaDigest } = await import(request.digestModuleUrl);
  const appRequire = createRequire(join(request.appRoot, 'package.json'));
  const loadOptional = async (specifier) => {
    try {
      return await import(pathToFileURL(appRequire.resolve(specifier)).href);
    } catch {
      return undefined;
    }
  };

  const toJson = async (schema, io) => {
    try {
      if (schema._zod) {
        if (typeof schema.toJSONSchema === 'function') {
          return jsonObject(schema.toJSONSchema({ io, unrepresentable: 'any' }));
        }
        const zod = (await loadOptional('zod/v4')) ?? (await loadOptional('zod'));
        const convert = zod?.toJSONSchema ?? zod?.z?.toJSONSchema;
        return typeof convert === 'function' ? jsonObject(convert(schema, { io, unrepresentable: 'any' })) : null;
      }
      if (schema._def) {
        const converter = await loadOptional('zod-to-json-schema');
        const convert = converter?.zodToJsonSchema ?? converter?.default;
        return typeof convert === 'function'
          ? jsonObject(convert(schema, { $refStrategy: 'none', target: 'jsonSchema7' }))
          : null;
      }
    } catch {
      return null;
    }
    return null;
  };

  const describeSchema = async (value, io) => {
    if (!isSchema(value)) return { ok: false, reason: 'not-a-schema' };
    return {
      ok: true,
      kind: 'schema',
      digest: createLocalSchemaDigest(value),
      jsonSchema: await toJson(value, io),
      description: text(value.description) ?? text(value._def?.description),
    };
  };

  const describeEntry = async (entry) => {
    if (entry === null || typeof entry !== 'object') return { ok: false, reason: 'invalid-entry' };
    const input = await describeSchema(entry.input, 'input');
    if (!input.ok) return { ok: false, reason: 'invalid-entry' };
    const output = entry.output === undefined ? null : await describeSchema(entry.output, 'output');
    if (output && !output.ok) return { ok: false, reason: 'invalid-entry' };
    return {
      ok: true,
      kind: 'contract-entry',
      input,
      output,
      description: text(entry.description),
      effect: typeof entry.effect === 'string' ? entry.effect : null,
      id: typeof entry.id === 'string' ? entry.id : null,
      module: typeof entry.module === 'string' ? entry.module : null,
      usageHints: Array.isArray(entry.usageHints)
        ? entry.usageHints.filter((hint) => typeof hint === 'string').slice(0, 20)
        : null,
      presentation: entry.presentation !== null && typeof entry.presentation === 'object'
        ? jsonObject(entry.presentation)
        : null,
    };
  };

  const results = [];
  for (const item of request.items) {
    try {
      const module = await import(pathToFileURL(join(request.appRoot, item.module)).href);
      let value = module[item.export];
      for (const key of item.property) value = value === null || value === undefined ? undefined : value[key];
      if (value === undefined || value === null) {
        results.push({ ok: false, reason: 'missing' });
      } else {
        results.push(item.kind === 'contract-entry'
          ? await describeEntry(value)
          : await describeSchema(value, item.io));
      }
    } catch {
      results.push({ ok: false, reason: 'import-failed' });
    }
  }
  return results;
}

main().then(
  (results) => { process.stdout.write(JSON.stringify({ results }), () => process.exit(0)); },
  () => { process.stdout.write(JSON.stringify({ results: null }), () => process.exit(1)); },
);
```

- [ ] **Step 5: Implement `schema-probe.ts`**

```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ToolPresentationSchema, type ToolPresentation } from '../../contracts/index.js';
import type { DeclaredEffect } from '../../contracts/tool-policy.js';
import { sha256Digest, sortKeysDeep } from './canonical.js';
import type { JsonSchemaLike } from './types.js';

export interface SchemaProbeItem {
  kind: 'schema' | 'contract-entry';
  io: 'input' | 'output';
  module: string;
  export: string;
  property: string[];
}

export interface ProbedSchema {
  ok: true;
  kind: 'schema';
  digest: string;
  jsonSchema: JsonSchemaLike | null;
  description: string | null;
}

export interface ProbedContractEntry {
  ok: true;
  kind: 'contract-entry';
  input: ProbedSchema;
  output: ProbedSchema | null;
  description: string | null;
  effect: DeclaredEffect | null;
  id: string | null;
  module: string | null;
  usageHints: string[] | null;
  presentation: ToolPresentation | null;
  moduleDigest: string;
}

export type ProbeFailureReason =
  | 'missing' | 'import-failed' | 'not-a-schema' | 'invalid-entry' | 'timeout' | 'probe-failed';

export interface ProbeFailure {
  ok: false;
  reason: ProbeFailureReason;
}

export type SchemaProbeResult = ProbedSchema | ProbedContractEntry | ProbeFailure;

export interface SchemaProbe {
  probe(root: string, items: ReadonlyArray<SchemaProbeItem>): Promise<SchemaProbeResult[]>;
}

export const PROBE_TIMEOUT_MS = 10_000;
const CHUNK_SIZE = 25;
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const ENVIRONMENT_KEYS = ['PATH', 'NODE_ENV', 'TZ'] as const;
const DECLARED_EFFECTS: ReadonlyArray<string> = ['read', 'write', 'destructive', 'external', 'financial'];

const WireSchema = z.object({
  ok: z.literal(true),
  kind: z.literal('schema'),
  digest: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  jsonSchema: z.record(z.string(), z.unknown()).nullable(),
  description: z.string().nullable(),
});
const WireEntry = z.object({
  ok: z.literal(true),
  kind: z.literal('contract-entry'),
  input: WireSchema,
  output: WireSchema.nullable(),
  description: z.string().nullable(),
  effect: z.string().nullable(),
  id: z.string().nullable(),
  module: z.string().nullable(),
  usageHints: z.array(z.string()).nullable(),
  presentation: z.record(z.string(), z.unknown()).nullable(),
});
const WireFailure = z.object({
  ok: z.literal(false),
  reason: z.enum(['missing', 'import-failed', 'not-a-schema', 'invalid-entry']),
});
const WireOutput = z.object({ results: z.array(z.union([WireEntry, WireSchema, WireFailure])) });

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function sdkLocations(): { digestModuleUrl: string; sdkSourceRoot: string | null; typescriptUrl: string } {
  const compiled = new URL('../../runtime/local-tool-bindings.js', import.meta.url);
  const fromSource = !existsSync(fileURLToPath(compiled));
  return {
    digestModuleUrl: fromSource
      ? new URL('../../runtime/local-tool-bindings.ts', import.meta.url).href
      : compiled.href,
    sdkSourceRoot: fromSource ? fileURLToPath(new URL('../../', import.meta.url)) : null,
    typescriptUrl: pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href,
  };
}

function normalizeJson(value: Record<string, unknown> | null): JsonSchemaLike | null {
  if (!value) return null;
  const { $schema: _metaSchema, ...rest } = value;
  return sortKeysDeep(rest) as JsonSchemaLike;
}

function toSchema(wire: z.infer<typeof WireSchema>): ProbedSchema {
  const description = wire.description?.trim();
  return {
    ok: true,
    kind: 'schema',
    digest: wire.digest,
    jsonSchema: normalizeJson(wire.jsonSchema),
    description: description ? description.slice(0, 1_000) : null,
  };
}

function toEntry(wire: z.infer<typeof WireEntry>): ProbedContractEntry {
  const input = toSchema(wire.input);
  const output = wire.output ? toSchema(wire.output) : null;
  const presentation = wire.presentation ? ToolPresentationSchema.safeParse(wire.presentation) : undefined;
  const metadata = {
    description: wire.description?.trim() ? wire.description.trim().slice(0, 1_000) : null,
    effect: wire.effect && DECLARED_EFFECTS.includes(wire.effect) ? wire.effect as DeclaredEffect : null,
    id: wire.id?.trim() || null,
    module: wire.module?.trim() || null,
    usageHints: wire.usageHints
      ? wire.usageHints.map((hint) => hint.trim()).filter(Boolean).slice(0, 20)
      : null,
    presentation: presentation?.success ? presentation.data : null,
  };
  return {
    ok: true,
    kind: 'contract-entry',
    input,
    output,
    ...metadata,
    moduleDigest: sha256Digest(JSON.stringify(sortKeysDeep({
      input: input.digest,
      output: output?.digest ?? null,
      ...metadata,
    }))),
  };
}

function runChunk(
  root: string,
  items: ReadonlyArray<SchemaProbeItem>,
  timeoutMs: number,
): Promise<SchemaProbeResult[]> {
  return new Promise((resolveResults) => {
    let settled = false;
    let output = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (results: SchemaProbeResult[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResults(results);
    };
    const failAll = (reason: ProbeFailureReason) => finish(items.map(() => ({ ok: false, reason })));
    const child = spawn(process.execPath, [fileURLToPath(new URL('./probe-child.mjs', import.meta.url))], {
      cwd: root,
      env: scrubbedEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      failAll('timeout');
    }, timeoutMs);
    child.on('error', () => failAll('probe-failed'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        child.kill('SIGKILL');
        failAll('probe-failed');
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        failAll('probe-failed');
        return;
      }
      const parsed = WireOutput.safeParse((() => {
        try {
          return JSON.parse(output) as unknown;
        } catch {
          return undefined;
        }
      })());
      if (!parsed.success || parsed.data.results.length !== items.length) {
        failAll('probe-failed');
        return;
      }
      finish(parsed.data.results.map((result): SchemaProbeResult => {
        if (!result.ok) return { ok: false, reason: result.reason };
        return result.kind === 'contract-entry' ? toEntry(result) : toSchema(result);
      }));
    });
    child.stdin.on('error', () => failAll('probe-failed'));
    child.stdin.end(JSON.stringify({ appRoot: root, items, ...sdkLocations() }));
  });
}

/**
 * Imports exported schema modules in a child process: environment reduced to
 * PATH/NODE_ENV/TZ, no shell, bounded time and output. A chunk that fails as
 * a whole is retried module by module so one hanging module only costs itself.
 */
export function createSchemaProbe(options: { timeoutMs?: number; chunkSize?: number } = {}): SchemaProbe {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const chunkSize = Math.max(1, options.chunkSize ?? CHUNK_SIZE);
  return {
    async probe(root, items) {
      const results: SchemaProbeResult[] = [];
      for (let index = 0; index < items.length; index += chunkSize) {
        const chunk = items.slice(index, index + chunkSize);
        const chunkResults = await runChunk(root, chunk, timeoutMs);
        const wholeChunkFailed = chunk.length > 1 && chunkResults.every((result) => (
          !result.ok && (result.reason === 'timeout' || result.reason === 'probe-failed')
        ));
        if (!wholeChunkFailed) {
          results.push(...chunkResults);
          continue;
        }
        for (const item of chunk) results.push(...await runChunk(root, [item], timeoutMs));
      }
      return results;
    },
  };
}
```

- [ ] **Step 6: Ship the probe files and keep them out of the CommonJS build**

In `package.json`, append to the end of `scripts.build` (after `node scripts/generate-subpath-shims.mjs`):

```json
" && cp src/codegen/tools/probe-child.mjs src/codegen/tools/probe-loader.mjs dist/codegen/tools/"
```

so the script ends with `… && node scripts/generate-subpath-shims.mjs && cp src/codegen/tools/probe-child.mjs src/codegen/tools/probe-loader.mjs dist/codegen/tools/`.

In `tsconfig.cjs.json`, add to `exclude`:

```json
"src/codegen/tools/**"
```

In `package.json`, raise the engine floor to the first Node 20 release with `module.register` (used by the probe loader):

```json
"engines": {
  "node": ">=20.6"
},
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/schema-probe.test.ts && bun run typecheck && bun run build && ls dist/codegen/tools/probe-child.mjs dist/codegen/tools/probe-loader.mjs`
Expected: PASS; typecheck clean; build succeeds (no `TS1343` from the CJS pass) and both `.mjs` files are listed.

- [ ] **Step 8: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/schema-probe.ts src/codegen/tools/probe-child.mjs src/codegen/tools/probe-loader.mjs src/codegen/tools/schema-probe.test.ts package.json tsconfig.cjs.json
git commit -m "feat(codegen): probe app schema modules in a scrubbed child process"
```

### Task 11: Output schema inference

**Files:**
- Create: `src/codegen/tools/output-inference.ts`
- Test: `src/codegen/tools/output-inference.test.ts`

**Interfaces:**
- Consumes: `typescript`, `canonicalJson`, `compareCodeUnits`, `analyzeRouteHandler` (for test inputs).
- Produces:
  - `export const MAX_OUTPUT_DEPTH = 6`
  - `export function typeToJsonSchema(checker: ts.TypeChecker, type: ts.Type, location: ts.Node, depth?: number, seen?: ReadonlySet<ts.Type>): JsonSchemaLike`
  - `export function inferResponseSchema(checker: ts.TypeChecker, expressions: ReadonlyArray<ts.Expression>): JsonSchemaLike | undefined` (undefined = opaque)

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/output-inference.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { analyzeRouteHandler } from './handler-analysis.js';
import { inferResponseSchema } from './output-inference.js';
import { createAppProgram } from './program.js';

afterEach(removeAppFixtures);

async function inferred(source: string) {
  const route = 'src/app/api/things/route.ts';
  const app = await createAppFixture({ [route]: source });
  const program = createAppProgram({ root: app.root, rootNames: [app.path(route)] });
  const analysis = analyzeRouteHandler({
    app: program,
    sourceFile: program.sourceFile(app.path(route))!,
    method: 'GET',
    conventions: { handlerWrappers: [], bodyReaders: [], authHelpers: [] },
  });
  return inferResponseSchema(program.checker, analysis.responseArguments);
}

describe('inferResponseSchema', () => {
  it('describes typed rows and skips error responses', async () => {
    expect(await inferred(
      "type Row = { id: string; status: 'open' | 'done'; due?: Date; score: number | null; tags: string[] };\n"
      + 'declare function loadRows(): Promise<Row[]>;\n'
      + 'export async function GET() {\n  const rows = await loadRows();\n'
      + "  if (rows.length > 99) return Response.json({ error: 'too many' }, { status: 413 });\n"
      + '  return Response.json({ items: rows, total: rows.length });\n}\n',
    )).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              due: { type: 'string', format: 'date-time' },
              id: { type: 'string' },
              score: { anyOf: [{ type: 'null' }, { type: 'number' }] },
              status: { type: 'string', enum: ['done', 'open'] },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'score', 'status', 'tags'],
          },
        },
        total: { type: 'number' },
      },
      required: ['items', 'total'],
    });
  });

  it('combines distinct success shapes with anyOf', async () => {
    expect(await inferred(
      'export async function GET(request: Request) {\n'
      + "  if (request.headers.get('x')) return Response.json({ a: 1 });\n"
      + "  return Response.json({ b: 'x' });\n}\n",
    )).toEqual({
      anyOf: [
        { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    });
  });

  it('stops at depth six', async () => {
    const schema = await inferred(
      'type Deep = { a: { b: { c: { d: { e: { f: { g: { h: string } } } } } } } };\n'
      + 'declare const deep: Deep;\nexport async function GET() { return Response.json(deep); }\n',
    ) as Record<string, any>;
    expect(schema.properties.a.properties.b.properties.c.properties.d.properties.e.properties.f.properties.g)
      .toEqual({});
  });

  it('is opaque for any-typed or missing JSON responses', async () => {
    expect(await inferred(
      "export async function GET() { const data: any = await fetch('https://example.com').then((r) => r.json());\n"
      + '  return Response.json(data); }\n',
    )).toBeUndefined();
    expect(await inferred("export async function GET() { return new Response('ok'); }\n")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/output-inference.test.ts`
Expected: FAIL — `Failed to resolve import "./output-inference.js"`.

- [ ] **Step 3: Implement `output-inference.ts`**

```ts
import ts from 'typescript';
import { canonicalJson, compareCodeUnits } from './canonical.js';
import type { JsonSchemaLike } from './types.js';

export const MAX_OUTPUT_DEPTH = 6;
const MAX_PROPERTIES = 200;

function isOpaque(schema: JsonSchemaLike): boolean {
  return Object.keys(schema).length === 0;
}

function dedupe(schemas: ReadonlyArray<JsonSchemaLike>): JsonSchemaLike[] {
  const byText = new Map<string, JsonSchemaLike>();
  for (const schema of schemas) byText.set(canonicalJson(schema), schema);
  return [...byText.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, schema]) => schema);
}

/** Bounded checker-type → JSON Schema; anything not provable becomes `{}`. */
export function typeToJsonSchema(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
  depth = 0,
  seen: ReadonlySet<ts.Type> = new Set(),
): JsonSchemaLike {
  if (depth > MAX_OUTPUT_DEPTH) return {};
  const flags = type.flags;
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return {};
  if (flags & ts.TypeFlags.StringLiteral) return { type: 'string', enum: [(type as ts.StringLiteralType).value] };
  if (flags & ts.TypeFlags.NumberLiteral) return { type: 'number', enum: [(type as ts.NumberLiteralType).value] };
  if (flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean' };
  if (flags & ts.TypeFlags.StringLike) return { type: 'string' };
  if (flags & ts.TypeFlags.NumberLike) return { type: 'number' };
  if (flags & ts.TypeFlags.BooleanLike) return { type: 'boolean' };
  if (flags & ts.TypeFlags.Null) return { type: 'null' };
  if (type.isUnion()) {
    const members = type.types.filter((member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
    if (members.length > 0 && members.every((member) => member.flags & ts.TypeFlags.StringLiteral)) {
      return {
        type: 'string',
        enum: members.map((member) => (member as ts.StringLiteralType).value).sort(compareCodeUnits),
      };
    }
    if (members.length > 0 && members.every((member) => member.flags & ts.TypeFlags.BooleanLiteral)) {
      return { type: 'boolean' };
    }
    const parts = dedupe(members.map((member) => typeToJsonSchema(checker, member, location, depth + 1, seen)));
    if (parts.length === 0 || parts.some(isOpaque)) return {};
    return parts.length === 1 ? parts[0]! : { anyOf: parts };
  }
  if (seen.has(type)) return {};
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    return { type: 'array', items: element ? typeToJsonSchema(checker, element, location, depth + 1, seen) : {} };
  }
  if (checker.isTupleType(type)) return { type: 'array' };
  if (type.symbol?.name === 'Date') return { type: 'string', format: 'date-time' };
  if (flags & ts.TypeFlags.Object) {
    if (type.getCallSignatures().length > 0) return {};
    if (checker.getIndexInfosOfType(type).length > 0) return { type: 'object' };
    const properties = checker.getPropertiesOfType(type)
      .filter((property) => !(property.flags & ts.SymbolFlags.Method));
    if (properties.length > MAX_PROPERTIES) return { type: 'object' };
    const next = new Set(seen).add(type);
    const entries = properties
      .map((property) => [
        property.name,
        typeToJsonSchema(checker, checker.getTypeOfSymbolAtLocation(property, location), location, depth + 1, next),
      ] as const)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    const required = properties
      .filter((property) => !(property.flags & ts.SymbolFlags.Optional))
      .map((property) => property.name)
      .sort(compareCodeUnits);
    return {
      type: 'object',
      properties: Object.fromEntries(entries),
      ...(required.length ? { required } : {}),
    };
  }
  return {};
}

export function inferResponseSchema(
  checker: ts.TypeChecker,
  expressions: ReadonlyArray<ts.Expression>,
): JsonSchemaLike | undefined {
  if (expressions.length === 0) return undefined;
  const schemas = dedupe(expressions.map((expression) => (
    typeToJsonSchema(checker, checker.getTypeAtLocation(expression), expression)
  )));
  if (schemas.some(isOpaque)) return undefined;
  return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/output-inference.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/output-inference.ts src/codegen/tools/output-inference.test.ts
git commit -m "feat(codegen): infer endpoint output schemas with the type checker"
```

### Task 12: Tool resolutions reader and basic validation

**Files:**
- Create: `src/codegen/tools/resolutions.ts`
- Test: `src/codegen/tools/resolutions.test.ts`

**Interfaces:**
- Consumes: `Ajv`, `ajv-formats`, `findSensitiveStringPath`, `TOOLS_PATHS`, `toolFinding`, `HandlerConventions` (Task 7).
- Produces:
  - `export const MAX_RESOLUTION_SCHEMA_BYTES = 32 * 1024`
  - `export const HandlerWrapperConventionSchema`, `ToolConventionsSchema`, `SchemaRefSchema`, `ResolutionEntrySchema`
  - `export type ToolConventions`; `export type ResolutionEntry`
  - `export interface ToolResolutions { conventions: ToolConventions; entries: ReadonlyMap<string, unknown> }`
  - `export const EMPTY_CONVENTIONS: ToolConventions`
  - `export function toHandlerConventions(conventions: ToolConventions): HandlerConventions`
  - `export function loadToolResolutions(root: string): { resolutions: ToolResolutions; findings: ToolFinding[] }`
  - `export interface ResolutionEvidence { pathParams: ReadonlyArray<string>; queryKeys: ReadonlyArray<string>; bodyKeys: ReadonlyArray<string> | 'opaque' }`
  - `export function validateResolutionEntry(input: { stableKey: string; raw: unknown; evidence: ResolutionEvidence }): { entry?: ResolutionEntry; findings: ToolFinding[] }`
  - `export function resolutionOrigin(resolutions: ToolResolutions, stableKey: string): 'human' | 'agent' | undefined`

P03 reads `tool-resolutions.json` and applies the basic gate (strict schema, Ajv strict, object with `additionalProperties:false`, ≤ 32 KB, no unbacked input keys, no secret-looking content). The full validation of agent-written entries (evidence locations, examples, locked fields) is P05.

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/resolutions.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_CONVENTIONS,
  loadToolResolutions,
  resolutionOrigin,
  validateResolutionEntry,
} from './resolutions.js';

const roots: string[] = [];
const DIGEST = `sha256:${'R'.repeat(43)}`;
const evidence = { pathParams: ['id'], queryKeys: ['q'], bodyKeys: ['title'] as ReadonlyArray<string> | 'opaque' };

async function appWith(content?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-resolutions-'));
  roots.push(root);
  if (content !== undefined) {
    await mkdir(join(root, '.glirastes'), { recursive: true });
    await writeFile(join(root, '.glirastes/tool-resolutions.json'), content);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const objectSchema = (properties: Record<string, unknown>) => ({
  type: 'object', properties, additionalProperties: false,
});

describe('tool resolutions', () => {
  it('is empty without a file', async () => {
    const { resolutions, findings } = loadToolResolutions(await appWith());
    expect(resolutions.conventions).toEqual(EMPTY_CONVENTIONS);
    expect(resolutions.entries.size).toBe(0);
    expect(findings).toEqual([]);
  });

  it('reads conventions and keeps raw per-tool entries', async () => {
    const { resolutions, findings } = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1,
      conventions: {
        handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
        authHelpers: ['resolveSession'],
      },
      tools: { 'GET /api/tasks': { interfaceDigest: DIGEST } },
    })));
    expect(findings).toEqual([]);
    expect(resolutions.conventions).toEqual({
      handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
      bodyReaders: [],
      authHelpers: ['resolveSession'],
      filterValues: {},
    });
    expect([...resolutions.entries.keys()]).toEqual(['GET /api/tasks']);
  });

  it('ignores malformed files and invalid conventions with a visible warning', async () => {
    const malformed = loadToolResolutions(await appWith('{'));
    expect(malformed.findings.map((finding) => [finding.code, finding.severity])).toEqual([['resolution-rejected', 'warning']]);
    const badConventions = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1,
      conventions: { handlerWrappers: [{ module: '../outside.js', export: 'query' }] },
      tools: { 'GET /api/tasks': {} },
    })));
    expect(badConventions.resolutions.conventions).toEqual(EMPTY_CONVENTIONS);
    expect(badConventions.resolutions.entries.size).toBe(1);
    expect(badConventions.findings.map((finding) => finding.subjectRef)).toEqual(['conventions']);
  });

  it('accepts backed JSON Schema entries and strips the meta-schema', () => {
    const result = validateResolutionEntry({
      stableKey: 'PATCH /api/tasks/:id',
      raw: {
        interfaceDigest: DIGEST,
        origin: 'agent',
        input: { jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...objectSchema({ id: { type: 'string' }, title: { type: 'string' } }) } },
      },
      evidence,
    });
    expect(result.findings).toEqual([]);
    expect(result.entry?.input?.jsonSchema).toEqual(objectSchema({ id: { type: 'string' }, title: { type: 'string' } }));
    expect(result.entry?.origin).toBe('agent');
  });

  it.each([
    ['unbacked keys', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: {}, secretFlag: {} }) } }],
    ['a non-object input', { interfaceDigest: DIGEST, input: { jsonSchema: { type: 'string' } } }],
    ['open additional properties', { interfaceDigest: DIGEST, input: { jsonSchema: { type: 'object', properties: { title: {} } } } }],
    ['an oversized schema', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: { description: 'x'.repeat(33_000) } }) } }],
    ['an unknown keyword', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: { type: 'string', looksLike: 'x' } }) } }],
    ['secret-looking content', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ title: { description: `sk-or-v1-${'a'.repeat(32)}` } }) } }],
    ['a missing interface digest', { input: { jsonSchema: objectSchema({ title: {} }) } }],
    ['both schema forms', { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({}), schemaRef: { module: 'src/a.ts', export: 'a' } } }],
  ])('rejects %s', (_label, raw) => {
    const result = validateResolutionEntry({ stableKey: 'PATCH /api/tasks/:id', raw, evidence });
    expect(result.entry).toBeUndefined();
    expect(result.findings.map((finding) => finding.code)).toEqual(['resolution-rejected']);
  });

  it('allows any body keys when the body is opaque and accepts schema references', async () => {
    expect(validateResolutionEntry({
      stableKey: 'POST /api/tasks',
      raw: { interfaceDigest: DIGEST, input: { jsonSchema: objectSchema({ anything: {} }) } },
      evidence: { pathParams: [], queryKeys: [], bodyKeys: 'opaque' },
    }).entry).toBeDefined();
    const ref = validateResolutionEntry({
      stableKey: 'POST /api/tasks',
      raw: { interfaceDigest: DIGEST, input: { schemaRef: { module: 'src/lib/schemas.ts', export: 'createTask' } } },
      evidence,
    });
    expect(ref.entry?.input?.schemaRef).toEqual({ module: 'src/lib/schemas.ts', export: 'createTask', property: [] });
    const { resolutions } = loadToolResolutions(await appWith(JSON.stringify({
      schemaVersion: 1, tools: { 'POST /api/tasks': { interfaceDigest: DIGEST, origin: 'agent' } },
    })));
    expect(resolutionOrigin(resolutions, 'POST /api/tasks')).toBe('agent');
    expect(resolutionOrigin(resolutions, 'GET /api/none')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/resolutions.test.ts`
Expected: FAIL — `Failed to resolve import "./resolutions.js"`.

- [ ] **Step 3: Implement `resolutions.ts`**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { HandlerConventions } from './handler-analysis.js';
import type { ToolFinding } from './types.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

export const MAX_RESOLUTION_SCHEMA_BYTES = 32 * 1024;

const appModule = z.string().trim().min(1).max(512)
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), 'Path must stay inside the app');
const exportName = z.string().trim().min(1).max(200);
const argumentIndex = z.number().int().min(0).max(15);

export const HandlerWrapperConventionSchema = z.object({
  module: appModule,
  export: exportName,
  inputArg: argumentIndex.optional(),
  queryArg: argumentIndex.optional(),
  outputArg: argumentIndex.optional(),
}).strict();

export const ToolConventionsSchema = z.object({
  handlerWrappers: z.array(HandlerWrapperConventionSchema).max(50).default([]),
  bodyReaders: z.array(z.object({ module: appModule, export: exportName }).strict()).max(50).default([]),
  authHelpers: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).max(100).default([]),
  /** Accepted now; used by the filter sources in P04. */
  filterValues: z.record(z.string(), z.array(z.string().max(200)).max(200)).default({}),
}).strict();

export const SchemaRefSchema = z.object({
  module: appModule,
  export: exportName,
  property: z.array(exportName).max(8).default([]),
}).strict();

const SchemaSpecSchema = z.object({
  schemaRef: SchemaRefSchema.optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(
  (spec) => Boolean(spec.schemaRef) !== Boolean(spec.jsonSchema),
  'Provide exactly one of schemaRef or jsonSchema',
);

/** P05 extends entries (model, digests, prose); unknown fields pass through untouched. */
export const ResolutionEntrySchema = z.object({
  origin: z.enum(['human', 'agent']).default('human'),
  interfaceDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  input: SchemaSpecSchema.optional(),
  output: SchemaSpecSchema.optional(),
  effect: z.enum(['read', 'write', 'destructive', 'external', 'financial']).optional(),
}).passthrough();

const ResolutionsFileSchema = z.object({
  schemaVersion: z.literal(1),
  conventions: z.unknown().optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ToolConventions = z.infer<typeof ToolConventionsSchema>;
export type ResolutionEntry = z.infer<typeof ResolutionEntrySchema>;

export interface ToolResolutions {
  conventions: ToolConventions;
  entries: ReadonlyMap<string, unknown>;
}

export const EMPTY_CONVENTIONS: ToolConventions = {
  handlerWrappers: [],
  bodyReaders: [],
  authHelpers: [],
  filterValues: {},
};

/** Compile-time proof that parsed conventions satisfy the handler analyzer. */
export function toHandlerConventions(conventions: ToolConventions): HandlerConventions {
  return conventions;
}

function rejected(subjectRef: string, message: string): ToolFinding {
  return toolFinding('resolution-rejected', 'warning', subjectRef, message);
}

export function loadToolResolutions(root: string): { resolutions: ToolResolutions; findings: ToolFinding[] } {
  const empty: ToolResolutions = { conventions: EMPTY_CONVENTIONS, entries: new Map() };
  let raw: string;
  try {
    raw = readFileSync(resolve(root, TOOLS_PATHS.resolutions), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { resolutions: empty, findings: [] };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { resolutions: empty, findings: [rejected(TOOLS_PATHS.resolutions, 'tool-resolutions.json is not valid JSON and is ignored.')] };
  }
  const file = ResolutionsFileSchema.safeParse(json);
  if (!file.success) {
    return { resolutions: empty, findings: [rejected(TOOLS_PATHS.resolutions, 'tool-resolutions.json does not match its schema and is ignored.')] };
  }
  const findings: ToolFinding[] = [];
  const conventions = ToolConventionsSchema.safeParse(file.data.conventions ?? {});
  if (!conventions.success) {
    findings.push(rejected('conventions', 'The conventions in tool-resolutions.json are invalid and are ignored.'));
  }
  const entries = new Map(Object.entries(file.data.tools ?? {})
    .sort(([left], [right]) => compareCodeUnits(left, right)));
  return {
    resolutions: { conventions: conventions.success ? conventions.data : EMPTY_CONVENTIONS, entries },
    findings,
  };
}

export interface ResolutionEvidence {
  pathParams: ReadonlyArray<string>;
  queryKeys: ReadonlyArray<string>;
  bodyKeys: ReadonlyArray<string> | 'opaque';
}

function withoutMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _metaSchema, ...rest } = schema;
  return rest;
}

function compilesStrictly(schema: Record<string, unknown>): boolean {
  const ajv = new Ajv({ strict: true, allErrors: false, logger: false });
  addFormats(ajv);
  try {
    ajv.compile(schema);
    return true;
  } catch {
    return false;
  }
}

function normalizeSpec<T extends { jsonSchema?: Record<string, unknown> }>(spec: T | undefined): T | undefined {
  return spec?.jsonSchema ? { ...spec, jsonSchema: withoutMetaSchema(spec.jsonSchema) } : spec;
}

/** Basic gate for one entry; invalid entries are ignored and the tool keeps its fallback. */
export function validateResolutionEntry(input: {
  stableKey: string;
  raw: unknown;
  evidence: ResolutionEvidence;
}): { entry?: ResolutionEntry; findings: ToolFinding[] } {
  const reject = (reason: string) => ({
    findings: [rejected(input.stableKey, `The tool-resolutions.json entry was rejected: ${reason}.`)],
  });
  const parsed = ResolutionEntrySchema.safeParse(input.raw);
  if (!parsed.success) return reject('it does not match the entry schema');
  if (findSensitiveStringPath(parsed.data)) return reject('it contains secret-looking content');
  const entry = parsed.data;
  const specs = [['input', entry.input], ['output', entry.output]] as const;
  for (const [label, spec] of specs) {
    if (!spec?.jsonSchema) continue;
    const schema = withoutMetaSchema(spec.jsonSchema);
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_RESOLUTION_SCHEMA_BYTES) {
      return reject(`the ${label} schema exceeds 32 KB`);
    }
    if (!compilesStrictly(schema)) return reject(`the ${label} schema is not valid strict JSON Schema`);
    if (label !== 'input') continue;
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
      return reject('the input schema must be an object with additionalProperties false');
    }
    if (input.evidence.bodyKeys !== 'opaque') {
      const allowed = new Set([...input.evidence.pathParams, ...input.evidence.queryKeys, ...input.evidence.bodyKeys]);
      const keys = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
      const unbacked = keys.filter((key) => !allowed.has(key)).sort(compareCodeUnits);
      if (unbacked.length > 0) return reject(`input keys without code evidence: ${unbacked.join(', ')}`);
    }
  }
  return {
    entry: {
      ...entry,
      ...(entry.input ? { input: normalizeSpec(entry.input) } : {}),
      ...(entry.output ? { output: normalizeSpec(entry.output) } : {}),
    },
    findings: [],
  };
}

export function resolutionOrigin(resolutions: ToolResolutions, stableKey: string): 'human' | 'agent' | undefined {
  const parsed = ResolutionEntrySchema.safeParse(resolutions.entries.get(stableKey));
  return parsed.success ? parsed.data.origin : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/resolutions.test.ts && bun run typecheck`
Expected: PASS, typecheck clean (`toHandlerConventions` proves the conventions shape matches Task 7).

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/resolutions.ts src/codegen/tools/resolutions.test.ts
git commit -m "feat(codegen): read and gate tool-resolutions.json entries"
```

### Task 13: Contract tiers

**Files:**
- Create: `src/codegen/tools/contract-tiers.ts`
- Test: `src/codegen/tools/contract-tiers.test.ts`

**Interfaces:**
- Consumes: `SchemaUse` (Task 7), `InputRole` (Task 6), `computeInterfaceDigest`, `jsonSchemaDigest`, `OPAQUE_JSON_SCHEMA`, `toolFinding`, `ResolutionEntry` (Task 12), `SchemaProbeItem`, `SchemaProbeResult`, `ProbedSchema`, `ProbedContractEntry` (Task 10), P02 `DeclaredEffect`.
- Produces:
  - `export interface EndpointEvidence { schemaUses: ReadonlyArray<SchemaUse>; queryKeys: ReadonlyArray<string>; repeatedQueryKeys: ReadonlyArray<string>; bodyKeys: ReadonlyArray<string> | 'opaque'; readsBody: boolean; normalizedText?: string }`
  - `export interface ContractModuleCandidate { module: string; loadBearing: boolean; result: SchemaProbeResult }`
  - `export interface ResolveEndpointContractInput { stableKey: string; method: EndpointMethod; path: string; pathParams: ReadonlyArray<string>; evidence: EndpointEvidence; inferredOutput?: JsonSchemaLike; probes: ReadonlyMap<string, SchemaProbeResult>; contractModule?: ContractModuleCandidate; resolution?: ResolutionEntry; previousContract?: ToolContract }`
  - `export interface ResolvedEndpointContract { contract?: ToolContract; interfaceDigest: string; inputSchemaDigest: string; outputSchemaDigest: string; findings: ToolFinding[]; prose: ToolProseHints; explicitId?: string; declaredEffect?: DeclaredEffect }`
  - `export const OPAQUE_SCHEMA_DIGEST: string`
  - `export function probeItemFor(binding: SchemaBindingRef, io: 'input' | 'output'): SchemaProbeItem`
  - `export function contractEntryItem(module: string, method: EndpointMethod): SchemaProbeItem`
  - `export function probeKey(item: SchemaProbeItem): string`
  - `export function bindingLabel(role: string, binding: SchemaBindingRef): string`
  - `export function resolveEndpointContract(input: ResolveEndpointContractInput): ResolvedEndpointContract`

Decisions pinned here: a native role schema never covers path parameters (a body key that is also a path parameter is a `parameter-collision`), while tier 2 and tier 4 schemas describe the whole tool input; a problematic tier 1 (unclear role, not exported, unloadable, unsupported role) can be rescued only by an explicit tier 2 or tier 4 contract, never by the weak derived tier; a stale descriptive contract module keeps its old binding in `tool-contracts.json` so the tool stays disabled on every following refresh until the module changes; contract-module metadata (`id`, `effect`, prose) applies even when tier 1 wins.

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/contract-tiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { jsonSchemaDigest } from './canonical.js';
import {
  contractEntryItem,
  OPAQUE_SCHEMA_DIGEST,
  probeItemFor,
  probeKey,
  resolveEndpointContract,
  type EndpointEvidence,
  type ResolveEndpointContractInput,
} from './contract-tiers.js';
import type { ProbedContractEntry, ProbedSchema, SchemaProbeItem, SchemaProbeResult } from './schema-probe.js';
import type { SchemaBindingRef, ToolContract } from './types.js';

const digest = (character: string) => `sha256:${character.repeat(43)}`;
const NOTE = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const SCHEMAS: SchemaBindingRef = { module: 'src/app/api/notes/schemas.ts', export: 'createNote', property: [] };
const CONTRACT_MODULE = 'src/app/api/notes/contract.ts';

const probed = (json: Record<string, unknown> | null, value: string, description: string | null = null): ProbedSchema => ({
  ok: true, kind: 'schema', digest: value, jsonSchema: json, description,
});
const probes = (...entries: Array<[SchemaProbeItem, SchemaProbeResult]>) => new Map(
  entries.map(([item, result]) => [probeKey(item), result] as const),
);
const evidence = (overrides: Partial<EndpointEvidence> = {}): EndpointEvidence => ({
  schemaUses: [], queryKeys: [], repeatedQueryKeys: [], bodyKeys: [], readsBody: false, ...overrides,
});
const bodyUse = { role: 'body' as const, via: 'parse' as const, binding: SCHEMAS };
const entry = (overrides: Partial<ProbedContractEntry> = {}): ProbedContractEntry => ({
  ok: true,
  kind: 'contract-entry',
  input: probed(NOTE, digest('C')),
  output: probed({ type: 'object', properties: { id: { type: 'string' } } }, digest('O')),
  description: 'Create a note',
  effect: 'write',
  id: 'notes.add',
  module: 'notes',
  usageHints: ['Add a note for the caller'],
  presentation: null,
  moduleDigest: digest('M'),
  ...overrides,
});

function resolve(overrides: Partial<ResolveEndpointContractInput>) {
  return resolveEndpointContract({
    stableKey: 'POST /api/notes',
    method: 'POST',
    path: '/api/notes',
    pathParams: [],
    evidence: evidence(),
    probes: new Map(),
    ...overrides,
  });
}

describe('resolveEndpointContract', () => {
  it('uses a native body schema with an inferred output (tier 1)', () => {
    const inferred = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    const result = resolve({
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'), 'Create a note for the caller')]),
      inferredOutput: inferred,
    });
    expect(result.findings).toEqual([]);
    expect(result.contract).toMatchObject({
      source: 'native',
      loadBearing: true,
      input: NOTE,
      output: inferred,
      params: { path: [], query: [], body: ['title'] },
      runtime: { input: { kind: 'module-export', ...SCHEMAS }, output: { kind: 'json', schema: inferred } },
    });
    expect(result.inputSchemaDigest).toBe(digest('N'));
    expect(result.outputSchemaDigest).toBe(jsonSchemaDigest(inferred));
    expect(result.prose.schemaDescription).toBe('Create a note for the caller');
  });

  it('warns about an opaque output', () => {
    const result = resolve({
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
    });
    expect(result.outputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([['output-contract-opaque', 'warning']]);
  });

  it('combines path parameters with the body schema', () => {
    const result = resolve({
      stableKey: 'PATCH /api/notes/:id', method: 'PATCH', path: '/api/notes/:id', pathParams: ['id'],
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
    });
    const combined = {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: ['id', 'title'],
      additionalProperties: false,
    };
    expect(result.contract?.input).toEqual(combined);
    expect(result.contract?.runtime.input).toEqual({ kind: 'json', schema: combined });
    expect(result.inputSchemaDigest).toBe(jsonSchemaDigest(combined));
    expect(result.contract?.params).toEqual({ path: ['id'], query: [], body: ['title'] });
  });

  it.each([
    ['a parameter collision', { pathParams: ['title'], path: '/api/notes/:title', stableKey: 'PATCH /api/notes/:title', method: 'PATCH' as const }, [[probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]], [bodyUse], 'parameter-collision'],
    ['an unexported schema', {}, [], [{ role: 'body' as const, via: 'parse' as const, problem: 'not-exported' as const }], 'schema-not-exported'],
    ['an unloadable schema', {}, [[probeItemFor(SCHEMAS, 'input'), { ok: false as const, reason: 'import-failed' as const }]], [bodyUse], 'schema-module-unloadable'],
    ['a query schema on a write method', {}, [[probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]], [{ ...bodyUse, role: 'query' as const }], 'input-role-unsupported'],
  ] as const)('reports %s as needing attention', (_label, route, probeEntries, uses, code) => {
    const result = resolve({
      ...route,
      evidence: evidence({ schemaUses: [...uses], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes(...probeEntries.map(([item, outcome]) => [item, outcome] as [SchemaProbeItem, SchemaProbeResult])),
    });
    expect(result.contract).toBeUndefined();
    expect(result.inputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(result.findings.map((finding) => [finding.code, finding.severity])).toEqual([[code, 'needs_attention']]);
  });

  it('lets a current resolution rescue an unclear native role, but not a stale one', () => {
    const unclear = evidence({ schemaUses: [{ role: 'unclear', via: 'parse', binding: SCHEMAS }], readsBody: true, bodyKeys: 'opaque' });
    const first = resolve({ evidence: unclear });
    expect(first.findings.map((finding) => finding.code)).toEqual(['input-role-unclear']);
    const rescued = resolve({
      evidence: unclear,
      resolution: { origin: 'agent', interfaceDigest: first.interfaceDigest, input: { jsonSchema: NOTE } },
    });
    expect(rescued.contract).toMatchObject({ source: 'resolution', loadBearing: false, input: NOTE });
    expect(rescued.inputSchemaDigest).toBe(jsonSchemaDigest(NOTE));
    const stale = resolve({
      evidence: unclear,
      resolution: { origin: 'agent', interfaceDigest: digest('S'), input: { jsonSchema: NOTE } },
    });
    expect(stale.contract).toBeUndefined();
    expect(stale.findings.map((finding) => finding.code)).toEqual(['contract-stale']);
  });

  it('uses a load-bearing contract module with its metadata (tier 2)', () => {
    const result = resolve({
      evidence: evidence({ readsBody: true, bodyKeys: 'opaque' }),
      contractModule: { module: CONTRACT_MODULE, loadBearing: true, result: entry() },
    });
    expect(result.contract).toMatchObject({
      source: 'contract-module',
      loadBearing: true,
      runtime: {
        input: { kind: 'module-export', module: CONTRACT_MODULE, export: 'contract', property: ['POST', 'input'] },
        output: { kind: 'module-export', module: CONTRACT_MODULE, export: 'contract', property: ['POST', 'output'] },
      },
    });
    expect(result.contract?.binding).toBeUndefined();
    expect(result).toMatchObject({
      explicitId: 'notes.add',
      declaredEffect: 'write',
      inputSchemaDigest: digest('C'),
      outputSchemaDigest: digest('O'),
      prose: { contractDescription: 'Create a note', module: 'notes', usageHints: ['Add a note for the caller'] },
    });
  });

  it('binds descriptive contract modules to the interface and keeps a stale binding', () => {
    const base = { evidence: evidence({ readsBody: true, bodyKeys: ['title'] }) };
    const fresh = resolve({ ...base, contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry() } });
    expect(fresh.contract?.binding).toEqual({ interfaceDigest: fresh.interfaceDigest, contractModuleDigest: digest('M') });
    const previous: ToolContract = { ...fresh.contract!, binding: { interfaceDigest: digest('X'), contractModuleDigest: digest('M') } };
    const stale = resolve({ ...base, previousContract: previous, contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry() } });
    expect(stale.findings.map((finding) => [finding.code, finding.severity])).toEqual([['contract-stale', 'needs_attention']]);
    expect(stale.contract?.binding).toEqual(previous.binding);
    const updated = resolve({
      ...base,
      previousContract: previous,
      contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry({ moduleDigest: digest('L') }) },
    });
    expect(updated.findings).toEqual([]);
    expect(updated.contract?.binding).toEqual({ interfaceDigest: updated.interfaceDigest, contractModuleDigest: digest('L') });
  });

  it('keeps contract metadata when the native schema wins', () => {
    const result = resolve({
      evidence: evidence({ schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' }),
      probes: probes([probeItemFor(SCHEMAS, 'input'), probed(NOTE, digest('N'))]),
      contractModule: { module: CONTRACT_MODULE, loadBearing: false, result: entry() },
    });
    expect(result.contract?.source).toBe('native');
    expect(result).toMatchObject({ explicitId: 'notes.add', declaredEffect: 'write', outputSchemaDigest: digest('O') });
  });

  it('derives a weak contract from query and body keys (tier 5)', () => {
    const list = resolve({
      stableKey: 'GET /api/notes', method: 'GET',
      evidence: evidence({ queryKeys: ['q', 'status'], repeatedQueryKeys: ['status'] }),
    });
    expect(list.contract?.input).toEqual({
      type: 'object',
      properties: { q: { type: 'string' }, status: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    });
    expect(list.contract?.source).toBe('derived');
    expect(list.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['output-contract-opaque', 'warning'], ['contract-derived', 'warning'],
    ]);
    const create = resolve({ evidence: evidence({ readsBody: true, bodyKeys: ['title'] }) });
    expect(create.contract?.params).toEqual({ path: [], query: [], body: ['title'] });
    const misuse = resolve({ stableKey: 'GET /api/notes', method: 'GET', evidence: evidence({ readsBody: true, bodyKeys: ['title'] }) });
    expect(misuse.findings.map((finding) => finding.code)).toEqual(['input-role-unsupported']);
  });

  it('needs attention when nothing describes an opaque body (tier 6)', () => {
    const result = resolve({ evidence: evidence({ readsBody: true, bodyKeys: 'opaque', normalizedText: 'save(body)' }) });
    expect(result.contract).toBeUndefined();
    expect(result.outputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);
    expect(result.findings.map((finding) => finding.code)).toEqual(['input-contract-unresolved']);
  });

  it('ignores cosmetic handler text when structured evidence exists', () => {
    const shared = { schemaUses: [bodyUse], readsBody: true, bodyKeys: 'opaque' as const };
    expect(resolve({ evidence: evidence({ ...shared, normalizedText: 'a' }) }).interfaceDigest)
      .toBe(resolve({ evidence: evidence({ ...shared, normalizedText: 'b' }) }).interfaceDigest);
    expect(contractEntryItem(CONTRACT_MODULE, 'POST')).toEqual({
      kind: 'contract-entry', io: 'input', module: CONTRACT_MODULE, export: 'contract', property: ['POST'],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/contract-tiers.test.ts`
Expected: FAIL — `Failed to resolve import "./contract-tiers.js"`.

- [ ] **Step 3: Implement `contract-tiers.ts`**

```ts
import type { DeclaredEffect } from '../../contracts/tool-policy.js';
import type { EndpointMethod } from '../../types.js';
import { compareCodeUnits, jsonSchemaDigest, OPAQUE_JSON_SCHEMA } from './canonical.js';
import { toolFinding } from './findings.js';
import type { SchemaUse } from './handler-analysis.js';
import type { InputRole } from './input-roles.js';
import { computeInterfaceDigest } from './interface-digest.js';
import type { ResolutionEntry } from './resolutions.js';
import type {
  ProbedContractEntry,
  ProbedSchema,
  SchemaProbeItem,
  SchemaProbeResult,
} from './schema-probe.js';
import type {
  ContractBinding,
  JsonSchemaLike,
  RuntimeSchemaSource,
  SchemaBindingRef,
  ToolContract,
  ToolFinding,
  ToolProseHints,
} from './types.js';

export interface EndpointEvidence {
  schemaUses: ReadonlyArray<SchemaUse>;
  queryKeys: ReadonlyArray<string>;
  repeatedQueryKeys: ReadonlyArray<string>;
  bodyKeys: ReadonlyArray<string> | 'opaque';
  readsBody: boolean;
  normalizedText?: string;
}

export interface ContractModuleCandidate {
  module: string;
  loadBearing: boolean;
  result: SchemaProbeResult;
}

export interface ResolveEndpointContractInput {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  pathParams: ReadonlyArray<string>;
  evidence: EndpointEvidence;
  inferredOutput?: JsonSchemaLike;
  probes: ReadonlyMap<string, SchemaProbeResult>;
  contractModule?: ContractModuleCandidate;
  resolution?: ResolutionEntry;
  previousContract?: ToolContract;
}

export interface ResolvedEndpointContract {
  contract?: ToolContract;
  interfaceDigest: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  findings: ToolFinding[];
  prose: ToolProseHints;
  explicitId?: string;
  declaredEffect?: DeclaredEffect;
}

export const OPAQUE_SCHEMA_DIGEST = jsonSchemaDigest(OPAQUE_JSON_SCHEMA);

const READ_METHODS: ReadonlySet<EndpointMethod> = new Set(['GET', 'DELETE']);
const EFFECT_STRENGTH: Readonly<Record<DeclaredEffect, number>> = {
  read: 0, write: 1, destructive: 2, external: 2, financial: 2,
};

interface RolePart {
  role: InputRole;
  json: JsonSchemaLike | null;
  source: RuntimeSchemaSource;
  digest: string;
  label: string;
  /** Tier 2/4 schemas describe the whole tool input, path parameters included. */
  wholeInput?: boolean;
}

interface ComposedInput {
  source: RuntimeSchemaSource;
  json: JsonSchemaLike;
  digest: string;
  findings: ToolFinding[];
}

interface OutputChoice {
  source: RuntimeSchemaSource;
  json: JsonSchemaLike;
  digest: string;
  description?: string;
  findings: ToolFinding[];
}

export function probeItemFor(binding: SchemaBindingRef, io: 'input' | 'output'): SchemaProbeItem {
  return { kind: 'schema', io, module: binding.module, export: binding.export, property: [...binding.property] };
}

export function contractEntryItem(module: string, method: EndpointMethod): SchemaProbeItem {
  return { kind: 'contract-entry', io: 'input', module, export: 'contract', property: [method] };
}

export function probeKey(item: SchemaProbeItem): string {
  return JSON.stringify([item.kind, item.io, item.module, item.export, item.property]);
}

export function bindingLabel(role: string, binding: SchemaBindingRef): string {
  return `${role}:${binding.module}#${[binding.export, ...binding.property].join('.')}`;
}

function moduleExport(binding: SchemaBindingRef): RuntimeSchemaSource {
  return { kind: 'module-export', module: binding.module, export: binding.export, property: [...binding.property] };
}

function jsonSource(schema: JsonSchemaLike): RuntimeSchemaSource {
  return { kind: 'json', schema };
}

function asSchema(result: SchemaProbeResult | undefined): ProbedSchema | undefined {
  return result?.ok && result.kind === 'schema' ? result : undefined;
}

function propertiesOf(json: JsonSchemaLike | null): Record<string, JsonSchemaLike> | undefined {
  if (!json || json.type !== 'object') return undefined;
  const value = json.properties;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonSchemaLike> : {};
}

function requiredOf(json: JsonSchemaLike): string[] {
  return Array.isArray(json.required)
    ? json.required.filter((value): value is string => typeof value === 'string')
    : [];
}

function strongerEffect(
  first: DeclaredEffect | null | undefined,
  second: DeclaredEffect | undefined,
): DeclaredEffect | undefined {
  if (!first) return second;
  if (!second) return first;
  return EFFECT_STRENGTH[second] > EFFECT_STRENGTH[first] ? second : first;
}

function composeInput(
  subject: string,
  parts: ReadonlyArray<RolePart>,
  pathParams: ReadonlyArray<string>,
): ComposedInput | { findings: ToolFinding[] } {
  const only = parts.length === 1 ? parts[0] : undefined;
  const covers = only?.wholeInput === true
    && pathParams.every((name) => propertiesOf(only.json)?.[name] !== undefined);
  if (only && (pathParams.length === 0 || only.role === 'path' || covers)) {
    return {
      source: only.source,
      json: only.json ?? OPAQUE_JSON_SCHEMA,
      digest: only.digest,
      findings: only.json ? [] : [toolFinding('schema-json-unavailable', 'warning', subject, `${only.label} has no JSON Schema description.`)],
    };
  }
  const findings: ToolFinding[] = [];
  const properties: Record<string, JsonSchemaLike> = {};
  const required = new Set<string>();
  const owners = new Map<string, InputRole>();
  if (!parts.some((part) => part.role === 'path')) {
    for (const name of pathParams) {
      properties[name] = { type: 'string' };
      required.add(name);
      owners.set(name, 'path');
    }
  }
  for (const part of parts) {
    if (!part.json) {
      findings.push(toolFinding('schema-json-unavailable', 'needs_attention', subject,
        `${part.label} has no JSON Schema, so it cannot be combined with other parameters.`));
      continue;
    }
    const partProperties = propertiesOf(part.json);
    if (!partProperties) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `${part.label} is not an object schema and cannot be combined with other parameters.`));
      continue;
    }
    for (const [key, value] of Object.entries(partProperties)) {
      if (part.wholeInput && pathParams.includes(key)) {
        properties[key] = value;
        continue;
      }
      const owner = owners.get(key);
      if (owner !== undefined && owner !== part.role) {
        findings.push(toolFinding('parameter-collision', 'needs_attention', subject,
          `Parameter ${key} is used both as ${owner} and as ${part.role} parameter.`));
        continue;
      }
      owners.set(key, part.role);
      properties[key] = value;
    }
    for (const key of requiredOf(part.json)) required.add(key);
  }
  if (findings.length > 0) return { findings };
  const json: JsonSchemaLike = {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).sort(([left], [right]) => compareCodeUnits(left, right))),
    ...(required.size ? { required: [...required].sort(compareCodeUnits) } : {}),
    additionalProperties: false,
  };
  return { source: jsonSource(json), json, digest: jsonSchemaDigest(json), findings: [] };
}

function paramsFrom(
  pathParams: ReadonlyArray<string>,
  parts: ReadonlyArray<RolePart>,
  evidence: EndpointEvidence,
): ToolContract['params'] {
  const keysOf = (role: InputRole): string[] | undefined => {
    const part = parts.find((candidate) => candidate.role === role);
    return part
      ? Object.keys(propertiesOf(part.json) ?? {}).filter((key) => !pathParams.includes(key)).sort(compareCodeUnits)
      : undefined;
  };
  return {
    path: [...pathParams],
    query: keysOf('query') ?? [...evidence.queryKeys],
    body: keysOf('body') ?? (evidence.bodyKeys === 'opaque' ? 'opaque' : [...evidence.bodyKeys]),
  };
}

function nativeParts(
  input: ResolveEndpointContractInput,
  uses: ReadonlyArray<SchemaUse>,
): { parts: RolePart[]; description?: string } | { findings: ToolFinding[] } {
  const subject = input.stableKey;
  if (uses.length === 0) {
    return { findings: [toolFinding('input-role-unclear', 'needs_attention', subject,
      'A schema validates request data, but its role (body, query or path) could not be traced.')] };
  }
  const findings: ToolFinding[] = [];
  const byRole = new Map<InputRole, RolePart>();
  let description: string | undefined;
  for (const use of uses) {
    const role = use.role as InputRole;
    if (!use.binding) {
      findings.push(toolFinding('schema-not-exported', 'needs_attention', subject,
        `The ${role} schema is not exported from an app module.`));
      continue;
    }
    if ((role === 'query' && !READ_METHODS.has(input.method)) || (role === 'body' && READ_METHODS.has(input.method))) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `A ${input.method} tool cannot send ${role} parameters.`));
      continue;
    }
    const label = bindingLabel(role, use.binding);
    const outcome = input.probes.get(probeKey(probeItemFor(use.binding, 'input')));
    const schema = asSchema(outcome);
    if (!schema) {
      findings.push(toolFinding('schema-module-unloadable', 'needs_attention', subject,
        `${use.binding.module}#${use.binding.export} could not be loaded (${outcome && !outcome.ok ? outcome.reason : 'not probed'}).`));
      continue;
    }
    const existing = byRole.get(role);
    if (existing && existing.label !== label) {
      findings.push(toolFinding('input-role-unclear', 'needs_attention', subject,
        `Two different schemas validate the ${role}.`));
      continue;
    }
    byRole.set(role, { role, json: schema.jsonSchema, source: moduleExport(use.binding), digest: schema.digest, label });
    description ??= schema.description ?? undefined;
  }
  if (findings.length > 0) return { findings };
  return {
    parts: [...byRole.values()].sort((left, right) => compareCodeUnits(left.role, right.role)),
    ...(description ? { description } : {}),
  };
}

function chooseOutput(
  input: ResolveEndpointContractInput,
  entry: ProbedContractEntry | undefined,
  resolutionCurrent: boolean,
): OutputChoice {
  const outputBindings = input.evidence.schemaUses
    .filter((use) => use.role === 'output' && use.binding)
    .map((use) => use.binding!)
    .sort((left, right) => compareCodeUnits(bindingLabel('output', left), bindingLabel('output', right)));
  for (const binding of outputBindings) {
    const schema = asSchema(input.probes.get(probeKey(probeItemFor(binding, 'output'))));
    if (schema) {
      return {
        source: moduleExport(binding),
        json: schema.jsonSchema ?? OPAQUE_JSON_SCHEMA,
        digest: schema.digest,
        ...(schema.description ? { description: schema.description } : {}),
        findings: [],
      };
    }
  }
  if (entry?.output && input.contractModule) {
    return {
      source: moduleExport({ module: input.contractModule.module, export: 'contract', property: [input.method, 'output'] }),
      json: entry.output.jsonSchema ?? OPAQUE_JSON_SCHEMA,
      digest: entry.output.digest,
      ...(entry.output.description ? { description: entry.output.description } : {}),
      findings: [],
    };
  }
  const resolutionOutput = resolutionCurrent ? input.resolution?.output : undefined;
  if (resolutionOutput?.schemaRef) {
    const schema = asSchema(input.probes.get(probeKey(probeItemFor(resolutionOutput.schemaRef, 'output'))));
    if (schema) {
      return { source: moduleExport(resolutionOutput.schemaRef), json: schema.jsonSchema ?? OPAQUE_JSON_SCHEMA, digest: schema.digest, findings: [] };
    }
  }
  if (resolutionOutput?.jsonSchema) {
    const json = resolutionOutput.jsonSchema;
    return { source: jsonSource(json), json, digest: jsonSchemaDigest(json), findings: [] };
  }
  if (input.inferredOutput) {
    return { source: jsonSource(input.inferredOutput), json: input.inferredOutput, digest: jsonSchemaDigest(input.inferredOutput), findings: [] };
  }
  return {
    source: jsonSource(OPAQUE_JSON_SCHEMA),
    json: OPAQUE_JSON_SCHEMA,
    digest: OPAQUE_SCHEMA_DIGEST,
    findings: [toolFinding('output-contract-opaque', 'warning', input.stableKey,
      'The response shape could not be determined; the model sees an untyped result.')],
  };
}

/** Tiers: 1 native, 2 contract module, 4 tool-resolutions.json, 5 derived, 6 unresolved. */
export function resolveEndpointContract(input: ResolveEndpointContractInput): ResolvedEndpointContract {
  const subject = input.stableKey;
  const { evidence } = input;
  const bound = evidence.schemaUses.filter((use) => use.binding);
  const interfaceDigest = computeInterfaceDigest({
    method: input.method,
    path: input.path,
    pathParams: [...input.pathParams],
    queryParams: [...evidence.queryKeys],
    schemaBindings: bound.map((use) => bindingLabel(use.role, use.binding!)),
    bodyKeys: evidence.bodyKeys === 'opaque' ? 'opaque' : [...evidence.bodyKeys],
    ...(evidence.bodyKeys === 'opaque' && bound.length === 0 && evidence.normalizedText !== undefined
      ? { handlerText: evidence.normalizedText }
      : {}),
  });
  const candidate = input.contractModule?.result;
  const entry = candidate?.ok && candidate.kind === 'contract-entry' ? candidate : undefined;
  const resolutionCurrent = input.resolution?.interfaceDigest === interfaceDigest;
  const effect = strongerEffect(entry?.effect, resolutionCurrent ? input.resolution?.effect : undefined);
  const prose: ToolProseHints = {
    ...(entry?.description ? { contractDescription: entry.description } : {}),
    ...(entry?.module ? { module: entry.module } : {}),
    ...(entry?.usageHints?.length ? { usageHints: entry.usageHints } : {}),
    ...(entry?.presentation ? { presentation: entry.presentation } : {}),
  };
  const base = {
    interfaceDigest,
    prose,
    ...(entry?.id ? { explicitId: entry.id } : {}),
    ...(effect ? { declaredEffect: effect } : {}),
  };
  const unresolved = (findings: ToolFinding[]): ResolvedEndpointContract => ({
    ...base,
    inputSchemaDigest: OPAQUE_SCHEMA_DIGEST,
    outputSchemaDigest: OPAQUE_SCHEMA_DIGEST,
    findings,
  });
  const output = chooseOutput(input, entry, resolutionCurrent);
  const finish = (
    source: ToolContract['source'],
    loadBearing: boolean,
    composed: ComposedInput,
    params: ToolContract['params'],
    extraFindings: ToolFinding[],
    schemaDescription: string | undefined,
    binding?: ContractBinding,
  ): ResolvedEndpointContract => {
    const description = schemaDescription ?? output.description;
    return {
      ...base,
      prose: { ...prose, ...(description ? { schemaDescription: description } : {}) },
      contract: {
        source,
        loadBearing,
        input: composed.json,
        output: output.json,
        params,
        interfaceDigest,
        runtime: { input: composed.source, output: output.source },
        ...(binding ? { binding } : {}),
      },
      inputSchemaDigest: composed.digest,
      outputSchemaDigest: output.digest,
      findings: [...composed.findings, ...output.findings, ...extraFindings],
    };
  };
  const roleFor = (): InputRole => (READ_METHODS.has(input.method) ? 'query' : 'body');

  // Tier 1: native schemas, including declared handler wrappers.
  const inputUses = evidence.schemaUses.filter((use) => use.role === 'body' || use.role === 'query' || use.role === 'path');
  const readsRequest = evidence.readsBody || evidence.queryKeys.length > 0;
  const nativeApplies = inputUses.length > 0
    || (evidence.schemaUses.some((use) => use.role === 'unclear') && readsRequest);
  let nativeProblems: ToolFinding[] = [];
  if (nativeApplies) {
    const native = nativeParts(input, inputUses);
    if ('parts' in native) {
      const composed = composeInput(subject, native.parts, input.pathParams);
      if ('source' in composed) {
        return finish('native', true, composed, paramsFrom(input.pathParams, native.parts, evidence), [], native.description);
      }
      nativeProblems = composed.findings;
    } else {
      nativeProblems = native.findings;
    }
  }

  // Tier 2: sibling contract module.
  if (entry && input.contractModule) {
    const part: RolePart = {
      role: roleFor(),
      json: entry.input.jsonSchema,
      source: moduleExport({ module: input.contractModule.module, export: 'contract', property: [input.method, 'input'] }),
      digest: entry.input.digest,
      label: `${input.contractModule.module}#contract.${input.method}.input`,
      wholeInput: true,
    };
    const composed = composeInput(subject, [part], input.pathParams);
    if (!('source' in composed)) return unresolved(composed.findings);
    const extra: ToolFinding[] = [];
    let binding: ContractBinding | undefined;
    if (!input.contractModule.loadBearing) {
      const previous = input.previousContract?.binding;
      if (previous && previous.contractModuleDigest === entry.moduleDigest && previous.interfaceDigest !== interfaceDigest) {
        binding = previous;
        extra.push(toolFinding('contract-stale', 'needs_attention', subject,
          'The handler interface changed after its descriptive contract.ts was written.'));
      } else {
        binding = { interfaceDigest, contractModuleDigest: entry.moduleDigest };
      }
    }
    return finish('contract-module', input.contractModule.loadBearing, composed,
      paramsFrom(input.pathParams, [part], evidence), extra, entry.input.description ?? undefined, binding);
  }
  if (candidate && !candidate.ok && candidate.reason !== 'missing' && !nativeApplies && input.contractModule) {
    return unresolved([toolFinding('schema-module-unloadable', 'needs_attention', subject,
      `${input.contractModule.module} could not be loaded (${candidate.reason}).`)]);
  }

  // Tier 4: tool-resolutions.json entry bound to the interface digest.
  const resolutionInput = input.resolution?.input;
  if (resolutionInput) {
    if (!resolutionCurrent) {
      return unresolved([toolFinding('contract-stale', 'needs_attention', subject,
        'The handler interface changed after its tool-resolutions.json entry was written.')]);
    }
    let part: RolePart;
    if (resolutionInput.schemaRef) {
      const outcome = input.probes.get(probeKey(probeItemFor(resolutionInput.schemaRef, 'input')));
      const schema = asSchema(outcome);
      if (!schema) {
        return unresolved([toolFinding('schema-module-unloadable', 'needs_attention', subject,
          `${resolutionInput.schemaRef.module}#${resolutionInput.schemaRef.export} could not be loaded (${outcome && !outcome.ok ? outcome.reason : 'not probed'}).`)]);
      }
      part = {
        role: roleFor(), json: schema.jsonSchema, source: moduleExport(resolutionInput.schemaRef), digest: schema.digest,
        label: bindingLabel(roleFor(), resolutionInput.schemaRef), wholeInput: true,
      };
    } else {
      const json = resolutionInput.jsonSchema!;
      part = {
        role: roleFor(), json, source: jsonSource(json), digest: jsonSchemaDigest(json),
        label: 'the tool-resolutions.json input schema', wholeInput: true,
      };
    }
    const composed = composeInput(subject, [part], input.pathParams);
    if (!('source' in composed)) return unresolved(composed.findings);
    return finish('resolution', false, composed, paramsFrom(input.pathParams, [part], evidence), [], undefined);
  }
  if (nativeApplies) return unresolved(nativeProblems);

  // Tier 5: weak contract derived from path params, query keys and closed body keys.
  if (evidence.bodyKeys !== 'opaque') {
    const bodyKeys = [...evidence.bodyKeys];
    const findings: ToolFinding[] = [];
    if (READ_METHODS.has(input.method) && bodyKeys.length > 0) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `The ${input.method} handler reads body fields, which a ${input.method} tool cannot send.`));
    }
    if (!READ_METHODS.has(input.method) && evidence.queryKeys.length > 0) {
      findings.push(toolFinding('input-role-unsupported', 'needs_attention', subject,
        `The ${input.method} handler reads query parameters, which a ${input.method} tool sends in the body.`));
    }
    const properties: Record<string, JsonSchemaLike> = {};
    const owners = new Map<string, string>();
    const add = (key: string, role: string, schema: JsonSchemaLike) => {
      const owner = owners.get(key);
      if (owner !== undefined && owner !== role) {
        findings.push(toolFinding('parameter-collision', 'needs_attention', subject,
          `Parameter ${key} is used both as ${owner} and as ${role} parameter.`));
        return;
      }
      owners.set(key, role);
      properties[key] = schema;
    };
    for (const name of input.pathParams) add(name, 'path', { type: 'string' });
    for (const key of evidence.queryKeys) {
      add(key, 'query', evidence.repeatedQueryKeys.includes(key)
        ? { type: 'array', items: { type: 'string' } }
        : { type: 'string' });
    }
    for (const key of bodyKeys) add(key, 'body', {});
    if (findings.length > 0) return unresolved(findings);
    const json: JsonSchemaLike = {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).sort(([left], [right]) => compareCodeUnits(left, right))),
      ...(input.pathParams.length ? { required: [...input.pathParams].sort(compareCodeUnits) } : {}),
      additionalProperties: false,
    };
    return finish('derived', false, { source: jsonSource(json), json, digest: jsonSchemaDigest(json), findings: [] },
      { path: [...input.pathParams], query: [...evidence.queryKeys], body: bodyKeys },
      [toolFinding('contract-derived', 'warning', subject,
        'Only parameter names are known; the endpoint keeps validating its own input.')],
      undefined);
  }

  // Tier 6.
  return unresolved([toolFinding('input-contract-unresolved', 'needs_attention', subject,
    'The input of this endpoint could not be determined from the code.')]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/contract-tiers.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/contract-tiers.ts src/codegen/tools/contract-tiers.test.ts
git commit -m "feat(codegen): resolve endpoint contracts across tiers"
```

### Task 14: The `next-app` endpoint source

**Files:**
- Modify: `src/codegen/tools/types.ts` (append the source interfaces)
- Create: `src/codegen/tools/sources/next-endpoints.ts`
- Test: `src/codegen/tools/sources/next-endpoints.test.ts`

**Interfaces:**
- Consumes: `scanNextAppRoutes` (source-discovery mode), `toRoutePath`, `createRouteSourceFingerprint`, `createAppProgram`, `analyzeRouteHandler`, `collectHandlerEvidence`, `inferResponseSchema`, `findExclusion`, `importsChatHandler`, `validateResolutionEntry`, `resolveEndpointContract`, `assignDefinitionIds`, `SchemaProbe`, P02 `ToolPolicyFile`.
- Produces (pinned `ToolSource` shape; `excluded` on the observation is an optional P03 addition):
  - `export interface ToolSourceContext { root: string; config: ToolsConfig; resolutions: ToolResolutions; policy: ToolPolicyFile; previous?: ExecutionGenerationState; previousContracts: ReadonlyMap<string, ToolContract>; probe: SchemaProbe }`
  - `export interface ToolSourceObservation { observations: ObservedTool[]; findings: ToolFinding[]; complete: boolean; excluded?: ExcludedTool[] }`
  - `export interface ToolSource { kind: string; observe(ctx: ToolSourceContext): Promise<ToolSourceObservation> }`
  - `export const NEXT_DEFAULT_API_DIR = 'src/app/api'`
  - `export function createNextEndpointSource(options?: { apiDir?: string }): ToolSource`

- [ ] **Step 1: Append the source interfaces to `types.ts`**

Add these imports at the top of `src/codegen/tools/types.ts` (type-only, next to the existing ones):

```ts
import type { ToolPolicyFile } from '../../contracts/tool-policy.js';
import type { ExecutionGenerationState } from '../inventory-generation.js';
import type { ToolsConfig } from './config.js';
import type { ToolResolutions } from './resolutions.js';
import type { SchemaProbe } from './schema-probe.js';
```

(`ExecutionGenerationState` joins the existing `ObservedExecution` import from `../inventory-generation.js`; merge them into one import line.) Append at the end of the file:

```ts
export interface ToolSourceContext {
  /** Real path of the app root. */
  root: string;
  config: ToolsConfig;
  resolutions: ToolResolutions;
  policy: ToolPolicyFile;
  previous?: ExecutionGenerationState;
  /** Previous contracts by stable key (descriptive bindings live here). */
  previousContracts: ReadonlyMap<string, ToolContract>;
  probe: SchemaProbe;
}

export interface ToolSourceObservation {
  observations: ObservedTool[];
  findings: ToolFinding[];
  /** false ⇒ enumeration incomplete; the pipeline writes nothing. */
  complete: boolean;
  excluded?: ExcludedTool[];
}

export interface ToolSource {
  kind: string;
  observe(ctx: ToolSourceContext): Promise<ToolSourceObservation>;
}
```

- [ ] **Step 2: Write the failing test**

`src/codegen/tools/sources/next-endpoints.test.ts`:

```ts
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createLocalSchemaDigest } from '../../../runtime/local-tool-bindings.js';
import type { SchemaLike } from '../../../types.js';
import { ExecutionGenerationStateSchema } from '../../inventory-generation.js';
import { createRouteSourceFingerprint } from '../../route-scanner.js';
import { createAppFixture, FIXTURE_APP_ID, removeAppFixtures, SDK_ROOT } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { OPAQUE_SCHEMA_DIGEST } from '../contract-tiers.js';
import { EMPTY_CONVENTIONS, type ToolResolutions } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ObservedTool, ToolSourceContext } from '../types.js';
import { createNextEndpointSource } from './next-endpoints.js';

afterEach(removeAppFixtures);

const POLICY = ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} });

function context(root: string, overrides: Partial<ToolSourceContext> = {}): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: POLICY,
    previousContracts: new Map(),
    probe: createSchemaProbe(),
    ...overrides,
  };
}

const byKey = (observations: ObservedTool[]) => new Map(
  observations.map((observation) => [observation.execution.stableKey, observation] as const),
);

const APP_FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  'src/lib/session.ts': "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n",
  'src/lib/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string().min(1) }).strict();\n",
  'src/app/api/tasks/route.ts': "import { getSession } from '@/lib/session';\nimport { createTask } from '@/lib/schemas';\n"
    + "/** Lists the caller's tasks. */\n"
    + 'export async function GET(request: Request) {\n  await getSession(request);\n'
    + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n"
    + 'export async function POST(request: Request) {\n  await getSession(request);\n'
    + '  const input = createTask.parse(await request.json());\n'
    + "  return Response.json({ id: '1', title: input.title }, { status: 201 });\n}\n",
  'src/app/api/tasks/[id]/route.ts': "import { getSession } from '@/lib/session';\n"
    + 'export async function DELETE(request: Request) {\n  await getSession(request);\n  return Response.json({ deleted: true });\n}\n',
  'src/app/api/raw/route.ts': "import { getSession } from '@/lib/session';\n"
    + 'declare function save(value: unknown): Promise<{ ok: boolean }>;\n'
    + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
    + '  return Response.json(await save(body));\n}\n',
  'src/app/api/open/route.ts': 'export async function GET() {\n  return Response.json({ open: true });\n}\n',
  'src/lib/logging.ts': 'export function withLogging<T>(handler: T): T {\n  return handler;\n}\n',
  'src/app/api/logged/route.ts': "import { getSession } from '@/lib/session';\nimport { withLogging } from '@/lib/logging';\n"
    + 'export const GET = withLogging(async (request: Request) => {\n  await getSession(request);\n'
    + '  return Response.json({ ok: true });\n});\n',
  'src/app/api/wrapped/route.ts': "import { handlers } from './handlers';\nexport const GET = handlers.GET;\n",
  'src/app/api/wrapped/handlers.ts': 'export const handlers = { GET: async () => Response.json([]) };\n',
  'src/app/api/notes/contract.ts': "import { z } from 'zod';\nexport const contract = {\n"
    + "  POST: { input: z.object({ title: z.string() }), description: 'Create a note for the caller', effect: 'write', id: 'notes.add' },\n};\n",
  'src/app/api/notes/route.ts': "import { getSession } from '@/lib/session';\nimport { contract } from './contract';\n"
    + 'declare function createNote(input: unknown, shape: typeof contract): Promise<{ id: string }>;\n'
    + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
    + '  return Response.json(await createNote(body, contract));\n}\n',
  'src/app/api/auth/login/route.ts': 'export async function POST() { return Response.json({}); }\n',
  'src/app/api/chat/route.ts': "import { createAiChatHandler } from 'glirastes/server/nextjs';\n"
    + 'export const POST = createAiChatHandler({} as never);\n',
};

describe('next-app endpoint source', () => {
  it('turns every enumerated route into a tool, an attention item or a reasoned exclusion', async () => {
    const app = await createAppFixture(APP_FILES);
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.complete).toBe(true);
    expect(observed.excluded).toEqual([
      { stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' },
      { stableKey: 'POST /api/chat', reason: 'chat-handler', origin: 'default' },
    ]);
    const tools = byKey(observed.observations);
    expect(Object.fromEntries([...tools].map(([key, tool]) => [key, tool.execution.definitionId]))).toEqual({
      'DELETE /api/tasks/:id': 'tasks.delete',
      'GET /api/logged': 'logged.list',
      'GET /api/open': 'open.list',
      'GET /api/tasks': 'tasks.list',
      'GET /api/wrapped': 'wrapped.list',
      'POST /api/notes': 'notes.add',
      'POST /api/raw': 'raw.create',
      'POST /api/tasks': 'tasks.create',
    });

    const create = tools.get('POST /api/tasks')!;
    expect(create.execution).toMatchObject({
      executionKind: 'endpoint',
      sourceKind: 'next-app',
      sourceFile: 'src/app/api/tasks/route.ts',
      sourceFingerprint: createRouteSourceFingerprint(await app.read('src/app/api/tasks/route.ts'), 'POST', '/api/tasks'),
    });
    expect(create.contract).toMatchObject({
      source: 'native',
      loadBearing: true,
      params: { path: [], query: [], body: ['title'] },
      runtime: { input: { kind: 'module-export', module: 'src/lib/schemas.ts', export: 'createTask' } },
    });
    expect(create.findings).toEqual([]);
    expect(create.evidence).toEqual({ authEvidence: true, externalCall: false });

    const list = tools.get('GET /api/tasks')!;
    expect(list.contract).toMatchObject({ source: 'derived', params: { query: ['status'] } });
    expect(list.evidence.jsDoc).toBe("Lists the caller's tasks.");
    expect(list.findings.map((finding) => finding.code)).toEqual(['contract-derived']);

    const attention = (key: string) => tools.get(key)!.findings
      .filter((finding) => finding.severity === 'needs_attention')
      .map((finding) => finding.code);
    expect(attention('POST /api/raw')).toEqual(['input-contract-unresolved']);
    expect(attention('GET /api/open')).toEqual(['auth-evidence-missing']);
    expect(attention('GET /api/wrapped')).toEqual(['handler-unresolved']);
    expect(tools.get('GET /api/wrapped')!.execution.inputSchemaDigest).toBe(OPAQUE_SCHEMA_DIGEST);

    // A wrapper export is enumerated through the route reader's
    // `route-export-unresolved` finding and analysed through its inner function.
    const logged = tools.get('GET /api/logged')!;
    expect(logged.execution.sourceFingerprint)
      .toBe(createRouteSourceFingerprint(await app.read('src/app/api/logged/route.ts'), 'GET', '/api/logged'));
    expect(logged.evidence.authEvidence).toBe(true);
    expect(logged.contract).toMatchObject({ source: 'derived' });
    expect(logged.findings.map((finding) => finding.code)).toEqual(['contract-derived']);

    const notes = tools.get('POST /api/notes')!;
    expect(notes.contract).toMatchObject({ source: 'contract-module', loadBearing: true });
    expect(notes.evidence.declaredEffect).toBe('write');
    expect(notes.prose?.contractDescription).toBe('Create a note for the caller');
  }, 60_000);

  it('reports export * as incomplete enumeration', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': "export * from './handlers';\n",
      'src/app/api/tasks/handlers.ts': 'export async function GET() { return Response.json([]); }\n',
    });
    const observed = await createNextEndpointSource().observe(context(app.root));
    expect(observed.complete).toBe(false);
    expect(observed.findings.map((finding) => [finding.code, finding.severity])).toEqual([['E-INVENTORY-011', 'error']]);
  }, 60_000);

  it('applies declared wrapper and auth conventions to the reference fixture', async () => {
    const app = await createAppFixture();
    await cp(join(SDK_ROOT, 'examples/source-driven-next/native'), app.root, { recursive: true });
    const resolutions: ToolResolutions = {
      conventions: {
        ...EMPTY_CONVENTIONS,
        handlerWrappers: [{ module: 'src/query.js', export: 'query', queryArg: 1, outputArg: 2 }],
        authHelpers: ['resolveSession'],
      },
      entries: new Map(),
    };
    const observed = await createNextEndpointSource().observe(context(app.root, { resolutions }));
    const contract = await import(pathToFileURL(app.path('src/app/api/tasks/contract.js')).href) as {
      inputSchema: SchemaLike;
      outputSchema: SchemaLike;
    };
    const [tasks] = observed.observations;
    expect(tasks?.execution).toMatchObject({
      stableKey: 'GET /api/tasks',
      definitionId: 'tasks.list',
      inputSchemaDigest: createLocalSchemaDigest(contract.inputSchema),
      outputSchemaDigest: createLocalSchemaDigest(contract.outputSchema),
    });
    expect(tasks?.contract).toMatchObject({
      source: 'native',
      params: { query: ['status'] },
      runtime: {
        input: { kind: 'module-export', module: 'src/app/api/tasks/contract.js', export: 'inputSchema' },
        output: { kind: 'module-export', module: 'src/app/api/tasks/contract.js', export: 'outputSchema' },
      },
    });
    expect(tasks?.findings).toEqual([]);
    expect(tasks?.prose?.schemaDescription).toBe('List your tasks, optionally filtered by status.');
  }, 60_000);

  it('keeps a previous definition id and handles apps without an API directory', async () => {
    const app = await createAppFixture({
      'src/app/api/tasks/route.ts': 'export async function GET() { await getSession(); return Response.json([]); }\n'
        + 'declare function getSession(): Promise<unknown>;\n',
    });
    const previous = ExecutionGenerationStateSchema.parse({
      schemaVersion: 1,
      appId: FIXTURE_APP_ID,
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'tool-fixture',
        executions: [{
          toolId: '019fb007-0000-7000-8000-0000000000d1',
          definitionId: 'tasks.search',
          stableKey: 'GET /api/tasks',
          executionKind: 'endpoint',
          sourceFile: 'src/app/api/tasks/route.ts',
          method: 'GET',
          path: '/api/tasks',
          sourceFingerprint: `sha256:${'F'.repeat(43)}`,
          inputSchemaDigest: `sha256:${'A'.repeat(43)}`,
          outputSchemaDigest: `sha256:${'B'.repeat(43)}`,
        }],
      },
      tombstones: [],
    });
    const observed = await createNextEndpointSource().observe(context(app.root, { previous }));
    expect(observed.observations[0]?.execution.definitionId).toBe('tasks.search');
    const empty = await createAppFixture();
    expect(await createNextEndpointSource().observe(context(empty.root)))
      .toEqual({ observations: [], findings: [], complete: true, excluded: [] });
  }, 60_000);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/next-endpoints.test.ts`
Expected: FAIL — `Failed to resolve import "./next-endpoints.js"`.

- [ ] **Step 4: Implement `sources/next-endpoints.ts`**

```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { EndpointMethod } from '../../../types.js';
import {
  createRouteSourceFingerprint,
  scanNextAppRoutes,
  toRoutePath,
} from '../../route-scanner.js';
import { compareCodeUnits } from '../canonical.js';
import {
  contractEntryItem,
  OPAQUE_SCHEMA_DIGEST,
  probeItemFor,
  probeKey,
  resolveEndpointContract,
  type ContractModuleCandidate,
  type ResolvedEndpointContract,
} from '../contract-tiers.js';
import { collectHandlerEvidence } from '../evidence.js';
import { findExclusion, importsChatHandler } from '../exclusions.js';
import { toolFinding } from '../findings.js';
import { analyzeRouteHandler, type HandlerAnalysis } from '../handler-analysis.js';
import { assignDefinitionIds } from '../identity.js';
import { inferResponseSchema } from '../output-inference.js';
import { createAppProgram, type AppProgram } from '../program.js';
import { validateResolutionEntry, type ResolutionEntry } from '../resolutions.js';
import type { SchemaProbeItem, SchemaProbeResult } from '../schema-probe.js';
import type {
  ExcludedTool,
  ObservedTool,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
  ToolSourceObservation,
} from '../types.js';

export const NEXT_DEFAULT_API_DIR = 'src/app/api';
const CONTRACT_FILE_NAMES = ['contract.ts', 'contract.tsx', 'contract.js', 'contract.mjs'];

interface RouteEntry {
  stableKey: string;
  method: EndpointMethod;
  path: string;
  pathParams: string[];
  sourceFile: string;
  absoluteFile: string;
  sourceFingerprint: string;
  source: string;
}

interface AnalyzedRoute {
  entry: RouteEntry;
  analysis?: HandlerAnalysis;
  contractModule?: string;
}

interface RoutePiece {
  entry: RouteEntry;
  resolved?: ResolvedEndpointContract;
  findings: ToolFinding[];
  evidence: ObservedTool['evidence'];
}

function incomplete(message: string): ToolSourceObservation {
  return {
    observations: [],
    findings: [toolFinding('E-INVENTORY-011', 'error', 'next-app', message)],
    complete: false,
    excluded: [],
  };
}

async function enumerateRoutes(
  root: string,
  apiDir: string,
): Promise<{ entries: RouteEntry[]; findings: ToolFinding[] } | ToolSourceObservation> {
  let scan: Awaited<ReturnType<typeof scanNextAppRoutes>>;
  try {
    scan = await scanNextAppRoutes({ rootDir: root, apiDir, mode: 'source-discovery' });
  } catch {
    return incomplete('Next.js route discovery is incomplete: a linked, oversized or unreadable file, or too many routes.');
  }
  const fatal = (scan.findings ?? []).find((finding) => finding.code !== 'route-export-unresolved');
  if (fatal) {
    return incomplete(fatal.code === 'route-wildcard-export-unresolved'
      ? `${fatal.sourceFile} uses export *, so its handlers cannot be enumerated.`
      : `${fatal.sourceFile} cannot be parsed.`);
  }
  const sources = new Map<string, string>();
  const read = async (sourceFile: string): Promise<string> => {
    const cached = sources.get(sourceFile);
    if (cached !== undefined) return cached;
    const source = await readFile(join(root, sourceFile), 'utf8');
    sources.set(sourceFile, source);
    return source;
  };
  const entries = new Map<string, RouteEntry>();
  const findings: ToolFinding[] = [];
  const add = (entry: RouteEntry) => {
    const existing = entries.get(entry.stableKey);
    if (existing && existing.sourceFile !== entry.sourceFile) {
      findings.push(toolFinding('E-INVENTORY-010', 'error', entry.stableKey,
        `${existing.sourceFile} and ${entry.sourceFile} both handle ${entry.stableKey}.`));
      return;
    }
    entries.set(entry.stableKey, entry);
  };
  for (const candidate of scan.candidates) {
    add({
      stableKey: `${candidate.method} ${candidate.path}`,
      method: candidate.method,
      path: candidate.path,
      pathParams: [...candidate.pathParams],
      sourceFile: candidate.sourceFile,
      absoluteFile: join(root, candidate.sourceFile),
      sourceFingerprint: candidate.sourceFingerprint,
      source: await read(candidate.sourceFile),
    });
  }
  for (const finding of scan.findings ?? []) {
    if (finding.code !== 'route-export-unresolved' || !finding.exportName) continue;
    const absoluteFile = join(root, finding.sourceFile);
    const route = toRoutePath(resolve(root, apiDir), absoluteFile);
    const source = await read(finding.sourceFile);
    add({
      stableKey: `${finding.exportName} ${route.path}`,
      method: finding.exportName,
      path: route.path,
      pathParams: route.pathParams,
      sourceFile: finding.sourceFile,
      absoluteFile,
      sourceFingerprint: createRouteSourceFingerprint(source, finding.exportName, route.path),
      source,
    });
  }
  return {
    entries: [...entries.values()].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    findings,
  };
}

function contractModuleOf(app: AppProgram, file: string): string | undefined {
  const sourceFile = app.sourceFile(file);
  if (!sourceFile) return undefined;
  const moduleSymbol = app.checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol || !app.checker.getExportsOfModule(moduleSymbol).some((symbol) => symbol.name === 'contract')) {
    return undefined;
  }
  return app.appRelative(file);
}

function observeRoute(
  ctx: ToolSourceContext,
  app: AppProgram,
  route: AnalyzedRoute,
  probes: ReadonlyMap<string, SchemaProbeResult>,
  resolution: ResolutionEntry | undefined,
): RoutePiece {
  const { entry, analysis, contractModule } = route;
  if (!analysis?.located?.fn) {
    return {
      entry,
      findings: [toolFinding('handler-unresolved', 'needs_attention', entry.stableKey,
        `The ${entry.method} export of ${entry.sourceFile} is not a function the generator can read.`)],
      evidence: { authEvidence: false, externalCall: false },
    };
  }
  const located = analysis.located;
  const evidence = collectHandlerEvidence({
    app, scope: located.scope, authHelpers: ctx.resolutions.conventions.authHelpers,
  });
  const inferredOutput = inferResponseSchema(app.checker, analysis.responseArguments);
  const candidate: ContractModuleCandidate | undefined = contractModule
    ? {
      module: contractModule,
      loadBearing: analysis.importedModules.includes(contractModule),
      result: probes.get(probeKey(contractEntryItem(contractModule, entry.method))) ?? { ok: false, reason: 'probe-failed' },
    }
    : undefined;
  const previousContract = ctx.previousContracts.get(entry.stableKey);
  const resolved = resolveEndpointContract({
    stableKey: entry.stableKey,
    method: entry.method,
    path: entry.path,
    pathParams: entry.pathParams,
    evidence: {
      schemaUses: analysis.schemaUses,
      queryKeys: analysis.queryKeys,
      repeatedQueryKeys: analysis.repeatedQueryKeys,
      bodyKeys: analysis.bodyKeys,
      readsBody: analysis.readsBody,
      ...(analysis.normalizedText !== undefined ? { normalizedText: analysis.normalizedText } : {}),
    },
    ...(inferredOutput ? { inferredOutput } : {}),
    probes,
    ...(candidate ? { contractModule: candidate } : {}),
    ...(resolution ? { resolution } : {}),
    ...(previousContract ? { previousContract } : {}),
  });
  const findings = [...resolved.findings];
  if (evidence.authEvidence.length === 0) {
    findings.push(toolFinding('auth-evidence-missing', 'needs_attention', entry.stableKey,
      `No session or auth helper call was found for ${entry.stableKey}; the tool stays disabled until the endpoint's authorization is visible.`));
  }
  return {
    entry,
    resolved,
    findings,
    evidence: {
      authEvidence: evidence.authEvidence.length > 0,
      externalCall: evidence.externalCall,
      ...(resolved.declaredEffect ? { declaredEffect: resolved.declaredEffect } : {}),
      ...(located.jsDoc ? { jsDoc: located.jsDoc } : {}),
    },
  };
}

function toObserved(piece: RoutePiece, definitionId: string): ObservedTool {
  const { entry, resolved } = piece;
  return {
    execution: {
      definitionId,
      stableKey: entry.stableKey,
      executionKind: 'endpoint',
      sourceKind: 'next-app',
      sourceFile: entry.sourceFile,
      method: entry.method,
      path: entry.path,
      sourceFingerprint: entry.sourceFingerprint,
      inputSchemaDigest: resolved?.inputSchemaDigest ?? OPAQUE_SCHEMA_DIGEST,
      outputSchemaDigest: resolved?.outputSchemaDigest ?? OPAQUE_SCHEMA_DIGEST,
    },
    ...(resolved?.contract ? { contract: resolved.contract } : {}),
    evidence: piece.evidence,
    findings: piece.findings,
    ...(resolved && Object.keys(resolved.prose).length > 0 ? { prose: resolved.prose } : {}),
  };
}

async function observeNextEndpoints(ctx: ToolSourceContext, apiDir: string): Promise<ToolSourceObservation> {
  if (!existsSync(resolve(ctx.root, apiDir))) {
    return { observations: [], findings: [], complete: true, excluded: [] };
  }
  const enumerated = await enumerateRoutes(ctx.root, apiDir);
  if (!('entries' in enumerated)) return enumerated;
  const findings: ToolFinding[] = [...enumerated.findings];
  const excluded: ExcludedTool[] = [];
  const kept: RouteEntry[] = [];
  const policyExcludes = ctx.policy.exclude ?? [];
  for (const entry of enumerated.entries) {
    const exclusion = findExclusion({
      stableKey: entry.stableKey,
      method: entry.method,
      path: entry.path,
      chatHandler: importsChatHandler(entry.source),
    }, policyExcludes);
    if (exclusion) excluded.push(exclusion);
    else kept.push(entry);
  }
  if (kept.length === 0) return { observations: [], findings, complete: true, excluded };

  const contractFiles = new Map<string, string>();
  for (const entry of kept) {
    const directory = dirname(entry.absoluteFile);
    if (contractFiles.has(directory)) continue;
    const file = CONTRACT_FILE_NAMES.map((name) => join(directory, name)).find((candidate) => existsSync(candidate));
    if (file) contractFiles.set(directory, file);
  }
  const app = createAppProgram({
    root: ctx.root,
    rootNames: [...new Set([...kept.map((entry) => entry.absoluteFile), ...contractFiles.values()])],
  });
  const conventions = ctx.resolutions.conventions;
  const analyzed: AnalyzedRoute[] = kept.map((entry) => {
    const sourceFile = app.sourceFile(entry.absoluteFile);
    const analysis = sourceFile
      ? analyzeRouteHandler({ app, sourceFile, method: entry.method, conventions })
      : undefined;
    const contractFile = contractFiles.get(dirname(entry.absoluteFile));
    const contractModule = contractFile ? contractModuleOf(app, contractFile) : undefined;
    return { entry, ...(analysis ? { analysis } : {}), ...(contractModule ? { contractModule } : {}) };
  });

  const resolutions = new Map<string, ResolutionEntry>();
  for (const { entry, analysis } of analyzed) {
    const raw = ctx.resolutions.entries.get(entry.stableKey);
    if (raw === undefined) continue;
    const validated = validateResolutionEntry({
      stableKey: entry.stableKey,
      raw,
      evidence: {
        pathParams: entry.pathParams,
        queryKeys: analysis?.queryKeys ?? [],
        bodyKeys: analysis?.bodyKeys ?? 'opaque',
      },
    });
    findings.push(...validated.findings);
    if (validated.entry) resolutions.set(entry.stableKey, validated.entry);
  }

  const items = new Map<string, SchemaProbeItem>();
  const request = (item: SchemaProbeItem) => items.set(probeKey(item), item);
  for (const { entry, analysis, contractModule } of analyzed) {
    for (const use of analysis?.schemaUses ?? []) {
      if (use.binding) request(probeItemFor(use.binding, use.role === 'output' ? 'output' : 'input'));
    }
    if (contractModule) request(contractEntryItem(contractModule, entry.method));
    const resolution = resolutions.get(entry.stableKey);
    if (resolution?.input?.schemaRef) request(probeItemFor(resolution.input.schemaRef, 'input'));
    if (resolution?.output?.schemaRef) request(probeItemFor(resolution.output.schemaRef, 'output'));
  }
  const keys = [...items.keys()].sort(compareCodeUnits);
  const results = keys.length > 0 ? await ctx.probe.probe(ctx.root, keys.map((key) => items.get(key)!)) : [];
  const probes = new Map<string, SchemaProbeResult>(keys.map((key, index) => [
    key,
    results[index] ?? { ok: false, reason: 'probe-failed' },
  ]));

  const pieces = analyzed.map((route) => observeRoute(ctx, app, route, probes, resolutions.get(route.entry.stableKey)));
  const naming = assignDefinitionIds(
    pieces.map(({ entry, resolved }) => ({
      stableKey: entry.stableKey,
      method: entry.method,
      path: entry.path,
      ...(resolved?.explicitId ? { explicitId: resolved.explicitId } : {}),
    })),
    new Map((ctx.previous?.inventory.executions ?? []).map((execution) => [execution.stableKey, execution.definitionId])),
  );
  findings.push(...naming.findings);
  return {
    observations: pieces.map((piece) => toObserved(piece, naming.ids.get(piece.entry.stableKey)!)),
    findings,
    complete: true,
    excluded,
  };
}

export function createNextEndpointSource(options: { apiDir?: string } = {}): ToolSource {
  const apiDir = options.apiDir ?? NEXT_DEFAULT_API_DIR;
  return { kind: 'next-app', observe: (ctx) => observeNextEndpoints(ctx, apiDir) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/sources/next-endpoints.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/types.ts src/codegen/tools/sources/next-endpoints.ts src/codegen/tools/sources/next-endpoints.test.ts
git commit -m "feat(codegen): observe next.js endpoints as tool sources"
```

### Task 15: Prose fallback and `tool-semantics.json`

**Files:**
- Create: `src/codegen/tools/prose.ts`
- Test: `src/codegen/tools/prose.test.ts`

**Interfaces:**
- Consumes: `ToolPresentationSchema`, `findSensitiveStringPath`, P02 `ToolPolicyDefaults`, `ToolProseHints`, `toolFinding`, `TOOLS_PATHS`.
- Produces:
  - `export type DescriptionOrigin = 'human' | 'code' | 'agent' | 'template'`
  - `export type ToolSemanticsEntry`; `export interface ToolSemantics { byStableKey: ReadonlyMap<string, ToolSemanticsEntry>; byName: ReadonlyMap<string, ToolSemanticsEntry> }`; `export const EMPTY_SEMANTICS: ToolSemantics`
  - `export function loadToolSemantics(root: string): { semantics: ToolSemantics; findings: ToolFinding[] }`
  - `export interface ToolProse { description: string; descriptionOrigin: DescriptionOrigin; module: string; sharedWith: string[]; usageHints: string[]; presentation: ToolPresentation; findings: ToolFinding[] }`
  - `export interface ResolveToolProseInput { stableKey: string; definitionId: string; method?: string; path?: string; operationGroup: ToolPolicyDefaults['operationGroup']; locale: string; jsDoc?: string; hints?: ToolProseHints; semantics: ToolSemantics; policyDescription?: string }`
  - `export function resolveToolProse(input: ResolveToolProseInput): ToolProse`

`tool-semantics.json` is read in the existing Get-It-Done format (`{schemaVersion: 1, tools: [{name, description, module, sharedWith, usageHints, presentation, …}]}`) plus an optional `stableKey` and `origin.description` (`human`/`code`/`agent`) per entry; unknown fields pass through for P05. Description order: local policy description → JSDoc → contract → `.describe()` → `tool-semantics.json` → locale template (`de*` German, everything else English).

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/prose.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_SEMANTICS, loadToolSemantics, resolveToolProse, type ResolveToolProseInput } from './prose.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function semanticsFile(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'glirastes-semantics-'));
  roots.push(root);
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await writeFile(join(root, '.glirastes/tool-semantics.json'), content);
  return loadToolSemantics(root);
}

const base: ResolveToolProseInput = {
  stableKey: 'POST /api/tasks',
  definitionId: 'tasks.create',
  method: 'POST',
  path: '/api/tasks',
  operationGroup: 'create',
  locale: 'en-US',
  semantics: EMPTY_SEMANTICS,
};

describe('tool prose', () => {
  it.each([
    [{ policyDescription: 'Policy text.', jsDoc: 'Doc text.' }, 'Policy text.', 'human'],
    [{ jsDoc: 'Doc text.', hints: { contractDescription: 'Contract text.' } }, 'Doc text.', 'code'],
    [{ hints: { contractDescription: 'Contract text.', schemaDescription: 'Schema text.' } }, 'Contract text.', 'code'],
    [{ hints: { schemaDescription: 'Schema text.' } }, 'Schema text.', 'code'],
    [{ jsDoc: `Bearer ${'a'.repeat(30)}`, hints: { schemaDescription: 'Schema text.' } }, 'Schema text.', 'code'],
  ] as const)('chooses the description by precedence (%#)', (overrides, description, origin) => {
    const prose = resolveToolProse({ ...base, ...overrides });
    expect(prose).toMatchObject({ description, descriptionOrigin: origin, findings: [] });
  });

  it('falls back to tool-semantics.json by stable key before name and keeps its origin', async () => {
    const { semantics, findings } = await semanticsFile(JSON.stringify({
      schemaVersion: 1,
      tools: [
        { name: 'tasks.create', description: 'By name.', module: 'task_mutation' },
        {
          stableKey: 'POST /api/tasks', description: 'By key.', module: 'task_mutation',
          sharedWith: ['task_mutation', 'calendar'], usageHints: ['Use for new tasks.'],
          presentation: { locale: 'de-DE', singular: 'Aufgabe anlegen', plural: 'Aufgaben anlegen', approval: 'Aufgabe anlegen?' },
          origin: { description: 'agent' },
        },
      ],
    }));
    expect(findings).toEqual([]);
    expect(resolveToolProse({ ...base, semantics })).toEqual({
      description: 'By key.',
      descriptionOrigin: 'agent',
      module: 'task_mutation',
      sharedWith: ['calendar'],
      usageHints: ['Use for new tasks.'],
      presentation: { locale: 'de-DE', singular: 'Aufgabe anlegen', plural: 'Aufgaben anlegen', approval: 'Aufgabe anlegen?' },
      findings: [],
    });
  });

  it('uses locale templates with a visible warning when no prose exists', () => {
    const english = resolveToolProse({ ...base, definitionId: 'tasksByDate.list', stableKey: 'GET /api/tasks-by-date', method: 'GET', path: '/api/tasks-by-date', operationGroup: 'read' });
    expect(english).toMatchObject({
      description: 'List tasks by date (GET /api/tasks-by-date).',
      descriptionOrigin: 'template',
      module: 'tasksByDate',
      sharedWith: [],
      usageHints: ['List tasks by date (GET /api/tasks-by-date).'],
      presentation: { locale: 'en-US', singular: 'List tasks by date', plural: 'List tasks by date', approval: 'List tasks by date' },
    });
    expect(english.findings.map((finding) => [finding.code, finding.severity])).toEqual([['description-templated', 'warning']]);
    const german = resolveToolProse({ ...base, locale: 'de-DE', definitionId: 'tasks.get', method: 'GET', path: '/api/tasks/:id', operationGroup: 'read' });
    expect(german.description).toBe('Tasks anzeigen (GET /api/tasks/:id).');
    expect(german.presentation.locale).toBe('de-DE');
  });

  it('prefers contract module, hints and presentation over semantics', async () => {
    const { semantics } = await semanticsFile(JSON.stringify({
      schemaVersion: 1, tools: [{ name: 'tasks.create', module: 'from_semantics', usageHints: ['From semantics.'] }],
    }));
    const prose = resolveToolProse({
      ...base,
      semantics,
      jsDoc: 'Creates a task.',
      hints: {
        module: 'task_mutation',
        usageHints: ['From the contract.'],
        presentation: { locale: 'en-US', singular: 'Create task', plural: 'Create tasks', approval: 'Create this task?' },
      },
    });
    expect(prose).toMatchObject({
      module: 'task_mutation',
      usageHints: ['From the contract.'],
      presentation: { singular: 'Create task', approval: 'Create this task?' },
    });
  });

  it('reports malformed semantics files and entries without failing', async () => {
    expect((await semanticsFile('{')).findings.map((finding) => finding.code)).toEqual(['tool-semantics-invalid']);
    const partial = await semanticsFile(JSON.stringify({ schemaVersion: 1, tools: [{ description: 'no key' }, { name: 'tasks.create', description: 'Kept.' }] }));
    expect(partial.findings.map((finding) => finding.subjectRef)).toEqual(['.glirastes/tool-semantics.json#0']);
    expect(partial.semantics.byName.get('tasks.create')?.description).toBe('Kept.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/prose.test.ts`
Expected: FAIL — `Failed to resolve import "./prose.js"`.

- [ ] **Step 3: Implement `prose.ts`**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findSensitiveStringPath } from '../../contracts/content-boundary.js';
import { ToolPresentationSchema, type ToolPresentation } from '../../contracts/index.js';
import type { ToolPolicyDefaults } from '../../contracts/tool-policy.js';
import { compareCodeUnits } from './canonical.js';
import { TOOLS_PATHS } from './config.js';
import { toolFinding } from './findings.js';
import type { ToolFinding, ToolProseHints } from './types.js';

export type DescriptionOrigin = 'human' | 'code' | 'agent' | 'template';

const MAX_DESCRIPTION = 1_000;
const MAX_HINT = 500;

const SemanticsEntrySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  stableKey: z.string().trim().min(1).max(2_100).optional(),
  description: z.string().optional(),
  module: z.string().optional(),
  sharedWith: z.array(z.string()).optional(),
  usageHints: z.array(z.string()).optional(),
  presentation: z.unknown().optional(),
  origin: z.record(z.string(), z.string()).optional(),
}).passthrough();

const SemanticsFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.array(z.unknown()).max(5_000),
}).passthrough();

export type ToolSemanticsEntry = z.infer<typeof SemanticsEntrySchema>;

export interface ToolSemantics {
  byStableKey: ReadonlyMap<string, ToolSemanticsEntry>;
  byName: ReadonlyMap<string, ToolSemanticsEntry>;
}

export const EMPTY_SEMANTICS: ToolSemantics = { byStableKey: new Map(), byName: new Map() };

export function loadToolSemantics(root: string): { semantics: ToolSemantics; findings: ToolFinding[] } {
  let raw: string;
  try {
    raw = readFileSync(resolve(root, TOOLS_PATHS.semantics), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { semantics: EMPTY_SEMANTICS, findings: [] };
    throw error;
  }
  const invalid = (message: string) => ({
    semantics: EMPTY_SEMANTICS,
    findings: [toolFinding('tool-semantics-invalid', 'warning', TOOLS_PATHS.semantics, message)],
  });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid('tool-semantics.json is not valid JSON and is ignored.');
  }
  const file = SemanticsFileSchema.safeParse(json);
  if (!file.success) return invalid('tool-semantics.json does not match its schema and is ignored.');
  const byStableKey = new Map<string, ToolSemanticsEntry>();
  const byName = new Map<string, ToolSemanticsEntry>();
  const findings: ToolFinding[] = [];
  file.data.tools.forEach((value, index) => {
    const entry = SemanticsEntrySchema.safeParse(value);
    if (!entry.success || (!entry.data.stableKey && !entry.data.name)) {
      findings.push(toolFinding('tool-semantics-invalid', 'warning', `${TOOLS_PATHS.semantics}#${index}`,
        `Entry ${index} of tool-semantics.json is invalid and is ignored.`));
      return;
    }
    if (entry.data.stableKey) byStableKey.set(entry.data.stableKey, entry.data);
    if (entry.data.name) byName.set(entry.data.name, entry.data);
  });
  return { semantics: { byStableKey, byName }, findings };
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || findSensitiveStringPath(text)) return undefined;
  return text.slice(0, max);
}

function identifier(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length <= 200 ? text : undefined;
}

function capitalized(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function resourceWords(definitionId: string): string {
  const resource = definitionId.split('.')[0] ?? definitionId;
  return resource
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim() || 'item';
}

type Operation = 'list' | 'get' | 'create' | 'update' | 'delete' | 'ui';

const LABELS: Readonly<Record<'en' | 'de', Readonly<Record<Operation, (words: string) => string>>>> = {
  en: {
    list: (words) => `List ${words}`,
    get: (words) => `Show ${words}`,
    create: (words) => `Create ${words}`,
    update: (words) => `Update ${words}`,
    delete: (words) => `Delete ${words}`,
    ui: (words) => `Run ${words}`,
  },
  de: {
    list: (words) => `${capitalized(words)} auflisten`,
    get: (words) => `${capitalized(words)} anzeigen`,
    create: (words) => `${capitalized(words)} anlegen`,
    update: (words) => `${capitalized(words)} ändern`,
    delete: (words) => `${capitalized(words)} löschen`,
    ui: (words) => `${capitalized(words)} ausführen`,
  },
};

function operationOf(group: ToolPolicyDefaults['operationGroup'], path: string | undefined): Operation {
  if (group === 'read') return path && /\/:[^/]+$/.test(path) ? 'get' : 'list';
  return group;
}

function presentationOf(value: unknown): ToolPresentation | undefined {
  const parsed = ToolPresentationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface ToolProse {
  description: string;
  descriptionOrigin: DescriptionOrigin;
  module: string;
  sharedWith: string[];
  usageHints: string[];
  presentation: ToolPresentation;
  findings: ToolFinding[];
}

export interface ResolveToolProseInput {
  stableKey: string;
  definitionId: string;
  method?: string;
  path?: string;
  operationGroup: ToolPolicyDefaults['operationGroup'];
  locale: string;
  jsDoc?: string;
  hints?: ToolProseHints;
  semantics: ToolSemantics;
  policyDescription?: string;
}

/** Prose without a model; templates are the visible floor, never a blocker. */
export function resolveToolProse(input: ResolveToolProseInput): ToolProse {
  const entry = input.semantics.byStableKey.get(input.stableKey) ?? input.semantics.byName.get(input.definitionId);
  const entryOrigin: DescriptionOrigin = entry?.origin?.description === 'agent'
    ? 'agent'
    : entry?.origin?.description === 'code' ? 'code' : 'human';
  const language = input.locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  const label = LABELS[language][operationOf(input.operationGroup, input.path)](resourceWords(input.definitionId));
  const candidates: ReadonlyArray<readonly [string | undefined, DescriptionOrigin]> = [
    [input.policyDescription, 'human'],
    [input.jsDoc, 'code'],
    [input.hints?.contractDescription, 'code'],
    [input.hints?.schemaDescription, 'code'],
    [entry?.description, entryOrigin],
  ];
  const findings: ToolFinding[] = [];
  let description: string | undefined;
  let descriptionOrigin: DescriptionOrigin = 'template';
  for (const [value, origin] of candidates) {
    const text = bounded(value, MAX_DESCRIPTION);
    if (text) {
      description = text;
      descriptionOrigin = origin;
      break;
    }
  }
  if (!description) {
    description = input.method && input.path ? `${label} (${input.method} ${input.path}).` : `${label}.`;
    findings.push(toolFinding('description-templated', 'warning', input.stableKey,
      'Only a template description is available; the model may pick this tool less reliably.'));
  }
  const module = identifier(input.hints?.module)
    ?? identifier(entry?.module)
    ?? (input.definitionId.split('.')[0] || 'tools');
  const sharedWith = [...new Set((entry?.sharedWith ?? [])
    .map(identifier)
    .filter((value): value is string => value !== undefined && value !== module))]
    .sort(compareCodeUnits)
    .slice(0, 50);
  const hintSource = input.hints?.usageHints?.length
    ? input.hints.usageHints
    : entry?.usageHints?.length ? entry.usageHints : [description];
  const usageHints = hintSource
    .map((hint) => bounded(hint, MAX_HINT))
    .filter((hint): hint is string => hint !== undefined)
    .slice(0, 20);
  const presentation = input.hints?.presentation
    ?? presentationOf(entry?.presentation)
    ?? { locale: input.locale, singular: label, plural: label, approval: label };
  return {
    description,
    descriptionOrigin,
    module,
    sharedWith,
    usageHints: usageHints.length > 0 ? usageHints : [description.slice(0, MAX_HINT)],
    presentation,
    findings,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/prose.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/prose.ts src/codegen/tools/prose.test.ts
git commit -m "feat(codegen): resolve tool prose without a model"
```

### Task 16: Shared setup-plan core and manifests with `policyDigest`

**Files:**
- Modify: `src/cli/commands/setup-plan.ts` (whole file as left by P02 Task 10: export `compareArtifacts`, pure `createSetupPlanFromContents`, `createSetupPlan` delegates; P02's `classifyNewTool` stays byte-for-byte)
- Modify: `src/cli/commands/validate-build.ts` (export `LocalPromptBundleSchema`, `computePolicyDigest`, `renderManifestContents`; `validateWorkspace` returns the parsed artifact)
- Test: `src/cli/commands/setup-plan.test.ts`, `src/cli/commands/manifest-contents.test.ts`

**Interfaces:**
- Consumes: `classifyToolSemanticChange`, `assertAppSetupSemanticParity`, `AppSetupArtifactSchema`, `SetupProfile`; from P02: `SemanticChangeClassification` with `'added'` (P02 Task 10), `deriveToolPolicyDefaults`, `riskTier` and the private `classifyNewTool`/`compareArtifacts` in `setup-plan.ts` (P02 Task 10).
- Produces:
  - `export function compareArtifacts(previous: AppSetupArtifact | undefined, proposed: AppSetupArtifact): SemanticChange[]` (P02's behaviour, now exported: a new tool at its defaults ⇒ `{ classification: 'added', fields: ['toolId'], requiresConfirmation: false }`; a new tool below its defaults stays a confirmable `loosening`)
  - `export interface SetupPlanContents { mode: 'standalone' | 'managed'; paths: SetupProfile['paths']; proposed: { path: string; raw: string }; previousRaw?: string; inventoryRaw: string; promptBundleRaw: string }`
  - `export function createSetupPlanFromContents(input: SetupPlanContents): SetupPlan`
  - `export const LocalPromptBundleSchema`; `export type LocalPromptBundle`
  - `export function computePolicyDigest(artifact: AppSetupArtifact): string`
  - `export interface ManifestRenderInput { appId: string; targetAppKey: string; inventoryDigest: string; executions: ReadonlyArray<{ toolId: string; stableKey: string; executionKind: 'endpoint' | 'ui'; sourceFingerprint: string; inputSchemaDigest: string; outputSchemaDigest: string }>; promptBundle: LocalPromptBundle; setupArtifact?: AppSetupArtifact }`
  - `export function renderManifestContents(input: ManifestRenderInput): RenderedManifests`

The runtime manifest gains `policyDigest` (digest of `toolId`, `enabled`, `requiresApproval`, `riskClass`, sorted `allowedRoles` per tool) whenever a setup artifact exists. Existing apps with a committed `runtime-manifest.json` see one diff on their next refresh or setup; doctor and `glirastes build` render the same field.

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/commands/setup-plan.test.ts` inside `describe('createSetupPlan', …)`:

```ts
  it('classifies tools missing from the previous artifact as added without confirmation', async () => {
    const root = await fixture();
    const empty = { ...artifact(), tools: [], planner: { ...artifact().planner, toolIds: [] } };
    await writeFile(join(root, '.glirastes/previous-setup-artifact.json'), `${JSON.stringify(empty)}\n`);
    const plan = await createSetupPlan({ rootDir: root });
    expect(plan.semanticChanges).toEqual([{
      toolId: id('4'), classification: 'added', fields: ['toolId'], requiresConfirmation: false,
    }]);
    expect(plan.requiresConfirmation).toBe(false);
    expect(compareArtifacts(undefined, AppSetupArtifactSchema.parse(artifact())))
      .toEqual([{ toolId: id('4'), classification: 'added', fields: ['toolId'], requiresConfirmation: false }]);
  });

  it('computes the identical plan from file contents', async () => {
    const root = await fixture();
    const read = (path: string) => readFile(join(root, path), 'utf8');
    const fromFiles = await createSetupPlan({ rootDir: root });
    const fromContents = createSetupPlanFromContents({
      mode: 'standalone',
      paths: {
        inventory: '.glirastes/foundation-execution-inventory.json',
        setupArtifact: '.glirastes/setup-artifact.json',
        canonicalSetupArtifact: '.glirastes/setup-artifact.json',
        previousSetupArtifact: '.glirastes/previous-setup-artifact.json',
        promptBundle: '.glirastes/prompt-bundle.json',
        buildDir: '.glirastes/build',
        receipt: '.glirastes/setup-receipt.json',
      },
      proposed: { path: '.glirastes/setup-artifact.json', raw: await read('.glirastes/setup-artifact.json') },
      previousRaw: await read('.glirastes/previous-setup-artifact.json'),
      inventoryRaw: await read('.glirastes/foundation-execution-inventory.json'),
      promptBundleRaw: await read('.glirastes/prompt-bundle.json'),
    });
    expect(fromContents).toEqual(fromFiles);
  });
```

and extend the file's imports:

```ts
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import {
  assertSetupPlanConfirmation,
  compareArtifacts,
  createSetupPlan,
  createSetupPlanFromContents,
} from './setup-plan.js';
```

(replacing the existing `import { createSetupPlan, assertSetupPlanConfirmation } from './setup-plan.js';`).

Create `src/cli/commands/manifest-contents.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { computePolicyDigest, LocalPromptBundleSchema, renderManifestContents } from './validate-build.js';

const id = (suffix: string) => `019fa9a9-d5f7-7ec3-a3c7-8899de30${suffix.padStart(4, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;

function artifact(requiresApproval: boolean) {
  return AppSetupArtifactSchema.parse({
    schemaVersion: 1,
    artifactId: id('1'),
    runId: id('2'),
    appId: id('3'),
    discoveryDigest: digest('A'),
    assessmentMode: 'autonomous',
    status: 'ready',
    tools: [{
      toolId: id('4'), sourceFingerprint: digest('B'), name: 'tasks.create', description: 'Create a task.',
      modelName: 'tasks_create', module: 'tasks', sharedWith: [], usageHints: ['Create a task.'],
      presentation: { locale: 'en-US', singular: 'Create task', plural: 'Create tasks', approval: 'Create task' },
      executionKind: 'endpoint', method: 'POST', path: '/api/tasks', operationGroup: 'create',
      riskClass: 'write', enabled: true, requiresApproval, allowedRoles: ['member', 'admin'],
      inputSchemaDigest: digest('C'), outputSchemaDigest: digest('D'),
    }],
    planner: { plannerId: id('5'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('4')] },
    prompts: {
      bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'),
      appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-10-04T08:00:00.000Z',
  });
}

const promptBundle = LocalPromptBundleSchema.parse({
  schemaVersion: 1,
  appId: id('3'),
  artifactRef: 'local://fixture/prompts',
  sections: { planner: 'Plan.', appBehavior: 'Behave.', responseStyle: 'Short.' },
});

const input = {
  appId: id('3'),
  targetAppKey: 'fixture',
  inventoryDigest: digest('I'),
  executions: [{
    toolId: id('4'), stableKey: 'POST /api/tasks', executionKind: 'endpoint' as const,
    sourceFingerprint: digest('B'), inputSchemaDigest: digest('C'), outputSchemaDigest: digest('D'),
  }],
  promptBundle,
};

describe('renderManifestContents', () => {
  it('adds a policy digest that follows the effective policy only when an artifact exists', () => {
    const without = JSON.parse(renderManifestContents(input).runtimeContent) as Record<string, unknown>;
    expect(without).not.toHaveProperty('policyDigest');
    const strict = renderManifestContents({ ...input, setupArtifact: artifact(true) });
    const relaxed = renderManifestContents({ ...input, setupArtifact: artifact(false) });
    expect(JSON.parse(strict.runtimeContent).policyDigest).toBe(computePolicyDigest(artifact(true)));
    expect(strict.runtimeDigest).not.toBe(relaxed.runtimeDigest);
    expect(strict.promptDigest).toBe(relaxed.promptDigest);
  });

  it('ignores role order in the policy digest', () => {
    const reordered = AppSetupArtifactSchema.parse({
      ...artifact(true),
      tools: artifact(true).tools.map((tool) => ({ ...tool, allowedRoles: ['admin', 'member'] })),
    });
    expect(computePolicyDigest(reordered)).toBe(computePolicyDigest(artifact(true)));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/setup-plan.test.ts src/cli/commands/manifest-contents.test.ts`
Expected: FAIL — `compareArtifacts is not a function` and `createSetupPlanFromContents is not a function` in `setup-plan.test.ts` (the `createSetupPlan` half of the first new test already passes thanks to P02 Task 10), and `manifest-contents.test.ts` fails at import time with `Cannot read properties of undefined (reading 'parse')` because `LocalPromptBundleSchema` is not exported; `renderManifestContents`/`computePolicyDigest` are missing as well.

- [ ] **Step 3: Confirm the P02 baseline this task builds on**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && grep -n "| 'added'" src/contracts/semantic-change.ts && grep -n "function classifyNewTool" src/cli/commands/setup-plan.ts`
Expected: one match each (P02 Task 10). If either is missing, stop: P02 is not complete on this branch. `src/contracts/semantic-change.ts` is not touched by this task.

- [ ] **Step 4: Refactor `setup-plan.ts`**

Replace the whole file content (P02 Task 10's version) with the following. Imports, `classifyNewTool` and the body of `compareArtifacts` are P02's code unchanged; only `export` is added to `compareArtifacts`, file reading moves into `createSetupPlan`, and the plan computation moves into the pure `createSetupPlanFromContents`:

```ts
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  AppSetupArtifactSchema,
  assertAppSetupSemanticParity,
  classifyToolSemanticChange,
  deriveToolPolicyDefaults,
  riskTier,
  type AppSetupArtifact,
  type AppSetupToolCandidate,
  type SemanticChange,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import { detectSetupProfile, type SetupProfile } from './setup-profile.js';

export interface SetupPlanOperation {
  kind: 'validate' | 'adopt' | 'build' | 'receipt' | 'sync';
  path: string;
  digest: string;
}

export interface SetupPlan {
  schemaVersion: 1;
  mode: 'standalone' | 'managed';
  planDigest: string;
  operations: SetupPlanOperation[];
  counts: { tools: number; semanticChanges: number };
  semanticChanges: SemanticChange[];
  diagnostics: Array<{ code: string; operation: string }>;
  requiresConfirmation: boolean;
}

export interface CreateSetupPlanOptions {
  rootDir: string;
  artifactPath?: string;
  previousArtifactPath?: string;
  inventoryPath?: string;
  promptBundlePath?: string;
  managed?: boolean;
}

export interface SetupPlanContents {
  mode: 'standalone' | 'managed';
  paths: SetupProfile['paths'];
  proposed: { path: string; raw: string };
  /** Undefined when no previous artifact exists. */
  previousRaw?: string;
  inventoryRaw: string;
  promptBundleRaw: string;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('base64url')}`;
}

function boundedPath(rootDir: string, path: string): {
  absolute: string;
  relative: string;
} {
  const absolute = resolve(rootDir, path);
  const local = relative(resolve(rootDir), absolute);
  if (
    local === ''
    || local.startsWith('..')
    || isAbsolute(local)
    || local.length > 2_048
  ) {
    throw new FoundationDiagnosticError({
      code: 'E-SETUP-003',
      operation: 'setup.plan',
      message: 'A setup artifact path is outside the workspace.',
      remediation: 'choose-workspace-artifact-path',
    });
  }
  return { absolute, relative: local };
}

async function readRaw(
  rootDir: string,
  path: string,
  required: boolean,
): Promise<{ raw: string; path: string } | undefined> {
  const bounded = boundedPath(rootDir, path);
  try {
    return { raw: await readFile(bounded.absolute, 'utf8'), path: bounded.relative };
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function resolvePreviousArtifactPath(
  rootDir: string,
  proposedPath: string,
  canonicalPath: string,
  configuredPath: string | undefined,
  defaultPreviousPath: string,
): Promise<string | undefined> {
  if (configuredPath) return configuredPath;
  const previous = boundedPath(rootDir, defaultPreviousPath);
  if (await exists(previous.absolute)) return previous.relative;
  if (proposedPath === canonicalPath) return proposedPath;
  const canonical = boundedPath(rootDir, canonicalPath);
  if (await exists(canonical.absolute)) return canonical.relative;
  return undefined;
}

/**
 * A tool that is new in the proposal needs no confirmation when its policy is
 * at least as strict as the deterministic defaults for its route. Only a
 * committed relaxation below those defaults stays a confirmable loosening.
 */
function classifyNewTool(tool: AppSetupToolCandidate): SemanticChange {
  const defaults = deriveToolPolicyDefaults({
    executionKind: tool.executionKind,
    ...(tool.method ? { method: tool.method } : {}),
    ...(tool.path ? { path: tool.path } : {}),
    definitionId: tool.name,
  });
  const relaxedFields: string[] = [];
  if (riskTier(tool.riskClass) < riskTier(defaults.riskClass)) {
    relaxedFields.push('riskClass');
  }
  const approvalExpected = defaults.requiresApproval
    || riskTier(tool.riskClass) >= 2;
  if (approvalExpected && !tool.requiresApproval) {
    relaxedFields.push('requiresApproval');
  }
  if (relaxedFields.length === 0) {
    return {
      toolId: tool.toolId,
      classification: 'added',
      fields: ['toolId'],
      requiresConfirmation: false,
    };
  }
  return {
    toolId: tool.toolId,
    classification: 'loosening',
    fields: ['toolId', ...relaxedFields],
    requiresConfirmation: true,
  };
}

/** P02's classification, exported for the tools generator and the corpus tests. */
export function compareArtifacts(
  previous: AppSetupArtifact | undefined,
  proposed: AppSetupArtifact,
): SemanticChange[] {
  const previousTools = previous?.tools ?? [];
  const proposedById = new Map(proposed.tools.map((tool) => [tool.toolId, tool]));
  const previousById = new Map(previousTools.map((tool) => [tool.toolId, tool]));
  const changes: SemanticChange[] = proposed.tools.map((tool) => {
    const before = previousById.get(tool.toolId);
    return before
      ? classifyToolSemanticChange(before, tool)
      : classifyNewTool(tool);
  });
  for (const tool of previousTools) {
    if (!proposedById.has(tool.toolId)) {
      changes.push({
        toolId: tool.toolId,
        classification: 'hardening',
        fields: ['toolId'],
        requiresConfirmation: false,
      });
    }
  }
  return changes.sort((left, right) => left.toolId.localeCompare(right.toolId));
}

/** Pure plan core shared by file-based setup and the tools generator. */
export function createSetupPlanFromContents(input: SetupPlanContents): SetupPlan {
  const proposed = AppSetupArtifactSchema.parse(JSON.parse(input.proposed.raw));
  const previous = input.previousRaw === undefined
    ? undefined
    : AppSetupArtifactSchema.parse(JSON.parse(input.previousRaw));
  assertAppSetupSemanticParity(proposed, proposed.tools.map((tool) => tool.name));
  if (previous) {
    assertAppSetupSemanticParity(previous, previous.tools.map((tool) => tool.name));
  }
  const semanticChanges = compareArtifacts(previous, proposed);
  const proposedDigest = sha256(input.proposed.raw);
  const buildInputDigest = sha256(JSON.stringify({
    setup: proposedDigest,
    inventory: sha256(input.inventoryRaw),
    promptBundle: sha256(input.promptBundleRaw),
  }));
  const body = {
    schemaVersion: 1 as const,
    mode: input.mode,
    operations: [
      { kind: 'validate' as const, path: input.proposed.path, digest: proposedDigest },
      { kind: 'adopt' as const, path: input.paths.canonicalSetupArtifact, digest: proposedDigest },
      { kind: 'build' as const, path: input.paths.buildDir, digest: buildInputDigest },
      { kind: 'receipt' as const, path: input.paths.receipt, digest: proposedDigest },
      ...(input.mode === 'managed' ? [{
        kind: 'sync' as const,
        path: input.proposed.path,
        digest: proposedDigest,
      }] : []),
    ],
    counts: {
      tools: proposed.tools.length,
      semanticChanges: semanticChanges.length,
    },
    semanticChanges,
    diagnostics: [] as Array<{ code: string; operation: string }>,
    requiresConfirmation: semanticChanges.some((change) => change.requiresConfirmation),
  };
  return { ...body, planDigest: sha256(JSON.stringify(body)) };
}

export async function createSetupPlan(
  options: CreateSetupPlanOptions,
): Promise<SetupPlan> {
  const profile = await detectSetupProfile({
    rootDir: options.rootDir,
    managed: options.managed,
    artifactPath: options.artifactPath,
    inventoryPath: options.inventoryPath,
    promptBundlePath: options.promptBundlePath,
  });
  const proposed = await readRaw(options.rootDir, profile.paths.setupArtifact, true);
  if (!proposed) throw new Error('unreachable');
  const previousPath = await resolvePreviousArtifactPath(
    options.rootDir,
    proposed.path,
    profile.paths.canonicalSetupArtifact,
    options.previousArtifactPath,
    profile.paths.previousSetupArtifact,
  );
  const previous = await readRaw(
    options.rootDir,
    previousPath ?? profile.paths.previousSetupArtifact,
    false,
  );
  const inventory = await readRaw(options.rootDir, profile.paths.inventory, true);
  const promptBundle = await readRaw(options.rootDir, profile.paths.promptBundle, true);
  return createSetupPlanFromContents({
    mode: profile.mode,
    paths: profile.paths,
    proposed,
    ...(previous ? { previousRaw: previous.raw } : {}),
    inventoryRaw: inventory!.raw,
    promptBundleRaw: promptBundle!.raw,
  });
}

export function assertSetupPlanConfirmation(
  plan: SetupPlan,
  confirmation: { confirmLoosening?: boolean; planDigest?: string },
): void {
  if (!plan.requiresConfirmation) return;
  if (
    !confirmation.confirmLoosening
    || confirmation.planDigest !== plan.planDigest
  ) {
    throw new FoundationDiagnosticError({
      code: 'E-SEMANTICS-004',
      operation: 'setup.plan-confirmation',
      message: 'A semantic loosening requires confirmation of this exact plan.',
      remediation: 'confirm-plan-digest',
      identifier: plan.planDigest,
    });
  }
}
```

- [ ] **Step 5: Refactor `validate-build.ts`**

1. Change `const LocalPromptBundleSchema = z.object({` to `export const LocalPromptBundleSchema = z.object({`.
2. Replace `import { assertAppSetupSemanticParity } from '../../contracts/app-setup.js';` with `import { assertAppSetupSemanticParity, type AppSetupArtifact } from '../../contracts/app-setup.js';`.
3. Add `setupArtifact?: AppSetupArtifact;` to `interface ValidatedWorkspace`. In `validateWorkspace`, declare `let parsedArtifact: AppSetupArtifact | undefined;` directly before `if (existsSync(setupArtifactPath)) {`, add `parsedArtifact = parsed;` as the last statement inside that block (after the two `discoveryDigest`/`appId` checks), and add `...(parsedArtifact ? { setupArtifact: parsedArtifact } : {}),` to the returned object. (The block already has a local `const setupArtifact` holding the raw JSON; the new name avoids shadowing it.)
4. Replace `renderManifests` with the following four declarations (the `RenderedManifests`/`RenderManifestOptions` interfaces stay unchanged):

```ts
/** Digest of the effective, security-relevant policy per tool. */
export function computePolicyDigest(artifact: AppSetupArtifact): string {
  return digestOf({
    tools: [...artifact.tools]
      .map((tool) => ({
        toolId: tool.toolId,
        enabled: tool.enabled,
        requiresApproval: tool.requiresApproval,
        riskClass: tool.riskClass,
        allowedRoles: [...tool.allowedRoles ?? []].sort(),
      }))
      .sort((left, right) => left.toolId.localeCompare(right.toolId)),
  });
}

export interface ManifestRenderInput {
  appId: string;
  targetAppKey: string;
  inventoryDigest: string;
  executions: ReadonlyArray<{
    toolId: string;
    stableKey: string;
    executionKind: 'endpoint' | 'ui';
    sourceFingerprint: string;
    inputSchemaDigest: string;
    outputSchemaDigest: string;
  }>;
  promptBundle: LocalPromptBundle;
  setupArtifact?: AppSetupArtifact;
}

/** Pure manifest rendering shared by build, setup, doctor and the tools generator. */
export function renderManifestContents(input: ManifestRenderInput): RenderedManifests {
  const executions = [...input.executions]
    .map((execution) => ({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      executionKind: execution.executionKind,
      sourceFingerprint: execution.sourceFingerprint,
      inputSchemaDigest: execution.inputSchemaDigest,
      outputSchemaDigest: execution.outputSchemaDigest,
    }))
    .sort((left, right) => left.toolId.localeCompare(right.toolId));
  const runtimeBody = {
    schemaVersion: 1 as const,
    appId: input.appId,
    targetAppKey: input.targetAppKey,
    inventoryDigest: input.inventoryDigest,
    executions,
    ...(input.setupArtifact ? { policyDigest: computePolicyDigest(input.setupArtifact) } : {}),
  };
  const runtimeManifest = {
    ...runtimeBody,
    runtimeDigest: digestOf(runtimeBody),
  };

  const { sections } = input.promptBundle;
  const groupDigests: Record<string, string> = {
    planner: digestOf(sections.planner),
    appBehavior: digestOf(sections.appBehavior),
    responseStyle: digestOf(sections.responseStyle),
    ...Object.fromEntries(
      Object.entries(sections.capabilityFragments)
        .map(([name, content]) => [name, digestOf(content)]),
    ),
  };
  const promptBody = {
    schemaVersion: 1 as const,
    appId: input.appId,
    artifactRef: input.promptBundle.artifactRef,
    groupDigests,
  };
  const promptManifest = {
    ...promptBody,
    promptDigest: digestOf(promptBody),
  };
  return {
    runtimeContent: `${JSON.stringify(canonicalValue(runtimeManifest), null, 2)}\n`,
    promptContent: `${JSON.stringify(canonicalValue(promptManifest), null, 2)}\n`,
    runtimeDigest: runtimeManifest.runtimeDigest,
    promptDigest: promptManifest.promptDigest,
  };
}

/** Render the complete build outputs in memory for an atomic caller. */
export async function renderManifests(
  options: RenderManifestOptions,
): Promise<RenderedManifests> {
  const workspace = await validateWorkspace(options);
  return renderManifestContents({
    appId: workspace.appId,
    targetAppKey: workspace.inventory.targetAppKey,
    inventoryDigest: workspace.inventoryDigest,
    executions: workspace.executions,
    promptBundle: workspace.promptBundle,
    ...(workspace.setupArtifact ? { setupArtifact: workspace.setupArtifact } : {}),
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/setup-plan.test.ts src/cli/commands/manifest-contents.test.ts src/cli/validate-build.test.ts src/cli/commands/apply-setup-plan.test.ts src/cli/commands/doctor.test.ts src/cli/commands/sync.test.ts src/cli/setup.test.ts src/contracts/__tests__/semantic-change.test.ts && bun run typecheck`
Expected: PASS — including P02's new-tool tests in `setup-plan.test.ts` ("adds a new tool at its route defaults…", "keeps … as a confirmable loosening"), which prove `classifyNewTool` survived the refactor; existing setup, doctor and sync suites stay green because they render manifests through the same function on both sides; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/setup-plan.ts src/cli/commands/validate-build.ts src/cli/commands/setup-plan.test.ts src/cli/commands/manifest-contents.test.ts
git commit -m "feat(setup): share the setup plan core and add a policy digest"
```

### Task 17: Setup artifact, tool contracts and tool report

**Files:**
- Create: `src/codegen/tools/artifact.ts`
- Test: `src/codegen/tools/artifact.test.ts`

**Interfaces:**
- Consumes: `AppSetupArtifactSchema`, `ToolRiskClassSchema`, P02 `confirmationFloor` and `EffectiveToolPolicy`, `LocalPromptBundle` (Task 16), `modelFacingToolName`, `canonicalRuntimeJson` (`src/sync/signature-verifier.ts`), `canonicalJson`, `deterministicUuid`, `sha256Digest`, `sortFindings`, `TRANSIENT_FINDING_CODES`, `ToolProse`, `ToolContractsFileSchema` (for the round-trip test).
- Produces:
  - `export const EPOCH = '1970-01-01T00:00:00.000Z'`
  - `export interface ArtifactToolInput { execution: FoundationExecutionInventory['executions'][number]; prose: ToolProse; effective: EffectiveToolPolicy; operationGroup: AppSetupOperationGroup }`
  - `export interface PreviousArtifact { artifact?: AppSetupArtifact; planner?: AppSetupArtifact['planner'] }`
  - `export interface BuildSetupArtifactInput { appId: string; targetAppKey: string; discoveryDigest: string; tools: ReadonlyArray<ArtifactToolInput>; promptBundle: Pick<LocalPromptBundle, 'artifactRef' | 'sections'>; warnings: ReadonlyArray<{ code: string; subjectRef: string }>; previous?: PreviousArtifact; now: (() => Date) | null }`
  - `export function promptMetadata(bundle: Pick<LocalPromptBundle, 'artifactRef' | 'sections'>): AppSetupArtifact['prompts']`
  - `export function buildSetupArtifact(input: BuildSetupArtifactInput): { artifact: AppSetupArtifact; raw: string }`
  - `export function renderToolContracts(appId: string, entries: ReadonlyArray<ToolContractsEntry>): string`
  - `export type SchemaQuality = 'zod' | 'openapi' | 'json-schema' | 'agent' | 'field-names' | 'none'`; `export function schemaQualityOf(contract: ToolContract | null | undefined, resolutionOrigin?: 'human' | 'agent'): SchemaQuality`
  - `export interface ToolReportTool { toolId: string; stableKey: string; definitionId: string; enabled: boolean; riskClass: ToolRiskClass; requiresApproval: boolean; contractSource: ContractSource | null; quality: { description: DescriptionOrigin; schema: SchemaQuality } }`
  - `export const ToolReportFileSchema`; `export type ToolReportFile`
  - `export function renderToolReport(input: { appId: string; discoveryDigest: string; tools: ReadonlyArray<ToolReportTool>; findings: ReadonlyArray<ToolFinding>; excluded: ReadonlyArray<ExcludedTool> }): string`

`artifactId`/`runId` = UUIDv5(appId, kind, content digest) where the content digest covers the parsed artifact without `artifactId`, `runId`, `generatedAt`. `generatedAt` is carried when the content digest equals the previous artifact's; otherwise `now()` in write mode, and in frozen mode (`now: null`) the previous value or the epoch (a content change is drift anyway). `tool-report.json` holds no messages and no change-relative findings.

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/artifact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertAppSetupSemanticParity, type AppSetupOperationGroup } from '../../contracts/index.js';
import type { EffectiveToolPolicy } from '../../contracts/tool-policy.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import {
  buildSetupArtifact,
  EPOCH,
  promptMetadata,
  renderToolContracts,
  renderToolReport,
  schemaQualityOf,
  ToolReportFileSchema,
  type ArtifactToolInput,
} from './artifact.js';
import { canonicalJson, sha256Digest } from './canonical.js';
import { ToolContractsFileSchema } from './files.js';
import { toolFinding } from './findings.js';
import type { ToolContract } from './types.js';

const APP_ID = '019fb007-0000-7000-8000-0000000000a1';
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const bundle = {
  artifactRef: 'local://fixture/prompts',
  sections: { planner: 'Plan.', appBehavior: 'Behave.', responseStyle: 'Short.', capabilityFragments: { tasks: 'Tasks.' } },
};

function effective(overrides: Partial<EffectiveToolPolicy> = {}): EffectiveToolPolicy {
  return {
    enabled: true,
    requiresApproval: false,
    riskClass: 'safe-read',
    allowedRoles: [],
    origin: {
      enabled: 'code-default', requiresApproval: 'code-default', riskClass: 'code-default',
      allowedRoles: 'code-default', description: 'code-default',
    },
    ...overrides,
  };
}

function tool(
  toolId: string,
  definitionId: string,
  overrides: { effective?: Partial<EffectiveToolPolicy>; operationGroup?: AppSetupOperationGroup } = {},
): ArtifactToolInput {
  return {
    execution: {
      toolId, definitionId, stableKey: `GET /api/${definitionId}`, executionKind: 'endpoint', sourceKind: 'next-app',
      sourceFile: `src/app/api/${definitionId}/route.ts`, method: 'GET', path: `/api/${definitionId}`,
      sourceFingerprint: digest('F'), inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
    },
    prose: {
      description: `Run ${definitionId}.`, descriptionOrigin: 'code', module: 'tasks', sharedWith: [],
      usageHints: [`Run ${definitionId}.`],
      presentation: { locale: 'en-US', singular: definitionId, plural: definitionId, approval: definitionId },
      findings: [],
    },
    effective: effective(overrides.effective),
    operationGroup: overrides.operationGroup ?? 'read',
  };
}

const TOOL_A = '019fb007-0000-7000-8000-0000000000b1';
const TOOL_B = '019fb007-0000-7000-8000-0000000000b2';
const base = {
  appId: APP_ID,
  targetAppKey: 'fixture',
  discoveryDigest: digest('D'),
  promptBundle: bundle,
  warnings: [],
};

describe('setup artifact', () => {
  it('derives identifiers from content and passes semantic parity', () => {
    const first = buildSetupArtifact({ ...base, tools: [tool(TOOL_B, 'notes.list'), tool(TOOL_A, 'tasks.list')], now: () => new Date('2026-10-04T10:00:00.000Z') });
    const second = buildSetupArtifact({ ...base, tools: [tool(TOOL_A, 'tasks.list'), tool(TOOL_B, 'notes.list')], now: () => new Date('2026-10-05T10:00:00.000Z') });
    expect(second.artifact.artifactId).toBe(first.artifact.artifactId);
    expect(second.artifact.runId).toBe(first.artifact.runId);
    expect(first.artifact.artifactId).not.toBe(first.artifact.runId);
    expect(first.artifact.tools.map((entry) => entry.toolId)).toEqual([TOOL_A, TOOL_B]);
    expect(first.artifact.generatedAt).toBe('2026-10-04T10:00:00.000Z');
    expect(first.raw).toBe(canonicalJson(first.artifact));
    expect(() => assertAppSetupSemanticParity(first.artifact, ['notes.list', 'tasks.list'])).not.toThrow();
    expect(first.artifact.tools[0]).toMatchObject({
      modelName: 'tasks_list', authBindingRef: 'endpoint-authorization', method: 'GET', path: '/api/tasks.list',
    });
  });

  it('carries generatedAt for unchanged content and never reads the clock in frozen mode', () => {
    const first = buildSetupArtifact({ ...base, tools: [tool(TOOL_A, 'tasks.list')], now: () => new Date('2026-10-04T10:00:00.000Z') });
    const carried = buildSetupArtifact({
      ...base, tools: [tool(TOOL_A, 'tasks.list')], previous: { artifact: first.artifact, planner: first.artifact.planner },
      now: () => new Date('2026-12-31T00:00:00.000Z'),
    });
    expect(carried.raw).toBe(first.raw);
    const changed = buildSetupArtifact({
      ...base, tools: [tool(TOOL_A, 'tasks.list', { effective: { enabled: false } })],
      previous: { artifact: first.artifact }, now: null,
    });
    expect(changed.artifact.generatedAt).toBe('2026-10-04T10:00:00.000Z');
    expect(buildSetupArtifact({ ...base, tools: [], now: null }).artifact.generatedAt).toBe(EPOCH);
  });

  it('applies the confirmation floor, keeps the planner and reports attention as review', () => {
    const previousPlanner = {
      plannerId: '019fb007-0000-7000-8000-0000000000c3', modelBindingRef: 'balanced',
      promptBindingRef: 'prompt:pilot', budgetProfileRef: 'foundation-default', toolIds: [],
    };
    const { artifact } = buildSetupArtifact({
      ...base,
      tools: [
        tool(TOOL_A, 'tasks.delete', { effective: { riskClass: 'delete', requiresApproval: false } }),
        tool(TOOL_B, 'notes.list', { effective: { enabled: false }, operationGroup: 'needs_attention' }),
      ],
      previous: { planner: previousPlanner },
      now: null,
    });
    expect(artifact.tools.find((entry) => entry.toolId === TOOL_A)?.requiresApproval).toBe(true);
    expect(artifact.planner).toEqual({ ...previousPlanner, toolIds: [TOOL_A] });
    expect(artifact.status).toBe('review');
  });

  it('digests the local prompt bundle like the runtime and the prompt manifest', () => {
    expect(promptMetadata(bundle)).toEqual({
      bundleDigest: sha256Digest(canonicalRuntimeJson(bundle.sections)),
      artifactRef: 'local://fixture/prompts',
      plannerDigest: sha256Digest('Plan.'),
      appBehaviorDigest: sha256Digest('Behave.'),
      responseStyleDigest: sha256Digest('Short.'),
      capabilityFragmentDigests: { tasks: sha256Digest('Tasks.') },
    });
  });
});

describe('tool contracts and report', () => {
  const contract: ToolContract = {
    source: 'derived', loadBearing: false, input: { type: 'object' }, output: {},
    params: { path: [], query: ['q'], body: [] }, interfaceDigest: digest('N'),
    runtime: { input: { kind: 'json', schema: { type: 'object' } }, output: { kind: 'json', schema: {} } },
  };
  const defaults = { operationGroup: 'read' as const, riskClass: 'safe-read' as const, requiresApproval: false, rulesVersion: 1 as const };

  it('renders tool-contracts.json sorted and parseable', () => {
    const raw = renderToolContracts(APP_ID, [
      { toolId: TOOL_B, stableKey: 'GET /api/b', definitionId: 'b.list', contract: null, defaults },
      { toolId: TOOL_A, stableKey: 'GET /api/a', definitionId: 'a.list', contract, defaults },
    ]);
    const parsed = ToolContractsFileSchema.parse(JSON.parse(raw));
    expect(parsed.tools.map((entry) => entry.toolId)).toEqual([TOOL_A, TOOL_B]);
    expect(raw).toBe(canonicalJson(parsed));
  });

  it('keeps the report content-free and free of change-relative findings', () => {
    const raw = renderToolReport({
      appId: APP_ID,
      discoveryDigest: digest('D'),
      tools: [{
        toolId: TOOL_A, stableKey: 'GET /api/a', definitionId: 'a.list', enabled: true, riskClass: 'safe-read',
        requiresApproval: false, contractSource: 'derived', quality: { description: 'template', schema: 'field-names' },
      }],
      findings: [
        toolFinding('contract-derived', 'warning', 'GET /api/a', 'Only names.'),
        toolFinding('contract-derived', 'warning', 'GET /api/a', 'Only names.'),
        toolFinding('risk-raised', 'warning', 'GET /api/a', 'Raised.'),
      ],
      excluded: [{ stableKey: 'POST /api/auth/login', reason: 'auth-route', origin: 'default' }],
    });
    const report = ToolReportFileSchema.parse(JSON.parse(raw));
    expect(report.findings).toEqual([{
      code: 'contract-derived', severity: 'warning', subjectRef: 'GET /api/a',
      nextAction: toolFinding('contract-derived', 'warning', 'x', 'x').nextAction,
    }]);
    expect(raw).not.toContain('"message"');
  });

  it('grades schema quality by contract source', () => {
    expect(schemaQualityOf(undefined)).toBe('none');
    expect(schemaQualityOf(contract)).toBe('field-names');
    expect(schemaQualityOf({ ...contract, source: 'native' })).toBe('zod');
    expect(schemaQualityOf({ ...contract, source: 'resolution' }, 'agent')).toBe('agent');
    expect(schemaQualityOf({ ...contract, source: 'resolution' }, 'human')).toBe('json-schema');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/artifact.test.ts`
Expected: FAIL — `Failed to resolve import "./artifact.js"`.

- [ ] **Step 3: Implement `artifact.ts`**

```ts
import { z } from 'zod';
import {
  AppSetupArtifactSchema,
  ToolRiskClassSchema,
  type AppSetupArtifact,
  type AppSetupOperationGroup,
  type AppSetupToolCandidate,
  type ToolRiskClass,
} from '../../contracts/index.js';
import { confirmationFloor, type EffectiveToolPolicy } from '../../contracts/tool-policy.js';
import type { LocalPromptBundle } from '../../cli/commands/validate-build.js';
import { modelFacingToolName } from '../../runtime/local-tool-bindings.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import type { FoundationExecutionInventory } from '../execution-inventory.js';
import { canonicalJson, compareCodeUnits, deterministicUuid, sha256Digest } from './canonical.js';
import { sortFindings, TRANSIENT_FINDING_CODES } from './findings.js';
import type { DescriptionOrigin, ToolProse } from './prose.js';
import type {
  ContractSource,
  ExcludedTool,
  ToolContract,
  ToolContractsEntry,
  ToolFinding,
} from './types.js';

export const EPOCH = '1970-01-01T00:00:00.000Z';
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

type InventoryExecution = FoundationExecutionInventory['executions'][number];
type ArtifactContent = Omit<AppSetupArtifact, 'artifactId' | 'runId' | 'generatedAt'>;

export interface ArtifactToolInput {
  execution: InventoryExecution;
  prose: ToolProse;
  effective: EffectiveToolPolicy;
  operationGroup: AppSetupOperationGroup;
}

export interface PreviousArtifact {
  artifact?: AppSetupArtifact;
  planner?: AppSetupArtifact['planner'];
}

export interface BuildSetupArtifactInput {
  appId: string;
  targetAppKey: string;
  discoveryDigest: string;
  tools: ReadonlyArray<ArtifactToolInput>;
  promptBundle: Pick<LocalPromptBundle, 'artifactRef' | 'sections'>;
  warnings: ReadonlyArray<{ code: string; subjectRef: string }>;
  previous?: PreviousArtifact;
  now: (() => Date) | null;
}

export function promptMetadata(
  bundle: Pick<LocalPromptBundle, 'artifactRef' | 'sections'>,
): AppSetupArtifact['prompts'] {
  return {
    bundleDigest: sha256Digest(canonicalRuntimeJson(bundle.sections)),
    artifactRef: bundle.artifactRef,
    plannerDigest: sha256Digest(bundle.sections.planner),
    appBehaviorDigest: sha256Digest(bundle.sections.appBehavior),
    responseStyleDigest: sha256Digest(bundle.sections.responseStyle),
    capabilityFragmentDigests: Object.fromEntries(Object.entries(bundle.sections.capabilityFragments)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, content]) => [name, sha256Digest(content)])),
  };
}

function candidate(tool: ArtifactToolInput): AppSetupToolCandidate {
  const { execution, prose, effective } = tool;
  const base = {
    toolId: execution.toolId,
    sourceFingerprint: execution.sourceFingerprint,
    name: execution.definitionId,
    description: prose.description,
    modelName: modelFacingToolName(execution.definitionId),
    module: prose.module,
    sharedWith: [...prose.sharedWith],
    usageHints: [...prose.usageHints],
    presentation: prose.presentation,
    allowedRoles: [...effective.allowedRoles].sort(compareCodeUnits),
    operationGroup: tool.operationGroup,
    riskClass: effective.riskClass,
    enabled: effective.enabled,
    requiresApproval: confirmationFloor(effective.riskClass, effective.requiresApproval),
    inputSchemaDigest: execution.inputSchemaDigest,
    outputSchemaDigest: execution.outputSchemaDigest,
  };
  if (execution.executionKind === 'endpoint') {
    return {
      ...base,
      executionKind: 'endpoint',
      method: execution.method,
      path: execution.path,
      authBindingRef: 'endpoint-authorization',
    };
  }
  return { ...base, executionKind: 'ui', actionBindingRef: execution.actionBindingRef };
}

function withoutIdentity(artifact: AppSetupArtifact): ArtifactContent {
  const { artifactId: _artifactId, runId: _runId, generatedAt: _generatedAt, ...content } = artifact;
  return content;
}

function contentDigestOf(content: ArtifactContent): string {
  return sha256Digest(canonicalJson(content));
}

export function buildSetupArtifact(input: BuildSetupArtifactInput): { artifact: AppSetupArtifact; raw: string } {
  const tools = input.tools.map(candidate).sort((left, right) => compareCodeUnits(left.toolId, right.toolId));
  const previousPlanner = input.previous?.planner ?? input.previous?.artifact?.planner;
  const warnings = [...new Map(input.warnings.map((warning) => [`${warning.code}|${warning.subjectRef}`, warning])).values()]
    .sort((left, right) => compareCodeUnits(left.code, right.code) || compareCodeUnits(left.subjectRef, right.subjectRef));
  const draft = AppSetupArtifactSchema.parse({
    schemaVersion: 1,
    artifactId: PLACEHOLDER_ID,
    runId: PLACEHOLDER_ID,
    appId: input.appId,
    discoveryDigest: input.discoveryDigest,
    assessmentMode: 'autonomous',
    status: tools.some((tool) => tool.operationGroup === 'needs_attention') ? 'review' : 'ready',
    tools,
    planner: {
      plannerId: previousPlanner?.plannerId ?? deterministicUuid(input.appId, ['planner']),
      modelBindingRef: previousPlanner?.modelBindingRef ?? 'default',
      promptBindingRef: previousPlanner?.promptBindingRef ?? `prompt:${input.targetAppKey}`,
      budgetProfileRef: previousPlanner?.budgetProfileRef ?? 'default',
      toolIds: tools.filter((tool) => tool.enabled).map((tool) => tool.toolId),
    },
    prompts: promptMetadata(input.promptBundle),
    warnings,
    generatedAt: EPOCH,
  });
  const contentDigest = contentDigestOf(withoutIdentity(draft));
  const previous = input.previous?.artifact;
  const generatedAt = previous && contentDigestOf(withoutIdentity(previous)) === contentDigest
    ? previous.generatedAt
    : input.now ? input.now().toISOString() : previous?.generatedAt ?? EPOCH;
  const artifact = AppSetupArtifactSchema.parse({
    ...draft,
    artifactId: deterministicUuid(input.appId, ['setup-artifact', contentDigest]),
    runId: deterministicUuid(input.appId, ['setup-run', contentDigest]),
    generatedAt,
  });
  return { artifact, raw: canonicalJson(artifact) };
}

export function renderToolContracts(appId: string, entries: ReadonlyArray<ToolContractsEntry>): string {
  return canonicalJson({
    schemaVersion: 1,
    appId,
    tools: [...entries].sort((left, right) => compareCodeUnits(left.toolId, right.toolId)),
  });
}

export type SchemaQuality = 'zod' | 'openapi' | 'json-schema' | 'agent' | 'field-names' | 'none';

export function schemaQualityOf(
  contract: ToolContract | null | undefined,
  resolutionOrigin?: 'human' | 'agent',
): SchemaQuality {
  if (!contract) return 'none';
  switch (contract.source) {
    case 'native':
    case 'contract-module':
    case 'legacy-ai-tool':
    case 'ui-bridge':
      return 'zod';
    case 'openapi':
      return 'openapi';
    case 'derived':
      return 'field-names';
    case 'resolution':
      if (resolutionOrigin === 'agent') return 'agent';
      return contract.runtime.input.kind === 'module-export' ? 'zod' : 'json-schema';
  }
}

export interface ToolReportTool {
  toolId: string;
  stableKey: string;
  definitionId: string;
  enabled: boolean;
  riskClass: ToolRiskClass;
  requiresApproval: boolean;
  contractSource: ContractSource | null;
  quality: { description: DescriptionOrigin; schema: SchemaQuality };
}

export const ToolReportFileSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.uuid(),
  discoveryDigest: z.string(),
  tools: z.array(z.object({
    toolId: z.uuid(),
    stableKey: z.string(),
    definitionId: z.string(),
    enabled: z.boolean(),
    riskClass: ToolRiskClassSchema,
    requiresApproval: z.boolean(),
    contractSource: z.enum([
      'native', 'contract-module', 'legacy-ai-tool', 'resolution', 'openapi', 'derived', 'ui-bridge',
    ]).nullable(),
    quality: z.object({
      description: z.enum(['human', 'code', 'agent', 'template']),
      schema: z.enum(['zod', 'openapi', 'json-schema', 'agent', 'field-names', 'none']),
    }).strict(),
  }).strict()),
  findings: z.array(z.object({
    code: z.string(),
    severity: z.enum(['error', 'needs_attention', 'warning']),
    subjectRef: z.string(),
    nextAction: z.string(),
  }).strict()),
  excluded: z.array(z.object({
    stableKey: z.string(),
    reason: z.string(),
    origin: z.enum(['default', 'policy']),
  }).strict()),
}).strict();

export type ToolReportFile = z.infer<typeof ToolReportFileSchema>;

/** Content-free state report: no messages, no change-relative findings. */
export function renderToolReport(input: {
  appId: string;
  discoveryDigest: string;
  tools: ReadonlyArray<ToolReportTool>;
  findings: ReadonlyArray<ToolFinding>;
  excluded: ReadonlyArray<ExcludedTool>;
}): string {
  const seen = new Set<string>();
  const findings = sortFindings(input.findings)
    .filter((finding) => !TRANSIENT_FINDING_CODES.has(finding.code))
    .filter((finding) => {
      const key = `${finding.severity}|${finding.code}|${finding.subjectRef}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ code, severity, subjectRef, nextAction }) => ({ code, severity, subjectRef, nextAction }));
  return canonicalJson({
    schemaVersion: 1,
    appId: input.appId,
    discoveryDigest: input.discoveryDigest,
    tools: [...input.tools].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
    findings,
    excluded: [...input.excluded].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey)),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/artifact.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/artifact.ts src/codegen/tools/artifact.test.ts
git commit -m "feat(codegen): render deterministic setup artifact and tool reports"
```

### Task 18: Runtime contract bindings

**Files:**
- Create: `src/runtime/contract-bindings.ts`
- Modify: `src/runtime/index.ts` (exports)
- Test: `src/runtime/contract-bindings.test.ts`

**Interfaces:**
- Consumes: `AppSetupArtifactSchema`, `createLocalSchemaDigest`, `LocalEndpointToolBinding`, `createLocalRuntimeSource`, `LocalRuntimeSourceOptions`.
- Produces:
  - `export interface GeneratedToolBinding { readonly toolId: string; readonly definitionId: string; readonly executionKind: 'endpoint'; readonly method: EndpointMethod; readonly path: string; readonly sourceFingerprint: string; readonly inputSchemaDigest: string; readonly outputSchemaDigest: string; readonly inputSchema: SchemaLike; readonly outputSchema: SchemaLike; readonly tool: Tool }`
  - `export interface GeneratedToolModule { readonly setupArtifact: unknown; createToolBindings(): ReadonlyArray<GeneratedToolBinding> }`
  - `export type ContractBindingDisabledReason = 'binding-missing' | 'binding-duplicated' | 'binding-mismatch' | 'input-schema-digest-mismatch' | 'output-schema-digest-mismatch'`
  - `export interface ContractBindingsResult { setupArtifact: AppSetupArtifact; bindings: LocalEndpointToolBinding[]; disabled: Array<{ toolId: string; reason: ContractBindingDisabledReason }> }`
  - `export function createContractBindings(generated: GeneratedToolModule): ContractBindingsResult`
  - `export interface GeneratedRuntimeSource { source: LocalRuntimeSource; bindings: LocalEndpointToolBinding[]; disabled: ContractBindingsResult['disabled'] }`
  - `export function createGeneratedRuntimeSource(generated: GeneratedToolModule, options: Omit<LocalRuntimeSourceOptions, 'setupArtifact' | 'bindings'>): GeneratedRuntimeSource`

Digests are recomputed from the live schema objects at boot; only the affected tool is disabled (the artifact copy handed to the runtime marks it `enabled: false`), the registry never fails as a whole.

- [ ] **Step 1: Write the failing test**

`src/runtime/contract-bindings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppSetupArtifactSchema } from '../contracts/index.js';
import { endpointToolToTool } from '../server/core/index.js';
import {
  createContractBindings,
  createGeneratedRuntimeSource,
  type GeneratedToolBinding,
  type GeneratedToolModule,
} from './contract-bindings.js';
import { createJsonSchemaLike } from './json-schema.js';
import { createLocalSchemaDigest } from './local-tool-bindings.js';

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const TENANT = id('f1');
const inputSchema = z.object({ status: z.enum(['open', 'done']).optional() }).strict();
const outputSchema = z.object({ tasks: z.array(z.string()) });
const jsonInput = createJsonSchemaLike({ type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false });
const limits = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

function candidate(toolId: string, method: 'GET' | 'POST' | 'DELETE', enabled: boolean, input: string, output: string) {
  const name = `tasks.${method.toLowerCase()}`;
  return {
    toolId, sourceFingerprint: digest(method[0]!), name, description: `Run ${name}.`,
    modelName: name.replace('.', '_'), module: 'tasks', sharedWith: [], usageHints: [`Run ${name}.`],
    presentation: { locale: 'en-US', singular: name, plural: name, approval: name },
    executionKind: 'endpoint', method, path: '/api/tasks', authBindingRef: 'endpoint-authorization',
    allowedRoles: [], operationGroup: method === 'GET' ? 'read' : method === 'POST' ? 'create' : 'delete',
    riskClass: method === 'GET' ? 'safe-read' : method === 'POST' ? 'write' : 'delete',
    enabled, requiresApproval: method !== 'GET', inputSchemaDigest: input, outputSchemaDigest: output,
  };
}

const tools = [
  candidate(id('a1'), 'GET', true, createLocalSchemaDigest(inputSchema), createLocalSchemaDigest(outputSchema)),
  candidate(id('a2'), 'POST', true, createLocalSchemaDigest(jsonInput), createLocalSchemaDigest(outputSchema)),
  candidate(id('a3'), 'DELETE', false, digest('X'), digest('Y')),
];
const setupArtifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready', tools,
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('a1'), id('a2')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
});

function binding(index: number, overrides: Partial<GeneratedToolBinding> = {}): GeneratedToolBinding {
  const entry = tools[index]!;
  const input = index === 0 ? inputSchema : jsonInput;
  return {
    toolId: entry.toolId, definitionId: entry.name, executionKind: 'endpoint', method: entry.method, path: entry.path,
    sourceFingerprint: entry.sourceFingerprint, inputSchemaDigest: entry.inputSchemaDigest, outputSchemaDigest: entry.outputSchemaDigest,
    inputSchema: input, outputSchema,
    tool: endpointToolToTool({
      id: entry.name, toolName: entry.modelName, description: entry.description, method: entry.method, path: entry.path,
      inputSchema: input, needsApproval: entry.requiresApproval,
    }),
    ...overrides,
  };
}

const module = (bindings: GeneratedToolBinding[]): GeneratedToolModule => ({ setupArtifact, createToolBindings: () => bindings });

describe('createContractBindings', () => {
  it('binds every matching enabled tool', () => {
    const result = createContractBindings(module([binding(0), binding(1)]));
    expect(result.disabled).toEqual([]);
    expect(result.bindings.map((entry) => entry.toolId)).toEqual([id('a1'), id('a2')]);
    expect(result.setupArtifact.tools.map((tool) => tool.enabled)).toEqual([true, true, false]);
  });

  it('disables only the tools whose live schema, binding or presence differs', () => {
    const tampered = createJsonSchemaLike({ type: 'object', properties: { title: { type: 'number' } }, additionalProperties: false });
    const result = createContractBindings(module([binding(0, { sourceFingerprint: digest('Z') }), binding(1, { inputSchema: tampered })]));
    expect(result.disabled).toEqual([
      { toolId: id('a1'), reason: 'binding-mismatch' },
      { toolId: id('a2'), reason: 'input-schema-digest-mismatch' },
    ]);
    expect(result.bindings).toEqual([]);
    const missing = createContractBindings(module([binding(0), binding(0)]));
    expect(missing.disabled).toEqual([
      { toolId: id('a1'), reason: 'binding-duplicated' },
      { toolId: id('a2'), reason: 'binding-missing' },
    ]);
  });

  it('feeds the standalone runtime with the remaining tools only', () => {
    const runtime = createGeneratedRuntimeSource(module([binding(0)]), { localLimits: limits, identity: { tenantId: TENANT } });
    const snapshot = runtime.source.resolveTurnSnapshot({
      turnId: 'turn-1',
      principal: { subjectId: 'alice', tenantId: TENANT, roles: ['member'], attributes: {} },
    });
    expect(snapshot.manifestRevision.tools.map((tool) => tool.toolId)).toEqual([id('a1')]);
    expect(runtime.disabled).toEqual([{ toolId: id('a2'), reason: 'binding-missing' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/contract-bindings.test.ts`
Expected: FAIL — `Failed to resolve import "./contract-bindings.js"`.

- [ ] **Step 3: Implement `contract-bindings.ts`**

```ts
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../contracts/index.js';
import type { EndpointMethod, SchemaLike, Tool } from '../types.js';
import {
  createLocalRuntimeSource,
  type LocalRuntimeSource,
  type LocalRuntimeSourceOptions,
} from './local-runtime-source.js';
import { createLocalSchemaDigest, type LocalEndpointToolBinding } from './local-tool-bindings.js';

/** One entry of `createToolBindings()` in the generated module. */
export interface GeneratedToolBinding {
  readonly toolId: string;
  readonly definitionId: string;
  readonly executionKind: 'endpoint';
  readonly method: EndpointMethod;
  readonly path: string;
  readonly sourceFingerprint: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly inputSchema: SchemaLike;
  readonly outputSchema: SchemaLike;
  readonly tool: Tool;
}

/** The shape of `src/generated/glirastes/tools.generated.ts`. */
export interface GeneratedToolModule {
  readonly setupArtifact: unknown;
  createToolBindings(): ReadonlyArray<GeneratedToolBinding>;
}

export type ContractBindingDisabledReason =
  | 'binding-missing'
  | 'binding-duplicated'
  | 'binding-mismatch'
  | 'input-schema-digest-mismatch'
  | 'output-schema-digest-mismatch';

export interface ContractBindingsResult {
  setupArtifact: AppSetupArtifact;
  bindings: LocalEndpointToolBinding[];
  disabled: Array<{ toolId: string; reason: ContractBindingDisabledReason }>;
}

function byToolId(left: { toolId: string }, right: { toolId: string }): number {
  return left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0;
}

/**
 * Recomputes every schema digest from the live schema objects at boot and
 * disables only tools whose binding is missing or differs from the artifact.
 */
export function createContractBindings(generated: GeneratedToolModule): ContractBindingsResult {
  const artifact = AppSetupArtifactSchema.parse(generated.setupArtifact);
  const candidates = new Map(artifact.tools.map((tool) => [tool.toolId, tool] as const));
  const grouped = new Map<string, GeneratedToolBinding[]>();
  for (const binding of generated.createToolBindings()) {
    grouped.set(binding.toolId, [...grouped.get(binding.toolId) ?? [], binding]);
  }
  const disabled = new Map<string, ContractBindingDisabledReason>();
  const bindings: LocalEndpointToolBinding[] = [];
  for (const [toolId, entries] of grouped) {
    const candidate = candidates.get(toolId);
    if (!candidate?.enabled) continue;
    if (entries.length !== 1) {
      disabled.set(toolId, 'binding-duplicated');
      continue;
    }
    const binding = entries[0]!;
    if (
      candidate.executionKind !== 'endpoint'
      || binding.executionKind !== 'endpoint'
      || candidate.method !== binding.method
      || candidate.path !== binding.path
      || candidate.sourceFingerprint !== binding.sourceFingerprint
      || candidate.inputSchemaDigest !== binding.inputSchemaDigest
      || candidate.outputSchemaDigest !== binding.outputSchemaDigest
    ) {
      disabled.set(toolId, 'binding-mismatch');
      continue;
    }
    if (createLocalSchemaDigest(binding.inputSchema) !== candidate.inputSchemaDigest) {
      disabled.set(toolId, 'input-schema-digest-mismatch');
      continue;
    }
    if (createLocalSchemaDigest(binding.outputSchema) !== candidate.outputSchemaDigest) {
      disabled.set(toolId, 'output-schema-digest-mismatch');
      continue;
    }
    bindings.push({
      toolId,
      executionKind: 'endpoint',
      method: binding.method,
      path: binding.path,
      sourceFingerprint: binding.sourceFingerprint,
      inputSchemaDigest: binding.inputSchemaDigest,
      outputSchemaDigest: binding.outputSchemaDigest,
      tool: binding.tool,
    });
  }
  for (const tool of artifact.tools) {
    if (tool.enabled && !grouped.has(tool.toolId)) disabled.set(tool.toolId, 'binding-missing');
  }
  const setupArtifact = AppSetupArtifactSchema.parse({
    ...artifact,
    tools: artifact.tools.map((tool) => (disabled.has(tool.toolId) ? { ...tool, enabled: false } : tool)),
  });
  return {
    setupArtifact,
    bindings: bindings.sort(byToolId),
    disabled: [...disabled].map(([toolId, reason]) => ({ toolId, reason })).sort(byToolId),
  };
}

export interface GeneratedRuntimeSource {
  source: LocalRuntimeSource;
  bindings: LocalEndpointToolBinding[];
  disabled: ContractBindingsResult['disabled'];
}

export function createGeneratedRuntimeSource(
  generated: GeneratedToolModule,
  options: Omit<LocalRuntimeSourceOptions, 'setupArtifact' | 'bindings'>,
): GeneratedRuntimeSource {
  const result = createContractBindings(generated);
  return {
    source: createLocalRuntimeSource({ ...options, setupArtifact: result.setupArtifact, bindings: result.bindings }),
    bindings: result.bindings,
    disabled: result.disabled,
  };
}
```

- [ ] **Step 4: Export from the runtime subpath**

Append to `src/runtime/index.ts`:

```ts
export {
  createContractBindings,
  createGeneratedRuntimeSource,
  type ContractBindingDisabledReason,
  type ContractBindingsResult,
  type GeneratedRuntimeSource,
  type GeneratedToolBinding,
  type GeneratedToolModule,
} from './contract-bindings.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/contract-bindings.test.ts src/public-subpaths.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/contract-bindings.ts src/runtime/index.ts src/runtime/contract-bindings.test.ts
git commit -m "feat(runtime): bind generated tool modules with boot-time digests"
```

### Task 19: Generated module emitter

**Files:**
- Create: `src/codegen/tools/emit-module.ts`
- Test: `src/codegen/tools/emit-module.test.ts`

**Interfaces:**
- Consumes: `AppSetupArtifact`, `ToolContractsEntry`, `RuntimeSchemaSource`, `sortKeysDeep`, `compareCodeUnits`; at app runtime `createJsonSchemaLike` (`glirastes/runtime`) and `endpointToolToTool` (`glirastes/server`).
- Produces:
  - `export interface RenderGeneratedModuleInput { modulePath: string; artifact: AppSetupArtifact; contracts: ReadonlyArray<ToolContractsEntry> }`
  - `export function renderGeneratedModule(input: RenderGeneratedModuleInput): string`
  - The emitted module exports `setupArtifact`, `toolCatalog` (`as const` in TS), `GeneratedToolId` (TS only) and `createToolBindings()`; it satisfies `GeneratedToolModule` from Task 18.

Import specifiers are relative to the module; TypeScript targets drop the extension (bundler/Next resolution), JavaScript targets keep it. A `json` source becomes `createJsonSchemaLike(<schema>)`; a `module-export` source becomes `m<N>.<export>.<property…>`.

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/emit-module.test.ts`:

```ts
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { createAppFixture, removeAppFixtures, SDK_ROOT } from './__tests__/app-fixture.js';
import { renderGeneratedModule } from './emit-module.js';
import type { ToolContract, ToolContractsEntry } from './types.js';

afterEach(removeAppFixtures);

const id = (suffix: string) => `019fb007-0000-7000-8000-0000000000${suffix}`;
const digest = (character: string) => `sha256:${character.repeat(43)}`;
const NOTE = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };

function candidate(toolId: string, name: string, method: 'GET' | 'POST', enabled: boolean) {
  return {
    toolId, sourceFingerprint: digest('F'), name, description: `Run ${name}.`, modelName: name.replace('.', '_'),
    module: 'notes', sharedWith: [], usageHints: [`Run ${name}.`],
    presentation: { locale: 'en-US', singular: name, plural: name, approval: name },
    executionKind: 'endpoint', method, path: '/api/notes', authBindingRef: 'endpoint-authorization', allowedRoles: [],
    operationGroup: method === 'GET' ? 'read' : 'create', riskClass: method === 'GET' ? 'safe-read' : 'write',
    enabled, requiresApproval: method !== 'GET', inputSchemaDigest: digest('I'), outputSchemaDigest: digest('O'),
  };
}

const artifact = AppSetupArtifactSchema.parse({
  schemaVersion: 1, artifactId: id('b1'), runId: id('b2'), appId: id('b3'), discoveryDigest: digest('D'),
  assessmentMode: 'autonomous', status: 'ready',
  tools: [candidate(id('a1'), 'notes.create', 'POST', true), candidate(id('a2'), 'notes.list', 'GET', true), candidate(id('a3'), 'notes.archive', 'POST', false)],
  planner: { plannerId: id('b4'), modelBindingRef: 'default', promptBindingRef: 'prompt:fixture', budgetProfileRef: 'default', toolIds: [id('a1'), id('a2')] },
  prompts: { bundleDigest: digest('E'), artifactRef: 'local://fixture/prompts', plannerDigest: digest('F'), appBehaviorDigest: digest('G'), responseStyleDigest: digest('H'), capabilityFragmentDigests: {} },
  warnings: [], generatedAt: '2026-10-04T08:00:00.000Z',
});

function contract(runtime: ToolContract['runtime']): ToolContract {
  return {
    source: 'native', loadBearing: true, input: NOTE, output: {}, params: { path: [], query: [], body: ['title'] },
    interfaceDigest: digest('N'), runtime,
  };
}

const defaults = { operationGroup: 'create' as const, riskClass: 'write' as const, requiresApproval: true, rulesVersion: 1 as const };

function contracts(schemaModule: string): ToolContractsEntry[] {
  return [
    {
      toolId: id('a1'), stableKey: 'POST /api/notes', definitionId: 'notes.create', defaults,
      contract: contract({
        input: { kind: 'module-export', module: schemaModule, export: 'createNote', property: [] },
        output: { kind: 'json', schema: { type: 'object', properties: { id: { type: 'string' } } } },
      }),
    },
    {
      toolId: id('a2'), stableKey: 'GET /api/notes', definitionId: 'notes.list', defaults,
      contract: contract({
        input: { kind: 'json', schema: { type: 'object', properties: {}, additionalProperties: false } },
        output: { kind: 'module-export', module: schemaModule, export: 'contract', property: ['GET', 'output'] },
      }),
    },
    { toolId: id('a3'), stableKey: 'POST /api/notes/archive', definitionId: 'notes.archive', defaults, contract: null },
  ];
}

describe('renderGeneratedModule', () => {
  it('emits a deterministic, syntactically valid TypeScript module for enabled tools only', () => {
    const input = { modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts: contracts('src/app/api/notes/schemas.ts') };
    const text = renderGeneratedModule(input);
    expect(renderGeneratedModule(input)).toBe(text);
    expect(text).toContain("import { createJsonSchemaLike } from 'glirastes/runtime';");
    expect(text).toContain("import { endpointToolToTool } from 'glirastes/server';");
    expect(text).toContain('import * as m0 from "../../app/api/notes/schemas";');
    expect(text).toContain(`export type GeneratedToolId = "${id('a1')}" | "${id('a2')}";`);
    expect(text).toContain('m0.contract.GET.output');
    expect(text).toContain('] as const;');
    expect(text.slice(text.indexOf('export const toolCatalog'))).not.toContain(id('a3'));
    const output = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    expect(output.diagnostics ?? []).toEqual([]);
  });

  it('keeps extensions and drops type syntax for JavaScript targets', () => {
    const text = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.js', artifact, contracts: contracts('src/app/api/notes/schemas.js'),
    });
    expect(text).toContain('import * as m0 from "../../app/api/notes/schemas.js";');
    expect(text).not.toContain('as const');
    expect(text).not.toContain('export type');
  });

  it('emits an empty module when no tool is enabled', () => {
    const empty = AppSetupArtifactSchema.parse({ ...artifact, tools: [artifact.tools[2]], planner: { ...artifact.planner, toolIds: [] } });
    const text = renderGeneratedModule({ modulePath: 'src/generated/glirastes/tools.generated.ts', artifact: empty, contracts: contracts('src/a.ts') });
    expect(text).toContain('export type GeneratedToolId = never;');
    expect(text).toContain('  return [];');
    expect(text).not.toContain('glirastes/server');
  });

  it('type-checks under strict TypeScript against the SDK runtime surface', async () => {
    const generated = renderGeneratedModule({
      modulePath: 'src/generated/glirastes/tools.generated.ts', artifact, contracts: contracts('src/app/api/notes/schemas.ts'),
    });
    const app = await createAppFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true,
          paths: {
            'glirastes/runtime': [join(SDK_ROOT, 'src/runtime/index.ts')],
            'glirastes/server': [join(SDK_ROOT, 'src/server/index.ts')],
          },
        },
      }),
      'src/app/api/notes/schemas.ts': "import { z } from 'zod';\n"
        + 'export const createNote = z.object({ title: z.string() }).strict();\n'
        + 'export const contract = { GET: { output: z.object({ notes: z.array(z.string()) }) } };\n',
      'src/generated/glirastes/tools.generated.ts': generated,
      'src/consumer.ts': "import { createContractBindings } from 'glirastes/runtime';\n"
        + "import * as generated from './generated/glirastes/tools.generated';\n"
        + 'export const bound = createContractBindings(generated);\n'
        + 'export const ids: generated.GeneratedToolId[] = generated.toolCatalog.map((entry) => entry.toolId);\n',
    });
    const config = ts.readConfigFile(app.path('tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app.root);
    const files = [app.path('src/consumer.ts'), app.path('src/generated/glirastes/tools.generated.ts')];
    const program = ts.createProgram(files, parsed.options);
    const diagnostics = files.flatMap((file) => program.getSemanticDiagnostics(program.getSourceFile(file)));
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/emit-module.test.ts`
Expected: FAIL — `Failed to resolve import "./emit-module.js"`.

- [ ] **Step 3: Implement `emit-module.ts`**

```ts
import { posix } from 'node:path';
import type { AppSetupArtifact } from '../../contracts/index.js';
import { compareCodeUnits, sortKeysDeep } from './canonical.js';
import type { RuntimeSchemaSource, ToolContractsEntry } from './types.js';

export interface RenderGeneratedModuleInput {
  modulePath: string;
  artifact: AppSetupArtifact;
  contracts: ReadonlyArray<ToolContractsEntry>;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function accessor(name: string): string {
  return IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

function importSpecifier(fromModule: string, target: string, typescript: boolean): string {
  let specifier = posix.relative(posix.dirname(fromModule), target);
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return typescript ? specifier.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '') : specifier;
}

function literal(value: unknown, indent = 0): string {
  const text = JSON.stringify(sortKeysDeep(value), null, 2);
  return indent > 0 ? text.replace(/\n/g, `\n${' '.repeat(indent)}`) : text;
}

/** Pure function of artifact, contracts and module path; integrity mode re-renders it byte for byte. */
export function renderGeneratedModule(input: RenderGeneratedModuleInput): string {
  const typescript = input.modulePath.endsWith('.ts');
  const contractsById = new Map(input.contracts.map((entry) => [entry.toolId, entry] as const));
  const tools = input.artifact.tools
    .filter((tool) => tool.enabled && tool.executionKind === 'endpoint')
    .sort((left, right) => compareCodeUnits(left.toolId, right.toolId));
  const runtime = tools.map((tool) => {
    const contract = contractsById.get(tool.toolId)?.contract;
    if (!contract) throw new Error(`Enabled tool ${tool.name} has no contract to bind.`);
    return contract.runtime;
  });
  const modules = [...new Set(runtime
    .flatMap((entry) => [entry.input, entry.output])
    .flatMap((source) => (source.kind === 'module-export' ? [source.module] : [])))]
    .sort(compareCodeUnits);
  const aliases = new Map(modules.map((module, index) => [module, `m${index}`] as const));
  const usesJson = runtime.some((entry) => entry.input.kind === 'json' || entry.output.kind === 'json');
  const expression = (source: RuntimeSchemaSource): string => (source.kind === 'json'
    ? `createJsonSchemaLike(${literal(source.schema, 2)})`
    : `${aliases.get(source.module)!}${[source.export, ...source.property].map(accessor).join('')}`);
  const catalog = tools.map((tool) => ({
    toolId: tool.toolId,
    definitionId: tool.name,
    modelName: tool.modelName ?? tool.name.replace(/\./g, '_'),
    executionKind: 'endpoint',
    method: tool.method,
    path: tool.path,
    sourceFingerprint: tool.sourceFingerprint,
    inputSchemaDigest: tool.inputSchemaDigest,
    outputSchemaDigest: tool.outputSchemaDigest,
    description: tool.description,
    riskClass: tool.riskClass,
    requiresApproval: tool.requiresApproval,
  }));

  const lines: string[] = [
    '// @generated by `glirastes tools refresh`. Do not edit; rerun the command after code changes.',
    '/* eslint-disable */',
  ];
  if (usesJson) lines.push("import { createJsonSchemaLike } from 'glirastes/runtime';");
  if (tools.length > 0) lines.push("import { endpointToolToTool } from 'glirastes/server';");
  for (const module of modules) {
    lines.push(`import * as ${aliases.get(module)!} from ${JSON.stringify(importSpecifier(input.modulePath, module, typescript))};`);
  }
  lines.push(
    '',
    `export const setupArtifact = ${literal(input.artifact)};`,
    '',
    `export const toolCatalog = ${literal(catalog)}${typescript ? ' as const' : ''};`,
    '',
  );
  if (typescript) {
    lines.push(`export type GeneratedToolId = ${tools.length > 0
      ? tools.map((tool) => JSON.stringify(tool.toolId)).join(' | ')
      : 'never'};`, '');
  }
  lines.push('export function createToolBindings() {');
  if (tools.length === 0) {
    lines.push('  return [];');
  } else {
    runtime.forEach((entry, index) => {
      lines.push(`  const input${index} = ${expression(entry.input)};`);
      lines.push(`  const output${index} = ${expression(entry.output)};`);
    });
    lines.push('  return [');
    runtime.forEach((entry, index) => {
      const catalogEntry = `toolCatalog[${index}]`;
      lines.push(
        '    {',
        `      ...${catalogEntry},`,
        `      inputSchema: input${index},`,
        `      outputSchema: output${index},`,
        '      tool: endpointToolToTool({',
        `        id: ${catalogEntry}.definitionId,`,
        `        toolName: ${catalogEntry}.modelName,`,
        `        description: ${catalogEntry}.description,`,
        `        method: ${catalogEntry}.method,`,
        `        path: ${catalogEntry}.path,`,
        `        inputSchema: input${index},`,
        ...(entry.output.kind === 'module-export' ? [`        outputSchema: output${index},`] : []),
        `        needsApproval: ${catalogEntry}.requiresApproval,`,
        '      }),',
        '    },',
      );
    });
    lines.push('  ];');
  }
  lines.push('}', '');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/emit-module.test.ts && bun run typecheck`
Expected: PASS (including the strict type-check of the emitted module against `createContractBindings`), typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/emit-module.ts src/codegen/tools/emit-module.test.ts
git commit -m "feat(codegen): emit the generated glirastes tools module"
```

### Task 20: Pipeline — write and frozen modes

**Files:**
- Create: `src/codegen/tools/inputs.ts`
- Create: `src/codegen/tools/pipeline.ts`
- Test: `src/codegen/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: everything above plus `reconcileExecutionInventory`, `discoverFoundationExecutions`, P02 `deriveToolPolicyDefaults`, `resolveToolPolicy`, `riskTier`, `confirmationFloor`, `ToolPolicyFileSchema`, `writeArtifactSetAtomically`, `createSetupPlanFromContents`, `renderManifestContents`, `LocalPromptBundleSchema`.
- Produces (pinned):
  - `export interface ToolsPipelineResult { mode: ToolsMode; changes: { added: string[]; changed: string[]; removed: string[]; unchanged: string[] }; findings: ToolFinding[]; excluded: Array<{ stableKey: string; reason: string; origin: string }>; outputs: Record<string, string>; driftPaths: string[]; wrote: boolean }`
  - `export async function runToolsPipeline(options: { root: string; mode: ToolsMode; keepGoing?: boolean; adoptInventoryPath?: string }): Promise<ToolsPipelineResult>`
- Produces (P03 additions):
  - `export interface ToolsPipelineOptions { root: string; mode: ToolsMode; keepGoing?: boolean; adoptInventoryPath?: string }`
  - `export interface ToolsPipelineDependencies { probe?: SchemaProbe; now?: () => Date; sources?: ReadonlyArray<ToolSource> }`
  - `export async function runToolsPipelineWith(options: ToolsPipelineOptions, dependencies: ToolsPipelineDependencies): Promise<ToolsPipelineResult>`
  - `export class ToolsPipelineFailure extends FoundationDiagnosticError { readonly result: ToolsPipelineResult }` (code `E-TOOLS-010`)
  - `inputs.ts`: `export interface PromptBundleInput { raw: string; bundle: LocalPromptBundle }`; `export interface ToolInputs { policy: ToolPolicyFile; resolutions: ToolResolutions; semantics: ToolSemantics; promptBundle?: PromptBundleInput; previousSetupArtifactRaw?: string }`; `export function emptyToolPolicy(): ToolPolicyFile`; `export async function readPromptBundle(root: string, config: ToolsConfig): Promise<{ promptBundle?: PromptBundleInput; findings: ToolFinding[] }>`; `export async function readToolInputs(root: string, config: ToolsConfig): Promise<{ inputs: ToolInputs; findings: ToolFinding[] }>`

Failure contract: any `error` finding ⇒ nothing is written; without `keepGoing` the pipeline throws `ToolsPipelineFailure` (carrying the full result for the CLI), with `keepGoing` it returns `{ wrote: false }`. Frozen mode computes the same outputs in memory and reports every differing path as `tool-outputs-drift`. In this task `integrity` takes the frozen path (a strictly stronger check that also runs the sources); Task 21 gives it its own source-free verification.

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/pipeline.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderCurrentSetupManifests } from '../../cli/commands/current-setup-manifests.js';
import { createSetupPlan } from '../../cli/commands/setup-plan.js';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { FoundationExecutionInventorySchema } from '../execution-inventory.js';
import { canonicalJson } from './canonical.js';
import { createAppFixture, FIXTURE_APP_ID, removeAppFixtures, SDK_ROOT, type AppFixture } from './__tests__/app-fixture.js';
import { DEFAULT_GENERATED_MODULE, TOOLS_PATHS } from './config.js';
import { runToolsPipeline, ToolsPipelineFailure } from './pipeline.js';

const outsideDirs: string[] = [];
afterEach(async () => {
  await removeAppFixtures();
  for (const directory of outsideDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

const SESSION = "export async function getSession(request: Request) {\n  return request.headers.get('cookie') ? { id: 'u1' } : null;\n}\n";
const SCHEMAS = "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string().min(1) }).strict();\n";
const GET_HANDLER = 'export async function GET(request: Request) {\n  await getSession(request);\n'
  + "  const { searchParams } = new URL(request.url);\n  return Response.json({ status: searchParams.getAll('status') });\n}\n";
const POST_HANDLER = 'export async function POST(request: Request) {\n  await getSession(request);\n'
  + '  const input = createTask.parse(await request.json());\n'
  + "  return Response.json({ id: '1', title: input.title }, { status: 201 });\n}\n";
const IMPORTS = "import { getSession } from '@/lib/session';\nimport { createTask } from '@/lib/schemas';\n";
const OUTPUT_PATHS = [
  TOOLS_PATHS.inventory, TOOLS_PATHS.tombstones, TOOLS_PATHS.contracts, TOOLS_PATHS.report,
  TOOLS_PATHS.setupArtifact, TOOLS_PATHS.runtimeManifest, TOOLS_PATHS.promptManifest, TOOLS_PATHS.receipt,
  DEFAULT_GENERATED_MODULE,
];

async function app(): Promise<AppFixture> {
  return createAppFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/lib/session.ts': SESSION,
    'src/lib/schemas.ts': SCHEMAS,
    'src/app/api/tasks/route.ts': `${IMPORTS}${GET_HANDLER}${POST_HANDLER}`,
  });
}

async function snapshot(fixture: AppFixture): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(OUTPUT_PATHS.map(async (path) => [path, await fixture.read(path)] as const)));
}

async function artifactOf(fixture: AppFixture) {
  return AppSetupArtifactSchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.setupArtifact)));
}

async function failure(promise: Promise<unknown>): Promise<ToolsPipelineFailure> {
  const outcome = await promise.then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  return outcome as ToolsPipelineFailure;
}

describe('runToolsPipeline (write and frozen)', () => {
  it('writes all outputs consistently with setup, doctor and the policy defaults', async () => {
    const fixture = await app();
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.wrote).toBe(true);
    expect(result.changes.added).toHaveLength(2);
    expect(Object.keys(result.outputs).sort()).toEqual([...OUTPUT_PATHS].sort());
    const files = await snapshot(fixture);
    expect(files).toEqual(result.outputs);
    const artifact = await artifactOf(fixture);
    expect(artifact.tools.map((tool) => [tool.method, tool.riskClass, tool.requiresApproval, tool.enabled]).sort())
      .toEqual([['GET', 'safe-read', false, true], ['POST', 'write', true, true]]);
    const rendered = await renderCurrentSetupManifests({ rootDir: fixture.root, managed: false });
    expect(rendered.runtimeContent).toBe(files[TOOLS_PATHS.runtimeManifest]);
    expect(JSON.parse(rendered.runtimeContent)).toHaveProperty('policyDigest');
    const receipt = JSON.parse(files[TOOLS_PATHS.receipt]!) as { planDigest: string; runtimeDigest: string };
    expect(receipt.planDigest).toBe((await createSetupPlan({ rootDir: fixture.root })).planDigest);
    expect(receipt.runtimeDigest).toBe(rendered.runtimeDigest);
  }, 120_000);

  it('is byte-identical on the next run and passes the frozen check', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const first = await snapshot(fixture);
    const again = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(again.wrote).toBe(false);
    expect(again.driftPaths).toEqual([]);
    expect(await snapshot(fixture)).toEqual(first);
    const frozen = await runToolsPipeline({ root: fixture.root, mode: 'frozen' });
    expect(frozen.driftPaths).toEqual([]);
    expect(frozen.outputs).toEqual(first);
  }, 120_000);

  it('keeps change-relative findings out of the outputs after a risk raise', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    await fixture.write('src/app/api/tasks/route.ts', "import { execFile } from 'node:child_process';\n"
      + `${IMPORTS}${GET_HANDLER}${POST_HANDLER.replace('  await getSession(request);\n', "  await getSession(request);\n  execFile('true');\n")}`);
    const raised = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(raised.findings.filter((finding) => finding.code === 'risk-raised').map((finding) => finding.subjectRef))
      .toEqual(['POST /api/tasks']);
    const post = (await artifactOf(fixture)).tools.find((tool) => tool.method === 'POST');
    expect(post).toMatchObject({ riskClass: 'external', requiresApproval: true });
    expect(await fixture.read(TOOLS_PATHS.report)).not.toContain('risk-raised');
    const frozen = await runToolsPipeline({ root: fixture.root, mode: 'frozen' });
    expect(frozen.driftPaths).toEqual([]);
  }, 120_000);

  it('reports drift in frozen mode with a named finding and writes nothing', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const before = await snapshot(fixture);
    await fixture.write('src/app/api/notes/route.ts', `${IMPORTS}${GET_HANDLER}`);
    const error = await failure(runToolsPipeline({ root: fixture.root, mode: 'frozen' }));
    expect(error.code).toBe('E-TOOLS-010');
    expect(error.result.changes.added).toHaveLength(1);
    expect(error.result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'tool-outputs-drift', severity: 'error', subjectRef: TOOLS_PATHS.inventory }),
    ]));
    expect(await snapshot(fixture)).toEqual(before);
  }, 120_000);

  it('writes nothing when enumeration is incomplete or the policy is invalid', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const before = await snapshot(fixture);
    await fixture.write('src/app/api/broken/route.ts', "export * from './handlers';\n");
    const incomplete = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(incomplete.result.wrote).toBe(false);
    expect(incomplete.result.findings.map((finding) => finding.code)).toContain('E-INVENTORY-011');
    const kept = await runToolsPipeline({ root: fixture.root, mode: 'write', keepGoing: true });
    expect(kept.wrote).toBe(false);
    expect(await snapshot(fixture)).toEqual(before);
    await fixture.remove('src/app/api/broken');
    await fixture.write(TOOLS_PATHS.policy, '{ "schemaVersion": 1, "tools": { "GET /api/tasks": { "enabled": "nope" } } }');
    const invalid = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(invalid.result.findings.map((finding) => finding.code)).toContain('E-POLICY-001');
    expect(await snapshot(fixture)).toEqual(before);
  }, 120_000);

  it('keeps the identity of a known tool that becomes unresolved and disables it', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const postId = (await artifactOf(fixture)).tools.find((tool) => tool.method === 'POST')!.toolId;
    await fixture.write('src/app/api/tasks/route.ts', `${IMPORTS}declare function save(value: unknown): Promise<{ id: string }>;\n${GET_HANDLER}`
      + 'export async function POST(request: Request) {\n  await getSession(request);\n  const body = await request.json();\n'
      + '  return Response.json(await save(body));\n}\n');
    const result = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(result.changes.changed).toContain(postId);
    const post = (await artifactOf(fixture)).tools.find((tool) => tool.toolId === postId);
    expect(post).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    const module = await fixture.read(DEFAULT_GENERATED_MODULE);
    expect(module.slice(module.indexOf('export const toolCatalog'))).not.toContain(postId);
  }, 120_000);

  it('tombstones removed tools and adopts an existing inventory', async () => {
    const fixture = await app();
    await fixture.write('pilot/inventory.json', canonicalJson({
      schemaVersion: 2,
      targetAppKey: 'tool-fixture',
      executions: [{
        toolId: '019fb007-0000-7000-8000-0000000000e1', definitionId: 'tasks.search', stableKey: 'GET /api/tasks',
        executionKind: 'endpoint', sourceFile: 'src/app/api/tasks/route.ts', method: 'GET', path: '/api/tasks',
        sourceFingerprint: `sha256:${'F'.repeat(43)}`, inputSchemaDigest: `sha256:${'A'.repeat(43)}`,
        outputSchemaDigest: `sha256:${'B'.repeat(43)}`,
      }],
    }));
    const adopted = await runToolsPipeline({ root: fixture.root, mode: 'write', adoptInventoryPath: 'pilot/inventory.json' });
    expect(adopted.changes.changed).toEqual(['019fb007-0000-7000-8000-0000000000e1']);
    const inventory = FoundationExecutionInventorySchema.parse(JSON.parse(await fixture.read(TOOLS_PATHS.inventory)));
    expect(inventory.executions.find((entry) => entry.stableKey === 'GET /api/tasks'))
      .toMatchObject({ toolId: '019fb007-0000-7000-8000-0000000000e1', definitionId: 'tasks.search' });
    await fixture.write('src/app/api/tasks/route.ts', `${IMPORTS}${POST_HANDLER}`);
    const removed = await runToolsPipeline({ root: fixture.root, mode: 'write' });
    expect(removed.changes.removed).toEqual(['019fb007-0000-7000-8000-0000000000e1']);
    expect(JSON.parse(await fixture.read(TOOLS_PATHS.tombstones))).toMatchObject({
      appId: FIXTURE_APP_ID,
      tombstones: [{ toolId: '019fb007-0000-7000-8000-0000000000e1', stableKey: 'GET /api/tasks' }],
    });
  }, 120_000);

  it('refuses to write through a linked output folder', async () => {
    const fixture = await app();
    const outside = await mkdtemp(join(SDK_ROOT, '.tool-fixtures', 'outside-'));
    outsideDirs.push(outside);
    await mkdir(fixture.path('.glirastes'), { recursive: true });
    await symlink(outside, fixture.path('.glirastes/build'), 'dir');
    const error = await failure(runToolsPipeline({ root: fixture.root, mode: 'write' }));
    expect(error.result.findings.map((finding) => finding.code)).toContain('output-path-linked');
    expect(await readdir(outside)).toEqual([]);
    await expect(readFile(fixture.path(TOOLS_PATHS.inventory))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline.test.ts`
Expected: FAIL — `Failed to resolve import "./pipeline.js"`.

- [ ] **Step 3: Implement `inputs.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalPromptBundleSchema, type LocalPromptBundle } from '../../cli/commands/validate-build.js';
import { ToolPolicyFileSchema, type ToolPolicyFile } from '../../contracts/tool-policy.js';
import { TOOLS_PATHS, type ToolsConfig } from './config.js';
import { toolFinding } from './findings.js';
import { loadToolSemantics, type ToolSemantics } from './prose.js';
import { loadToolResolutions, type ToolResolutions } from './resolutions.js';
import type { ToolFinding } from './types.js';

export interface PromptBundleInput {
  raw: string;
  bundle: LocalPromptBundle;
}

export interface ToolInputs {
  policy: ToolPolicyFile;
  resolutions: ToolResolutions;
  semantics: ToolSemantics;
  promptBundle?: PromptBundleInput;
  previousSetupArtifactRaw?: string;
}

async function readOptional(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(resolve(root, path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function emptyToolPolicy(): ToolPolicyFile {
  return ToolPolicyFileSchema.parse({ schemaVersion: 1, tools: {}, exclude: [], acceptedRisk: {} });
}

export async function readPromptBundle(
  root: string,
  config: ToolsConfig,
): Promise<{ promptBundle?: PromptBundleInput; findings: ToolFinding[] }> {
  const raw = await readOptional(root, TOOLS_PATHS.promptBundle);
  if (raw === undefined) {
    return { findings: [toolFinding('prompt-bundle-missing', 'error', TOOLS_PATHS.promptBundle, 'The app has no local prompt bundle.')] };
  }
  const invalid = { findings: [toolFinding('prompt-bundle-invalid', 'error', TOOLS_PATHS.promptBundle, 'The prompt bundle is invalid or belongs to a different app.')] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid;
  }
  const parsed = LocalPromptBundleSchema.safeParse(json);
  if (!parsed.success || parsed.data.appId !== config.appId) return invalid;
  return { promptBundle: { raw, bundle: parsed.data }, findings: [] };
}

/** Reads the developer-owned inputs; the pipeline never writes any of them. */
export async function readToolInputs(
  root: string,
  config: ToolsConfig,
): Promise<{ inputs: ToolInputs; findings: ToolFinding[] }> {
  const findings: ToolFinding[] = [];
  let policy = emptyToolPolicy();
  const policyRaw = await readOptional(root, TOOLS_PATHS.policy);
  if (policyRaw !== undefined) {
    let parsed: ReturnType<typeof ToolPolicyFileSchema.safeParse> | undefined;
    try {
      parsed = ToolPolicyFileSchema.safeParse(JSON.parse(policyRaw));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) {
      policy = parsed.data;
    } else {
      // Same code as P02's parseToolPolicyFile, so CLI, doctor and Platform agree.
      findings.push(toolFinding('E-POLICY-001', 'error', TOOLS_PATHS.policy,
        'tool-policy.json is not valid; nothing is written until it is fixed.'));
    }
  }
  const resolutions = loadToolResolutions(root);
  findings.push(...resolutions.findings);
  const semantics = loadToolSemantics(root);
  findings.push(...semantics.findings);
  const prompt = await readPromptBundle(root, config);
  findings.push(...prompt.findings);
  const previousSetupArtifactRaw = await readOptional(root, TOOLS_PATHS.previousSetupArtifact);
  return {
    inputs: {
      policy,
      resolutions: resolutions.resolutions,
      semantics: semantics.semantics,
      ...(prompt.promptBundle ? { promptBundle: prompt.promptBundle } : {}),
      ...(previousSetupArtifactRaw !== undefined ? { previousSetupArtifactRaw } : {}),
    },
    findings,
  };
}
```

- [ ] **Step 4: Implement `pipeline.ts`**

```ts
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { writeArtifactSetAtomically } from '../../cli/commands/atomic-artifact-write.js';
import { createSetupPlanFromContents } from '../../cli/commands/setup-plan.js';
import { renderManifestContents } from '../../cli/commands/validate-build.js';
import { assertAppSetupSemanticParity, type AppSetupArtifact } from '../../contracts/index.js';
import {
  confirmationFloor,
  deriveToolPolicyDefaults,
  resolveToolPolicy,
  riskTier,
} from '../../contracts/tool-policy.js';
import { FoundationDiagnosticError, isFoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  discoverFoundationExecutions,
  type FoundationExecutionDiscovery,
  type FoundationExecutionInventory,
} from '../execution-inventory.js';
import { reconcileExecutionInventory, type ExecutionGenerationResult } from '../inventory-generation.js';
import {
  buildSetupArtifact,
  renderToolContracts,
  renderToolReport,
  schemaQualityOf,
  type ArtifactToolInput,
  type ToolReportTool,
} from './artifact.js';
import { compareCodeUnits } from './canonical.js';
import {
  generatedModulePath,
  loadToolsConfig,
  normalizeSources,
  TOOLS_PATHS,
  type ToolsConfig,
} from './config.js';
import { renderGeneratedModule } from './emit-module.js';
import { sortFindings, toolFinding, TRANSIENT_FINDING_CODES } from './findings.js';
import { readToolInputs, type PromptBundleInput } from './inputs.js';
import type { ToolsMode } from './mode.js';
import { resolveToolProse } from './prose.js';
import { resolutionOrigin } from './resolutions.js';
import { createSchemaProbe, type SchemaProbe } from './schema-probe.js';
import { createNextEndpointSource } from './sources/next-endpoints.js';
import {
  readPreviousToolState,
  renderInventory,
  renderTombstones,
  ToolStateError,
  type PreviousToolState,
} from './state.js';
import type {
  ExcludedTool,
  ObservedTool,
  ToolContractsEntry,
  ToolFinding,
  ToolSource,
  ToolSourceContext,
} from './types.js';

export interface ToolsPipelineResult {
  mode: ToolsMode;
  changes: { added: string[]; changed: string[]; removed: string[]; unchanged: string[] };
  findings: ToolFinding[];
  excluded: Array<{ stableKey: string; reason: string; origin: string }>;
  outputs: Record<string, string>;
  driftPaths: string[];
  wrote: boolean;
}

export interface ToolsPipelineOptions {
  root: string;
  mode: ToolsMode;
  keepGoing?: boolean;
  adoptInventoryPath?: string;
}

export interface ToolsPipelineDependencies {
  probe?: SchemaProbe;
  now?: () => Date;
  sources?: ReadonlyArray<ToolSource>;
}

export class ToolsPipelineFailure extends FoundationDiagnosticError {
  readonly result: ToolsPipelineResult;

  constructor(result: ToolsPipelineResult) {
    const first = result.findings.find((finding) => finding.severity === 'error');
    super({
      code: 'E-TOOLS-010',
      operation: `tools.${result.mode}`,
      message: 'Glirastes tools found errors; no outputs were written.',
      remediation: first?.nextAction ?? 'inspect-tool-findings',
      ...(first ? { identifier: first.code } : {}),
    });
    this.name = 'ToolsPipelineFailure';
    this.result = result;
  }
}

class DerivedOutputError extends Error {
  readonly finding: ToolFinding;

  constructor(finding: ToolFinding) {
    super(finding.message);
    this.finding = finding;
  }
}

const SETUP_PATHS = {
  inventory: TOOLS_PATHS.inventory,
  setupArtifact: TOOLS_PATHS.setupArtifact,
  canonicalSetupArtifact: TOOLS_PATHS.setupArtifact,
  previousSetupArtifact: TOOLS_PATHS.previousSetupArtifact,
  promptBundle: TOOLS_PATHS.promptBundle,
  buildDir: '.glirastes/build',
  receipt: TOOLS_PATHS.receipt,
};

function emptyChanges(): ToolsPipelineResult['changes'] {
  return { added: [], changed: [], removed: [], unchanged: [] };
}

function isError(finding: ToolFinding): boolean {
  return finding.severity === 'error';
}

function sortExcluded(excluded: ReadonlyArray<ExcludedTool>): ExcludedTool[] {
  return [...excluded].sort((left, right) => compareCodeUnits(left.stableKey, right.stableKey));
}

function policyWarningMessage(code: string, field: string | undefined): string {
  switch (code) {
    case 'override-lapsed-risk-raised':
      return 'A relaxation in tool-policy.json no longer applies because the risk was raised.';
    case 'risk-lower-available':
      return 'The code now implies a lower risk; the previous risk is kept until it is accepted.';
    case 'policy-entry-orphaned':
      return 'The tool-policy.json entry belongs to an earlier identity of this tool.';
    default:
      return field ? `Policy warning for ${field}.` : 'Policy warning.';
  }
}

interface DerivedOutputInput {
  config: ToolsConfig;
  inventory: FoundationExecutionInventory;
  inventoryRaw: string;
  discovery: FoundationExecutionDiscovery;
  artifact: AppSetupArtifact;
  artifactRaw: string;
  contracts: ReadonlyArray<ToolContractsEntry>;
  promptBundle: PromptBundleInput;
  previousSetupArtifactRaw?: string;
  receiptMode: 'standalone' | 'managed';
}

/** Manifests, receipt and generated module: a pure function of the primary outputs. */
function renderDerivedOutputs(input: DerivedOutputInput): Record<string, string> {
  const manifests = renderManifestContents({
    appId: input.config.appId,
    targetAppKey: input.inventory.targetAppKey,
    inventoryDigest: input.discovery.inventoryDigest,
    executions: input.discovery.executions,
    promptBundle: input.promptBundle.bundle,
    setupArtifact: input.artifact,
  });
  let planDigest: string;
  try {
    planDigest = createSetupPlanFromContents({
      mode: input.receiptMode,
      paths: SETUP_PATHS,
      proposed: { path: TOOLS_PATHS.setupArtifact, raw: input.artifactRaw },
      previousRaw: input.previousSetupArtifactRaw ?? input.artifactRaw,
      inventoryRaw: input.inventoryRaw,
      promptBundleRaw: input.promptBundle.raw,
    }).planDigest;
  } catch {
    throw new DerivedOutputError(toolFinding('setup-plan-invalid', 'error', TOOLS_PATHS.previousSetupArtifact,
      'The previous setup artifact left by glirastes setup cannot be compared with the generated artifact.'));
  }
  const receipt = {
    schemaVersion: 1,
    planDigest,
    mode: input.receiptMode,
    appId: input.config.appId,
    toolCount: input.inventory.executions.length,
    runtimeDigest: manifests.runtimeDigest,
    promptDigest: manifests.promptDigest,
    restartRequired: true,
  };
  const modulePath = generatedModulePath(input.config);
  return {
    [TOOLS_PATHS.runtimeManifest]: manifests.runtimeContent,
    [TOOLS_PATHS.promptManifest]: manifests.promptContent,
    [TOOLS_PATHS.receipt]: `${JSON.stringify(receipt, null, 2)}\n`,
    [modulePath]: renderGeneratedModule({ modulePath, artifact: input.artifact, contracts: input.contracts }),
  };
}

async function diffOutputs(root: string, outputs: Readonly<Record<string, string>>): Promise<string[]> {
  const drift: string[] = [];
  for (const path of Object.keys(outputs).sort(compareCodeUnits)) {
    const current = await readFile(resolve(root, path), 'utf8').catch(() => undefined);
    if (current !== outputs[path]) drift.push(path);
  }
  return drift;
}

async function linkedOutputPath(root: string, paths: ReadonlyArray<string>): Promise<string | undefined> {
  for (const path of paths) {
    const target = resolve(root, path);
    let directory = dirname(target);
    while (!existsSync(directory)) directory = dirname(directory);
    const local = relative(root, await realpath(directory));
    if (local.startsWith('..') || isAbsolute(local)) return path;
    if (existsSync(target) && (await lstat(target)).isSymbolicLink()) return path;
  }
  return undefined;
}

async function writeOutputs(
  root: string,
  outputs: Readonly<Record<string, string>>,
  paths: ReadonlyArray<string>,
): Promise<void> {
  for (const directory of new Set(paths.map((path) => dirname(resolve(root, path))))) {
    await mkdir(directory, { recursive: true });
  }
  await writeArtifactSetAtomically(paths.map((path) => ({ path: resolve(root, path), content: outputs[path]! })));
}

async function generate(
  root: string,
  config: ToolsConfig,
  options: ToolsPipelineOptions,
  dependencies: ToolsPipelineDependencies,
): Promise<ToolsPipelineResult> {
  const findings: ToolFinding[] = [];
  const excluded: ExcludedTool[] = [];
  const result = (extra: Partial<ToolsPipelineResult> = {}): ToolsPipelineResult => ({
    mode: options.mode,
    changes: emptyChanges(),
    findings,
    excluded: sortExcluded(excluded),
    outputs: {},
    driftPaths: [],
    wrote: false,
    ...extra,
  });

  const { inputs, findings: inputFindings } = await readToolInputs(root, config);
  findings.push(...inputFindings);
  let previous: PreviousToolState;
  try {
    previous = await readPreviousToolState(root, config,
      options.adoptInventoryPath ? { adoptInventoryPath: options.adoptInventoryPath } : {});
  } catch (error) {
    if (error instanceof ToolStateError) {
      findings.push(toolFinding('generation-state-invalid', 'error', error.path, error.message));
      return result();
    }
    throw error;
  }
  const promptBundle = inputs.promptBundle;
  if (!promptBundle || findings.some(isError)) return result();

  const context: ToolSourceContext = {
    root,
    config,
    resolutions: inputs.resolutions,
    policy: inputs.policy,
    ...(previous.state ? { previous: previous.state } : {}),
    previousContracts: previous.contracts,
    probe: dependencies.probe ?? createSchemaProbe(),
  };
  const sources = dependencies.sources ?? normalizeSources(config).map((source) => (
    createNextEndpointSource(source.apiDir ? { apiDir: source.apiDir } : {})
  ));
  const observed: ObservedTool[] = [];
  let complete = true;
  for (const source of sources) {
    const observation = await source.observe(context);
    observed.push(...observation.observations);
    findings.push(...observation.findings);
    excluded.push(...observation.excluded ?? []);
    complete &&= observation.complete;
  }
  if (!complete || findings.some(isError)) return result();
  const definitionOwners = new Map<string, string>();
  for (const tool of observed) {
    const owner = definitionOwners.get(tool.execution.definitionId);
    if (owner !== undefined && owner !== tool.execution.stableKey) {
      findings.push(toolFinding('definition-id-conflict', 'error', tool.execution.stableKey,
        `${tool.execution.definitionId} is also used by ${owner}.`));
    }
    definitionOwners.set(tool.execution.definitionId, tool.execution.stableKey);
  }
  if (findings.some(isError)) return result();

  let generation: ExecutionGenerationResult;
  try {
    generation = reconcileExecutionInventory({
      appId: config.appId,
      targetAppKey: config.targetAppKey,
      observed: { complete: true, executions: observed.map((tool) => tool.execution) },
      ...(previous.state ? { previous: previous.state } : {}),
    });
  } catch (error) {
    if (isFoundationDiagnosticError(error)) {
      findings.push(toolFinding(error.code, 'error', 'inventory', error.message));
      return result();
    }
    throw error;
  }
  const inventory = generation.state.inventory;
  const discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  const observedByKey = new Map(observed.map((tool) => [tool.execution.stableKey, tool] as const));
  const toolIdByKey = new Map(inventory.executions.map((execution) => [execution.stableKey, execution.toolId] as const));
  const artifactTools: ArtifactToolInput[] = [];
  const contractEntries: ToolContractsEntry[] = [];
  const reportTools: ToolReportTool[] = [];

  for (const execution of inventory.executions) {
    const tool = observedByKey.get(execution.stableKey);
    if (!tool) throw new Error(`No observation for ${execution.stableKey}`);
    const needsAttention = tool.findings.some((finding) => finding.severity === 'needs_attention');
    const defaults = deriveToolPolicyDefaults({
      executionKind: execution.executionKind,
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      definitionId: execution.definitionId,
      ...(tool.evidence.declaredEffect ? { declaredEffect: tool.evidence.declaredEffect } : {}),
      evidence: { externalCall: tool.evidence.externalCall },
    });
    const local = (inputs.policy.tools ?? {})[execution.stableKey];
    const acceptedRisk = (inputs.policy.acceptedRisk ?? {})[execution.stableKey];
    const previousRisk = previous.artifact?.riskByToolId.get(execution.toolId);
    const resolved = resolveToolPolicy({
      toolId: execution.toolId,
      defaults,
      codeEnabled: !needsAttention,
      ...(local ? { local } : {}),
      ...(acceptedRisk ? { acceptedRisk } : {}),
      ...(previousRisk ? { previousEffectiveRiskClass: previousRisk } : {}),
    });
    for (const warning of resolved.warnings) {
      findings.push(toolFinding(warning.code, 'warning', execution.stableKey, policyWarningMessage(warning.code, warning.field)));
    }
    for (const error of resolved.errors) {
      findings.push(toolFinding(error.code, 'error', execution.stableKey, `${error.field}: ${error.reason}`));
    }
    if (previousRisk && riskTier(resolved.effective.riskClass) > riskTier(previousRisk)) {
      findings.push(toolFinding('risk-raised', 'warning', execution.stableKey,
        `Risk raised from ${previousRisk} to ${resolved.effective.riskClass}; confirmation follows automatically.`));
    }
    findings.push(...tool.findings);
    const prose = resolveToolProse({
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      ...(execution.executionKind === 'endpoint' ? { method: execution.method, path: execution.path } : {}),
      operationGroup: defaults.operationGroup,
      locale: config.locale,
      ...(tool.evidence.jsDoc ? { jsDoc: tool.evidence.jsDoc } : {}),
      ...(tool.prose ? { hints: tool.prose } : {}),
      semantics: inputs.semantics,
      ...(resolved.effective.description && resolved.effective.origin.description !== 'code-default'
        ? { policyDescription: resolved.effective.description }
        : {}),
    });
    findings.push(...prose.findings);
    artifactTools.push({
      execution,
      prose,
      effective: resolved.effective,
      operationGroup: needsAttention ? 'needs_attention' : defaults.operationGroup,
    });
    contractEntries.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      contract: tool.contract ?? null,
      defaults,
    });
    reportTools.push({
      toolId: execution.toolId,
      stableKey: execution.stableKey,
      definitionId: execution.definitionId,
      enabled: resolved.effective.enabled,
      riskClass: resolved.effective.riskClass,
      requiresApproval: confirmationFloor(resolved.effective.riskClass, resolved.effective.requiresApproval),
      contractSource: tool.contract?.source ?? null,
      quality: {
        description: prose.descriptionOrigin,
        schema: schemaQualityOf(tool.contract, resolutionOrigin(inputs.resolutions, execution.stableKey)),
      },
    });
  }
  for (const key of Object.keys(inputs.policy.tools ?? {})) {
    if (!observedByKey.has(key)) {
      findings.push(toolFinding('policy-entry-orphaned', 'warning', key,
        'This tool-policy.json entry matches no tool in the current code.'));
    }
  }
  if (findings.some(isError)) return result({ changes: generation.changes });

  const stableFindings = findings.filter((finding) => !TRANSIENT_FINDING_CODES.has(finding.code));
  const built = buildSetupArtifact({
    appId: config.appId,
    targetAppKey: config.targetAppKey,
    discoveryDigest: discovery.inventoryDigest,
    tools: artifactTools,
    promptBundle: promptBundle.bundle,
    warnings: stableFindings
      .filter((finding) => toolIdByKey.has(finding.subjectRef))
      .map((finding) => ({ code: finding.code, subjectRef: toolIdByKey.get(finding.subjectRef)! })),
    ...(previous.artifact ? { previous: previous.artifact } : {}),
    now: options.mode === 'write' ? dependencies.now ?? (() => new Date()) : null,
  });
  assertAppSetupSemanticParity(built.artifact, inventory.executions.map((execution) => execution.definitionId));
  const inventoryRaw = renderInventory(generation.state);
  let derived: Record<string, string>;
  try {
    derived = renderDerivedOutputs({
      config,
      inventory,
      inventoryRaw,
      discovery,
      artifact: built.artifact,
      artifactRaw: built.raw,
      contracts: contractEntries,
      promptBundle,
      ...(inputs.previousSetupArtifactRaw !== undefined
        ? { previousSetupArtifactRaw: inputs.previousSetupArtifactRaw }
        : {}),
      receiptMode: previous.receiptMode ?? 'standalone',
    });
  } catch (error) {
    if (error instanceof DerivedOutputError) {
      findings.push(error.finding);
      return result({ changes: generation.changes });
    }
    throw error;
  }
  const outputs: Record<string, string> = {
    [TOOLS_PATHS.inventory]: inventoryRaw,
    [TOOLS_PATHS.tombstones]: renderTombstones(generation.state),
    [TOOLS_PATHS.contracts]: renderToolContracts(config.appId, contractEntries),
    [TOOLS_PATHS.report]: renderToolReport({
      appId: config.appId,
      discoveryDigest: discovery.inventoryDigest,
      tools: reportTools,
      findings: stableFindings,
      excluded,
    }),
    [TOOLS_PATHS.setupArtifact]: built.raw,
    ...derived,
  };
  const driftPaths = await diffOutputs(root, outputs);
  if (options.mode !== 'write') {
    for (const path of driftPaths) {
      findings.push(toolFinding('tool-outputs-drift', 'error', path, `${path} is out of date with the code.`));
    }
    return result({ changes: generation.changes, outputs, driftPaths });
  }
  if (driftPaths.length === 0) return result({ changes: generation.changes, outputs, driftPaths });
  const linked = await linkedOutputPath(root, driftPaths);
  if (linked) {
    findings.push(toolFinding('output-path-linked', 'error', linked, `${linked} resolves outside the app.`));
    return result({ changes: generation.changes, outputs, driftPaths });
  }
  await writeOutputs(root, outputs, driftPaths);
  return result({ changes: generation.changes, outputs, driftPaths, wrote: true });
}

export async function runToolsPipelineWith(
  options: ToolsPipelineOptions,
  dependencies: ToolsPipelineDependencies,
): Promise<ToolsPipelineResult> {
  const root = await realpath(resolve(options.root));
  const config = loadToolsConfig(root);
  const raw = await generate(root, config, options, dependencies);
  const result = { ...raw, findings: sortFindings(raw.findings) };
  if (result.findings.some(isError) && !options.keepGoing) throw new ToolsPipelineFailure(result);
  return result;
}

/** Derives the app's tools from code: write, frozen (check) or integrity (deploy) mode. */
export async function runToolsPipeline(options: ToolsPipelineOptions): Promise<ToolsPipelineResult> {
  return runToolsPipelineWith(options, {});
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/inputs.ts src/codegen/tools/pipeline.ts src/codegen/tools/pipeline.test.ts
git commit -m "feat(codegen): run the tools pipeline in write and frozen modes"
```

### Task 21: Pipeline — integrity mode

**Files:**
- Modify: `src/codegen/tools/pipeline.ts` (imports, new `verifyIntegrity`, dispatch in `runToolsPipelineWith`)
- Test: `src/codegen/tools/pipeline-integrity.test.ts`

**Interfaces:**
- Consumes: `FoundationExecutionInventorySchema`, `ToolTombstonesFileSchema`, `ToolContractsFileSchema`, `toToolContractsEntry` (Task 4), `AppSetupArtifactSchema`, `readPromptBundle` (Task 20), `renderDerivedOutputs`, `diffOutputs` (Task 20, same file).
- Produces: `runToolsPipeline({ mode: 'integrity' })` verifies inventory → discovery `inventoryDigest` → artifact `discoveryDigest` → runtime manifest (`runtimeDigest`, `policyDigest`) → receipt → generated module by re-rendering the derived outputs from the committed primary outputs; it never observes sources, never probes, never writes, and reports `tool-output-invalid` / `integrity-chain-broken` findings.

- [ ] **Step 1: Write the failing test**

`src/codegen/tools/pipeline-integrity.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures, type AppFixture } from './__tests__/app-fixture.js';
import { DEFAULT_GENERATED_MODULE, TOOLS_PATHS } from './config.js';
import { runToolsPipeline, runToolsPipelineWith, ToolsPipelineFailure } from './pipeline.js';
import type { SchemaProbe } from './schema-probe.js';
import type { ToolSource } from './types.js';

afterEach(removeAppFixtures);

const ROUTE = 'src/app/api/tasks/route.ts';
const ROUTE_SOURCE = "import { createTask } from './schemas';\n"
  + 'declare function getSession(): Promise<unknown>;\n'
  + 'export async function GET() {\n  await getSession();\n  return Response.json({ tasks: [] as string[] });\n}\n'
  + 'export async function POST(request: Request) {\n  await getSession();\n'
  + '  const input = createTask.parse(await request.json());\n  return Response.json({ id: input.title });\n}\n';

async function refreshedApp(): Promise<AppFixture> {
  const fixture = await createAppFixture({
    'src/app/api/tasks/schemas.ts': "import { z } from 'zod';\nexport const createTask = z.object({ title: z.string() }).strict();\n",
    [ROUTE]: ROUTE_SOURCE,
  });
  await runToolsPipeline({ root: fixture.root, mode: 'write' });
  return fixture;
}

const forbiddenProbe: SchemaProbe = {
  probe: () => {
    throw new Error('integrity mode must not probe schema modules');
  },
};
const forbiddenSource: ToolSource = {
  kind: 'next-app',
  observe: () => {
    throw new Error('integrity mode must not observe sources');
  },
};

async function brokenSubjects(fixture: AppFixture): Promise<string[]> {
  const outcome = await runToolsPipelineWith(
    { root: fixture.root, mode: 'integrity' },
    { probe: forbiddenProbe, sources: [forbiddenSource] },
  ).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  return (outcome as ToolsPipelineFailure).result.findings
    .filter((finding) => finding.code === 'integrity-chain-broken' || finding.code === 'tool-output-invalid')
    .map((finding) => `${finding.code}:${finding.subjectRef}`);
}

describe('runToolsPipeline (integrity)', () => {
  it('verifies the committed chain without observing or probing anything', async () => {
    const fixture = await refreshedApp();
    const result = await runToolsPipelineWith(
      { root: fixture.root, mode: 'integrity' },
      { probe: forbiddenProbe, sources: [forbiddenSource] },
    );
    expect(result).toMatchObject({ mode: 'integrity', wrote: false, driftPaths: [] });
    expect(Object.keys(result.outputs).sort()).toEqual([
      TOOLS_PATHS.runtimeManifest, TOOLS_PATHS.promptManifest, TOOLS_PATHS.receipt, DEFAULT_GENERATED_MODULE,
    ].sort());
  }, 120_000);

  it.each([
    ['the generated module', DEFAULT_GENERATED_MODULE, (text: string) => `${text}export const injected = true;\n`, `integrity-chain-broken:${DEFAULT_GENERATED_MODULE}`],
    ['the runtime manifest', TOOLS_PATHS.runtimeManifest, (text: string) => text.replace('"policyDigest": "sha256:', '"policyDigest": "sha256:X'), `integrity-chain-broken:${TOOLS_PATHS.runtimeManifest}`],
    ['an approval flag in the artifact', TOOLS_PATHS.setupArtifact, (text: string) => text.replace('"requiresApproval": true', '"requiresApproval": false'), `integrity-chain-broken:${TOOLS_PATHS.runtimeManifest}`],
    ['the receipt', TOOLS_PATHS.receipt, (text: string) => text.replace('"toolCount": 2', '"toolCount": 3'), `integrity-chain-broken:${TOOLS_PATHS.receipt}`],
    ['the route source', ROUTE, (text: string) => `${text}// edited after refresh\n`, `integrity-chain-broken:${TOOLS_PATHS.inventory}`],
  ])('detects a manipulated %s', async (_label, path, edit, expected) => {
    const fixture = await refreshedApp();
    const original = await fixture.read(path);
    const edited = edit(original);
    expect(edited).not.toBe(original);
    await fixture.write(path, edited);
    expect(await brokenSubjects(fixture)).toContain(expected);
  }, 120_000);

  it('reports missing generated files as invalid outputs', async () => {
    const fixture = await refreshedApp();
    await fixture.remove(TOOLS_PATHS.contracts);
    expect(await brokenSubjects(fixture)).toEqual([`tool-output-invalid:${TOOLS_PATHS.contracts}`]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline-integrity.test.ts`
Expected: FAIL — the first test throws `integrity mode must not observe sources` (integrity still takes the frozen path).

- [ ] **Step 3: Implement integrity verification**

In `src/codegen/tools/pipeline.ts`:

1. Add these imports (merging with the existing import lines from the same modules):

```ts
import type { z } from 'zod';
import { AppSetupArtifactSchema } from '../../contracts/index.js';
import { FoundationExecutionInventorySchema } from '../execution-inventory.js';
import { ToolContractsFileSchema, ToolTombstonesFileSchema, toToolContractsEntry } from './files.js';
import { readPromptBundle } from './inputs.js';
```

(`AppSetupArtifactSchema` joins `assertAppSetupSemanticParity, type AppSetupArtifact` from `'../../contracts/index.js'`; `FoundationExecutionInventorySchema` joins the existing `'../execution-inventory.js'` import; `readPromptBundle` joins `readToolInputs, type PromptBundleInput` from `'./inputs.js'`.)

2. Add above `runToolsPipelineWith`:

```ts
function receiptModeOf(raw: string | undefined): 'standalone' | 'managed' {
  try {
    const parsed = JSON.parse(raw ?? '') as { mode?: unknown };
    return parsed.mode === 'managed' ? 'managed' : 'standalone';
  } catch {
    return 'standalone';
  }
}

/**
 * Deploy-time check: re-renders manifests, receipt and generated module from
 * the committed primary outputs and verifies the inventory against the route
 * files. Never observes sources, never imports app modules, never writes.
 */
async function verifyIntegrity(root: string, config: ToolsConfig): Promise<ToolsPipelineResult> {
  const findings: ToolFinding[] = [];
  const result = (outputs: Record<string, string> = {}, driftPaths: string[] = []): ToolsPipelineResult => ({
    mode: 'integrity',
    changes: emptyChanges(),
    findings,
    excluded: [],
    outputs,
    driftPaths,
    wrote: false,
  });
  const read = (path: string): Promise<string | undefined> => (
    readFile(resolve(root, path), 'utf8').catch(() => undefined)
  );
  const parse = <T>(path: string, raw: string | undefined, schema: z.ZodType<T>): T | undefined => {
    if (raw === undefined) {
      findings.push(toolFinding('tool-output-invalid', 'error', path, `${path} is missing.`));
      return undefined;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Reported below like any other schema violation.
    }
    findings.push(toolFinding('tool-output-invalid', 'error', path, `${path} is not a valid generated file.`));
    return undefined;
  };
  const broken = (path: string, message: string) => {
    findings.push(toolFinding('integrity-chain-broken', 'error', path, message));
  };

  const inventoryRaw = await read(TOOLS_PATHS.inventory);
  const artifactRaw = await read(TOOLS_PATHS.setupArtifact);
  const inventory = parse(TOOLS_PATHS.inventory, inventoryRaw, FoundationExecutionInventorySchema);
  const tombstones = parse(TOOLS_PATHS.tombstones, await read(TOOLS_PATHS.tombstones), ToolTombstonesFileSchema);
  const contracts = parse(TOOLS_PATHS.contracts, await read(TOOLS_PATHS.contracts), ToolContractsFileSchema);
  const artifact = parse(TOOLS_PATHS.setupArtifact, artifactRaw, AppSetupArtifactSchema);
  const prompt = await readPromptBundle(root, config);
  findings.push(...prompt.findings);
  if (!inventory || !inventoryRaw || !tombstones || !contracts || !artifact || !artifactRaw || !prompt.promptBundle) {
    return result();
  }
  if (tombstones.appId !== config.appId || contracts.appId !== config.appId || artifact.appId !== config.appId) {
    broken(TOOLS_PATHS.setupArtifact, 'The generated files belong to a different app.');
    return result();
  }
  let discovery: FoundationExecutionDiscovery;
  try {
    discovery = await discoverFoundationExecutions({ rootDir: root, inventory });
  } catch {
    broken(TOOLS_PATHS.inventory, 'The inventory no longer matches the route sources; run glirastes tools refresh.');
    return result();
  }
  if (artifact.discoveryDigest !== discovery.inventoryDigest) {
    broken(TOOLS_PATHS.setupArtifact, 'The setup artifact was generated from a different inventory.');
  }
  try {
    assertAppSetupSemanticParity(artifact, inventory.executions.map((execution) => execution.definitionId));
  } catch {
    broken(TOOLS_PATHS.setupArtifact, 'The setup artifact does not match the inventory tools.');
  }
  const inventoryIds = inventory.executions.map((execution) => execution.toolId).sort(compareCodeUnits).join(',');
  if (contracts.tools.map((entry) => entry.toolId).sort(compareCodeUnits).join(',') !== inventoryIds) {
    broken(TOOLS_PATHS.contracts, 'Tool contracts do not match the inventory.');
  }
  if (findings.some(isError)) return result();

  const previousSetupArtifactRaw = await read(TOOLS_PATHS.previousSetupArtifact);
  let derived: Record<string, string>;
  try {
    derived = renderDerivedOutputs({
      config,
      inventory,
      inventoryRaw,
      discovery,
      artifact,
      artifactRaw,
      contracts: contracts.tools.map(toToolContractsEntry),
      promptBundle: prompt.promptBundle,
      ...(previousSetupArtifactRaw !== undefined ? { previousSetupArtifactRaw } : {}),
      receiptMode: receiptModeOf(await read(TOOLS_PATHS.receipt)),
    });
  } catch (error) {
    if (error instanceof DerivedOutputError) {
      findings.push(error.finding);
      return result();
    }
    if (error instanceof Error) {
      broken(generatedModulePath(config), error.message);
      return result();
    }
    throw error;
  }
  const driftPaths = await diffOutputs(root, derived);
  for (const path of driftPaths) broken(path, `${path} does not match the committed tool outputs.`);
  return result(derived, driftPaths);
}
```

3. In `runToolsPipelineWith`, replace

```ts
  const raw = await generate(root, config, options, dependencies);
```

with

```ts
  const raw = options.mode === 'integrity'
    ? await verifyIntegrity(root, config)
    : await generate(root, config, options, dependencies);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline-integrity.test.ts src/codegen/tools/pipeline.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/pipeline.ts src/codegen/tools/pipeline-integrity.test.ts
git commit -m "feat(codegen): verify committed tool outputs in integrity mode"
```

### Task 22: CLI `glirastes tools refresh|check|status`

**Files:**
- Create: `src/cli/commands/tools/args.ts`, `src/cli/commands/tools/format.ts`, `src/cli/commands/tools/refresh.ts`, `src/cli/commands/tools/check.ts`, `src/cli/commands/tools/status.ts`, `src/cli/commands/tools/index.ts`
- Modify: `src/cli/index.ts:51-60` (`CommandName`), `:62-67` (`CliDependencies`), `:77-117` (`parseCommand`), `:656-716` (`runCli`)
- Modify: `src/cli/environment-loading.ts:6-9`, `src/cli/environment-loading.test.ts:5-13` (`it.each` list)
- Modify: `src/public-subpaths.test.ts` (Foundation CLI guard)
- Test: `src/cli/commands/tools/tools-command.test.ts`

**Interfaces:**
- Consumes: `runToolsPipeline`, `ToolsPipelineFailure`, `ToolsPipelineOptions`, `ToolsPipelineResult` (Tasks 20–21), `resolveToolsMode`, `isToolsMode`, `loadToolsConfig`, `TOOLS_PATHS`, `ToolReportFileSchema`, `ToolTombstonesFileSchema`, `AppSetupArtifactSchema`, `nextActionFor`, `isFoundationDiagnosticError`.
- Produces:
  - `export class ToolsUsageError extends Error`; `export function parseToolArgs(argv: ReadonlyArray<string>, spec: { flags: ReadonlyArray<string>; values: ReadonlyArray<string> }): { flags: Set<string>; values: Map<string, string> }`
  - `export interface ToolsIo { cwd: string; env: NodeJS.ProcessEnv; log(line: string): void; error(line: string): void; runPipeline(options: ToolsPipelineOptions): Promise<ToolsPipelineResult> }`
  - `export interface ToolStatusEntry { toolId: string; name: string; route: string; enabled: boolean; needsAttention: boolean; riskClass: ToolRiskClass; confirmation: boolean; contractSource: ContractSource | null; descriptionQuality: DescriptionOrigin; schemaQuality: SchemaQuality }`
  - `export function formatToolsJson(result: ToolsPipelineResult): string`; `export function formatToolsHuman(result: ToolsPipelineResult): string`; `export function formatToolStatus(entries: ReadonlyArray<ToolStatusEntry>): string`
  - `export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number>`; `export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number>`; `export async function readToolStatus(root: string): Promise<ToolStatusEntry[]>`; `export async function runToolsStatus(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number>`
  - `export interface ToolsCommandDependencies { cwd?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void; error?: (line: string) => void; runPipeline?: (options: ToolsPipelineOptions) => Promise<ToolsPipelineResult> }`
  - `export const TOOLS_USAGE: string`; `export async function runToolsCommand(argv: string[], deps?: ToolsCommandDependencies): Promise<number>`
  - `CommandName` gains `'tools'`; `CliDependencies.tools?: ToolsCommandDependencies`

Exit codes: 0 success; 1 errors (pipeline failure, invalid config, strict attention items, missing outputs for status); 2 usage errors. `--keep-going` only applies in write mode. Every refresh prints added, changed, risk raised, removed, needs attention and excluded tools, each with the next safe action.

- [ ] **Step 1: Write the failing tests**

`src/cli/commands/tools/tools-command.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from '../../../codegen/tools/__tests__/app-fixture.js';
import { toolFinding } from '../../../codegen/tools/findings.js';
import type { ToolsPipelineOptions, ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
import { runToolsCommand } from './index.js';

afterEach(removeAppFixtures);

const ROUTE = "declare function getSession(): Promise<unknown>;\n"
  + 'export async function GET() { await getSession(); return Response.json({ tasks: [] as string[] }); }\n'
  + 'export async function POST(request: Request) { await getSession(); const body = await request.json();\n'
  + '  return Response.json({ id: String(body.title) }); }\n';

function emptyResult(overrides: Partial<ToolsPipelineResult> = {}): ToolsPipelineResult {
  return {
    mode: 'write',
    changes: { added: [], changed: [], removed: [], unchanged: [] },
    findings: [],
    excluded: [],
    outputs: {},
    driftPaths: [],
    wrote: false,
    ...overrides,
  };
}

function harness(result: ToolsPipelineResult | (() => never) = emptyResult()) {
  const calls: ToolsPipelineOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    calls, out, err,
    deps: (env: NodeJS.ProcessEnv = {}, cwd = '/app') => ({
      cwd,
      env,
      log: (line: string) => { out.push(line); },
      error: (line: string) => { err.push(line); },
      runPipeline: async (options: ToolsPipelineOptions) => {
        calls.push(options);
        return typeof result === 'function' ? result() : result;
      },
    }),
  };
}

describe('glirastes tools', () => {
  it('prints usage for unknown subcommands and options', async () => {
    const h = harness();
    expect(await runToolsCommand(['generate'], h.deps())).toBe(2);
    expect(h.err.join('\n')).toContain('glirastes tools refresh');
    expect(await runToolsCommand(['refresh', '--force'], h.deps())).toBe(2);
    expect(await runToolsCommand(['refresh', '--mode', 'dry'], h.deps())).toBe(2);
  });

  it('resolves the refresh mode from flag, environment and CI', async () => {
    const h = harness();
    await runToolsCommand(['refresh'], h.deps());
    await runToolsCommand(['refresh'], h.deps({ CI: 'true' }));
    await runToolsCommand(['refresh', '--keep-going'], h.deps({ GLIRASTES_TOOLS_MODE: 'integrity' }));
    await runToolsCommand(['refresh', '--mode', 'write', '--keep-going', '--adopt', 'pilot/inventory.json', '--root', 'web'], h.deps({ CI: 'true' }));
    expect(h.calls).toEqual([
      { root: '/app', mode: 'write' },
      { root: '/app', mode: 'frozen' },
      { root: '/app', mode: 'integrity' },
      { root: '/app/web', mode: 'write', keepGoing: true, adoptInventoryPath: 'pilot/inventory.json' },
    ]);
  });

  it('exits 1 with the findings when the pipeline fails and 0 with --keep-going results', async () => {
    const failed = emptyResult({ findings: [toolFinding('E-INVENTORY-011', 'error', 'next-app', 'export * found')] });
    const h = harness(() => { throw new ToolsPipelineFailure(failed); });
    expect(await runToolsCommand(['refresh'], h.deps())).toBe(1);
    expect(h.out.join('\n')).toContain('E-INVENTORY-011');
    expect(h.out.join('\n')).toContain('Nothing was written');
    const json = harness(() => { throw new ToolsPipelineFailure(failed); });
    expect(await runToolsCommand(['refresh', '--json'], json.deps())).toBe(1);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ schemaVersion: 1, wrote: false, findings: [{ code: 'E-INVENTORY-011' }] });
    const kept = harness(failed);
    expect(await runToolsCommand(['refresh', '--keep-going'], kept.deps())).toBe(0);
  });

  it('checks frozen or integrity and honours strict mode from flag or config', async () => {
    const attention = emptyResult({
      mode: 'frozen',
      findings: [toolFinding('input-contract-unresolved', 'needs_attention', 'POST /api/x', 'unresolved')],
    });
    const fixture = await createAppFixture();
    const h = harness(attention);
    expect(await runToolsCommand(['check', '--root', fixture.root], h.deps())).toBe(0);
    expect(await runToolsCommand(['check', '--root', fixture.root, '--strict'], h.deps())).toBe(1);
    expect(await runToolsCommand(['check', '--root', fixture.root, '--integrity-only'], h.deps())).toBe(0);
    expect(h.calls.map((call) => call.mode)).toEqual(['frozen', 'frozen', 'integrity']);
    const strictApp = await createAppFixture({}, { toolsConfig: { ci: { strict: true } } });
    expect(await runToolsCommand(['check', '--root', strictApp.root], harness(attention).deps())).toBe(1);
  });

  it('refreshes a real app, explains the changes and shows what the chat can do', async () => {
    const fixture = await createAppFixture({ 'src/app/api/tasks/route.ts': ROUTE });
    const out: string[] = [];
    const deps = { cwd: fixture.root, env: {}, log: (line: string) => { out.push(line); }, error: () => undefined };
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    const refresh = out.join('\n');
    expect(refresh).toContain('Added (2)');
    expect(refresh).toContain('+ tasks.list  GET /api/tasks  [safe-read]');
    expect(refresh).toContain('+ tasks.create  POST /api/tasks  [write, confirmation]');
    expect(refresh).toContain('Next: Review .glirastes/setup-artifact.json');
    out.length = 0;
    expect(await runToolsCommand(['status'], deps)).toBe(0);
    expect(out.join('\n')).toContain('What can my chat do? 2 active tools, 0 need attention.');
    out.length = 0;
    expect(await runToolsCommand(['status', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      schemaVersion: 1,
      tools: [
        { name: 'tasks.create', route: 'POST /api/tasks', confirmation: true, contractSource: 'derived', schemaQuality: 'field-names' },
        { name: 'tasks.list', route: 'GET /api/tasks', confirmation: false, contractSource: 'derived', descriptionQuality: 'template' },
      ],
    });
    await fixture.write('src/app/api/tasks/route.ts', ROUTE.split('export async function POST')[0]!);
    out.length = 0;
    expect(await runToolsCommand(['refresh'], deps)).toBe(0);
    expect(out.join('\n')).toContain('- tasks.create  POST /api/tasks  [removed]');
    out.length = 0;
    expect(await runToolsCommand(['check'], deps)).toBe(0);
    expect(out.join('\n')).toContain('Tool outputs match the code.');
  }, 120_000);

  it('asks for a refresh when status finds no outputs', async () => {
    const fixture = await createAppFixture();
    const err: string[] = [];
    expect(await runToolsCommand(['status', '--root', fixture.root], { log: () => undefined, error: (line) => { err.push(line); } })).toBe(1);
    expect(err.join('\n')).toContain('E-TOOLS-020');
  });
});
```

Append to `src/cli/environment-loading.test.ts` inside the `it.each` list (after `['setup', '--managed']`):

```ts
    ['tools', 'refresh'],
    ['tools', 'check', '--json'],
```

In `src/public-subpaths.test.ts`, change the positive command list in `'keeps the Foundation CLI focused on local setup and connection'` to:

```ts
    for (const command of [
      'scan', 'setup', 'connect', 'doctor', 'install', 'validate', 'build', 'tools',
    ]) {
      expect(source).toContain(`| '${command}'`);
    }
```

and append inside the same test, after the wizard assertions:

```ts
    // Tool generation stays model-free: no provider SDK in the CLI or pipeline.
    for (const file of [
      './cli/commands/tools/index.ts',
      './cli/commands/tools/refresh.ts',
      './cli/commands/tools/check.ts',
      './codegen/tools/pipeline.ts',
    ]) {
      const toolsSource = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(toolsSource).not.toMatch(/@ai-sdk\/openai|openrouter/i);
      expect(toolsSource).not.toContain("'generate'");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/cli/environment-loading.test.ts src/public-subpaths.test.ts`
Expected: FAIL — `Failed to resolve import "./index.js"`; `tools` still loads dotenv; `| 'tools'` missing in `src/cli/index.ts`.

- [ ] **Step 3: Implement `args.ts`**

```ts
export class ToolsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsUsageError';
  }
}

export function parseToolArgs(
  argv: ReadonlyArray<string>,
  spec: { flags: ReadonlyArray<string>; values: ReadonlyArray<string> },
): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (spec.flags.includes(argument)) {
      flags.add(argument);
      continue;
    }
    if (spec.values.includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new ToolsUsageError(`${argument} needs a value.`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new ToolsUsageError(`Unknown argument ${argument}.`);
  }
  return { flags, values };
}
```

- [ ] **Step 4: Implement `format.ts`**

```ts
import type { SchemaQuality } from '../../../codegen/tools/artifact.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { ToolTombstonesFileSchema } from '../../../codegen/tools/files.js';
import { nextActionFor } from '../../../codegen/tools/findings.js';
import type { ToolsPipelineOptions, ToolsPipelineResult } from '../../../codegen/tools/pipeline.js';
import type { DescriptionOrigin } from '../../../codegen/tools/prose.js';
import type { ContractSource, ToolFinding } from '../../../codegen/tools/types.js';
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';

export interface ToolsIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  error(line: string): void;
  runPipeline(options: ToolsPipelineOptions): Promise<ToolsPipelineResult>;
}

export interface ToolStatusEntry {
  toolId: string;
  name: string;
  route: string;
  enabled: boolean;
  needsAttention: boolean;
  riskClass: ToolRiskClass;
  confirmation: boolean;
  contractSource: ContractSource | null;
  descriptionQuality: DescriptionOrigin;
  schemaQuality: SchemaQuality;
}

interface ToolLabel {
  name: string;
  route: string;
  detail: string;
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function labels(result: ToolsPipelineResult): Map<string, ToolLabel> {
  const map = new Map<string, ToolLabel>();
  const artifact = AppSetupArtifactSchema.safeParse(parseJson(result.outputs[TOOLS_PATHS.setupArtifact]));
  if (artifact.success) {
    for (const tool of artifact.data.tools) {
      map.set(tool.toolId, {
        name: tool.name,
        route: tool.executionKind === 'endpoint' ? `${tool.method} ${tool.path}` : `UI ${tool.actionBindingRef}`,
        detail: `${tool.riskClass}${tool.requiresApproval ? ', confirmation' : ''}${tool.enabled ? '' : ', disabled'}`,
      });
    }
  }
  const tombstones = ToolTombstonesFileSchema.safeParse(parseJson(result.outputs[TOOLS_PATHS.tombstones]));
  if (tombstones.success) {
    for (const tombstone of tombstones.data.tombstones) {
      if (!map.has(tombstone.toolId)) {
        map.set(tombstone.toolId, { name: tombstone.definitionId, route: tombstone.stableKey, detail: 'removed' });
      }
    }
  }
  return map;
}

export function formatToolsJson(result: ToolsPipelineResult): string {
  return JSON.stringify({
    schemaVersion: 1,
    mode: result.mode,
    wrote: result.wrote,
    changes: result.changes,
    driftPaths: result.driftPaths,
    findings: result.findings,
    excluded: result.excluded,
  });
}

function outcomeLine(result: ToolsPipelineResult): string {
  if (result.findings.some((finding) => finding.severity === 'error')) {
    return result.mode === 'write'
      ? 'Nothing was written. Fix the errors above and run glirastes tools refresh again.'
      : 'Check failed: tool outputs do not match the code.';
  }
  if (result.mode === 'write') {
    return result.wrote
      ? `Updated ${result.driftPaths.length} file(s). Commit them together with your code.`
      : 'Tool outputs are up to date.';
  }
  return result.mode === 'integrity' ? 'Tool outputs verified (integrity).' : 'Tool outputs match the code.';
}

export function formatToolsHuman(result: ToolsPipelineResult): string {
  const lookup = labels(result);
  const describe = (toolId: string) => {
    const label = lookup.get(toolId);
    return label ? `${label.name}  ${label.route}  [${label.detail}]` : toolId;
  };
  const lines: string[] = [
    `Glirastes tools (${result.mode}): ${result.changes.added.length} added, `
      + `${result.changes.changed.length} changed, ${result.changes.removed.length} removed`,
  ];
  const section = (title: string, items: ReadonlyArray<string>, next?: string) => {
    if (items.length === 0) return;
    lines.push('', `${title} (${items.length})`, ...items.map((item) => `  ${item}`));
    if (next) lines.push(`  Next: ${next}`);
  };
  const detailed = (title: string, marker: string, findings: ReadonlyArray<ToolFinding>) => {
    if (findings.length === 0) return;
    lines.push('', `${title} (${findings.length})`);
    for (const finding of findings) {
      lines.push(`  ${marker} ${finding.subjectRef}  ${finding.code}: ${finding.message}`, `    Next: ${finding.nextAction}`);
    }
  };
  section('Added', result.changes.added.map((toolId) => `+ ${describe(toolId)}`),
    'Review .glirastes/setup-artifact.json in your diff and commit it together with the code.');
  section('Changed', result.changes.changed.map((toolId) => `~ ${describe(toolId)}`),
    'Review the tool diff and commit it together with the code.');
  section('Risk raised', result.findings
    .filter((finding) => finding.code === 'risk-raised')
    .map((finding) => `^ ${finding.subjectRef}: ${finding.message}`), nextActionFor('risk-raised'));
  section('Removed', result.changes.removed.map((toolId) => `- ${describe(toolId)}`),
    'Nothing to do: the tool is tombstoned and stops working after the next build or restart.');
  detailed('Needs attention', '!', result.findings.filter((finding) => finding.severity === 'needs_attention'));
  section('Excluded', result.excluded.map((entry) => `. ${entry.stableKey}  ${entry.reason} (${entry.origin})`),
    'Excluded routes are never tools; remove a matching exclude entry from .glirastes/tool-policy.json to include a policy exclusion.');
  detailed('Errors', 'x', result.findings.filter((finding) => finding.severity === 'error'));
  const warnings = result.findings.filter((finding) => finding.severity === 'warning' && finding.code !== 'risk-raised');
  if (warnings.length > 0) {
    lines.push('', `Warnings (${warnings.length})`);
    for (const finding of warnings) lines.push(`  - ${finding.subjectRef}  ${finding.code}: ${finding.message}`);
  }
  lines.push('', outcomeLine(result));
  return lines.join('\n');
}

export function formatToolStatus(entries: ReadonlyArray<ToolStatusEntry>): string {
  const active = entries.filter((entry) => entry.enabled).length;
  const attention = entries.filter((entry) => entry.needsAttention).length;
  const lines = [
    `What can my chat do? ${active} active tool${active === 1 ? '' : 's'}, ${attention} need${attention === 1 ? 's' : ''} attention.`,
  ];
  for (const entry of entries) {
    const state = entry.needsAttention ? ', disabled: needs attention' : entry.enabled ? '' : ', disabled';
    lines.push(
      `  ${entry.enabled ? '+' : '!'} ${entry.name}  ${entry.route}  ${entry.riskClass}, `
        + `${entry.confirmation ? 'asks first' : 'runs directly'}${state}`,
      `      contract: ${entry.contractSource ?? 'none'}, description: ${entry.descriptionQuality}, schema: ${entry.schemaQuality}`,
    );
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Implement `refresh.ts`, `check.ts` and `status.ts`**

`refresh.ts`:

```ts
import { resolve } from 'node:path';
import { isToolsMode, resolveToolsMode } from '../../../codegen/tools/mode.js';
import { parseToolArgs, ToolsUsageError } from './args.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

export async function runToolsRefresh(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--keep-going', '--json'], values: ['--root', '--mode', '--adopt'] });
  const modeFlag = args.values.get('--mode');
  if (modeFlag !== undefined && !isToolsMode(modeFlag)) {
    throw new ToolsUsageError('--mode must be write, frozen or integrity.');
  }
  const mode = resolveToolsMode({ ...(modeFlag !== undefined ? { flag: modeFlag } : {}), env: io.env });
  const keepGoing = args.flags.has('--keep-going') && mode === 'write';
  const adoptInventoryPath = args.values.get('--adopt');
  const result = await io.runPipeline({
    root: resolve(io.cwd, args.values.get('--root') ?? '.'),
    mode,
    ...(keepGoing ? { keepGoing } : {}),
    ...(adoptInventoryPath ? { adoptInventoryPath } : {}),
  });
  io.log(args.flags.has('--json') ? formatToolsJson(result) : formatToolsHuman(result));
  return 0;
}
```

`check.ts`:

```ts
import { resolve } from 'node:path';
import { loadToolsConfig } from '../../../codegen/tools/config.js';
import { parseToolArgs } from './args.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';

/** Frozen refresh: never writes, never calls a model, never uses the network. */
export async function runToolsCheck(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--strict', '--integrity-only', '--json'], values: ['--root'] });
  const root = resolve(io.cwd, args.values.get('--root') ?? '.');
  const strict = args.flags.has('--strict') || loadToolsConfig(root).ci.strict === true;
  const result = await io.runPipeline({ root, mode: args.flags.has('--integrity-only') ? 'integrity' : 'frozen' });
  const json = args.flags.has('--json');
  io.log(json ? formatToolsJson(result) : formatToolsHuman(result));
  const attention = result.findings.filter((finding) => finding.severity === 'needs_attention');
  if (strict && attention.length > 0) {
    if (!json) io.log(`Strict check: ${attention.length} tool finding(s) need attention.`);
    return 1;
  }
  return 0;
}
```

`status.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { ToolReportFileSchema } from '../../../codegen/tools/artifact.js';
import { compareCodeUnits } from '../../../codegen/tools/canonical.js';
import { TOOLS_PATHS } from '../../../codegen/tools/config.js';
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { FoundationDiagnosticError } from '../../../diagnostics/index.js';
import { parseToolArgs } from './args.js';
import { formatToolStatus, type ToolStatusEntry, type ToolsIo } from './format.js';

async function readOutput<T>(root: string, path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, path), 'utf8');
  } catch {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-020',
      operation: 'tools.status',
      message: 'No tool outputs found. Run glirastes tools refresh first.',
      remediation: 'run-tools-refresh',
      path,
    });
  }
  let parsed: ReturnType<typeof schema.safeParse> | undefined;
  try {
    parsed = schema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    throw new FoundationDiagnosticError({
      code: 'E-TOOLS-021',
      operation: 'tools.status',
      message: 'The tool outputs are invalid. Run glirastes tools refresh.',
      remediation: 'run-tools-refresh',
      path,
    });
  }
  return parsed.data;
}

/** Local "What can my chat do?" from the committed outputs; no recomputation. */
export async function readToolStatus(root: string): Promise<ToolStatusEntry[]> {
  const artifact = await readOutput(root, TOOLS_PATHS.setupArtifact, AppSetupArtifactSchema);
  const report = await readOutput(root, TOOLS_PATHS.report, ToolReportFileSchema);
  const reported = new Map(report.tools.map((tool) => [tool.toolId, tool] as const));
  return artifact.tools.map((tool): ToolStatusEntry => {
    const entry = reported.get(tool.toolId);
    return {
      toolId: tool.toolId,
      name: tool.name,
      route: tool.executionKind === 'endpoint' ? `${tool.method} ${tool.path}` : `UI ${tool.actionBindingRef}`,
      enabled: tool.enabled,
      needsAttention: tool.operationGroup === 'needs_attention',
      riskClass: tool.riskClass,
      confirmation: tool.requiresApproval,
      contractSource: entry?.contractSource ?? null,
      descriptionQuality: entry?.quality.description ?? 'template',
      schemaQuality: entry?.quality.schema ?? 'none',
    };
  }).sort((left, right) => compareCodeUnits(left.name, right.name));
}

export async function runToolsStatus(argv: ReadonlyArray<string>, io: ToolsIo): Promise<number> {
  const args = parseToolArgs(argv, { flags: ['--json'], values: ['--root'] });
  const entries = await readToolStatus(resolve(io.cwd, args.values.get('--root') ?? '.'));
  io.log(args.flags.has('--json') ? JSON.stringify({ schemaVersion: 1, tools: entries }) : formatToolStatus(entries));
  return 0;
}
```

- [ ] **Step 6: Implement `index.ts`**

```ts
import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineOptions,
  type ToolsPipelineResult,
} from '../../../codegen/tools/pipeline.js';
import { isFoundationDiagnosticError } from '../../../diagnostics/index.js';
import { ToolsUsageError } from './args.js';
import { runToolsCheck } from './check.js';
import { formatToolsHuman, formatToolsJson, type ToolsIo } from './format.js';
import { runToolsRefresh } from './refresh.js';
import { runToolsStatus } from './status.js';

export interface ToolsCommandDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  runPipeline?: (options: ToolsPipelineOptions) => Promise<ToolsPipelineResult>;
}

export const TOOLS_USAGE = [
  'Usage: glirastes tools refresh [--root <dir>] [--mode write|frozen|integrity] [--keep-going] [--adopt <inventory>] [--json]',
  '         derive tools from the code (writes locally, checks in CI, verifies in Docker)',
  '       glirastes tools check [--root <dir>] [--strict] [--integrity-only] [--json]',
  '         verify the committed tool outputs without writing, models or network',
  '       glirastes tools status [--root <dir>] [--json]',
  '         show what your chat can do',
].join('\n');

/** Subcommand parsing lives here so src/cli/index.ts only dispatches `tools`. */
export async function runToolsCommand(argv: string[], deps: ToolsCommandDependencies = {}): Promise<number> {
  const io: ToolsIo = {
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    log: deps.log ?? ((line) => { console.log(line); }),
    error: deps.error ?? ((line) => { console.error(line); }),
    runPipeline: deps.runPipeline ?? runToolsPipeline,
  };
  const [subcommand, ...rest] = argv;
  const json = rest.includes('--json');
  try {
    switch (subcommand) {
      case 'refresh':
        return await runToolsRefresh(rest, io);
      case 'check':
        return await runToolsCheck(rest, io);
      case 'status':
        return await runToolsStatus(rest, io);
      default:
        io.error(TOOLS_USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ToolsUsageError) {
      io.error(`${error.message}\n${TOOLS_USAGE}`);
      return 2;
    }
    if (error instanceof ToolsPipelineFailure) {
      io.log(json ? formatToolsJson(error.result) : formatToolsHuman(error.result));
      return 1;
    }
    if (isFoundationDiagnosticError(error)) {
      if (json) io.log(JSON.stringify(error.toJSON()));
      else io.error(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
```

- [ ] **Step 7: Wire the command into the CLI**

In `src/cli/index.ts`:

1. Add the import next to the other command imports:

```ts
import { runToolsCommand, type ToolsCommandDependencies } from './commands/tools/index.js';
```

2. Extend `CommandName` with a final member `| 'tools';` (after `| 'build'`).
3. Add `tools?: ToolsCommandDependencies;` to `CliDependencies`.
4. In `parseCommand`, add `&& command !== 'tools'` to the condition and append to the usage text, after the `glirastes build …` line:

```ts
      + '       glirastes tools <refresh|check|status> [options]\n'
      + '         derive chat tools from the code, verify them or show them\n',
```

(drop the trailing comma of the existing `+ '       glirastes build [--root] [--app-id] [--output]\n',` line so the two new `+` lines continue the same string expression).
5. In `runCli`, insert before `if (command === 'connect') {`:

```ts
  if (command === 'tools') {
    const exitCode = await runToolsCommand(rest, dependencies.tools);
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }
```

In `src/cli/environment-loading.ts`, replace the first condition (line 8, `if (command === 'sync' || command === 'connect' || command === 'doctor' || command === 'init') {` through its `return false;` and closing brace) with:

```ts
  if (
    command === 'sync' || command === 'connect' || command === 'doctor'
    || command === 'init' || command === 'tools'
  ) {
    return false;
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts src/cli/environment-loading.test.ts src/public-subpaths.test.ts src/cli && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools src/cli/index.ts src/cli/environment-loading.ts src/cli/environment-loading.test.ts src/public-subpaths.test.ts
git commit -m "feat(cli): add glirastes tools refresh, check and status"
```

### Task 23: Migrate the Next reference fixture's endpoints to `tools refresh`

**Files:**
- Create: `examples/source-driven-next/native/.glirastes/tools.json`, `examples/source-driven-next/native/.glirastes/tool-resolutions.json`, `examples/source-driven-next/native/.glirastes/prompt-bundle.json`
- Create: `tests/support/tool-runtime.ts`
- Modify (rewrite): `tests/source-driven-next.test.ts`
- Modify: `tests/source-driven-build.test.ts:30` (insert one line before it: the copied `native/.glirastes` folder must be removed before the link test creates its symlink, otherwise `symlink` fails with `EEXIST`)
- Modify: `examples/source-driven-next/README.md` (new section, adapter paragraph), `examples/source-driven-next/adapter.mjs:1` (header comment only)

**Interfaces:**
- Consumes: `runToolsPipeline` (Task 20), `createGeneratedRuntimeSource` (Task 18), `createManagedTurnGuard`, `materializeManifestToolRegistry`, `createAiSdkTools`, `toolsToAiTools`, `FoundationExecutionInventorySchema`, `AppSetupArtifactSchema`.
- Produces (`tests/support/tool-runtime.ts`):
  - `export const SDK_ROOT: string`; `export const EXAMPLES: string`; `export const NATIVE_APP: string`; `export const FIXTURE_TENANT_ID: string`; `export const GENERATED_MODULE = 'src/generated/glirastes/tools.generated.js'`; `export const LOCAL_LIMITS`
  - `export function assertBuiltSdk(): void`
  - `export async function copyApp(from: string, prefix?: string): Promise<string>`; `export async function removeCopiedApps(): Promise<void>`
  - `export function principal(roles?: string[], subjectId?: string): Principal`
  - `export interface BootedTurn { guard: ManagedTurnGuard; registry: ToolRegistry; tools: Record<string, AiSdkWrappedTool>; execute(name: string, input: unknown): Promise<unknown> }`
  - `export interface BootedApp { disabled: ReadonlyArray<{ toolId: string; reason: string }>; createSession(user: Principal): string; revokeSession(token: string): void; turn(options: { cookie?: string; resolvePrincipal?: () => Principal | undefined }): BootedTurn }`
  - `export async function bootApp(root: string, modulePath?: string): Promise<BootedApp>`

Endpoints of `examples/source-driven-next/native` are now generated by `glirastes tools refresh` with one `handlerWrappers` entry for the fixture's `query(request, inputSchema, outputSchema, execute)` wrapper and `resolveSession` as declared auth helper; the generated module is JavaScript (`src/generated/glirastes/tools.generated.js`) because the fixture is a JavaScript app. Files that stay unchanged until P04 replaces UI generation (they still need one combined endpoint + UI runtime for the browser proof): `adapter.mjs` (logic), `ui-adapter.mjs`, `build.mjs`, `prepare-browser.mjs`, `ui-bridge.js`, `native-ui/*`, `browser-shell/*`, `tests/source-driven-ui.test.tsx`, `tests/source-driven-browser.test.mjs`; `tests/source-driven-build.test.ts` only gets the one-line link-test fix.

Behavioural changes versus the adapter tests (by design of the spec's trust model, where the endpoint stays the authorization boundary): a changed shared wrapper no longer needs a hand-made "assessment" comparison — the tool is disabled as soon as the auth evidence disappears; unknown or unauthenticated handlers become visible, disabled `needs_attention` tools instead of a thrown error; role checks stay in the endpoint and a `tool-policy.json` role restriction adds a runtime denial.

- [ ] **Step 1: Rewrite the endpoint test against `tools refresh` (failing)**

Replace the whole content of `tests/source-driven-next.test.ts` with:

```ts
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runToolsPipeline } from '../src/codegen/tools/pipeline.js';
import { AppSetupArtifactSchema } from '../src/contracts/index.js';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(async () => {
  vi.restoreAllMocks();
  await removeCopiedApps();
});

async function refreshedCopy(edit?: (root: string) => Promise<void>): Promise<string> {
  const root = await copyApp(NATIVE_APP);
  if (edit) await edit(root);
  await runToolsPipeline({ root, mode: 'write' });
  return root;
}

async function toolAt(root: string, method: string, path: string) {
  const artifact = AppSetupArtifactSchema.parse(JSON.parse(await readFile(join(root, '.glirastes/setup-artifact.json'), 'utf8')));
  return artifact.tools.find((tool) => tool.method === method && tool.path === path);
}

async function replaceIn(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

describe('native endpoints through glirastes tools refresh', () => {
  it('executes the real query with a server-resolved principal and no platform connection', async () => {
    const root = await refreshedCopy();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const app = await bootApp(root);
    expect(app.disabled).toEqual([]);
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    expect(await turn.execute('tasks_list', { status: 'open' })).toMatchObject({
      success: true, tasks: [{ id: '1', title: 'Review release', status: 'open' }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('denies a revoked session before executing a pinned tool', async () => {
    const app = await bootApp(await refreshedCopy());
    const token = app.createSession(principal());
    const turn = app.turn({ cookie: `session=${token}` });
    app.revokeSession(token);
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('missing_principal');
  }, 120_000);

  it('keeps the endpoint as role boundary and adds a tool-policy role restriction at runtime', async () => {
    const app = await bootApp(await refreshedCopy());
    const guest = app.turn({ cookie: `session=${app.createSession(principal(['guest']))}` });
    expect(await guest.execute('tasks_list', {})).toMatchObject({ success: false, error: 'Forbidden' });
    const restricted = await bootApp(await refreshedCopy(async (copy) => {
      await writeFile(join(copy, '.glirastes/tool-policy.json'), JSON.stringify({
        schemaVersion: 1, tools: { 'GET /api/tasks': { allowedRoles: ['member'] } }, exclude: [], acceptedRisk: {},
      }));
    }));
    const policed = restricted.turn({ cookie: `session=${restricted.createSession(principal(['guest']))}` });
    await expect(policed.execute('tasks_list', {})).rejects.toThrow('principal_role_denied');
  }, 120_000);

  it('disables the tool as soon as the shared wrapper stops resolving a session', async () => {
    const root = await refreshedCopy((copy) => replaceIn(copy, 'src/query.js',
      '  const principal = resolveSession(request);\n',
      "  const principal = { subjectId: 'anyone', roles: ['member'] };\n"));
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
    expect(await readFile(join(root, '.glirastes/tool-report.json'), 'utf8')).toContain('auth-evidence-missing');
    const app = await bootApp(root);
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
  }, 120_000);

  it('disables an exported handler without auth evidence instead of trusting it', async () => {
    const root = await refreshedCopy(async (copy) => {
      const route = join(copy, 'src/app/api/tasks/route.js');
      await writeFile(route, (await readFile(route, 'utf8')).replace('export async function GET', 'async function GET')
        + '\nfunction direct() { return Response.json({ tasks: [] }); }\nexport { direct as GET };\n');
    });
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);

  it('does not treat a same-spelled wrapper from another module as the declared convention', async () => {
    const root = await refreshedCopy(async (copy) => {
      await cp(join(copy, 'src/app/api/tasks'), join(copy, 'src/app/api/nested/tasks'), { recursive: true });
      await writeFile(join(copy, 'src/app/query.js'), 'export function query() { return Response.json({ tasks: [] }); }\n');
    });
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: true });
    expect(await toolAt(root, 'GET', '/api/nested/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);

  it('does not treat a handler parameter shadowing the wrapper as the declared convention', async () => {
    const root = await refreshedCopy((copy) => replaceIn(copy, 'src/app/api/tasks/route.js',
      'GET(request)', 'GET(request, query = () => Response.json({ tasks: [] }))'));
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);

  it('keeps an unknown route visible but disabled instead of dropping it', async () => {
    const root = await refreshedCopy(async (copy) => {
      await mkdir(join(copy, 'src/app/api/unknown'), { recursive: true });
      await writeFile(join(copy, 'src/app/api/unknown/route.js'), 'export function GET() { return Response.json({}); }\n');
    });
    expect(await toolAt(root, 'GET', '/api/tasks')).toMatchObject({ enabled: true });
    expect(await toolAt(root, 'GET', '/api/unknown')).toMatchObject({ enabled: false, operationGroup: 'needs_attention' });
  }, 120_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bunx vitest run tests/source-driven-next.test.ts`
Expected: FAIL — `Failed to resolve import "./support/tool-runtime.js"`.

- [ ] **Step 3: Create the runtime test support**

`tests/support/tool-runtime.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FoundationExecutionInventorySchema } from '../../src/codegen/execution-inventory.js';
import type { Principal } from '../../src/contracts/index.js';
import { createAiSdkTools, type AiSdkWrappedTool } from '../../src/runtime/ai-sdk/index.js';
import {
  createGeneratedRuntimeSource,
  type GeneratedToolModule,
} from '../../src/runtime/contract-bindings.js';
import {
  createManagedTurnGuard,
  materializeManifestToolRegistry,
  type ManagedTurnGuard,
} from '../../src/runtime/index.js';
import {
  toolsToAiTools,
  type InternalApiRequest,
  type InternalApiResponse,
} from '../../src/server/index.js';
import type { ToolRegistry } from '../../src/types.js';

export const SDK_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const EXAMPLES = fileURLToPath(new URL('../../examples/source-driven-next/', import.meta.url));
export const NATIVE_APP = join(EXAMPLES, 'native');
export const FIXTURE_TENANT_ID = '019fb007-0000-7000-8000-000000000002';
export const GENERATED_MODULE = 'src/generated/glirastes/tools.generated.js';
export const LOCAL_LIMITS = {
  maxModelSteps: 4, maxToolCalls: 8, totalTimeoutMs: 30_000, toolTimeoutMs: 5_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

const copies: string[] = [];

/** The generated module imports glirastes/runtime and glirastes/server from dist. */
export function assertBuiltSdk(): void {
  for (const file of ['dist/runtime/index.js', 'dist/server/index.js']) {
    if (!existsSync(join(SDK_ROOT, file))) throw new Error(`Run bun run build first: ${file} is missing.`);
  }
}

/** Copies an app next to the fixture (so `zod` resolves) and links the local SDK as `glirastes`. */
export async function copyApp(from: string, prefix = '.tool-sync-'): Promise<string> {
  const root = await mkdtemp(join(EXAMPLES, prefix));
  copies.push(root);
  await cp(from, root, { recursive: true, filter: (source) => !source.split(sep).includes('node_modules') });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(SDK_ROOT, join(root, 'node_modules/glirastes'), 'dir');
  return root;
}

export async function removeCopiedApps(): Promise<void> {
  for (const root of copies.splice(0)) await rm(root, { recursive: true, force: true });
}

export function principal(roles: string[] = ['member'], subjectId = 'alice'): Principal {
  return { subjectId, tenantId: FIXTURE_TENANT_ID, roles, attributes: {} };
}

interface FixtureAuth {
  createSession(user: Principal): string;
  revokeSession(token: string): void;
  resolveSession(request: Request): Principal | undefined;
}

type RouteHandler = (request: Request) => Promise<Response>;

export interface BootedTurn {
  guard: ManagedTurnGuard;
  registry: ToolRegistry;
  tools: Record<string, AiSdkWrappedTool>;
  execute(name: string, input: unknown): Promise<unknown>;
}

export interface BootedApp {
  disabled: ReadonlyArray<{ toolId: string; reason: string }>;
  createSession(user: Principal): string;
  revokeSession(token: string): void;
  turn(options: { cookie?: string; resolvePrincipal?: () => Principal | undefined }): BootedTurn;
}

function matchesRoute(pattern: string, pathname: string): boolean {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  return expected.length === actual.length
    && expected.every((segment, index) => segment.startsWith(':') || segment === actual[index]);
}

/** Boots the standalone runtime from the committed outputs, like the app's chat route does. */
export async function bootApp(root: string, modulePath = GENERATED_MODULE): Promise<BootedApp> {
  const generated = await import(pathToFileURL(join(root, modulePath)).href) as GeneratedToolModule;
  const runtime = createGeneratedRuntimeSource(generated, {
    localLimits: LOCAL_LIMITS,
    identity: { tenantId: FIXTURE_TENANT_ID },
  });
  const auth = await import(pathToFileURL(join(root, 'src/auth.js')).href) as FixtureAuth;
  const inventory = FoundationExecutionInventorySchema.parse(JSON.parse(
    await readFile(join(root, '.glirastes/foundation-execution-inventory.json'), 'utf8'),
  ));
  const routeModules = new Map<string, Record<string, RouteHandler | undefined>>();
  const handlerFor = async (method: string, pathname: string): Promise<RouteHandler | undefined> => {
    for (const execution of inventory.executions) {
      if (execution.executionKind !== 'endpoint' || execution.method !== method) continue;
      if (!matchesRoute(execution.path, pathname)) continue;
      let module = routeModules.get(execution.sourceFile);
      if (!module) {
        module = await import(pathToFileURL(join(root, execution.sourceFile)).href) as Record<string, RouteHandler | undefined>;
        routeModules.set(execution.sourceFile, module);
      }
      return module[method];
    }
    return undefined;
  };
  return {
    disabled: runtime.disabled,
    createSession: (user) => auth.createSession(user),
    revokeSession: (token) => { auth.revokeSession(token); },
    turn(options) {
      const resolvePrincipal = options.resolvePrincipal ?? (() => auth.resolveSession(new Request(
        'http://fixture.local/chat',
        { headers: options.cookie ? { cookie: options.cookie } : {} },
      )));
      const initial = resolvePrincipal();
      if (!initial) throw new Error('missing_principal');
      const snapshot = runtime.source.resolveTurnSnapshot({ turnId: randomUUID(), principal: initial });
      const guard = createManagedTurnGuard({ snapshot, resolvePrincipal });
      const registry = materializeManifestToolRegistry({ snapshot, bindings: runtime.bindings });
      const callEndpoint = async ({ method, path, body }: InternalApiRequest): Promise<InternalApiResponse> => {
        const url = new URL(path, 'http://fixture.local');
        const handler = await handlerFor(method, url.pathname);
        if (!handler) return { ok: false, status: 404, error: 'Unavailable' };
        const headers = new Headers(options.cookie ? { cookie: options.cookie } : {});
        if (body !== undefined) headers.set('content-type', 'application/json');
        const response = await handler(new Request(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }));
        const data = await response.json() as unknown;
        const error = !response.ok && typeof data === 'object' && data !== null
          && typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : undefined;
        return { ok: response.ok, status: response.status, data, ...(error ? { error } : {}) };
      };
      const context = { currentDate: new Date(), locale: 'en-US', callEndpoint };
      const tools = createAiSdkTools({ tools: toolsToAiTools(registry, context), ...guard });
      return {
        guard,
        registry,
        tools,
        async execute(name, input) {
          const tool = tools[name];
          if (!tool?.execute) {
            await guard.beforeToolCall({ toolName: name, input });
            throw new Error(`Tool unavailable: ${name}`);
          }
          const parsed = registry[name]!.inputSchema.safeParse(input);
          if (!parsed.success) throw new Error(`Input does not match the bound schema (${name})`);
          return tool.execute(parsed.data, { toolCallId: randomUUID(), messages: [] });
        },
      };
    },
  };
}
```

- [ ] **Step 4: Add the fixture's tool inputs**

`examples/source-driven-next/native/.glirastes/tools.json`:

```json
{
  "schemaVersion": 1,
  "appId": "019fb007-0000-7000-8000-000000000001",
  "targetAppKey": "native-query-fixture",
  "locale": "en-US",
  "sources": [{ "kind": "next-app", "apiDir": "src/app/api" }],
  "emit": { "module": "src/generated/glirastes/tools.generated.js" }
}
```

`examples/source-driven-next/native/.glirastes/tool-resolutions.json`:

```json
{
  "schemaVersion": 1,
  "conventions": {
    "handlerWrappers": [
      { "module": "src/query.js", "export": "query", "queryArg": 1, "outputArg": 2 }
    ],
    "bodyReaders": [],
    "authHelpers": ["resolveSession"],
    "filterValues": {}
  },
  "tools": {}
}
```

`examples/source-driven-next/native/.glirastes/prompt-bundle.json`:

```json
{
  "schemaVersion": 1,
  "appId": "019fb007-0000-7000-8000-000000000001",
  "artifactRef": "local://native-query-fixture/prompts",
  "sections": {
    "planner": "Use only the available native queries; ask when the target is unclear.",
    "appBehavior": "Answer questions about the caller's own tasks and notes.",
    "responseStyle": "Be concise.",
    "capabilityFragments": {}
  }
}
```

- [ ] **Step 5: Keep the existing link test independent of the new folder**

In `tests/source-driven-build.test.ts`, in `'rejects a linked generation directory without writing outside the app'`, insert directly before `await symlink(outside, resolve(root, '.glirastes'), 'dir');`:

```ts
  await rm(resolve(root, '.glirastes'), { recursive: true, force: true });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bunx vitest run tests/source-driven-next.test.ts tests/source-driven-build.test.ts tests/source-driven-ui.test.tsx`
Expected: PASS — the rewritten endpoint tests, the unchanged UI tests and the build tests (including the link test) are green. (Between Step 3 and Step 4 the endpoint tests fail with `E-TOOLS-001` because `native/.glirastes/tools.json` does not exist yet.)

- [ ] **Step 7: Document the migration**

In `examples/source-driven-next/README.md`, insert after the first paragraph:

```markdown
## Endpoints come from `glirastes tools refresh`

The endpoint tools of `native/` are generated by the SDK, not by a fixture
adapter: `.glirastes/tools.json` enables the `next-app` source,
`.glirastes/tool-resolutions.json` declares the app's `query(request,
inputSchema, outputSchema, execute)` wrapper (`queryArg` 1, `outputArg` 2) and
`resolveSession` as its auth helper. `glirastes tools refresh` writes the
committed outputs and `src/generated/glirastes/tools.generated.js`;
`createGeneratedRuntimeSource` boots the standalone runtime from them
(`tests/source-driven-next.test.ts`, `tests/tool-sync-next.test.ts`).

`adapter.mjs`, `ui-adapter.mjs`, `build.mjs`, `prepare-browser.mjs`,
`ui-bridge.js`, `native-ui/` and `browser-shell/` remain only for the combined
endpoint + UI browser proof until the UI sources replace them.
```

and replace the sentence starting with "`adapter.mjs` is intentionally specific to this fixture's native query" (line 44) up to the end of that paragraph with:

```markdown
`adapter.mjs` is the transitional runtime glue for the UI and browser proofs;
endpoint detection there predates the generator and is not used by the
endpoint tests anymore. Native modules are trusted application code executed
inside the customer environment, not in the platform.
```

At the top of `examples/source-driven-next/adapter.mjs` add:

```js
// Transitional: endpoint tools of this fixture are generated by
// `glirastes tools refresh` (see native/.glirastes). This adapter only remains
// for the combined endpoint + UI browser proof until the UI sources land.
```

- [ ] **Step 8: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add examples/source-driven-next/native/.glirastes examples/source-driven-next/README.md examples/source-driven-next/adapter.mjs tests/support/tool-runtime.ts tests/source-driven-next.test.ts tests/source-driven-build.test.ts
git commit -m "test(examples): generate next fixture endpoints with tools refresh"
```

### Task 24: Next endpoint change corpus (add, change, delete)

**Files:**
- Create: `tests/tool-sync-next.test.ts`

**Interfaces:**
- Consumes: `runToolsPipeline`, `ToolsPipelineFailure`, `ToolsPipelineResult`, `compareArtifacts` (Task 16), `AppSetupArtifactSchema`, `tests/support/tool-runtime.ts` (Task 23).
- Produces: the three Next endpoint corpus tests of spec 4.12. Each: copy fixture, refresh, patch, `check` (frozen) fails with the named finding `tool-outputs-drift` and the change set, refresh, assert change set / stable or tombstoned IDs / defaults (GET without, POST with confirmation, no plan confirmation for new tools), `check` green, boot the runtime from the committed outputs and assert the effect.

- [ ] **Step 1: Write the corpus test**

`tests/tool-sync-next.test.ts`:

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/cli/commands/setup-plan.js';
import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineResult,
} from '../src/codegen/tools/pipeline.js';
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../src/contracts/index.js';
import {
  assertBuiltSdk,
  bootApp,
  copyApp,
  NATIVE_APP,
  principal,
  removeCopiedApps,
} from './support/tool-runtime.js';

beforeAll(assertBuiltSdk);
afterEach(removeCopiedApps);

const NOTES_SCHEMAS = "import { z } from 'zod';\n\n"
  + "export const listNotesInput = z.object({ pinned: z.enum(['true', 'false']).optional() }).strict();\n"
  + 'export const listNotesOutput = z.object({\n'
  + '  notes: z.array(z.object({ id: z.string(), title: z.string(), pinned: z.boolean() })),\n'
  + "}).describe('List your notes, optionally only pinned ones.');\n"
  + 'export const createNoteInput = z.object({ title: z.string().min(1) }).strict();\n'
  + 'export const noteOutput = z.object({ id: z.string(), title: z.string(), pinned: z.boolean() })\n'
  + "  .describe('Create a note for yourself.');\n";

const NOTES_ROUTE = "import { createNoteInput, listNotesInput, listNotesOutput, noteOutput } from './schemas.js';\n"
  + "import { query } from '../../../query.js';\n"
  + "import { resolveSession } from '../../../auth.js';\n\n"
  + 'const notes = [];\n\n'
  + 'export async function GET(request) {\n'
  + '  return query(request, listNotesInput, listNotesOutput, (input, principal) => ({\n'
  + '    notes: notes\n'
  + '      .filter((note) => note.owner === principal.subjectId && (!input.pinned || String(note.pinned) === input.pinned))\n'
  + '      .map(({ id, title, pinned }) => ({ id, title, pinned })),\n'
  + '  }));\n}\n\n'
  + 'export async function POST(request) {\n'
  + '  const principal = resolveSession(request);\n'
  + "  if (!principal) return Response.json({ error: 'Unauthenticated' }, { status: 401 });\n"
  + '  const input = createNoteInput.safeParse(await request.json());\n'
  + "  if (!input.success) return Response.json({ error: 'Invalid note' }, { status: 400 });\n"
  + '  const note = { id: String(notes.length + 1), title: input.data.title, pinned: false, owner: principal.subjectId };\n'
  + '  notes.push(note);\n'
  + '  return Response.json(noteOutput.parse({ id: note.id, title: note.title, pinned: note.pinned }), { status: 201 });\n}\n';

async function artifactOf(root: string): Promise<AppSetupArtifact> {
  return AppSetupArtifactSchema.parse(JSON.parse(await readFile(join(root, '.glirastes/setup-artifact.json'), 'utf8')));
}

async function replaceIn(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

/** `glirastes tools check`: frozen refresh that must fail with a named drift finding. */
async function failingCheck(root: string): Promise<ToolsPipelineResult> {
  const outcome = await runToolsPipeline({ root, mode: 'frozen' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  const { result } = outcome as ToolsPipelineFailure;
  expect(result.wrote).toBe(false);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'tool-outputs-drift', subjectRef: '.glirastes/foundation-execution-inventory.json' }),
  ]));
  return result;
}

async function passingCheck(root: string): Promise<void> {
  expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
}

const byToolId = (left: { toolId: string }, right: { toolId: string }) => (left.toolId < right.toolId ? -1 : 1);

describe('Next endpoint change corpus', () => {
  it('adds an endpoint: active at once with defaults, inside the user session, rejected without one', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = await artifactOf(root);
    const tasksId = before.tools[0]!.toolId;
    await mkdir(join(root, 'src/app/api/notes'), { recursive: true });
    await writeFile(join(root, 'src/app/api/notes/schemas.js'), NOTES_SCHEMAS);
    await writeFile(join(root, 'src/app/api/notes/route.js'), NOTES_ROUTE);

    expect((await failingCheck(root)).changes.added).toHaveLength(2);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.added).toHaveLength(2);
    expect(refreshed.changes.unchanged).toEqual([tasksId]);
    const after = await artifactOf(root);
    const byName = new Map(after.tools.map((tool) => [tool.name, tool] as const));
    expect(byName.get('tasks.list')?.toolId).toBe(tasksId);
    expect(byName.get('notes.list')).toMatchObject({
      method: 'GET', operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false, enabled: true,
    });
    expect(byName.get('notes.create')).toMatchObject({
      method: 'POST', operationGroup: 'create', riskClass: 'write', requiresApproval: true, enabled: true,
    });
    const added = compareArtifacts(before, after)
      .filter((change) => refreshed.changes.added.includes(change.toolId))
      .sort(byToolId);
    expect(added).toEqual(refreshed.changes.added
      .map((toolId) => ({ toolId, classification: 'added', fields: ['toolId'], requiresConfirmation: false }))
      .sort(byToolId));
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const alice = principal();
    const turn = app.turn({ cookie: `session=${app.createSession(alice)}` });
    expect(await turn.guard.resolveApproval({ toolName: 'notes_create', input: { title: 'Buy milk' } })).toBe(true);
    expect(await turn.guard.resolveApproval({ toolName: 'notes_list', input: {} })).toBe(false);
    expect(await turn.execute('notes_create', { title: 'Buy milk' })).toMatchObject({
      success: true, id: '1', title: 'Buy milk', pinned: false,
    });
    expect(await turn.execute('notes_list', {})).toMatchObject({
      success: true, notes: [{ id: '1', title: 'Buy milk', pinned: false }],
    });
    const withoutSession = app.turn({ resolvePrincipal: () => alice });
    expect(await withoutSession.execute('notes_create', { title: 'Sneaky' })).toMatchObject({
      success: false, error: 'Unauthenticated',
    });
  }, 240_000);

  it('changes an endpoint: same identity, the new schema is enforced after refresh', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const before = (await artifactOf(root)).tools[0]!;
    await replaceIn(root, 'src/app/api/tasks/contract.js',
      "status: z.enum(['open', 'done']).optional()", "status: z.enum(['done']).optional()");
    await replaceIn(root, 'src/app/api/tasks/route.js', 'Write tests', 'Write verified tests');

    expect((await failingCheck(root)).changes.changed).toEqual([before.toolId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.changed).toEqual([before.toolId]);
    const after = (await artifactOf(root)).tools[0]!;
    expect(after.toolId).toBe(before.toolId);
    expect(after.inputSchemaDigest).not.toBe(before.inputSchemaDigest);
    expect(after).toMatchObject({ riskClass: 'safe-read', requiresApproval: false, enabled: true });
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    expect(app.disabled).toEqual([]);
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    await expect(turn.execute('tasks_list', { status: 'open' })).rejects.toThrow('Input does not match');
    expect(await turn.execute('tasks_list', { status: 'done' })).toMatchObject({
      success: true, tasks: [{ id: '2', title: 'Write verified tests', status: 'done' }],
    });
  }, 240_000);

  it('removes an endpoint: tombstoned, absent from the runtime, a direct call is unavailable', async () => {
    const root = await copyApp(NATIVE_APP);
    await runToolsPipeline({ root, mode: 'write' });
    const tasksId = (await artifactOf(root)).tools[0]!.toolId;
    await rm(join(root, 'src/app/api/tasks/route.js'));

    expect((await failingCheck(root)).changes.removed).toEqual([tasksId]);

    const refreshed = await runToolsPipeline({ root, mode: 'write' });
    expect(refreshed.changes.removed).toEqual([tasksId]);
    expect(JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')).tombstones)
      .toEqual([expect.objectContaining({ toolId: tasksId, stableKey: 'GET /api/tasks' })]);
    expect((await artifactOf(root)).tools).toEqual([]);
    await passingCheck(root);

    const app = await bootApp(await copyApp(root, '.tool-sync-deploy-'));
    const turn = app.turn({ cookie: `session=${app.createSession(principal())}` });
    expect(Object.keys(turn.registry)).toEqual([]);
    await expect(turn.guard.beforeToolCall({ toolName: 'tasks_list', input: {} }))
      .rejects.toThrow('manifest_tool_unavailable');
    await expect(turn.execute('tasks_list', {})).rejects.toThrow('manifest_tool_unavailable');
  }, 240_000);
});
```

- [ ] **Step 2: Run the corpus**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run build && bunx vitest run tests/tool-sync-next.test.ts`
Expected: PASS (3 tests). These are acceptance tests over Tasks 14–23, so they are expected to pass on the first run; a failure names the step (`failingCheck`, defaults, boot) and is a generator defect — fix the generator, not the test.

- [ ] **Step 3: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add tests/tool-sync-next.test.ts
git commit -m "test(codegen): cover next endpoint add, change and delete end to end"
```

### Task 25: Full gates and CLI smoke run

**Files:** none (verification only).

- [ ] **Step 1: Run every gate**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run typecheck && bun run build && bun run typecheck:tests && bun run test
```

Expected: every command exits 0 — typecheck clean, build without `TS1343` from the CommonJS pass, the P01 test-file gate `typecheck:tests` clean (it type-checks every new `*.test.ts`, `src/codegen/tools/__tests__/app-fixture.ts` and `tests/support/tool-runtime.ts`; it runs after the build because `glirastes/*` self-imports resolve through `dist/`), all Vitest suites green with the P02 baseline count plus the tests added here.

- [ ] **Step 2: Smoke the built CLI on a copy of the fixture**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools \
  && SMOKE=$(mktemp -d examples/source-driven-next/.smoke-XXXXXX) \
  && cp -R examples/source-driven-next/native/. "$SMOKE" \
  && node dist/cli/bin.js tools refresh --root "$SMOKE" \
  && node dist/cli/bin.js tools check --root "$SMOKE" \
  && node dist/cli/bin.js tools check --integrity-only --root "$SMOKE" \
  && node dist/cli/bin.js tools status --root "$SMOKE"; \
  STATUS=$?; rm -rf "$SMOKE"; exit $STATUS
```

Expected: refresh prints `Added (1)` with `+ tasks.list  GET /api/tasks  [safe-read]`; both checks print `Tool outputs match the code.` / `Tool outputs verified (integrity).`; status prints `What can my chat do? 1 active tool, 0 need attention.`; exit 0. (`dist/codegen/tools/probe-child.mjs` and `probe-loader.mjs` must exist for the refresh to probe from `dist`.)

- [ ] **Step 3: Record the checkpoint (no commit needed)**

Note in the P03 checkpoint report: gates run, test counts, and the open items listed under Self-Review.

---

## Self-Review

**Spec coverage (spec section → task):**

| Spec | Covered by |
| --- | --- |
| 4.1 Data flow: sources → contract tiers → `reconcileExecutionInventory` → `discoverFoundationExecutions` → `deriveToolPolicyDefaults` → `resolveToolPolicy` → prose → `AppSetupArtifact` → `createSetupPlan` (`added`) → atomic write + generated module; runtime via `createContractBindings` | Tasks 14, 15, 16, 17, 19, 20 (pipeline), 18 (runtime) |
| 4.2 CLI `tools refresh [--keep-going] [--adopt] [--json]`, `tools check [--strict] [--integrity-only] [--json]`, `tools status [--json]`; subcommand parsing outside `src/cli/index.ts`; no implicit `.env`; mode order flag → env → CI → write | Tasks 1 (mode), 22 |
| 4.3 `tools.json` (never a key), inputs never overwritten, outputs (inventory v2 + `sourceKind`, tombstones, contracts, content-free report, artifact, manifests + `policyDigest`, receipt, generated module) | Tasks 1, 3, 4, 12, 15, 16, 17, 19, 20 |
| 4.4 Enumeration complete or abort (`E-INVENTORY-011`), nothing silently dropped | Tasks 3, 14, 20 |
| 4.4 Contract tiers 1, 2, 4, 5, 6 (tier 3 is P11), roles by data flow, `handlerWrappers`/`bodyReaders` | Tasks 6, 7, 12, 13, 14 |
| 4.4 `interfaceDigest` binding, `contract-stale`, cosmetic changes ignored | Tasks 2, 6 (`normalizedNodeText`), 13 |
| 4.4 Schema probe (child process, `PATH`/`NODE_ENV`/`TZ`, 10 s, no shell, app's Zod v4/v3) | Task 10 |
| 4.4 Output: explicit schema → checker inference (depth ≤ 6) → `{}` + `output-contract-opaque` | Tasks 11, 13 |
| 4.4 Identity (`toolId` only from reconcile; `definitionId` contract → previous → derived; unresolved known tool keeps ID, `enabled:false`) | Tasks 4, 9, 20 |
| 4.4 Prose fallback order and `description-templated` | Task 15 |
| 4.4 Reproducibility (UUIDv5 ids, carried `generatedAt`, canonical JSON, no clock/randomness/network in check) | Tasks 2, 17, 20 |
| 4.4 Failure modes (incomplete enumeration, identity conflict, invalid policy ⇒ nothing written; `--keep-going`) and per-tool `needs_attention` codes | Tasks 13, 14, 20, 22 |
| 4.5 Defaults/bounds (consumed from P02), default exclusions, `added` without confirmation (implemented by P02 Task 10, exported and reused in Task 16, asserted end to end in Task 24), invalid `tool-policy.json` ⇒ `E-POLICY-001` | Tasks 9, 16, 20, 24 |
| 4.8 Frozen check in CI, integrity in Docker, refresh output with next safe action, merge conflicts resolved by rerunning refresh | Tasks 4, 20, 21, 22, 25 |
| 4.9 (P03 part) missing/mismatching binding disables only that tool | Task 18 |
| 4.11 `examples/source-driven-next` endpoints via `tools refresh`, one `handlerWrappers` entry | Task 23 |
| 4.12 Next endpoint add/change/delete (3 tests); additional-corpus items in scope: unresolved known tool keeps ID (Task 20), `export *` writes nothing (Task 20), chat route never a tool (Tasks 9, 14), integrity detects manipulated outputs (Task 21), twice byte-identical (Task 20) | Tasks 20, 21, 24 |

Not in P03 by the roadmap: navigation/filter/UI sources and the remaining 2 Next corpus rows (P04), `tools resolve|describe|eval|policy|verify`, agent validation, init scripts and the "N tools need a better description" hint (P05), `enrich --managed` (P10), legacy `ai-tool.ts` tier 3 and `mcpEndpointCatalog` (P11), Node 20/22 byte-identity matrix (CI job, P13). `tools refresh --watch` (spec 4.2/4.8, "optional") has no owner in the roadmap — flagged for the P04/P05 planner.

**Deliberate deviations from the spec text (for the P04/P05/P11 planners):**
- The generated module exports `createToolBindings()` without the `ctx` parameter spec 4.3 sketches: endpoint execution receives its request context per call through `ToolContext.callEndpoint`, so binding needs none. P11 may add an optional parameter if the MCP catalogue needs one; `GeneratedToolModule` then gains it compatibly.
- `HEAD`/`OPTIONS` route exports are not enumerated: `readRouteExports` and the inventory method enum only know GET/POST/PUT/PATCH/DELETE (pre-existing behaviour, unchanged here), so such exports are neither tools nor reported exclusions.
- `ToolContract.runtime` is required: every later source (P04 UI bridge, P06 Nest/OpenAPI) must state where the generated module obtains its schemas.
- A `.ts` generated module imports app schema modules without an extension (bundler resolution, as Next apps use). A TypeScript app compiled with `moduleResolution: NodeNext` (P06's NestJS fixture) needs `.js` suffixes; P06 must add that choice to `emit` before it emits a TypeScript module for such an app.

**Alignment with P02 (re-checked against the written P02 plan):** Task 1 extends the union P02 Task 3 leaves behind (`E-POLICY-*` kept); Task 16 keeps P02 Task 10's `classifyNewTool` byte-for-byte and only exports `compareArtifacts`; the pipeline consumes `deriveToolPolicyDefaults`, `resolveToolPolicy` (its `E-POLICY-001/002` errors abort the refresh), `confirmationFloor`, `riskTier`, `ToolPolicyFileSchema` exactly as P02 Tasks 1–6 produce them; Task 18 calls `createLocalRuntimeSource` and `materializeManifestToolRegistry` with options that P02 Tasks 12 and 14 keep compatible.

**Placeholder scan:** done — every step carries complete code or exact commands; no TBD/TODO, no "similar to Task N", no undefined types. The one deliberate staging is Task 20 → 21: in Task 20 `integrity` runs the stronger frozen comparison; Task 21 replaces that line with the source-free verification.

**Type consistency check:** done — pinned names used verbatim: `ToolsConfigSchema`/`ToolsConfig`/`loadToolsConfig`, `ToolsMode`/`resolveToolsMode`, `ToolFindingSeverity`/`ToolFinding`, `ContractSource`, `ToolContract`, `ObservedTool`, `ToolSource`, `computeInterfaceDigest`, `ToolsPipelineResult`, `runToolsPipeline`, `runToolsCommand`, P02 `deriveToolPolicyDefaults`/`resolveToolPolicy`/`confirmationFloor`/`riskTier`/`ToolPolicyFileSchema`/`ToolPolicyFile`/`EffectiveToolPolicy`/`ToolPolicyDefaults`/`DeclaredEffect`/`TOOL_POLICY_RULES_VERSION`. Additive P03 extensions to pinned shapes, used consistently across Tasks 2–24: `ToolContract.runtime` (required) and `ToolContract.binding` (optional), `ObservedTool.prose` (optional), `ToolSourceObservation.excluded` (optional), `ToolSourceContext` (defined in Task 14). Compile-time proofs: `toToolContract`/`toToolContractsEntry` (Task 4), `toHandlerConventions` (Task 12), generated-module strict type-check against `createContractBindings` (Task 19).
