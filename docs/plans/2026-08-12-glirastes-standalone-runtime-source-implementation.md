# Standalone Runtime Source Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A target app runs a full managed-quality chat turn from locally
generated artifacts with no control plane configured
(`GLIRASTES_CONTROL_PLANE_URL` unset), through the *same* pipeline,
registry, naming, and guard chain as managed mode.

**Architecture:** One pipeline, two revision sources. A new
`LocalRuntimeSource` materializes the same `TurnSnapshot` shape the managed
sync path produces — from `.glirastes/` artifacts, self-signed with an
ephemeral boot-time Ed25519 key so every strict contract schema and the
existing verifier chain stay intact. It plugs into the existing
`managedRuntime.resolveTurnSnapshot` seam of `createAiChatHandler`; nothing
downstream of the source changes.

**Tech Stack:** TypeScript strict/ESM, Bun, Vitest, Zod, node:crypto
(Ed25519). Repos: SDK worktree
`glirastes/.worktrees/foundation-runtime-v1` (branch
`codex/glirastes-foundation-runtime`), consumer proof in
`get-it-done/.worktrees/glirastes-foundation-pilot` (branch
`codex/glirastes-foundation-pilot`).

## Global Constraints

- Approved spec: `docs/plans/2026-08-10-glirastes-standalone-and-one-click-publish-design.md`. Approved assumptions: standalone snapshot is materialized **once at boot** (restart-only reload); standalone is **strictly network-silent**; no third mode.
- Fail closed everywhere. A managed-configured app that cannot verify its signed state never degrades into standalone.
- No unsigned data enters the runtime: standalone revisions are self-signed with an ephemeral key; all `*Schema.parse()` gates stay strict.
- The entire chain downstream of the source is shared: `createTurnSnapshot`, `materializeManifestToolRegistry`, `modelFacingToolName`, managed turn guard, budgets. Do not fork any of it.
- TDD: verify RED before GREEN. Verification is `bun run test` + `bun run typecheck`; **never** run `bun run build` while a consumer watch process runs (GID loads from `dist/`; build only with GID stopped).
- After changing anything under `src/contracts`: `bun run build` (with GID stopped) before touching the consumer.
- Conventional Commits, one logical change per commit. No push/merge without operator approval.
- All internal imports are relative with `.js` suffix (ESM NodeNext).

## Files (SDK)

- Create: `src/runtime/runtime-mode.ts` — mode resolution, fail-closed
- Create: `src/runtime/__tests__/runtime-mode.test.ts`
- Create: `src/runtime/local-signer.ts` — ephemeral Ed25519 revision signer
- Create: `src/runtime/__tests__/local-signer.test.ts`
- Create: `src/runtime/local-runtime-source.ts` — artifact→revision materialization + `createLocalRuntimeSource`
- Create: `src/runtime/__tests__/local-runtime-source.test.ts`
- Modify: `src/runtime/index.ts` — export the three new modules
- Read first (implementer orientation, do not modify): `src/runtime/turn-snapshot.ts`, `src/runtime/local-tool-bindings.ts`, `src/server/adapters/nextjs/types.ts:101-131` (`ManagedLocalRuntimeConfig`), `src/sync/signature-verifier.ts`, `src/contracts/revisions.ts`, `src/contracts/app-setup.ts`, `src/contracts/prompt-bundle.ts`

---

### Task 1: Runtime mode resolution

**Files:**
- Create: `src/runtime/runtime-mode.ts`
- Test: `src/runtime/__tests__/runtime-mode.test.ts`

**Interfaces:**
- Produces: `type RuntimeMode = 'standalone' | 'managed'`;
  `resolveRuntimeMode(env: Record<string, string | undefined>): RuntimeMode`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveRuntimeMode } from '../runtime-mode.js';

describe('resolveRuntimeMode', () => {
  it('resolves standalone when no control plane is configured', () => {
    expect(resolveRuntimeMode({})).toBe('standalone');
    expect(resolveRuntimeMode({ GLIRASTES_CONTROL_PLANE_URL: '' })).toBe('standalone');
    expect(resolveRuntimeMode({ GLIRASTES_CONTROL_PLANE_URL: '   ' })).toBe('standalone');
  });

  it('resolves managed when the control plane URL is set', () => {
    expect(resolveRuntimeMode({
      GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101',
      GLIRASTES_API_KEY: 'k',
    })).toBe('managed');
  });

  it('fails closed on a half-configured managed mode', () => {
    expect(() => resolveRuntimeMode({
      GLIRASTES_CONTROL_PLANE_URL: 'http://localhost:8101',
    })).toThrow(/GLIRASTES_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/runtime/__tests__/runtime-mode.test.ts`
Expected: FAIL — cannot resolve `../runtime-mode.js`

- [ ] **Step 3: Write minimal implementation**

```ts
export type RuntimeMode = 'standalone' | 'managed';

/**
 * Standalone is the default. Managed is opted into by configuring the
 * control plane. A half-configured managed mode fails closed — it never
 * silently degrades into standalone.
 */
export function resolveRuntimeMode(
  env: Record<string, string | undefined>,
): RuntimeMode {
  const controlPlaneUrl = env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  if (!controlPlaneUrl) return 'standalone';
  if (!env.GLIRASTES_API_KEY?.trim()) {
    throw new Error(
      'Managed mode is configured (GLIRASTES_CONTROL_PLANE_URL) but '
      + 'GLIRASTES_API_KEY is missing. Refusing to fall back to standalone.',
    );
  }
  return 'managed';
}
```

- [ ] **Step 4: Run test to verify it passes** (same command, expect PASS)

- [ ] **Step 5: Export from `src/runtime/index.ts`, run `bun run typecheck`, commit**

```bash
git add src/runtime/runtime-mode.ts src/runtime/__tests__/runtime-mode.test.ts src/runtime/index.ts
git commit -m "feat(runtime): resolve the runtime mode fail-closed"
```

---

### Task 2: Ephemeral local revision signer

**Files:**
- Create: `src/runtime/local-signer.ts`
- Test: `src/runtime/__tests__/local-signer.test.ts`

**Interfaces:**
- Consumes: the canonicalization + verification functions of
  `src/sync/signature-verifier.ts`. Read that file first and reuse its
  exact payload canonicalization (sign what the verifier verifies). If its
  canonicalizer is not exported, export it from there rather than copying.
- Produces:
  `createEphemeralLocalSigner(): LocalRevisionSigner` with
  `interface LocalRevisionSigner { readonly keyId: string; sign<T extends object>(unsigned: T): T & { signature: RevisionSignature }; readonly publicKeyJwk: JsonWebKey }`
  (`RevisionSignature` from `src/contracts/revisions.ts`)

- [ ] **Step 1: Write the failing test** — a signed object round-trips
  through the *existing* verifier with the signer's own JWKS entry:

```ts
import { describe, expect, it } from 'vitest';
import { createEphemeralLocalSigner } from '../local-signer.js';
// import the existing verify function from src/sync/signature-verifier.ts
// (exact name: read the file; referred to as verifyRevisionSignature below)

describe('createEphemeralLocalSigner', () => {
  it('produces signatures the existing verifier accepts', async () => {
    const signer = createEphemeralLocalSigner();
    const signed = signer.sign({ revisionId: '00000000-0000-4000-8000-000000000001', revision: 1 });
    expect(signed.signature.algorithm).toBe('Ed25519');
    expect(signed.signature.keyId).toBe(signer.keyId);
    await expect(
      verifyRevisionSignature(signed, { keys: [{ ...signer.publicKeyJwk, kid: signer.keyId }] }),
    ).resolves.not.toThrow();
  });

  it('rejects tampered payloads', async () => {
    const signer = createEphemeralLocalSigner();
    const signed = signer.sign({ revisionId: '00000000-0000-4000-8000-000000000001', revision: 1 });
    const tampered = { ...signed, revision: 2 };
    await expect(
      verifyRevisionSignature(tampered, { keys: [{ ...signer.publicKeyJwk, kid: signer.keyId }] }),
    ).rejects.toThrow();
  });

  it('generates a fresh key per boot', () => {
    expect(createEphemeralLocalSigner().keyId)
      .not.toBe(createEphemeralLocalSigner().keyId);
  });
});
```

Adapt the verifier call to the real exported API of
`src/sync/signature-verifier.ts` — the *behavioral* assertions above are
the contract; the call shape follows the existing code.

- [ ] **Step 2: Run to verify FAIL** (module not found)

- [ ] **Step 3: Implement** with `node:crypto`
  (`generateKeyPairSync('ed25519')`); `keyId` = first 16 hex chars of the
  SHA-256 of the public key DER, matching the platform's kid style; sign
  the same canonical bytes the verifier hashes.

- [ ] **Step 4: Run to verify PASS**, then `bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/runtime/local-signer.ts src/runtime/__tests__/local-signer.test.ts src/runtime/index.ts src/sync/signature-verifier.ts
git commit -m "feat(runtime): self-sign local revisions with an ephemeral boot key"
```

---

### Task 3: Local runtime source

**Files:**
- Create: `src/runtime/local-runtime-source.ts`
- Test: `src/runtime/__tests__/local-runtime-source.test.ts`

**Interfaces:**
- Consumes: `createTurnSnapshot` (`./turn-snapshot.js`),
  `LocalToolBinding` (`./local-tool-bindings.js`),
  `LocalRevisionSigner` (Task 2), and from `../contracts/index.js`:
  `AppSetupArtifactSchema`, `ManifestRevisionSchema`,
  `AgentRevisionSchema`, `RuntimePolicyRevisionSchema`,
  `PromptBundleSchema`, `ExecutionBudget`, `Principal`.
- Produces:

```ts
export interface LocalRuntimeSourceOptions {
  /** Parsed .glirastes artifacts; loading from disk is the caller's job. */
  setupArtifact: unknown;        // validated via AppSetupArtifactSchema.parse
  promptBundle?: unknown;        // validated via PromptBundleSchema.parse
  bindings: ReadonlyArray<LocalToolBinding>;
  localLimits: ExecutionBudget;
  /** Stable ids for the standalone world; defaults derived deterministically
   *  from the setup artifact's app identity so restarts agree with themselves. */
  identity?: { tenantId?: string; targetAppId?: string; environmentId?: string };
  signer?: LocalRevisionSigner;  // default: createEphemeralLocalSigner()
}

export interface LocalRuntimeSource {
  readonly mode: 'standalone';
  readonly keyId: string;
  /** Satisfies ManagedLocalRuntimeConfig.resolveTurnSnapshot. Same turnId
   *  → identical snapshot (approval continuations). */
  resolveTurnSnapshot(context: {
    turnId: string;
    principal: Principal;
  }): TurnSnapshot;
}

export function createLocalRuntimeSource(
  options: LocalRuntimeSourceOptions,
): LocalRuntimeSource;
```

- [ ] **Step 1: Write the failing tests.** Build a golden fixture from a
  minimal two-tool setup artifact (one `endpoint`, one `ui` tool, dotted
  definitionIds like `tasks.listTasks` / `ui.navigate`) plus matching
  `LocalToolBinding`s. Assert:

```ts
describe('createLocalRuntimeSource', () => {
  it('materializes schema-valid, self-signed revisions at boot', () => {
    const source = createLocalRuntimeSource(fixtureOptions());
    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal: fixturePrincipal() });
    // strict schemas accept the materialized revisions
    ManifestRevisionSchema.parse(snapshot.manifestRevision);
    AgentRevisionSchema.parse(snapshot.agentRevision);
    RuntimePolicyRevisionSchema.parse(snapshot.policyRevision);
    expect(snapshot.manifestRevision.signature.keyId).toBe(source.keyId);
  });

  it('yields a registry identical in shape to the managed path', () => {
    const source = createLocalRuntimeSource(fixtureOptions());
    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal: fixturePrincipal() });
    const registry = materializeManifestToolRegistry({ snapshot, bindings: fixtureBindings() });
    expect(Object.keys(registry).sort()).toEqual(['tasks_listTasks', 'ui_navigate']);
  });

  it('pins one snapshot per turnId and shares tenant with the principal', () => {
    const source = createLocalRuntimeSource(fixtureOptions());
    const first = source.resolveTurnSnapshot({ turnId: 't-1', principal: fixturePrincipal() });
    const again = source.resolveTurnSnapshot({ turnId: 't-1', principal: fixturePrincipal() });
    expect(again).toBe(first);            // identical object for approval continuations
    expect(() => source.resolveTurnSnapshot({
      turnId: 't-2',
      principal: { ...fixturePrincipal(), tenantId: 'other' },
    })).toThrow(/tenant/i);               // createTurnSnapshot fail-closed intact
  });

  it('rejects a setup artifact that fails the contract schema', () => {
    expect(() => createLocalRuntimeSource({ ...fixtureOptions(), setupArtifact: { nope: true } }))
      .toThrow();
  });

  it('carries the prompt pin when a prompt bundle is provided', () => {
    const source = createLocalRuntimeSource(fixtureOptions({ withPromptBundle: true }));
    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal: fixturePrincipal() });
    expect(snapshot.promptPin?.bundleDigest).toMatch(/^sha256:/);
  });
});
```

  Materialization rules (the implementation contract):
  - every enabled setup-artifact tool → one `ManifestTool` (fingerprints
    and schema digests come from the artifact; `enabled: true`,
    `tombstone: false`) and one `RuntimeToolPolicy`
    (`requiresApproval`/`riskClass`/`allowedRoles` from the artifact's
    assessment; missing risk class → `'unknown'` + `requiresApproval: true`,
    fail closed);
  - one `AgentRevision` with `toolAllowlist` = all materialized toolIds and
    `budget` = `localLimits`;
  - the standalone identity (tenant/app/environment ids) is derived
    deterministically (UUIDv5-style hash of the artifact's app identity)
    unless overridden, and the principal must carry the same tenantId —
    the existing `createTurnSnapshot` tenant gate stays the enforcement;
  - snapshots are cached by `turnId` (bounded LRU, e.g. last 256 turns).

- [ ] **Step 2: RED** · **Step 3: implement `local-runtime-source.ts`** ·
  **Step 4: GREEN + `bun run typecheck`**

- [ ] **Step 5: Full suite `bun run test`, then commit**

```bash
git add src/runtime/local-runtime-source.ts src/runtime/__tests__/local-runtime-source.test.ts src/runtime/index.ts
git commit -m "feat(runtime): materialize standalone turn snapshots from local artifacts"
```

---

### Task 4: Managed/standalone source parity gate

**Files:**
- Test: `src/runtime/__tests__/source-parity.test.ts`
- Possibly modify: `src/server/testing` barrel if the shared assertion
  lands there (same home as `assertModuleRegistryParity`).

**Interfaces:**
- Consumes: `createLocalRuntimeSource` (Task 3),
  `materializeManifestToolRegistry`, `assertModuleRegistryParity`
  (from `glirastes/server/testing`).
- Produces: a reusable golden-fixture test proving both sources
  materialize identical registries for identical inputs.

- [ ] **Step 1: Write the failing test.** Take one fixture inventory; run
  it (a) through the local source, (b) through a hand-built managed-style
  snapshot (`createTurnSnapshot` with platform-shaped revisions carrying
  the *same* tool set). Assert both registries expose identical
  model-facing names, `needsApproval` flags, and descriptions, and that
  `assertModuleRegistryParity` passes against both for a two-module
  membership fixture.
- [ ] **Step 2: RED** (new test file) · **Step 3/4: make it GREEN** —
  differences found here are materialization bugs in Task 3; fix them
  there, not in the test.
- [ ] **Step 5: Commit**

```bash
git add src/runtime/__tests__/source-parity.test.ts
git commit -m "test(runtime): prove managed and standalone sources materialize identically"
```

---

### Task 5: Standalone network silence proof

**Files:**
- Test: `src/runtime/__tests__/standalone-network-silence.test.ts`

- [ ] **Step 1: Write the failing test.** Stub `globalThis.fetch` with a
  spy that throws `new Error('standalone must not touch the network')`;
  boot `createLocalRuntimeSource` from fixtures, resolve a snapshot,
  materialize the registry, and run one guard cycle
  (`createManagedTurnGuard` from `src/runtime/managed-turn.ts`) end to
  end. Assert the spy was never called.
- [ ] **Step 2–4: RED → GREEN.** Any fetch observed is a Phase-1 bug (the
  approved assumption is *strictly* silent — no telemetry either).
- [ ] **Step 5: Commit**

```bash
git add src/runtime/__tests__/standalone-network-silence.test.ts
git commit -m "test(runtime): prove the standalone source is network-silent"
```

---

### Task 6: Consumer proof in Get It Done

**Files (GID worktree):**
- Create: `src/lib/glirastes/standalone-source.ts` — loads `.glirastes/`
  artifacts from disk, calls `createLocalRuntimeSource`
- Modify: `src/lib/glirastes/runtime-sync.ts` — mode switch via
  `resolveRuntimeMode(process.env)`: managed keeps today's path verbatim;
  standalone skips sync entirely and serves the local source
- Modify: `src/lib/glirastes/chat-handler.ts` — no structural change; it
  receives the source's `resolveTurnSnapshot` through the existing
  `managedRuntime` config
- Test: `src/__tests__/lib/glirastes/standalone-source.test.ts`

**Interfaces:**
- Consumes (from `glirastes/runtime`, built `dist/`): `resolveRuntimeMode`,
  `createLocalRuntimeSource`, `LocalRuntimeSource`.

- [ ] **Step 0: Stop any GID watch process, run `bun run build` in the SDK worktree** (GID loads from `dist/`).
- [ ] **Step 1: Write the failing test** — with a control-plane-free env,
  the GID runtime factory returns a standalone source whose registry
  contains the same model-facing tool names as the generated execution
  registry (reuse the existing parity-test fixture loading); with
  `GLIRASTES_CONTROL_PLANE_URL` set and no `GLIRASTES_API_KEY`, boot
  throws (no silent standalone downgrade).
- [ ] **Step 2–4: RED → GREEN.** The GID artifacts to load are
  `.glirastes/setup-artifact.json`, `.glirastes/local-tool-bindings.json`
  (bindings construction may reuse the existing generated bindings module
  rather than the JSON), and `.glirastes/prompt-bundle.json`.
- [ ] **Step 5: Full GID verification: `bun run test` + typecheck, commit in GID**

```bash
git commit -m "feat(glirastes): run standalone from local artifacts by default"
```

- [ ] **Step 6: Live proof (operator-visible):** with `.env.local`'s
  control-plane variables commented out, `bun run dev`, one chat turn with
  a tool execution on `localhost:3030`, offline. Record the result in the
  Platform working document (§6 entry).

---

### Task 7: Documentation

- [ ] Update SDK `CLAUDE.md` (mode model paragraph: standalone default,
  managed opt-in, no silent fallback) and the Platform working document
  §6 with a dated completion entry naming commits and the proof.
- [ ] Commit both docs changes in their repos
  (`docs(claude): …` / `docs(foundation): …`).

## Self-Review Notes

- Spec coverage: mode model → Task 1; local source + curated-semantics
  *consumption as far as the artifact already carries it* → Task 3 (full
  curated-semantics artifact generation is Phase 2, not this plan);
  shared-chain guarantee → Tasks 4–5; consumer proof → Task 6.
- The signer reuses the existing verifier's canonicalization — no second
  signature dialect.
- No task weakens a contract schema; standalone passes the same strict
  parses as managed.
