# Sicherung und Hygiene (P01) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure the uncommitted state of all three repositories and remove the hygiene defects that make the P01 gates unreliable (flaky cleanup, load-sensitive default timeouts, untyped test files, broken GID lint, unignored runner key, Aegis pseudonym collisions), so every later plan starts from green, deterministic gates.

**Architecture:** No new product behaviour; every task is a small, separately committed TDD cycle on the existing local foundation branches: SDK `codex/glirastes-foundation-runtime` in `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1`, Platform `codex/glirastes-foundation-control-plane` in `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1`, Get It Done `codex/glirastes-foundation-pilot` in `/Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot`. The single exception is Task 2, a doc-only local commit on `main` in the Platform main checkout `/Users/philipprollmann/Dev/chainmatics/glirastes-platform`, because that checkout's `CLAUDE.md` is the one sessions load. The three repos are independent; tasks may run per repo in parallel, but inside a repo they run in the listed order.

**Tech Stack:** TypeScript 5 (SDK NodeNext, GID bundler resolution), Bun, Vitest 4, `node:test` (SDK browser reference), NestJS 11 (Aegis), ESLint 9.39.3 flat config with bulk suppressions, `eslint-config-next` 16.1.6, git.

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (sections 1 "Annahmen", 2 "Ausgangslage", 7 "Platform-Hygiene" — Aegis bullet only, 9 "TP0"); acceptance context from 2026-09-13-mvp-scope-and-requirements.md section 6 "Release".

## Global Constraints

- No pushes, main-branch merges, npm publishes, deployments or live landing changes without Philipp's explicit approval (spec 1, 9, 11); the backup push of the three branches is requested only after this plan (spec 9).
- Local commits only; Task 2 is the only commit on a `main` branch and touches exactly `CLAUDE.md`.
- Omnify is neither read nor modified (spec 1, 11).
- TDD: verify RED first, then the minimal change, then GREEN; do not weaken protections and do not delete compatibility code (spec 1).
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution.
- Never open, print, copy or stage `.env*`, `.secrets/`, `.glirastes/platform-connection.json`, `.glirastes/setup-receipt.json` or `.glirastes/runtime-state.json` contents.
- Baseline 2026-10-04 (spec 2): SDK 1,079/1,079 Vitest tests; GID 1,000/1,000 with a 30 s timeout; Platform API 1,125/1,136 (10 skipped, 1 flaky = Aegis), DB 90/90, Citadel 250/250.
- Agent shells reset the working directory between calls, and the session's default directory is the Platform **main** checkout (which has its own `apps/api`). Every bash block below therefore starts with an absolute `cd`; never run a block from an inherited directory.
- SDK commands run from the SDK worktree root: `bunx vitest run <path>`, `bun run test`, `bun run typecheck`, `bun run build`; the browser reference uses `node --test`.
- Platform API tests: `cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/apps/api && ./node_modules/.bin/vitest run <path>` (the worktree root `node_modules/.bin` has no `vitest`); Citadel `cd …/foundation-control-plane-v1/apps/citadel && ./node_modules/.bin/vitest run`; DB `cd …/foundation-control-plane-v1/packages/db && bun test`.
- GID commands run from the pilot worktree root: `node scripts/run-vitest.mjs <path>`, `node_modules/.bin/tsc --noEmit`, `bun run lint`.
- `bun run typecheck:tests` resolves the `glirastes/*` self-imports through `dist/`; run `bun run build` first whenever `dist/` is missing or older than `src/`.
- Never run a build in a worktree that has a running dev or watch process (SDK `dist/`, GID `.next/`).

## Review Focus

1. **macOS zombie process groups.** `kill(-pgid, 0)` answers `EPERM` instead of `ESRCH` while every member is a zombie; the reference cleanup must treat that as stopped yet still throw on any other error code. Pinned in Task 9 (three injected-`kill` tests).
2. **Two people, one surname.** Two identity groups may draw the same generated surname; "Herr Neumann" must keep rehydrating to the person who claimed it first, both in `scan` and in the tool-result path `shieldResult`. Pinned in Task 3.
3. **Two people, one full pseudonym.** A second group must never receive the exact PERSON pseudonym of an existing group, or the model's tool arguments rehydrate to the wrong person. Pinned in Task 4.
4. **Suppression baseline hides new lint errors.** The ESLint debt baseline must suppress only the 96 recorded errors; a new violation must still fail `eslint`, both in a new file and as one more occurrence of an already-suppressed rule in an already-suppressed file (suppressions are counts per file and rule). Pinned in Task 8 Step 7.
5. **Runner key committed by accident.** `.glirastes/platform-connection.json` carries the runner key; the guard uses `git check-ignore --no-index` so it holds even if the file was ever tracked. Pinned in Task 6.

---

## File Structure

**Platform worktree** (`/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1`)

| File | Action | Responsibility |
| --- | --- | --- |
| `docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md` | Commit pending diff as-is (+693) | Canonical pilot working document |
| `docs/plans/2026-08-14-local-connected-managed-platform-design.md` | Commit pending diff as-is (+15) | Local/Connected/Managed platform design |
| `docs/plans/2026-08-15-conversational-product-value-and-european-trust.md` | Commit untracked file as-is (182 lines) | Product value note |
| `docs/plans/2026-09-13-glirastes-product-dx-and-landing-audit.md` | Commit untracked file as-is (225 lines) | Product, DX and landing audit |
| `CLAUDE.md` | Verify only (lines 168–173 already name the `glirastes` SDK) | Agent instructions on the foundation branch |
| `apps/api/src/modules/aegis/aegis.service.ts` | Modify | `indexPseudonym` (first owner keeps a variant) and `drawGroupSeed` (no shared full pseudonym) |
| `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts` | Modify | Deterministic collision tests (section 7) |

**Platform main checkout** (`/Users/philipprollmann/Dev/chainmatics/glirastes-platform`, branch `main`)

| File | Action | Responsibility |
| --- | --- | --- |
| `CLAUDE.md` | Modify lines 106–107 | Point SDK sync and releases to `/Users/philipprollmann/Dev/chainmatics/glirastes` |

**Get It Done pilot** (`/Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot`)

| File | Action | Responsibility |
| --- | --- | --- |
| `.glirastes/platform-tool-bindings.json` | Commit the pending 105-line deletion | Platform binding snapshot consistent with the committed parity test |
| `.gitignore` | Modify (after line 46) | Ignore the local connection descriptor |
| `src/__tests__/scripts/glirastes-local-state-ignored.test.ts` | Create | Guard: local Glirastes state stays ignored |
| `src/__tests__/scripts/prompt-size-baseline.test.ts` | Modify line 26 (`describe`) | Explicit 30 s suite timeout (six of its seven tests run the full measurement) |
| `src/__tests__/scripts/glirastes-connected-flow.test.ts` | Modify line 377 | Explicit 30 s timeout |
| `eslint.config.mjs` | Create (identical to `origin/master`) | Flat ESLint config for Next 16 |
| `eslint-suppressions.json` | Create (generated) | Recorded lint debt baseline (96 errors) |
| `package.json` | Modify line 17 | `"lint": "eslint ."` |

**SDK worktree** (`/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1`)

| File | Action | Responsibility |
| --- | --- | --- |
| `tests/source-driven-browser.test.mjs` | Modify lines 15–17, 33, 45, 48; insert tests before line 30 | EPERM-tolerant process-group cleanup |
| `tsconfig.test.json` | Create | Typecheck config for `src/**` tests and `tests/**` |
| `package.json` | Modify line 276 | `"typecheck:tests": "tsc -p tsconfig.test.json"` |
| `CLAUDE.md` | Modify lines 54–55 | Document the new gate |
| `src/cli/**` (6 test files) | Modify | 23 test type errors |
| `src/server/**` (6 test files) | Modify | 24 test type errors |
| `src/sync/__tests__/*` (3), `src/contracts/__tests__/revisions.test.ts` | Modify | 12 test type errors |
| `src/runtime/**` (6 test files) | Modify | 12 test type errors |
| `src/react/**` (7 test files) | Modify | 15 test type errors |
| `tests/source-driven-build.test.ts` | Modify (Task 16, Task 17) | Drop the RED-phase `.catch(() => ({}))` import; explicit 30 s timeout for the test that spawns `bun run build` |
| `examples/source-driven-next/{adapter,build,prepare-browser}.d.mts` | Create | Types for the plain-JS reference modules (replaced in P03) |

---

### Task 1: Platform – commit the pending planning documents as-is

**Files:**
- Modify (commit only, no content edits): `docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md`, `docs/plans/2026-08-14-local-connected-managed-platform-design.md`
- Create (already on disk, untracked): `docs/plans/2026-08-15-conversational-product-value-and-european-trust.md`, `docs/plans/2026-09-13-glirastes-product-dx-and-landing-audit.md`
- Test: guard commands in Steps 1–2

**Interfaces:** Consumes none. Produces none.

- [ ] **Step 1: Pin the pending set (fails if anything else is pending)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git branch --show-current
git status --short
git diff --numstat
```

Expected: branch `codex/glirastes-foundation-control-plane`; status exactly

```text
 M docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md
 M docs/plans/2026-08-14-local-connected-managed-platform-design.md
?? docs/plans/2026-08-15-conversational-product-value-and-european-trust.md
?? docs/plans/2026-09-13-glirastes-product-dx-and-landing-audit.md
```

and numstat `693 0` and `15 0` for the two modified files. Any other entry: stop and report it; never stage it.

- [ ] **Step 2: Secret scan (must print nothing)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
grep -nE "sk-or-v1-[A-Za-z0-9]{8,}|gl_[A-Za-z0-9]{20,}|BEGIN (RSA|EC|OPENSSH|PRIVATE)|npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|postgres(ql)?://[^ ]*:[^ ]*@" \
  docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md \
  docs/plans/2026-08-14-local-connected-managed-platform-design.md \
  docs/plans/2026-08-15-conversational-product-value-and-european-trust.md \
  docs/plans/2026-09-13-glirastes-product-dx-and-landing-audit.md; echo "exit=$?"
```

Expected: no matches, `exit=1` (measured 2026-10-04). A hit stops the task and goes to Philipp.

- [ ] **Step 3: Commit as-is**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git add docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md \
  docs/plans/2026-08-14-local-connected-managed-platform-design.md \
  docs/plans/2026-08-15-conversational-product-value-and-european-trust.md \
  docs/plans/2026-09-13-glirastes-product-dx-and-landing-audit.md
git commit -m "docs(plans): commit foundation pilot notes and product audits"
```

- [ ] **Step 4: Verify**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git status --short
git show --shortstat --format= HEAD
```

Expected: empty status; `4 files changed, 1115 insertions(+)`.

---

### Task 2: Platform – point CLAUDE.md at the glirastes SDK

**Files:**
- Verify (no change): `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/CLAUDE.md:168-173`
- Modify: `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/CLAUDE.md:106-107` (main checkout, branch `main`)
- Test: grep checks in Steps 1 and 4

**Interfaces:** Consumes none. Produces none.

Why both: the foundation worktree's `CLAUDE.md` already says "The SDK is `glirastes`, not `agentic-sdk`" (line 168) and names `/Users/philipprollmann/Dev/chainmatics/glirastes` (line 169); line 171 mentions the old path only as historical. The main checkout's `CLAUDE.md` is the file loaded by sessions that start in `/Users/philipprollmann/Dev/chainmatics/glirastes-platform`, and it still sends SDK sync and releases to the deleted `/Users/philipprollmann/Dev/chainmatics/agentic-sdk`.

- [ ] **Step 1: Failing check**

```bash
grep -n "chainmatics/agentic-sdk" /Users/philipprollmann/Dev/chainmatics/glirastes-platform/CLAUDE.md
grep -n "chainmatics/agentic-sdk\|Dev/chainmatics/glirastes\`" /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/CLAUDE.md
```

Expected: main checkout lines 106 and 107 (RED); foundation worktree only line 169 (the `glirastes` path) and line 171 (historical note) — leave the foundation file unchanged.

- [ ] **Step 2: Preconditions in the main checkout (protect Philipp's work in progress)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform
git branch --show-current
git diff --quiet -- CLAUDE.md; echo "claude-md-clean=$?"
git diff --cached --quiet; echo "nothing-staged=$?"
```

Expected: `main`, `claude-md-clean=0`, `nothing-staged=0`. The modified `apps/citadel/src/app/(dashboard)/connect/page.tsx`, `dev.sh`, `docs/foerderantrag-neuartigkeit.md` and all untracked files belong to Philipp and stay untouched. Any other result: stop and report.

- [ ] **Step 3: Replace lines 106–107**

In `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/CLAUDE.md` (main checkout, not the worktree copy), replace exactly these two lines:

```markdown
- **Agentic SDK sync**: When changing anything relevant to the Agentic SDK (API contracts, SDK types, endpoints, auth behavior, etc.), always apply the corresponding changes in the agentic-sdk project at `/Users/philipprollmann/Dev/chainmatics/agentic-sdk` on branch `main`.
- **Agentic SDK releases**: When releasing a new version of the agentic-sdk, always use the `releasing-packages` skill from the agentic-sdk project (at `/Users/philipprollmann/Dev/chainmatics/agentic-sdk/.claude/skills/releasing-packages/SKILL.md`). Never release manually or bypass the skill workflow.
```

with:

```markdown
- **SDK sync**: The SDK counterpart is the `glirastes` repository at `/Users/philipprollmann/Dev/chainmatics/glirastes` (the old `agentic-sdk` checkout no longer exists). Foundation work happens in its worktree `.worktrees/foundation-runtime-v1` on `codex/glirastes-foundation-runtime`, paired with this repository's `.worktrees/foundation-control-plane-v1` on `codex/glirastes-foundation-control-plane`. When changing anything relevant to the SDK (API contracts, SDK types, endpoints, auth behavior, etc.), apply the corresponding change there.
- **SDK releases**: When releasing a new version of `glirastes`, always use the `releasing-packages` skill at `/Users/philipprollmann/Dev/chainmatics/glirastes/.claude/skills/releasing-packages/SKILL.md`. Never release manually or bypass the skill workflow.
```

- [ ] **Step 4: Verify GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform
grep -c "chainmatics/agentic-sdk" CLAUDE.md
grep -c "/Users/philipprollmann/Dev/chainmatics/glirastes" CLAUDE.md
test -f /Users/philipprollmann/Dev/chainmatics/glirastes/.claude/skills/releasing-packages/SKILL.md && echo skill-present
```

Expected: `0`, `2`, `skill-present`.

- [ ] **Step 5: Doc-only local commit on main**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform
git branch --show-current
git add CLAUDE.md
git commit -m "docs(claude): point sdk sync and releases to glirastes"
git show --stat --format= HEAD
git status --short
```

Expected: `main`; `git show --stat` lists exactly `CLAUDE.md | 4 ++--` and `1 file changed, 2 insertions(+), 2 deletions(-)`; status still lists Philipp's three modified files and the untracked files exactly as before. Do not push.

---

### Task 3: Platform – Aegis keeps surname variants with their first identity group

**Files:**
- Modify: `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts:1-2` (imports) and append section 7 before the final `});` (line 471)
- Modify: `apps/api/src/modules/aegis/aegis.service.ts` – new helper after `rehydrateString` (line 72); six reverse-index blocks at lines 172–180, 222–232, 348–355, 397–404, 484–491, 527–534
- Test: `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts`

**Interfaces:**
- Consumes: `PiiSession { groups: IdentityGroup[]; forwardIndex: Record<string, { groupId: string; type: string }>; reverseIndex: Record<string, string>; … }` (`identity-group.ts:22`); `generateVariants(type: string, pseudonym: string, locale: string): string[]` (`variant-generator.ts`); `generateGroupIdentity(seed: number, locale: string): GroupIdentity` (`group-pseudonym-generator.ts`); `AegisService.scan|shieldResult|rehydrate` (unchanged signatures).
- Produces (module-private): `function indexPseudonym(session: PiiSession, original: string, pseudonym: string, variants: readonly string[]): void`.

Root cause: every new group draws `seed = (Math.random() * 0x7fffffff) | 0`, and the DE surname pool has 20 entries, so two people share a generated surname in about 5 % of two-person sessions. All six indexing blocks then write the surname variants (`Neumann`, `Herr Neumann`, `Frau Neumann`) for the second person over the first one. The flaky `identity-group-e2e.spec.ts:224` assertion is the visible symptom; the user-facing defect is that "Herr Neumann" rehydrates to the wrong person. The test forces the collision deterministically by spying on `Math.random` (seed 1000 → "Max Neumann", seed 3000 → "Lukas Neumann"), so no production parameter is needed.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git apply <<'PATCH'
--- a/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
+++ b/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
@@ -1,5 +1,6 @@
-import { describe, it, expect, beforeEach, vi } from 'vitest';
+import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
 import { AegisService } from '../aegis.service';
+import { generateGroupIdentity } from '../group-pseudonym-generator';
 import { transliterate } from '../identity-group';
 import type { PiiEntity } from '../detectors/regex.detector';
 
@@ -468,4 +469,68 @@
       ).toBe(true);
     });
   });
+
+  // -------------------------------------------------------------------------
+  // 7. Pseudonym collisions across identity groups
+  // -------------------------------------------------------------------------
+
+  describe('7. Pseudonym collisions across identity groups', () => {
+    // scan() draws each new group's seed as (Math.random() * 0x7fffffff) | 0.
+    // drawFor(seed) is the Math.random() value that yields exactly that seed.
+    const drawFor = (seed: number) => (seed + 0.5) / 0x7fffffff;
+    const MAX_NEUMANN = 1000;
+    const LUKAS_NEUMANN = 3000;
+    const fullName = (group: { firstName: string; lastName: string }) =>
+      `${group.firstName} ${group.lastName}`;
+
+    afterEach(() => {
+      vi.restoreAllMocks();
+    });
+
+    it('never re-points a shared surname variant to a second person', async () => {
+      expect(fullName(generateGroupIdentity(MAX_NEUMANN, 'de'))).toBe('Max Neumann');
+      expect(fullName(generateGroupIdentity(LUKAS_NEUMANN, 'de'))).toBe('Lukas Neumann');
+      const { sessionId } = await service.createSession('tenant-1', 'app-1', 'de');
+      injectPresidioMock(service, createPersonDetector(['Maria Schmidt', 'Hans Weber']));
+      vi.spyOn(Math, 'random')
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(LUKAS_NEUMANN));
+
+      const { newGroups, reverseMap } = await service.scan(
+        sessionId,
+        'Maria Schmidt und Hans Weber',
+        ['de', 'en'],
+      );
+
+      expect(newGroups.map(fullName)).toEqual(['Max Neumann', 'Lukas Neumann']);
+      const [first, second] = newGroups.map((group) => Object.keys(group.entities)[0]);
+      expect(reverseMap['Max Neumann']).toBe(first);
+      expect(reverseMap['Lukas Neumann']).toBe(second);
+      for (const variant of ['Neumann', 'Herr Neumann', 'Frau Neumann']) {
+        expect(reverseMap[variant]).toBe(first);
+      }
+      expect(
+        Object.entries(reverseMap).find(([, original]) => original === second)?.[0],
+      ).toBe('Lukas Neumann');
+      await expect(service.rehydrate(sessionId, 'Lukas Neumann'))
+        .resolves.toEqual({ rehydrated: second });
+    });
+
+    it('keeps surname variants with their first owner when a tool result adds a person', async () => {
+      const { sessionId } = await service.createSession('tenant-1', 'app-1', 'de');
+      injectPresidioMock(service, createPersonDetector(['Maria Schmidt', 'Hans Weber']));
+      vi.spyOn(Math, 'random')
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(LUKAS_NEUMANN));
+
+      await service.scan(sessionId, 'Finde Maria Schmidt', ['de', 'en']);
+      const shield = await service.shieldResult(sessionId, { owner: 'Hans Weber' });
+
+      expect(shield.shielded).toEqual({ owner: 'Lukas Neumann' });
+      expect(shield.reverseMapPatch['Lukas Neumann']).toBe('Hans Weber');
+      expect(shield.reverseMapPatch).not.toHaveProperty('Neumann');
+      await expect(service.rehydrate(sessionId, 'Herr Neumann'))
+        .resolves.toEqual({ rehydrated: 'Maria Schmidt' });
+    });
+  });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/apps/api && ./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts -t "Pseudonym collisions"
```

Expected: `2 failed | 6 skipped` – "never re-points a shared surname variant to a second person" with `expected 'Hans Weber' to be 'Maria Schmidt'`, and "keeps surname variants with their first owner when a tool result adds a person" with `expected { rehydrated: 'Hans Weber' } to deeply equal { rehydrated: 'Maria Schmidt' }`.

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git apply <<'PATCH'
--- a/apps/api/src/modules/aegis/aegis.service.ts
+++ b/apps/api/src/modules/aegis/aegis.service.ts
@@ -71,6 +71,27 @@
   );
 }
 
+/**
+ * Record a pseudonym and its variants for one original value. A variant that
+ * already resolves to a different original is never re-pointed: two identity
+ * groups may share a generated surname, and "Herr Neumann" must keep meaning
+ * the person who claimed it first instead of silently switching people.
+ */
+function indexPseudonym(
+  session: PiiSession,
+  original: string,
+  pseudonym: string,
+  variants: readonly string[],
+): void {
+  session.reverseIndex[pseudonym] = original;
+  for (const variant of variants) {
+    if (variant === pseudonym) continue;
+    const owner = session.reverseIndex[variant];
+    if (owner !== undefined && owner !== original) continue;
+    session.reverseIndex[variant] = original;
+  }
+}
+
 // ---------------------------------------------------------------------------
 // Service
 // ---------------------------------------------------------------------------
@@ -170,14 +191,12 @@
         };
 
         session.forwardIndex[entity.value] = { groupId: group.id, type: entity.type };
-        session.reverseIndex[pseudonym] = entity.value;
-
-        const variants = generateVariants(entity.type, pseudonym, locale);
-        for (const variant of variants) {
-          if (variant !== pseudonym) {
-            session.reverseIndex[variant] = entity.value;
-          }
-        }
+        indexPseudonym(
+          session,
+          entity.value,
+          pseudonym,
+          generateVariants(entity.type, pseudonym, locale),
+        );
       }
     }
 
@@ -219,18 +238,15 @@
             variants: generateVariants(entity.type, pseudonym, locale),
           };
 
-          // Update session indices
+          // Update session indices (variants included)
           session.forwardIndex[entity.value] = { groupId, type: entity.type };
-          session.reverseIndex[pseudonym] = entity.value;
+          indexPseudonym(
+            session,
+            entity.value,
+            pseudonym,
+            generateVariants(entity.type, pseudonym, locale),
+          );
 
-          // Store variants in reverseIndex too
-          const variants = generateVariants(entity.type, pseudonym, locale);
-          for (const variant of variants) {
-            if (variant !== pseudonym) {
-              session.reverseIndex[variant] = entity.value;
-            }
-          }
-
           existingPseudonyms.push(pseudonym);
         }
 
@@ -345,14 +361,12 @@
         };
 
         session.forwardIndex[entity.value] = { groupId: group.id, type: entity.type };
-        session.reverseIndex[pseudonym] = entity.value;
-
-        const variants = generateVariants(entity.type, pseudonym, locale);
-        for (const variant of variants) {
-          if (variant !== pseudonym) {
-            session.reverseIndex[variant] = entity.value;
-          }
-        }
+        indexPseudonym(
+          session,
+          entity.value,
+          pseudonym,
+          generateVariants(entity.type, pseudonym, locale),
+        );
 
         forwardMapping[entity.value] = pseudonym;
       }
@@ -394,15 +408,13 @@
           };
 
           session.forwardIndex[entity.value] = { groupId, type: entity.type };
-          session.reverseIndex[pseudonym] = entity.value;
+          indexPseudonym(
+            session,
+            entity.value,
+            pseudonym,
+            generateVariants(entity.type, pseudonym, locale),
+          );
 
-          const variants = generateVariants(entity.type, pseudonym, locale);
-          for (const variant of variants) {
-            if (variant !== pseudonym) {
-              session.reverseIndex[variant] = entity.value;
-            }
-          }
-
           forwardMapping[entity.value] = pseudonym;
           existingPseudonyms.push(pseudonym);
         }
@@ -481,14 +493,12 @@
           };
 
           session.forwardIndex[entity.value] = { groupId: group.id, type: entity.type };
-          session.reverseIndex[pseudonym] = entity.value;
-
-          const variants = generateVariants(entity.type, pseudonym, locale);
-          for (const variant of variants) {
-            if (variant !== pseudonym) {
-              session.reverseIndex[variant] = entity.value;
-            }
-          }
+          indexPseudonym(
+            session,
+            entity.value,
+            pseudonym,
+            generateVariants(entity.type, pseudonym, locale),
+          );
 
           forwardMapping[entity.value] = pseudonym;
         }
@@ -524,15 +534,13 @@
             };
 
             session.forwardIndex[entity.value] = { groupId, type: entity.type };
-            session.reverseIndex[pseudonym] = entity.value;
+            indexPseudonym(
+              session,
+              entity.value,
+              pseudonym,
+              generateVariants(entity.type, pseudonym, locale),
+            );
 
-            const variants = generateVariants(entity.type, pseudonym, locale);
-            for (const variant of variants) {
-              if (variant !== pseudonym) {
-                session.reverseIndex[variant] = entity.value;
-              }
-            }
-
             forwardMapping[entity.value] = pseudonym;
             existingPseudonyms.push(pseudonym);
           }
PATCH
```

(`git apply` is all-or-nothing. If whitespace was mangled in transit, make the identical edits with the Edit tool: add `indexPseudonym` above the `// Service` banner and replace each of the six `session.reverseIndex[pseudonym] = entity.value;` + variant loop blocks with the `indexPseudonym(...)` call shown.)

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/apps/api
./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts -t "Pseudonym collisions"
./node_modules/.bin/vitest run src/modules/aegis
grep -c "session.reverseIndex\[variant\] = entity.value" src/modules/aegis/aegis.service.ts
```

Expected: `2 passed | 6 skipped`; `176 passed | 10 skipped (186)`; `0` (all six blocks converted – the scan path with the "Store variants in reverseIndex too" comment is the one most easily missed, and the first test catches it).

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git add apps/api/src/modules/aegis/aegis.service.ts apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
git commit -m "fix(aegis): keep surname variants with their first identity group"
```

---

### Task 4: Platform – Aegis never gives two identity groups one full pseudonym

**Files:**
- Modify: `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts` (section 7 from Task 3)
- Modify: `apps/api/src/modules/aegis/aegis.service.ts` – helper after `indexPseudonym`; seed draws in `scan` (line ~231), `shieldResult` (~401), `shieldResults` (~531)
- Test: `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts`

**Interfaces:**
- Consumes: `generateGroupIdentity(seed: number, locale: string): { firstName: string; lastName: string; seed: number }`; `PiiSession.groups: IdentityGroup[]` with `firstName`, `lastName`.
- Produces (module-private): `const MAX_IDENTITY_DRAWS = 32;` and `function drawGroupSeed(session: PiiSession, locale: string): number`.

`deriveGroupPseudonym` returns `${firstName} ${lastName}` for PERSON and ignores `existingPseudonyms`, so two groups with the same seed outcome (1 in 400 per pair) get the identical pseudonym and the second person's original overwrites the first one's full-name mapping. The fix re-draws the seed (bounded, 32 draws) while the generated full name is already taken in the session.

- [ ] **Step 1: Write the failing test**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git apply <<'PATCH'
--- a/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
+++ b/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
@@ -480,6 +480,7 @@
     const drawFor = (seed: number) => (seed + 0.5) / 0x7fffffff;
     const MAX_NEUMANN = 1000;
     const LUKAS_NEUMANN = 3000;
+    const SOPHIE_HOFFMANN = 2000;
     const fullName = (group: { firstName: string; lastName: string }) =>
       `${group.firstName} ${group.lastName}`;
 
@@ -531,6 +532,27 @@
       expect(shield.reverseMapPatch).not.toHaveProperty('Neumann');
       await expect(service.rehydrate(sessionId, 'Herr Neumann'))
         .resolves.toEqual({ rehydrated: 'Maria Schmidt' });
+    });
+
+    it('draws a fresh identity instead of giving two people one full name', async () => {
+      expect(fullName(generateGroupIdentity(SOPHIE_HOFFMANN, 'de'))).toBe('Sophie Hoffmann');
+      const { sessionId } = await service.createSession('tenant-1', 'app-1', 'de');
+      injectPresidioMock(service, createPersonDetector(['Maria Schmidt', 'Hans Weber']));
+      vi.spyOn(Math, 'random')
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(SOPHIE_HOFFMANN));
+
+      const { newGroups, reverseMap } = await service.scan(
+        sessionId,
+        'Maria Schmidt und Hans Weber',
+        ['de', 'en'],
+      );
+
+      expect(newGroups.map(fullName)).toEqual(['Max Neumann', 'Sophie Hoffmann']);
+      const [first, second] = newGroups.map((group) => Object.keys(group.entities)[0]);
+      expect(reverseMap['Max Neumann']).toBe(first);
+      expect(reverseMap['Sophie Hoffmann']).toBe(second);
     });
   });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/apps/api && ./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts -t "draws a fresh identity"
```

Expected: `1 failed | 8 skipped` with `expected [ 'Max Neumann', 'Max Neumann' ] to deeply equal [ 'Max Neumann', 'Sophie Hoffmann' ]`.

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git apply <<'PATCH'
--- a/apps/api/src/modules/aegis/aegis.service.ts
+++ b/apps/api/src/modules/aegis/aegis.service.ts
@@ -89,7 +89,27 @@
     const owner = session.reverseIndex[variant];
     if (owner !== undefined && owner !== original) continue;
     session.reverseIndex[variant] = original;
+  }
+}
+
+const MAX_IDENTITY_DRAWS = 32;
+
+/**
+ * Draw the seed for a new identity group. Re-draws (bounded) while the
+ * generated full name already belongs to another group of this session, so
+ * two people never share one PERSON pseudonym.
+ */
+function drawGroupSeed(session: PiiSession, locale: string): number {
+  const taken = new Set(
+    session.groups.map((group) => `${group.firstName} ${group.lastName}`),
+  );
+  let seed = (Math.random() * 0x7fffffff) | 0 || 1;
+  for (let draw = 1; draw < MAX_IDENTITY_DRAWS; draw++) {
+    const { firstName, lastName } = generateGroupIdentity(seed, locale);
+    if (!taken.has(`${firstName} ${lastName}`)) break;
+    seed = (Math.random() * 0x7fffffff) | 0 || 1;
   }
+  return seed;
 }
 
 // ---------------------------------------------------------------------------
@@ -208,7 +228,7 @@
 
       for (const cluster of clusters) {
         // Generate a new identity group with a random seed
-        const seed = (Math.random() * 0x7fffffff) | 0 || 1;
+        const seed = drawGroupSeed(session, locale);
         const identity = generateGroupIdentity(seed, locale);
         const groupId = `ig_${session.groups.length}`;
 
@@ -378,7 +398,7 @@
       const clusters = clusterEntities(unmatched, textToScan);
 
       for (const cluster of clusters) {
-        const seed = (Math.random() * 0x7fffffff) | 0 || 1;
+        const seed = drawGroupSeed(session, locale);
         const identity = generateGroupIdentity(seed, locale);
         const groupId = `ig_${session.groups.length}`;
 
@@ -508,7 +528,7 @@
         const clusters = clusterEntities(unmatched, textToScan);
 
         for (const cluster of clusters) {
-          const seed = (Math.random() * 0x7fffffff) | 0 || 1;
+          const seed = drawGroupSeed(session, locale);
           const identity = generateGroupIdentity(seed, locale);
           const groupId = `ig_${session.groups.length}`;
 
PATCH
```

- [ ] **Step 4: Run and see GREEN, then prove stability**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/apps/api
./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts -t "Pseudonym collisions"
./node_modules/.bin/vitest run src/modules/aegis
grep -c "Math.random" src/modules/aegis/aegis.service.ts
for i in $(seq 1 20); do ./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts >/dev/null 2>&1 || echo "run $i failed"; done
```

Expected: `3 passed | 6 skipped`; `177 passed | 10 skipped (187)`; `2` (both inside `drawGroupSeed`); the loop prints nothing.

- [ ] **Step 5: Full API suite**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1/apps/api
./node_modules/.bin/vitest run
```

Expected: `1129 passed | 10 skipped (1139)` (baseline 1,136 plus the 3 new tests; the former Aegis flake is gone).

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
git add apps/api/src/modules/aegis/aegis.service.ts apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
git commit -m "fix(aegis): never give two identity groups one full pseudonym"
```

---

### Task 5: GID – settle the stale platform-tool-bindings.json deletion

**Files:**
- Modify (commit the pending deletion of HEAD lines 405–509, 21 UI entries): `.glirastes/platform-tool-bindings.json`
- Test: `src/__tests__/lib/glirastes/execution-inventory-parity.test.ts` (existing, "has no unreviewed drift against the synchronized Platform bindings")

**Interfaces:** Consumes the committed parity lists `EXPECTED_LOCAL_ONLY_STABLE_KEYS` (line 16) and `PENDING_PLATFORM_ADOPTION` (lines 26–47). Produces none.

Decision (deviates from the suggested "restore to HEAD", by evidence): the uncommitted deletion removes exactly the 21 UI stable keys that the committed parity test (commit 8094b2a, "adopt the version 2 execution inventory") lists as local-only or pending adoption. The deletion predates that commit (file mtime 2026-07-30 11:56, commit 16:15), so the test was written against it. Restoring HEAD turns the GID suite red (measured 2026-10-04: 1 failed in the parity file) and would make the next `generate-bindings` hook adopt Platform UUIDs for the UI tools. Committing the deletion makes HEAD self-consistent; the file itself is removed in P11 (spec 5.3).

- [ ] **Step 1: Pin what the deletion contains**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
git branch --show-current
git diff --numstat -- .glirastes/platform-tool-bindings.json
git diff -- .glirastes/platform-tool-bindings.json | grep '^-.*"stableKey"' | sed -E 's/.*"stableKey": "([^"]+)".*/\1/'
```

Expected: `codex/glirastes-foundation-pilot`; `0	105	.glirastes/platform-tool-bindings.json`; exactly these 21 keys: `UI suggest_followups`, `UI ui.chatOverlay.open`, `UI ui.commandPalette.open`, `UI ui.dashboard.navigate`, `UI ui.dashboard.refreshStats`, `UI ui.dashboard.showDueThisWeek`, `UI ui.dashboard.showOverdueTasks`, `UI ui.groupCreateDialog.open`, `UI ui.groupDeleteDialog.open`, `UI ui.groupDetails.open`, `UI ui.groupEditDialog.open`, `UI ui.navigate`, `UI ui.savedView.apply`, `UI ui.settingsTab.open`, `UI ui.taskCreateDialog.open`, `UI ui.taskDeleteDialog.open`, `UI ui.taskDetails.open`, `UI ui.taskEditDialog.open`, `UI ui.taskFilters.apply`, `UI ui.taskView.switch`, `UI ui.templateCreateDialog.open`. Anything else: stop and report.

- [ ] **Step 2: Prove HEAD is RED and the pending state GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
B="$(mktemp -d)"
cp .glirastes/platform-tool-bindings.json "$B/pending.json"
git show HEAD:.glirastes/platform-tool-bindings.json > .glirastes/platform-tool-bindings.json
node scripts/run-vitest.mjs src/__tests__/lib/glirastes/execution-inventory-parity.test.ts
cp "$B/pending.json" .glirastes/platform-tool-bindings.json
node scripts/run-vitest.mjs src/__tests__/lib/glirastes/execution-inventory-parity.test.ts
git diff --numstat -- .glirastes/platform-tool-bindings.json
```

Expected: first run `1 failed | 5 passed` ("has no unreviewed drift against the synchronized Platform bindings"); second run `6 passed`; numstat again `0	105`.

- [ ] **Step 3: Commit the deletion**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
git add .glirastes/platform-tool-bindings.json
git commit -m "chore(glirastes): drop unadopted ui actions from platform bindings"
git status --short
```

Expected status: only `?? .glirastes/platform-connection.json` (Task 6).

---

### Task 6: GID – ignore the local platform connection descriptor

**Files:**
- Create: `src/__tests__/scripts/glirastes-local-state-ignored.test.ts`
- Modify: `.gitignore` (insert after line 46 `.glirastes/previous-setup-artifact.json`)
- Test: `src/__tests__/scripts/glirastes-local-state-ignored.test.ts`

**Interfaces:** Consumes `git check-ignore --no-index <path>` (exit 0 and the path on stdout when ignored). Produces none.

- [ ] **Step 1: Write the failing guard test**

Create `/Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot/src/__tests__/scripts/glirastes-local-state-ignored.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Machine-local Glirastes state. The connection descriptor carries the runner
 * key and the runtime state is per-instance; neither may ever be committed.
 */
const LOCAL_ONLY_GLIRASTES_FILES = [
  '.glirastes/platform-connection.json',
  '.glirastes/runtime-state.json',
] as const;

describe('Glirastes local state stays out of git', () => {
  it.each(LOCAL_ONLY_GLIRASTES_FILES)('ignores %s', async (path) => {
    await expect(execFileAsync('git', ['check-ignore', '--no-index', path]))
      .resolves.toMatchObject({ stdout: expect.stringContaining(path) });
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
node scripts/run-vitest.mjs src/__tests__/scripts/glirastes-local-state-ignored.test.ts
```

Expected: `1 failed | 1 passed` – "ignores .glirastes/platform-connection.json" rejects with `Command failed: git check-ignore --no-index .glirastes/platform-connection.json`.

- [ ] **Step 3: Minimal implementation**

In the pilot worktree's `.gitignore`, directly after `.glirastes/previous-setup-artifact.json` (line 46), insert:

```gitignore

# local Glirastes connection descriptor (carries the runner key)
.glirastes/platform-connection.json
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
node scripts/run-vitest.mjs src/__tests__/scripts/glirastes-local-state-ignored.test.ts
node scripts/run-vitest.mjs src/__tests__/lib/glirastes/runtime-cutover.test.ts
git status --short
```

Expected: `2 passed`; runtime-cutover green (it asserts `.gitignore` never lists `platform-tool-bindings.json`); status exactly ` M .gitignore` and `?? src/__tests__/scripts/glirastes-local-state-ignored.test.ts`, no longer `?? .glirastes/platform-connection.json`. Do not open the descriptor.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
git add .gitignore src/__tests__/scripts/glirastes-local-state-ignored.test.ts
git commit -m "chore(glirastes): ignore the local platform connection descriptor"
```

---

### Task 7: GID – explicit timeouts for the load-sensitive script tests

**Files:**
- Modify: `src/__tests__/scripts/prompt-size-baseline.test.ts:26` (the `describe` line)
- Modify: `src/__tests__/scripts/glirastes-connected-flow.test.ts:377` (closing line of "runs the real sync …")
- Test: the two files themselves

**Interfaces:** Consumes Vitest 4.0.18's per-test timeout argument `it(name, fn, timeoutMs)` and the suite option `describe(name, { timeout }, fn)`; both override `--testTimeout`. Produces none.

Both named tests run with the 5 s default and fail under full-suite load; the doctor and setup-dry-run tests already pass `30_000` (`glirastes-doctor.test.ts:118`, `glirastes-setup-dry-run.test.ts:114`). In `prompt-size-baseline.test.ts` six of the seven tests call the expensive `measurePromptBaseline()`: in a full-suite run on 2026-10-04 (11 cores, load average 35) "measures deterministically" took 5,082 ms and its siblings 2,314–3,984 ms, so a per-test value on only the named test would leave five siblings one load spike away from the same flake. That file therefore gets the explicit 30 s timeout on its `describe`, which covers the named test and its siblings; the connected-flow file gets it on the named test only (its siblings ran in 9–287 ms). `--testTimeout=1` makes the default deterministic RED, and the explicit value wins once present.

- [ ] **Step 1: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
node scripts/run-vitest.mjs src/__tests__/scripts/prompt-size-baseline.test.ts -t "measures deterministically" --testTimeout=1
node scripts/run-vitest.mjs src/__tests__/scripts/glirastes-connected-flow.test.ts -t "runs the real sync" --testTimeout=1
```

Expected: `Error: Test timed out in 1ms.` – `1 failed | 6 skipped` and `1 failed | 4 skipped`.

- [ ] **Step 2: Minimal implementation**

In the pilot worktree's `src/__tests__/scripts/prompt-size-baseline.test.ts` replace line 26

```ts
describe('Glirastes prompt size baseline', () => {
```

with

```ts
// Six tests below run the full prompt measurement (2-5 s each under suite load).
describe('Glirastes prompt size baseline', { timeout: 30_000 }, () => {
```

In the pilot worktree's `src/__tests__/scripts/glirastes-connected-flow.test.ts` replace

```ts
      await expect(artifactDigests(fixtureRoot)).resolves.toEqual(before);
    });
  });

  it('ingests signed updates only through runner-scoped activation', async () => {
```

with

```ts
      await expect(artifactDigests(fixtureRoot)).resolves.toEqual(before);
    });
  }, 30_000);

  it('ingests signed updates only through runner-scoped activation', async () => {
```

- [ ] **Step 3: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
node scripts/run-vitest.mjs src/__tests__/scripts/prompt-size-baseline.test.ts --testTimeout=1
node scripts/run-vitest.mjs src/__tests__/scripts/glirastes-connected-flow.test.ts -t "runs the real sync" --testTimeout=1
node scripts/run-vitest.mjs src/__tests__/scripts/prompt-size-baseline.test.ts src/__tests__/scripts/glirastes-connected-flow.test.ts
node_modules/.bin/tsc --noEmit; echo "tsc-exit=$?"
```

Expected: `7 passed (7)` (the whole file, so the suite timeout reaches every sibling); `1 passed | 4 skipped`; `12 passed` (7 + 5); `tsc-exit=0` (Vitest 4 types accept the `describe` options object).

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
git add src/__tests__/scripts/prompt-size-baseline.test.ts src/__tests__/scripts/glirastes-connected-flow.test.ts
git commit -m "test(glirastes): give load-sensitive script tests explicit timeouts"
```

---

### Task 8: GID – replace `next lint` with ESLint and a recorded debt baseline

**Files:**
- Create: `eslint.config.mjs` (byte-identical to `origin/master:eslint.config.mjs`, master @296e98e)
- Create: `eslint-suppressions.json` (generated by ESLint, never hand-edited)
- Modify: `package.json:17` (`"lint": "next lint"` → `"lint": "eslint ."`)
- Test: `bun run lint` plus the probe in Step 7

**Interfaces:** Consumes `eslint/config` (`defineConfig`, `globalIgnores`), `eslint-config-next/core-web-vitals`, `eslint-config-next/typescript` – all already installed (`eslint` 9.39.3, `eslint-config-next` 16.1.6, declared in `package.json` as `^9.18.0` / `^16.0.0`). Produces the `lint` script.

Next 16 removed `next lint`. Mirroring master's config reports 96 pre-existing errors in 54 files (61 `no-explicit-any`, 18 `react-hooks/set-state-in-effect`, …), so plain `eslint .` would be a permanently red gate. Master solves the same debt with ESLint bulk suppressions (`eslint-suppressions.json`, 91 entries); this task records the pilot's own baseline the same way. New violations still fail. Run this task after Tasks 6 and 7 so the baseline covers the final file set.

- [ ] **Step 1: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
bun run lint; echo "exit=$?"
```

Expected: `Invalid project directory provided, no such directory: /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot/lint`, `exit=1`.

- [ ] **Step 2: Confirm no dependency change is needed**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
grep '"version"' node_modules/eslint/package.json node_modules/eslint-config-next/package.json
grep -n '"eslint"\|"eslint-config-next"' package.json
```

Expected: `9.39.3` and `16.1.6`; both declared in `devDependencies`. No `bun add`, no `bun.lock` change.

- [ ] **Step 3: Create `/Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot/eslint.config.mjs`**

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  { files: ["**/*.cjs", "server.ts"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  globalIgnores([
    ".agents/**", ".claude/**", ".harness/**", ".next/**", "out/**", "build/**",
    "next-env.d.ts", "src/generated/**",
  ]),
]);
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
diff <(git show origin/master:eslint.config.mjs) eslint.config.mjs && echo identical
```

Expected: `identical`.

- [ ] **Step 4: Set the lint script**

In the pilot worktree's `package.json` (line 17) replace `    "lint": "next lint",` with `    "lint": "eslint .",`. (Master uses `eslint . --prune-suppressions`, which rewrites the suppressions file on every lint run; the pilot keeps the read-only `eslint .` so a lint run never edits tracked files. ESLint 9.39.3 then exits 2 with "There are suppressions left that do not occur anymore. Consider re-running the command with `--prune-suppressions`." once a suppressed violation is fixed and not yet pruned, which is the intended ratchet; measured 2026-10-04.)

- [ ] **Step 5: Lint now runs and shows the debt**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
L="$(mktemp)"; bun run lint > "$L" 2>&1; echo "exit=$?"; tail -3 "$L"
```

Expected: `exit=1`; `✖ 214 problems (96 errors, 118 warnings)` (measured 2026-10-04 with Tasks 6–7 applied; the new guard test adds no finding).

- [ ] **Step 6: Record the baseline and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
./node_modules/.bin/eslint . --suppress-all > /dev/null 2>&1; echo "suppress-exit=$?"
node -e 'const j=require("./eslint-suppressions.json");let n=0;for(const f in j)for(const r in j[f])n+=j[f][r].count;console.log(Object.keys(j).length,"files",n,"suppressed")'
L="$(mktemp)"; bun run lint > "$L" 2>&1; echo "exit=$?"; tail -3 "$L"
```

Expected: `suppress-exit=0`; `54 files 96 suppressed`; `exit=0` and `✖ 118 problems (0 errors, 118 warnings)` (warnings do not fail the gate).

- [ ] **Step 7: Prove a new violation still fails (Review Focus 4)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
# (a) a violation in a new file
printf 'export const lintProbe = (value: any) => value;\n' > src/lib/lint-probe.ts
./node_modules/.bin/eslint src/lib/lint-probe.ts; echo "new-file-exit=$?"
rm src/lib/lint-probe.ts
# (b) one more occurrence of a suppressed rule in a suppressed file (baseline: 1 x no-explicit-any)
F=src/app/api/users/route.ts
git diff --quiet -- "$F" && node -e 'console.log(require("./eslint-suppressions.json")[process.argv[1]]["@typescript-eslint/no-explicit-any"].count)' "$F"
printf '\nexport const lintProbe = (value: any) => value;\n' >> "$F"
./node_modules/.bin/eslint "$F"; echo "suppressed-file-exit=$?"
git checkout -- "$F"
git status --short
```

Expected: (a) `1:34  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any`, `new-file-exit=1`; (b) `1` (clean file, one suppressed `any`), then both `any` occurrences reported as errors (`✖ 2 problems (2 errors, 0 warnings)`) and `suppressed-file-exit=1`, because the count exceeds the recorded one; status shows exactly ` M package.json`, `?? eslint-suppressions.json`, `?? eslint.config.mjs` (no probe file, `route.ts` restored).

- [ ] **Step 8: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
git add eslint.config.mjs eslint-suppressions.json package.json
git commit -m "build(lint): replace next lint with eslint and a debt baseline"
```

To pay the debt down later: fix violations, then run `./node_modules/.bin/eslint . --prune-suppressions` and commit the shrunken file (never `--suppress-all` again without review).

---

### Task 9: SDK – treat zombie process groups as stopped in the reference cleanup

**Files:**
- Modify: `tests/source-driven-browser.test.mjs:15-17` (helper head), `:33` and `:45` (`t.after` hooks), `:48` (`assert.throws`); insert three tests before line 30
- Test: `tests/source-driven-browser.test.mjs` (`node:test`, not part of `bun run test`)

**Interfaces (file-local JavaScript):**
- Produces: `processGroupAlive(pid: number, kill?: (pid: number, signal: string | number) => unknown): boolean`; `killProcessGroupQuietly(pid: number): void`; `stopProcessGroup(child: { pid: number }, graceMs?: number, kill?: (pid: number, signal: string | number) => unknown): Promise<void>` (the third parameter is new and defaults to `process.kill`).

On macOS `process.kill(-pgid, 0)` throws `EPERM` while every member of the group is a zombie awaiting reaping; `alive()` currently rethrows everything except `ESRCH`, so cleanup fails intermittently. The tests inject `kill` and use `UNREAL_PID = 2 ** 30` (above every Linux/macOS `pid_max`), so the RED run can only ever reach `ESRCH` on the real system and never signals a foreign group.

- [ ] **Step 1: Write the failing tests**

Insert directly before `test('reference cleanup escalates when its own child ignores SIGTERM', …` (line 30):

```js
const UNREAL_PID = 2 ** 30; // above every Linux/macOS pid_max: real kill() can only answer ESRCH
const killError = (code) => Object.assign(new Error(`kill ${code}`), { code, syscall: 'kill' });

test('reference cleanup treats a zombie-only process group (EPERM on macOS) as stopped', { timeout: 10_000 }, async () => {
  const sent = [];
  const zombieGroup = (pid, signal) => { sent.push([pid, signal]); throw killError('EPERM'); };
  await stopProcessGroup({ pid: UNREAL_PID }, 30, zombieGroup);
  assert.deepEqual(sent, [[-UNREAL_PID, 0]]);
});

test('reference cleanup stops waiting once the group becomes zombies after SIGTERM', { timeout: 10_000 }, async () => {
  const sent = [];
  let terminated = false;
  const exitsOnTerm = (pid, signal) => {
    sent.push(signal);
    if (signal === 'SIGTERM') { terminated = true; return true; }
    if (terminated) throw killError('EPERM');
    return true;
  };
  await stopProcessGroup({ pid: UNREAL_PID }, 1_000, exitsOnTerm);
  assert.deepEqual(sent.slice(0, 2), [0, 'SIGTERM']);
  assert.equal(sent.includes('SIGKILL'), false);
});

test('reference cleanup still surfaces unexpected kill errors', { timeout: 10_000 }, async () => {
  const broken = () => { throw killError('EINVAL'); };
  await assert.rejects(stopProcessGroup({ pid: UNREAL_PID }, 30, broken), { code: 'EINVAL' });
});

```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
node --test --test-name-pattern "reference cleanup" tests/source-driven-browser.test.mjs
```

Expected: `# pass 2`, `# fail 3` – the three new tests fail with `ERR_ASSERTION` (the helper ignores the injected `kill`); the two existing cleanup tests pass; the Playwright test is filtered out.

- [ ] **Step 3: Minimal implementation**

Replace lines 15–17:

```js
async function stopProcessGroup(child, graceMs = 3_000) {
  const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const signal = (name) => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
```

with:

```js
// macOS answers kill(-pgid) with EPERM instead of ESRCH while every member of
// the group is a zombie awaiting reaping. These groups are always our own
// detached children (same uid, no setuid), so EPERM can only mean "gone".
const GROUP_GONE = new Set(['ESRCH', 'EPERM']);
const systemKill = (pid, signal) => process.kill(pid, signal);

function processGroupAlive(pid, kill = systemKill) {
  try { kill(-pid, 0); return true; } catch (error) { if (GROUP_GONE.has(error.code)) return false; throw error; }
}

function killProcessGroupQuietly(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (!GROUP_GONE.has(error.code)) throw error; }
}

async function stopProcessGroup(child, graceMs = 3_000, kill = systemKill) {
  const alive = () => processGroupAlive(child.pid, kill);
  const signal = (name) => { try { kill(-child.pid, name); } catch (error) { if (!GROUP_GONE.has(error.code)) throw error; } };
```

Replace both occurrences (former lines 33 and 45) of

```js
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
```

with

```js
  t.after(() => killProcessGroupQuietly(child.pid));
```

Replace (former line 48)

```js
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
```

with

```js
  assert.equal(processGroupAlive(child.pid), false);
```

- [ ] **Step 4: Run and see GREEN, repeatedly**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
node --test --test-name-pattern "reference cleanup" tests/source-driven-browser.test.mjs
for i in $(seq 1 10); do node --test --test-name-pattern "reference cleanup" tests/source-driven-browser.test.mjs 2>&1 | grep -E "^# fail"; done | sort | uniq -c
```

Expected: `# pass 5`, `# fail 0`; the loop prints `10 # fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add tests/source-driven-browser.test.mjs
git commit -m "test(integration): treat zombie process groups as stopped on macos"
```

---

### Task 10: SDK – add the test-file typecheck gate

**Files:**
- Create: `tsconfig.test.json`
- Modify: `package.json:276` (scripts), `CLAUDE.md:54-55` (commands)
- Test: `bun run typecheck:tests`

**Interfaces:** Consumes `tsconfig.json` (NodeNext, strict, `rootDir: "src"`, excludes tests). Produces the script `"typecheck:tests": "tsc -p tsconfig.test.json"`.

`rootDir: "."` is required: with the base `rootDir: "src"`, including `tests/` fails with TS6059. The base exclude of `src/cli/deferred-full.ts` is kept.

- [ ] **Step 1: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests; echo "exit=$?"
```

Expected: `error: Script not found "typecheck:tests"`, non-zero exit.

- [ ] **Step 2: Create `tsconfig.test.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "tests"],
  "exclude": ["src/cli/deferred-full.ts"]
}
```

- [ ] **Step 3: Add the script and document it**

In `package.json` replace `    "typecheck": "tsc --noEmit",` with:

```json
    "typecheck": "tsc --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json",
```

In `CLAUDE.md` replace

```bash
# Typecheck
bun run typecheck
```

with

```bash
# Typecheck
bun run typecheck

# Typecheck test files (glirastes/* self-imports resolve via dist: build first)
bun run typecheck:tests
```

- [ ] **Step 4: Run and record the 92-error baseline**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
test -f dist/react/index.d.ts && test -f dist/codegen/index.d.ts || bun run build
bun run typecheck:tests 2>&1 | grep -c "error TS"
bun run typecheck:tests 2>&1 | grep "error TS" | sed -E 's/\(.*//' | sort -u | wc -l
bun run typecheck:tests 2>&1 | grep "error TS" | grep -oE "^(src/[a-z]+|tests)/" | sort | uniq -c
bun run typecheck; echo "main-exit=$?"
```

Expected: `92`; `32` files; per area `23 src/cli/`, `1 src/contracts/`, `15 src/react/`, `12 src/runtime/`, `24 src/server/`, `11 src/sync/`, `6 tests/`; `main-exit=0`.

- [ ] **Step 5: Commit (the new gate stays red until Task 16)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add tsconfig.test.json package.json CLAUDE.md
git commit -m "build(test): add a typecheck gate for test files"
```

---

### Task 11: SDK – fix test type errors in src/cli (23)

**Files:**
- Modify: `src/cli/commands/install-skills.test.ts:284`, `src/cli/commands/setup-profile.test.ts:134-160`, `src/cli/commands/sync.test.ts:1-10,143,156,369`, `src/cli/setup.test.ts:9,19,236-239,396`, `src/cli/utils/commit-parser.test.ts:3`, `src/cli/validate-build.test.ts:234-238`
- Test: `bun run typecheck:tests` (scoped grep) and the six Vitest files

**Interfaces:**
- Consumes: `AppSetupArtifact` (`src/contracts/index.ts`); `RenderedManifests { runtimeContent: string; promptContent: string; runtimeDigest: string; promptDigest: string }` (`src/cli/commands/validate-build.ts:175`); `SyncCommandDependencies.currentManifestDigests?: typeof renderCurrentSetupManifests`; `InstallSkillsOptions` (no `stack` key; `parts?: ReadonlyArray<InstallerPart>`); `FoundationDiagnosticError`.
- Produces: none.

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS2322/TS2345 (14) | `sync.test.ts:161,177,178,188,237,255,283,299,310,324,342,366,378,402` | `vi.fn(async (value: typeof artifact) …)` narrows to the `as const` literal; type the parameter `AppSetupArtifact`. The manifest mocks must return the full `RenderedManifests` (`runtimeContent: ''`, `promptContent: ''`). |
| TS2558 (5) | `setup-profile.test.ts:135,150,160`, `setup.test.ts:236`, `validate-build.test.ts:234` | Vitest 4's `toMatchObject` takes no type argument; keep the type check with `{ … } satisfies Partial<FoundationDiagnosticError>`. |
| TS2322 (1) | `setup.test.ts:349` | Fixture typed `Record<string, unknown>`; declare `{ appId: string; runId: string } & Record<string, unknown>`. |
| TS7006 (1) | `setup.test.ts:396` | Annotate `syncArtifact: async (value: AppSetupArtifact)`. |
| TS2353 (1) | `install-skills.test.ts:284` | `stack` was removed from `InstallSkillsOptions` and was already ignored at runtime; delete the key. |
| TS2835 (1) | `commit-parser.test.ts:3` | NodeNext needs `.js` on relative imports. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/cli/"
```

Expected: `23`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git apply <<'PATCH'
--- a/src/cli/commands/install-skills.test.ts
+++ b/src/cli/commands/install-skills.test.ts
@@ -281,7 +281,6 @@
       await installSkills({
         rootDir,
         host: 'claude',
-        stack: 'all',
         dryRun: true,
       });
     } finally {
--- a/src/cli/commands/setup-profile.test.ts
+++ b/src/cli/commands/setup-profile.test.ts
@@ -131,9 +131,10 @@
   it('fails closed when local artifacts disagree on app identity', async () => {
     const rootDir = await fixture({ promptAppId: id('9') });
 
-    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject<
-      Partial<FoundationDiagnosticError>
-    >({ code: 'E-SCOPE-002', operation: 'setup.profile' });
+    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject({
+      code: 'E-SCOPE-002',
+      operation: 'setup.profile',
+    } satisfies Partial<FoundationDiagnosticError>);
   });
 
   it('fails closed when two undeclared setup candidates are present', async () => {
@@ -146,9 +147,10 @@
       'utf8',
     );
 
-    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject<
-      Partial<FoundationDiagnosticError>
-    >({ code: 'E-SETUP-004', operation: 'setup.profile' });
+    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject({
+      code: 'E-SETUP-004',
+      operation: 'setup.profile',
+    } satisfies Partial<FoundationDiagnosticError>);
   });
 
   it('rejects configured paths outside the workspace', async () => {
@@ -156,9 +158,10 @@
       glirastes: { setupArtifact: '../outside.json' },
     });
 
-    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject<
-      Partial<FoundationDiagnosticError>
-    >({ code: 'E-SETUP-003', operation: 'setup.profile' });
+    await expect(detectSetupProfile({ rootDir })).rejects.toMatchObject({
+      code: 'E-SETUP-003',
+      operation: 'setup.profile',
+    } satisfies Partial<FoundationDiagnosticError>);
   });
 
   it('never returns credential values', async () => {
--- a/src/cli/commands/sync.test.ts
+++ b/src/cli/commands/sync.test.ts
@@ -3,6 +3,7 @@
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, it, vi } from 'vitest';
+import type { AppSetupArtifact } from '../../contracts/index.js';
 import { runCli } from '../index.js';
 import type { SetupPlan } from './setup-plan.js';
 import {
@@ -140,7 +141,7 @@
     artifactDigest,
     updatedAt: '2026-08-14T10:00:00.000Z',
   });
-  const syncArtifact = vi.fn(async (value: typeof artifact) => {
+  const syncArtifact = vi.fn(async (value: AppSetupArtifact) => {
     await createRun({
       runId: value.runId,
       assessmentMode: value.assessmentMode,
@@ -154,6 +155,8 @@
       env: {},
       createPlan: vi.fn().mockResolvedValue(plan()),
       currentManifestDigests: vi.fn().mockResolvedValue({
+        runtimeContent: '',
+        promptContent: '',
         runtimeDigest: digest('R'),
         promptDigest: digest('S'),
       }),
@@ -369,6 +372,8 @@
           replacementRaw,
         );
         return {
+          runtimeContent: '',
+          promptContent: '',
           runtimeDigest: digest('R'),
           promptDigest: digest('S'),
         };
--- a/src/cli/setup.test.ts
+++ b/src/cli/setup.test.ts
@@ -6,6 +6,7 @@
   createRouteSourceFingerprint,
   discoverFoundationExecutions,
 } from '../codegen/index.js';
+import type { AppSetupArtifact } from '../contracts/index.js';
 import { FoundationDiagnosticError } from '../diagnostics/foundation-diagnostic.js';
 import { runCli } from './index.js';
 
@@ -16,7 +17,7 @@
 
 async function setupFixture(): Promise<{
   root: string;
-  artifact: Record<string, unknown>;
+  artifact: { appId: string; runId: string } & Record<string, unknown>;
 }> {
   const root = await mkdtemp(join(tmpdir(), 'glirastes-cli-setup-'));
   const source =
@@ -233,10 +234,10 @@
 
     await expect(runCli([
       'setup', 'status', '--run-id', id('9'), '--quiet',
-    ])).rejects.toMatchObject<Partial<FoundationDiagnosticError>>({
+    ])).rejects.toMatchObject({
       code: 'E-SCOPE-001',
       operation: 'setup.connection',
-    });
+    } satisfies Partial<FoundationDiagnosticError>);
   });
 
   it('scans the positive inventory locally without network access', async () => {
@@ -393,7 +394,7 @@
         env: {},
         isGitIgnored: vi.fn().mockResolvedValue(true),
         clientFactory: vi.fn(() => ({
-          syncArtifact: async (value) => {
+          syncArtifact: async (value: AppSetupArtifact) => {
             await createRun({
               runId: value.runId,
               assessmentMode: value.assessmentMode,
--- a/src/cli/utils/commit-parser.test.ts
+++ b/src/cli/utils/commit-parser.test.ts
@@ -1,6 +1,6 @@
 // packages/cli/src/utils/commit-parser.test.ts
 import { describe, it, expect } from 'vitest';
-import { parseCommits, type ParsedCommit } from './commit-parser';
+import { parseCommits, type ParsedCommit } from './commit-parser.js';
 
 describe('parseCommits', () => {
   it('should parse conventional commits', () => {
--- a/src/cli/validate-build.test.ts
+++ b/src/cli/validate-build.test.ts
@@ -231,11 +231,11 @@
 
     await expect(runCli([
       'validate', '--root', root, '--app-id', APP_ID, '--quiet',
-    ])).rejects.toMatchObject<Partial<FoundationDiagnosticError>>({
+    ])).rejects.toMatchObject({
       code: 'E-INVENTORY-001',
       operation: 'validate.inventory',
       identifier: 'Tasks List!',
-    });
+    } satisfies Partial<FoundationDiagnosticError>);
   });
 
   it('rejects a schema-invalid inventory', async () => {
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/cli/"
bun run typecheck:tests 2>&1 | grep -c "error TS"
bunx vitest run src/cli/commands/install-skills.test.ts src/cli/commands/setup-profile.test.ts src/cli/commands/sync.test.ts src/cli/setup.test.ts src/cli/utils/commit-parser.test.ts src/cli/validate-build.test.ts
```

Expected: `0`; total `69`; `Test Files 6 passed (6)`, `Tests 69 passed (69)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add src/cli/commands/install-skills.test.ts src/cli/commands/setup-profile.test.ts src/cli/commands/sync.test.ts src/cli/setup.test.ts src/cli/utils/commit-parser.test.ts src/cli/validate-build.test.ts
git commit -m "test(cli): fix test type errors under the test typecheck"
```

---

### Task 12: SDK – fix test type errors in src/server (24)

**Files:**
- Modify: `src/server/pipeline.test.ts:5-33,42-45,202`, `src/server/core/__tests__/output-schema-validation.test.ts:4,49-56,145-158`, `src/server/lancer/__tests__/cache.test.ts:2`, `src/server/lancer/__tests__/client.test.ts:2-4`, `src/server/lancer/__tests__/contract-compatibility.spec.ts:2-3`, `src/server/lancer/__tests__/telemetry-buffer.test.ts:2-3`
- Test: scoped typecheck and the six Vitest files

**Interfaces:**
- Consumes: `ModuleDefinition` (`src/types.ts:622`, `classification?: { hint: string; examples: string[] }`); `ToolContext { currentDate: Date; locale: string; runtime?: RuntimeContext }`; `Lancer { primus; warden; aegis; config; telemetry; approvals?; destroy() }` (no `gate`); `ConfigNamespace.reportModels(models: Record<string, string>): Promise<void>`; `DegradationDefaults` keys `warden | primus | aegis | proctor | config | approvals`; `EndpointToolContext extends ToolContext { callEndpoint: InternalApiCaller }` (`src/server/core/index.ts:83`).
- Produces: none.

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS2322 (11) | `pipeline.test.ts:70,85,102,116,126,137,147,166,181,200,217` | Type `testModule: ModuleDefinition` and add the required `classification.hint`. |
| TS2353 (2) | `pipeline.test.ts:12` (`user`), `:202` (`gate`) | `ToolContext` has no `user`; `DegradationDefaults` has no `gate` → use `proctor: 'silent'`. |
| TS2741 (1) | `pipeline.test.ts:43` | Mock `config.reportModels`. Fixing it surfaces a masked TS2353: the mock's `gate` namespace is not part of `Lancer` – delete it (the patch does both). |
| TS2322 (1) | `output-schema-validation.test.ts:49` | The payload deliberately violates the schema; cast it `as unknown as { tasks: Array<{ id: string; creatorId: string }> }` with a comment. |
| TS2353 (1) | `output-schema-validation.test.ts:148` | Build the context as `EndpointToolContext`, then pass it. |
| TS2835 (8) | `lancer/__tests__/*` | Add `.js` to relative imports. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/server/"
```

Expected: `24`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git apply <<'PATCH'
--- a/src/server/pipeline.test.ts
+++ b/src/server/pipeline.test.ts
@@ -2,33 +2,30 @@
 import { createAiPipeline } from './pipeline.js';
 import { ServiceBlockedError } from './lancer/index.js';
 import type { Lancer } from './lancer/index.js';
-import type { ToolContext } from '../types.js';
+import type { ModuleDefinition, ToolContext } from '../types.js';
 
 // ---------------------------------------------------------------------------
 // Helpers
 // ---------------------------------------------------------------------------
 
 const mockContext: ToolContext = {
-  user: { userId: 'u1', roles: ['user'] },
   currentDate: new Date('2024-01-01'),
   locale: 'en',
 };
 
-const testModule = {
+const testModule: ModuleDefinition = {
   id: 'test-module',
   name: 'Test',
   description: 'Test module for managing tasks and to-do items',
   tools: ['tool1', 'tool2'],
   classification: {
+    hint: 'Task management',
     examples: ['create a new task', 'add a to-do item', 'manage my tasks'],
   },
 };
 
 function makeMockLancer(overrides: Partial<Lancer> = {}): Lancer {
   return {
-    gate: {
-      filter: vi.fn().mockResolvedValue({ allowed: [], denied: [] }),
-    },
     primus: {
       classify: vi.fn().mockResolvedValue({ moduleId: 'test-module', confidence: 0.9, modelTier: 'standard' }),
     },
@@ -42,6 +39,7 @@
     },
     config: {
       fetch: vi.fn().mockResolvedValue({ modules: {} }),
+      reportModels: vi.fn().mockResolvedValue(undefined),
     },
     telemetry: {
       emit: vi.fn(),
@@ -199,7 +197,7 @@
         createAiPipeline({
           modules: [testModule],
           lancer,
-          degradation: { warden: 'block', primus: 'fallback', gate: 'silent' },
+          degradation: { warden: 'block', primus: 'fallback', proctor: 'silent' },
           onServiceUnavailable: vi.fn().mockResolvedValue('fallback'),
         }),
       ).not.toThrow();
--- a/src/server/core/__tests__/output-schema-validation.test.ts
+++ b/src/server/core/__tests__/output-schema-validation.test.ts
@@ -1,7 +1,11 @@
 import { describe, expect, it, vi } from 'vitest';
 import { z } from 'zod';
 import { defineEndpointTool, defineTool } from '../../../types.js';
-import { endpointToolToTool, toolToAiTool } from '../index.js';
+import {
+  endpointToolToTool,
+  toolToAiTool,
+  type EndpointToolContext,
+} from '../index.js';
 
 describe('tool output schema validation', () => {
   it('validates the declared payload without rejecting transport metadata', async () => {
@@ -46,6 +50,7 @@
           creatorId: z.string(),
         }).strict()),
       }).strict(),
+      // Deliberately violates the declared output schema.
       execute: async () => ({
         success: true as const,
         tasks: [{
@@ -53,7 +58,7 @@
           title: 'Pilot pruefen',
           rank: 0.75,
         }],
-      }),
+      }) as unknown as { tasks: Array<{ id: string; creatorId: string }> },
     });
     const aiTool = toolToAiTool(tool, {
       currentDate: new Date('2026-08-15T10:00:00.000Z'),
@@ -142,7 +147,7 @@
       inputSchema: z.object({ title: z.string() }).strict(),
       outputSchema: z.object({ taskId: z.string() }).strict(),
     });
-    const aiTool = toolToAiTool(endpointToolToTool(definition), {
+    const context: EndpointToolContext = {
       currentDate: new Date('2026-08-15T10:00:00.000Z'),
       locale: 'de-DE',
       callEndpoint: async () => ({
@@ -155,7 +160,8 @@
           privateField: { policyTrace: 'must-not-reach-model' },
         },
       }),
-    });
+    };
+    const aiTool = toolToAiTool(endpointToolToTool(definition), context);
 
     const result = await aiTool.execute({ title: 'Pilot pruefen' });
 
--- a/src/server/lancer/__tests__/cache.test.ts
+++ b/src/server/lancer/__tests__/cache.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
-import { Cache } from '../cache';
+import { Cache } from '../cache.js';
 
 describe('Cache', () => {
   beforeEach(() => {
--- a/src/server/lancer/__tests__/client.test.ts
+++ b/src/server/lancer/__tests__/client.test.ts
@@ -1,7 +1,7 @@
 import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
-import { createLancer } from '../client';
-import { ServiceBlockedError } from '../errors';
-import type { Lancer } from '../types';
+import { createLancer } from '../client.js';
+import { ServiceBlockedError } from '../errors.js';
+import type { Lancer } from '../types.js';
 
 describe('createLancer', () => {
   let fetchMock: ReturnType<typeof vi.fn>;
--- a/src/server/lancer/__tests__/contract-compatibility.spec.ts
+++ b/src/server/lancer/__tests__/contract-compatibility.spec.ts
@@ -1,6 +1,6 @@
 import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
-import { createLancer } from '../client';
-import type { Lancer } from '../types';
+import { createLancer } from '../client.js';
+import type { Lancer } from '../types.js';
 
 /**
  * Contract-compatibility tests
--- a/src/server/lancer/__tests__/telemetry-buffer.test.ts
+++ b/src/server/lancer/__tests__/telemetry-buffer.test.ts
@@ -1,6 +1,6 @@
 import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
-import { TelemetryBuffer } from '../telemetry-buffer';
-import type { TelemetryEvent } from '../types';
+import { TelemetryBuffer } from '../telemetry-buffer.js';
+import type { TelemetryEvent } from '../types.js';
 
 function makeEvent(n = 0): TelemetryEvent {
   return { eventType: `test.event.${n}` };
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/server/"
bun run typecheck:tests 2>&1 | grep -c "error TS"
bunx vitest run src/server/pipeline.test.ts src/server/core/__tests__/output-schema-validation.test.ts src/server/lancer
```

Expected: `0`; total `45`; `Test Files 6 passed (6)`, `Tests 54 passed (54)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add src/server/pipeline.test.ts src/server/core/__tests__/output-schema-validation.test.ts src/server/lancer/__tests__/cache.test.ts src/server/lancer/__tests__/client.test.ts src/server/lancer/__tests__/contract-compatibility.spec.ts src/server/lancer/__tests__/telemetry-buffer.test.ts
git commit -m "test(server): fix test type errors under the test typecheck"
```

---

### Task 13: SDK – fix test type errors in src/sync and src/contracts (12)

**Files:**
- Modify: `src/sync/__tests__/app-setup-client.test.ts:44,205-207,254,288`, `src/sync/__tests__/control-plane-client.test.ts:16,101`, `src/sync/__tests__/runtime-setup-client.test.ts:159`, `src/contracts/__tests__/revisions.test.ts:69-70`
- Test: scoped typecheck and the four Vitest files

**Interfaces:**
- Consumes: `AppSetupClient`, `RuntimeControlPlaneClient`, `RuntimeSetupClient`, `ManifestRevisionSchema` (unchanged).
- Produces (test-local, one copy per file): `async function rejectionOf(promise: Promise<unknown>): Promise<Error>` – resolves to the rejection and fails the test if the promise resolves.

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS2339 (8) | `app-setup-client.test.ts:208-210,258-259,290-292` | `.catch((caught) => caught as Error)` yields `Error \| AppSetupRun`; use `rejectionOf(...)`, which also turns an unexpected success into a failure. |
| TS18046 (2) | `control-plane-client.test.ts:108,111` | Same helper. |
| TS2352 (1) | `runtime-setup-client.test.ts:157` | The test smuggles unknown fields on purpose; cast `as unknown as typeof scan`. |
| TS2790 (1) | `revisions.test.ts:70` | Do not `delete` a required property; build the historical tool by rest destructuring. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/(sync|contracts)/"
```

Expected: `12`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git apply <<'PATCH'
--- a/src/sync/__tests__/app-setup-client.test.ts
+++ b/src/sync/__tests__/app-setup-client.test.ts
@@ -41,6 +41,15 @@
   updatedAt: '2026-07-30T10:00:00.000Z',
 };
 
+async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
+  try {
+    await promise;
+  } catch (caught) {
+    return caught as Error;
+  }
+  throw new Error('expected the app setup request to reject');
+}
+
 describe('AppSetupClient', () => {
   it('creates an app-scoped run without transmitting an environment ID', async () => {
     const fetchImpl = vi.fn().mockResolvedValue(
@@ -202,9 +211,7 @@
       fetchImpl,
     });
 
-    const error = await client.getRun(artifact.runId).catch(
-      (caught: unknown) => caught as Error,
-    );
+    const error = await rejectionOf(client.getRun(artifact.runId));
     expect(error.message).toBe('Glirastes app setup request failed (403)');
     expect(error.message).not.toContain('setup-secret');
     expect(error.message).not.toContain('private business');
@@ -251,7 +258,7 @@
       });
 
       const pending = client.syncArtifact(artifact, { timeoutMs: 250 });
-      const outcome = pending.catch((caught: unknown) => caught as Error);
+      const outcome = rejectionOf(pending);
       await vi.advanceTimersByTimeAsync(250);
       const error = await outcome;
 
@@ -285,7 +292,7 @@
       timeoutMs: 5_000,
     });
     controller.abort('setup-secret private cancellation reason');
-    const error = await pending.catch((caught: unknown) => caught as Error);
+    const error = await rejectionOf(pending);
 
     expect(error.message).toBe('Glirastes app setup request cancelled');
     expect(error.message).not.toContain('setup-secret');
--- a/src/sync/__tests__/control-plane-client.test.ts
+++ b/src/sync/__tests__/control-plane-client.test.ts
@@ -13,6 +13,15 @@
   version: '1.0.0',
 };
 
+async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
+  try {
+    await promise;
+  } catch (caught) {
+    return caught as Error;
+  }
+  throw new Error('expected the control plane request to reject');
+}
+
 describe('RuntimeControlPlaneClient', () => {
   it('registers and polls using only the app-scoped credential header', async () => {
     const fetchImpl = vi.fn()
@@ -98,7 +107,7 @@
       manager: { apply: vi.fn() } as never,
     });
 
-    const error = await client.register().catch((caught) => caught);
+    const error = await rejectionOf(client.register());
 
     expect(error).toBeInstanceOf(RuntimeControlPlaneRequestError);
     expect(error).toMatchObject({
--- a/src/sync/__tests__/runtime-setup-client.test.ts
+++ b/src/sync/__tests__/runtime-setup-client.test.ts
@@ -156,7 +156,7 @@
         ...scan.candidates[0],
         rawSource: 'private source',
       }],
-    } as typeof scan);
+    } as unknown as typeof scan);
 
     const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
     const body = String(request.body);
--- a/src/contracts/__tests__/revisions.test.ts
+++ b/src/contracts/__tests__/revisions.test.ts
@@ -66,8 +66,8 @@
   });
 
   it('keeps presentation optional for historical signed revisions', () => {
-    const candidate = structuredClone(manifest);
-    delete candidate.tools[0]!.presentation;
+    const { presentation: _presentation, ...historicalTool } = manifest.tools[0]!;
+    const candidate = { ...manifest, tools: [historicalTool] };
     expect(ManifestRevisionSchema.safeParse(candidate).success).toBe(true);
   });
 
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/(sync|contracts)/"
bun run typecheck:tests 2>&1 | grep -c "error TS"
bunx vitest run src/sync/__tests__/app-setup-client.test.ts src/sync/__tests__/control-plane-client.test.ts src/sync/__tests__/runtime-setup-client.test.ts src/contracts/__tests__/revisions.test.ts
```

Expected: `0`; total `33`; `Test Files 4 passed (4)`, `Tests 33 passed (33)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add src/sync/__tests__/app-setup-client.test.ts src/sync/__tests__/control-plane-client.test.ts src/sync/__tests__/runtime-setup-client.test.ts src/contracts/__tests__/revisions.test.ts
git commit -m "test(sync): fix test type errors under the test typecheck"
```

---

### Task 14: SDK – fix test type errors in src/runtime (12)

**Files:**
- Modify: `src/runtime/__tests__/local-runtime-source.test.ts:119`, `src/runtime/__tests__/source-parity.test.ts:7,73,278-281,305`, `src/runtime/__tests__/standalone-network-silence.test.ts:91,148-150`, `src/runtime/__tests__/tool-discovery.test.ts:79`, `src/runtime/ai-sdk/__tests__/engine.test.ts:46`, `src/runtime/prompt-bundle-store.test.ts:6,94`
- Test: scoped typecheck and the six Vitest files

**Interfaces:**
- Consumes: `SchemaLike<T> { safeParse(value: unknown): { success: true; data: T } | { success: false; error: SchemaErrorLike } }` (`src/types.ts:27`); `ToolContext`; `ModuleDefinition` (requires `name`, `description`); `AiSdkToolSuccess extends AiSdkToolCall { result: unknown; durationMs: number }` (`src/runtime/ai-sdk/engine.ts:15`); `PromptArtifactRegistry { fetch(artifactRef: string): Promise<unknown> }`; `type Mock` from `vitest`.
- Produces: none.

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS2322 (4) | `local-runtime-source.test.ts:131,140`, `source-parity.test.ts:64`, `tool-discovery.test.ts:82` | `inputSchema: { type: 'object' }` is not a `SchemaLike`; use the accept-all `{ safeParse: (value: unknown) => ({ success: true as const, data: value }) }` (tool-discovery keeps its `secretSchema: true` marker beside it). |
| TS2353 (1) | `standalone-network-silence.test.ts:91` | Same accept-all schema. |
| TS2322 + TS2739 (2) | `source-parity.test.ts:301,305` | Module literals need `name` and `description`; type the array `ModuleDefinition[]`. |
| TS2353 (2) | `standalone-network-silence.test.ts:148,150` | Context needs `currentDate`/`locale` (no `user`); `afterToolCall` takes `{ …call, result, durationMs }`, not `output`. |
| TS7006 (1) | `engine.test.ts:46` | `execute: async (input: unknown)`. |
| TS2322 (2) | `prompt-bundle-store.test.ts:116,216` | Declare `registry: { fetch: Mock<(artifactRef: string) => Promise<unknown>> }`. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/runtime/"
```

Expected: `12`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git apply <<'PATCH'
--- a/src/runtime/__tests__/local-runtime-source.test.ts
+++ b/src/runtime/__tests__/local-runtime-source.test.ts
@@ -116,7 +116,7 @@
   const tool = (id: string, description: string) => ({
     id,
     description,
-    inputSchema: { type: 'object' },
+    inputSchema: { safeParse: (value: unknown) => ({ success: true as const, data: value }) },
     execute: async () => ({}),
   });
   return [
--- a/src/runtime/__tests__/source-parity.test.ts
+++ b/src/runtime/__tests__/source-parity.test.ts
@@ -5,6 +5,7 @@
   Principal,
 } from '../../contracts/index.js';
 import { assertModuleRegistryParity } from '../../server/testing/registry-parity.js';
+import type { ModuleDefinition } from '../../types.js';
 import { createEphemeralLocalSigner } from '../local-signer.js';
 import { createLocalRuntimeSource } from '../local-runtime-source.js';
 import {
@@ -70,7 +71,7 @@
       tool: {
         id: fact.name,
         description: fact.description,
-        inputSchema: { type: 'object' },
+        inputSchema: { safeParse: (value: unknown) => ({ success: true as const, data: value }) },
         execute: async () => ({}),
       },
     };
@@ -275,9 +276,9 @@
   });
 
   it('passes the shared module parity gate from both sources', () => {
-    const modules = [
-      { id: 'tasks', tools: ['tasks.listTasks'] },
-      { id: 'navigation', tools: ['ui_navigate'] },
+    const modules: ModuleDefinition[] = [
+      { id: 'tasks', name: 'Tasks', description: 'Task queries.', tools: ['tasks.listTasks'] },
+      { id: 'navigation', name: 'Navigation', description: 'App navigation.', tools: ['ui_navigate'] },
     ];
     const source = createLocalRuntimeSource({
       setupArtifact: fixtureArtifact(),
@@ -302,7 +303,7 @@
         servedToolNames: Object.keys(registry),
       })).not.toThrow();
       expect(() => assertModuleRegistryParity({
-        modules: [{ id: 'ghost', tools: ['tasks.retiredSnakeCase'] }],
+        modules: [{ id: 'ghost', name: 'Ghost', description: 'Retired module.', tools: ['tasks.retiredSnakeCase'] }],
         servedToolNames: Object.keys(registry),
       })).toThrow(/drift/i);
     }
--- a/src/runtime/__tests__/standalone-network-silence.test.ts
+++ b/src/runtime/__tests__/standalone-network-silence.test.ts
@@ -88,7 +88,7 @@
     tool: {
       id: 'tasks.listTasks',
       description: 'List the tasks the caller may see.',
-      inputSchema: { type: 'object' },
+      inputSchema: { safeParse: (value: unknown) => ({ success: true as const, data: value }) },
       execute: async () => ({ tasks: [] }),
     },
   }];
@@ -145,9 +145,9 @@
     await guard.beforeToolCall(call);
     const result = await registry.tasks_listTasks!.execute(
       {},
-      { user: { id: 'user-1', roles: ['member'] } },
+      { currentDate: new Date('2026-08-12T00:00:00.000Z'), locale: 'en' },
     );
-    await guard.afterToolCall({ ...call, output: result });
+    await guard.afterToolCall({ ...call, result, durationMs: 0 });
     await guard.afterModelStep({ inputTokens: 10, outputTokens: 10 });
 
     expect(result).toEqual({ tasks: [] });
--- a/src/runtime/__tests__/tool-discovery.test.ts
+++ b/src/runtime/__tests__/tool-discovery.test.ts
@@ -76,7 +76,10 @@
     .map((fact) => [fact.name.replaceAll('.', '_'), {
       id: fact.id,
       description: fact.description,
-      inputSchema: { secretSchema: true },
+      inputSchema: {
+        secretSchema: true,
+        safeParse: (value: unknown) => ({ success: true as const, data: value }),
+      },
       execute: async () => ({ secretResult: true }),
     }]));
   return { snapshot, registry };
--- a/src/runtime/ai-sdk/__tests__/engine.test.ts
+++ b/src/runtime/ai-sdk/__tests__/engine.test.ts
@@ -43,7 +43,7 @@
         list_tasks: {
           description: 'List tasks.',
           parameters: z.object({ status: z.string() }),
-          execute: async (input) => {
+          execute: async (input: unknown) => {
             calls.push(`execute:${JSON.stringify(input)}`);
             return { count: 2 };
           },
--- a/src/runtime/prompt-bundle-store.test.ts
+++ b/src/runtime/prompt-bundle-store.test.ts
@@ -3,7 +3,7 @@
   generateKeyPairSync,
   sign,
 } from 'node:crypto';
-import { beforeEach, describe, expect, it, vi } from 'vitest';
+import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
 import {
   canonicalPromptBundleJson,
   type PromptBundle,
@@ -91,7 +91,7 @@
 }
 
 describe('PromptBundleStore', () => {
-  let registry: { fetch: ReturnType<typeof vi.fn> };
+  let registry: { fetch: Mock<(artifactRef: string) => Promise<unknown>> };
   let store: PromptBundleStore;
   const artifacts = new Map<string, PromptBundle>();
 
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/runtime/"
bun run typecheck:tests 2>&1 | grep -c "error TS"
bunx vitest run src/runtime/__tests__/local-runtime-source.test.ts src/runtime/__tests__/source-parity.test.ts src/runtime/__tests__/standalone-network-silence.test.ts src/runtime/__tests__/tool-discovery.test.ts src/runtime/ai-sdk/__tests__/engine.test.ts src/runtime/prompt-bundle-store.test.ts
```

Expected: `0`; total `21`; `Test Files 6 passed (6)`, `Tests 39 passed (39)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add src/runtime/__tests__/local-runtime-source.test.ts src/runtime/__tests__/source-parity.test.ts src/runtime/__tests__/standalone-network-silence.test.ts src/runtime/__tests__/tool-discovery.test.ts src/runtime/ai-sdk/__tests__/engine.test.ts src/runtime/prompt-bundle-store.test.ts
git commit -m "test(runtime): fix test type errors under the test typecheck"
```

---

### Task 15: SDK – fix test type errors in src/react (15)

**Files:**
- Modify: `src/react/components/__tests__/chat-window.test.tsx:5`, `src/react/components/__tests__/floating-chat-ui.test.tsx:16,25,80`, `src/react/components/__tests__/message-bubble.test.tsx:6,14`, `src/react/components/__tests__/ui-components.test.tsx:99`, `src/react/components/__tests__/voice-window-lifecycle.test.tsx:56-57`, `src/react/hooks/__tests__/use-deepgram-transcription.test.tsx:18,41`, `src/react/hooks/__tests__/use-drag-resize-panel.test.tsx:8`
- Test: scoped typecheck and the seven Vitest files

**Interfaces:**
- Consumes: `ToolResultDisplayConfig { mode?: 'default' | 'hidden' | 'allowlist'; allowlist?: string[] }` (`src/react/types.ts:359`); `PendingApproval.messageId: string` (`src/react/types.ts:668`); `SessionSummary` (requires `title`); Testing Library `ByRoleOptions` (no `exact`; a string `name` already matches exactly).
- Produces: none.

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS2835 (3) + TS7006 (2) | `chat-window.test.tsx:5`, `use-deepgram-transcription.test.tsx:18`, `use-drag-resize-panel.test.tsx:8`; cascaded `chat-window.test.tsx:145,244` | Add `.js`; the unresolved `ChatWindow` import was the only cause of the two implicit-`any` callback parameters. |
| TS2769 (4) | `floating-chat-ui.test.tsx:16,80`, `voice-window-lifecycle.test.tsx:56,57` | Remove `exact: true` from `getByRole` (no behaviour change). |
| TS2322 (3) | `floating-chat-ui.test.tsx:26,29,30` | `create` must return a `SessionSummary` → add `title: 'Second chat'`. |
| TS2353 (1) | `message-bubble.test.tsx:75` | Hoisted literal inferred `{ mode: string }`; cast the initial value `as ToolResultDisplayConfig`. |
| TS2741 (1) | `ui-components.test.tsx:98` | Add `messageId: 'message-1'`. |
| TS2322 (1) | `use-deepgram-transcription.test.tsx:51` | Widen the initial prop: `getToken: (): string => 'first-token'`. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/react/"
```

Expected: `15`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git apply <<'PATCH'
--- a/src/react/components/__tests__/chat-window.test.tsx
+++ b/src/react/components/__tests__/chat-window.test.tsx
@@ -2,7 +2,7 @@
 import { useState } from 'react';
 import { cleanup, fireEvent, render, screen } from '@testing-library/react';
 import { afterEach, describe, expect, it, vi } from 'vitest';
-import { ChatWindow } from '../chat-window';
+import { ChatWindow } from '../chat-window.js';
 
 afterEach(cleanup);
 
--- a/src/react/components/__tests__/floating-chat-ui.test.tsx
+++ b/src/react/components/__tests__/floating-chat-ui.test.tsx
@@ -13,7 +13,7 @@
     native.focus();
     render(<VercelAiChat endpoint="/api/chat" keepMounted />);
     expect(document.activeElement).toBe(native);
-    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant', exact: true }));
+    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));
     expect(document.activeElement).toBe(screen.getByRole('textbox'));
     fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
     native.focus();
@@ -22,7 +22,7 @@
   });
 
   it('dismisses the session menu when the window collapses', async () => {
-    const sessions = { defaultActiveId: 'one', load: async () => [], list: async () => [{ id: 'one', title: 'First chat' }], create: async () => ({ id: 'two' }), remove: async () => {} };
+    const sessions = { defaultActiveId: 'one', load: async () => [], list: async () => [{ id: 'one', title: 'First chat' }], create: async () => ({ id: 'two', title: 'Second chat' }), remove: async () => {} };
     const { rerender } = render(<VercelAiChat endpoint="/api/chat" sessions={sessions} open mode="sidebar" keepMounted />);
     fireEvent.click(await screen.findByRole('button', { name: 'First chat' }));
     expect(screen.getByRole('listbox')).toBeTruthy();
@@ -77,7 +77,7 @@
     fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
     expect(input.isConnected).toBe(true);
     expect(screen.queryByRole('textbox')).toBeNull();
-    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant', exact: true }));
+    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));
     expect(screen.getByRole('textbox')).toBe(input);
     expect(input.value).toBe('Not submitted');
   });
--- a/src/react/components/__tests__/message-bubble.test.tsx
+++ b/src/react/components/__tests__/message-bubble.test.tsx
@@ -4,6 +4,7 @@
 import { cleanup, render, screen } from '@testing-library/react';
 import { afterEach, describe, expect, it, vi } from 'vitest';
 import { MessageBubble } from '../message-bubble.js';
+import type { ToolResultDisplayConfig } from '../../types.js';
 
 const chatContext = vi.hoisted(() => ({
   current: {
@@ -11,7 +12,7 @@
     components: {
       Markdown: ({ content }: { content: string }) => <div>{content}</div>,
     },
-    toolResults: { mode: 'default' },
+    toolResults: { mode: 'default' } as ToolResultDisplayConfig,
   },
 }));
 
--- a/src/react/components/__tests__/ui-components.test.tsx
+++ b/src/react/components/__tests__/ui-components.test.tsx
@@ -97,6 +97,7 @@
       <ApprovalCard
         approval={{
           id: 'approval-1',
+          messageId: 'message-1',
           toolName: 'tasks.update',
           description: 'Aufgabe aktualisieren',
           details: ['Titel: Quartalsbericht', 'Hohe Auswirkung'],
--- a/src/react/components/__tests__/voice-window-lifecycle.test.tsx
+++ b/src/react/components/__tests__/voice-window-lifecycle.test.tsx
@@ -53,8 +53,8 @@
     fireEvent.click(screen.getByRole('button', { name: 'mic' }));
     await waitFor(() => expect(document.querySelector('[data-component="voice-input-addon"]')?.getAttribute('data-state')).toBe('recording'));
     // Stop and hiding can race; only one final draft insertion is allowed.
-    fireEvent.click(screen.getByRole('button', { name: 'stop', exact: true }));
-    fireEvent.click(screen.getByRole('button', { name: 'stop', exact: true }));
+    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
+    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
     rerender(view(action !== 'close', action === 'collapse'));
     await act(async () => { release(); });
     await waitFor(() => expect(stopTrack).toHaveBeenCalled());
--- a/src/react/hooks/__tests__/use-deepgram-transcription.test.tsx
+++ b/src/react/hooks/__tests__/use-deepgram-transcription.test.tsx
@@ -15,7 +15,7 @@
   },
 }));
 
-import { useDeepgramTranscription } from '../use-deepgram-transcription';
+import { useDeepgramTranscription } from '../use-deepgram-transcription.js';
 
 afterEach(() => {
   adapterConnect.mockClear();
@@ -38,7 +38,7 @@
       ({ getToken }) => useDeepgramTranscription({ getToken }),
       {
         initialProps: {
-          getToken: () => 'first-token',
+          getToken: (): string => 'first-token',
         },
       },
     );
--- a/src/react/hooks/__tests__/use-drag-resize-panel.test.tsx
+++ b/src/react/hooks/__tests__/use-drag-resize-panel.test.tsx
@@ -5,7 +5,7 @@
 import {
   useDragResizePanel,
   type UseDragResizePanelOptions,
-} from '../use-drag-resize-panel';
+} from '../use-drag-resize-panel.js';
 
 function createOptions(): UseDragResizePanelOptions {
   const panel = document.createElement('section');
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^src/react/"
bun run typecheck:tests 2>&1 | grep -c "error TS"
bunx vitest run src/react/components/__tests__/chat-window.test.tsx src/react/components/__tests__/floating-chat-ui.test.tsx src/react/components/__tests__/message-bubble.test.tsx src/react/components/__tests__/ui-components.test.tsx src/react/components/__tests__/voice-window-lifecycle.test.tsx src/react/hooks/__tests__/use-deepgram-transcription.test.tsx src/react/hooks/__tests__/use-drag-resize-panel.test.tsx
```

Expected: `0`; total `6`; `Test Files 7 passed (7)`, `Tests 58 passed (58)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add src/react/components/__tests__/chat-window.test.tsx src/react/components/__tests__/floating-chat-ui.test.tsx src/react/components/__tests__/message-bubble.test.tsx src/react/components/__tests__/ui-components.test.tsx src/react/components/__tests__/voice-window-lifecycle.test.tsx src/react/hooks/__tests__/use-deepgram-transcription.test.tsx src/react/hooks/__tests__/use-drag-resize-panel.test.tsx
git commit -m "test(react): fix test type errors under the test typecheck"
```

---

### Task 16: SDK – type the source-driven reference example (6) and close the gate

**Files:**
- Create: `examples/source-driven-next/adapter.d.mts`, `examples/source-driven-next/build.d.mts`, `examples/source-driven-next/prepare-browser.d.mts`
- Modify: `tests/source-driven-build.test.ts:38-61`
- Test: `bun run typecheck:tests` (must exit 0) and `tests/source-driven-*.test.*`

**Interfaces:**
- Consumes: `ExecutionGenerationResult { state: ExecutionGenerationState; changes: { added; changed; removed; unchanged: string[] } }`, `ExecutionGenerationState` (`glirastes/codegen`); `AppSetupArtifact`, `ExecutionBudget`, `Principal` (`glirastes/contracts`); `LocalToolBinding`, `TurnSnapshot` (`glirastes/runtime`).
- Produces (declaration-only, test-facing; the modules are replaced by `tools refresh` in P03):
  - `adapter.d.mts`: `export const tenantId: string; export interface ReferenceTurn { snapshot: TurnSnapshot; execute(stableKey: string, input: unknown): Promise<unknown> } export interface ReferenceGeneration extends ExecutionGenerationResult { bindings: LocalToolBinding[]; artifact: AppSetupArtifact; limits: ExecutionBudget; createTurn(options: { request: Request; resolvePrincipal: () => Principal | undefined }): ReferenceTurn } export function generateReference(options: { rootDir: string; previous?: ExecutionGenerationState }): Promise<ReferenceGeneration>;`
  - `build.d.mts`: `export function buildReference(rootDir: string): Promise<ReferenceGeneration>;`
  - `prepare-browser.d.mts`: `export function prepareBrowserReference(): Promise<string>;`

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS7016 (5) | `source-driven-build.test.ts:12,25,38`, `source-driven-next.test.ts:5`, `source-driven-ui.test.tsx:9` | Add `.d.mts` declarations beside the `.mjs` modules (NodeNext resolves `x.mjs` → `x.d.mts`). `allowJs` was measured and rejected: it infers `{ rootDir, previous }` as required and adds 17 new errors. |
| TS7006 (1) + masked TS2339/TS2532 | `source-driven-build.test.ts:57` | Replace the RED-phase `import(...).catch(() => ({}))` (whose `{}` branch has no `buildReference`) with a plain dynamic import and assert the found endpoint with `!`. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests 2>&1 | grep "error TS" | grep -cE "^tests/"
```

Expected: `6`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git apply <<'PATCH'
--- a/tests/source-driven-build.test.ts
+++ b/tests/source-driven-build.test.ts
@@ -35,8 +35,8 @@
   expect(await readFile(resolve(outside, 'runtime.mjs'), 'utf8')).toBe('external sentinel');
 });
 it('persists source identities and tombstones with a statically importable signed runtime, preserving the last good build on failure', async () => {
-  const buildModule = await import('../examples/source-driven-next/build.mjs').catch(() => ({}));
-  expect(buildModule.buildReference, 'build-time runtime emitter').toBeTypeOf('function');
+  const { buildReference } = await import('../examples/source-driven-next/build.mjs');
+  expect(buildReference, 'build-time runtime emitter').toBeTypeOf('function');
   const root = await mkdtemp(resolve(base, '.build-proof-'));
   roots.push(root);
   await cp(resolve(base, 'native'), root, { recursive: true });
@@ -45,7 +45,7 @@
   await mkdir(resolve(root, 'node_modules'));
   await symlink(resolve('.'), resolve(root, 'node_modules/glirastes'), 'dir');
   const output = resolve(root, '.glirastes/runtime.mjs');
-  const first = await buildModule.buildReference(root);
+  const first = await buildReference(root);
   const runtime = await import(pathToFileURL(output).href);
   const principal = { subjectId: 'alice', tenantId: runtime.tenantId, roles: ['member'], attributes: {} };
   const snapshot = runtime.source.resolveTurnSnapshot({ turnId: 'build-test', principal });
@@ -53,10 +53,10 @@
   expect(runtime.bindings).toHaveLength(3);
   expect(await readFile(output, 'utf8')).not.toContain('glirastes/codegen');
   await rm(resolve(root, 'src/app/api/tasks/route.js'));
-  const removed = await buildModule.buildReference(root);
-  expect(removed.state.tombstones[0].toolId).toBe(first.state.inventory.executions.find((entry) => entry.executionKind === 'endpoint').toolId);
+  const removed = await buildReference(root);
+  expect(removed.state.tombstones[0].toolId).toBe(first.state.inventory.executions.find((entry) => entry.executionKind === 'endpoint')!.toolId);
   const valid = await readFile(output, 'utf8');
   await writeFile(resolve(root, 'src/query.js'), 'unreviewed native wrapper');
-  await expect(buildModule.buildReference(root)).rejects.toThrow('assessment');
+  await expect(buildReference(root)).rejects.toThrow('assessment');
   expect(await readFile(output, 'utf8')).toBe(valid);
 });
--- /dev/null
+++ b/examples/source-driven-next/adapter.d.mts
@@ -0,0 +1,26 @@
+import type { ExecutionGenerationResult, ExecutionGenerationState } from 'glirastes/codegen';
+import type { AppSetupArtifact, ExecutionBudget, Principal } from 'glirastes/contracts';
+import type { LocalToolBinding, TurnSnapshot } from 'glirastes/runtime';
+
+/** Type surface of the plain-JS reference adapter; consumed by the SDK tests only. */
+export const tenantId: string;
+
+export interface ReferenceTurn {
+  snapshot: TurnSnapshot;
+  execute(stableKey: string, input: unknown): Promise<unknown>;
+}
+
+export interface ReferenceGeneration extends ExecutionGenerationResult {
+  bindings: LocalToolBinding[];
+  artifact: AppSetupArtifact;
+  limits: ExecutionBudget;
+  createTurn(options: {
+    request: Request;
+    resolvePrincipal: () => Principal | undefined;
+  }): ReferenceTurn;
+}
+
+export function generateReference(options: {
+  rootDir: string;
+  previous?: ExecutionGenerationState;
+}): Promise<ReferenceGeneration>;
--- /dev/null
+++ b/examples/source-driven-next/build.d.mts
@@ -0,0 +1,4 @@
+import type { ReferenceGeneration } from './adapter.mjs';
+
+/** Writes `.glirastes/runtime.mjs` atomically and returns the generation it was built from. */
+export function buildReference(rootDir: string): Promise<ReferenceGeneration>;
--- /dev/null
+++ b/examples/source-driven-next/prepare-browser.d.mts
@@ -0,0 +1,2 @@
+/** Copies the browser reference into a fresh temporary app root and returns its path. */
+export function prepareBrowserReference(): Promise<string>;
PATCH
```

- [ ] **Step 3: See the whole gate GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bun run typecheck:tests; echo "exit=$?"
bun run typecheck; echo "main-exit=$?"
bunx vitest run tests/source-driven-build.test.ts tests/source-driven-next.test.ts tests/source-driven-ui.test.tsx
```

Expected: only the `$ tsc -p tsconfig.test.json` echo line and `exit=0`; `main-exit=0`; `Test Files 3 passed (3)`, `Tests 18 passed (18)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add examples/source-driven-next/adapter.d.mts examples/source-driven-next/build.d.mts examples/source-driven-next/prepare-browser.d.mts tests/source-driven-build.test.ts
git commit -m "test(integration): type the source-driven reference example"
```

---

### Task 17: SDK – explicit timeout for the build-spawning source-driven test

**Files:**
- Modify: `tests/source-driven-build.test.ts:23` (closing line of "stops the normal app build before Next when source assessment fails")
- Test: `tests/source-driven-build.test.ts`

**Interfaces:** Consumes Vitest 4.1.4's per-test timeout argument `it(name, fn, timeoutMs)` (same pattern as `tests/examples-compile.test.ts:22`). Produces none.

The test copies the reference app and spawns `bun run build` under the 5 s default. It takes about 1.3 s alone, but in full-suite runs on 2026-10-04 (11 cores, load average 35) it took 4,822 ms in one run and failed with `Test timed out in 5000ms` (5,013 ms) in another, which makes the Task 18 gate (`1079 passed`) non-deterministic. Spec 9 TP0 asks for load-sensitive tests to get their own timeout; this is the SDK instance. Run it after Task 16, which edits lines 38–61 of the same file (separate hunk, same line count, so either order applies cleanly).

- [ ] **Step 1: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bunx vitest run tests/source-driven-build.test.ts -t "stops the normal app build" --testTimeout=1
```

Expected: `Error: Test timed out in 1ms.` and `Tests  1 failed | 2 skipped (3)`.

- [ ] **Step 2: Minimal implementation**

In the SDK worktree's `tests/source-driven-build.test.ts` replace

```ts
  expect(await readFile(resolve(root, '.glirastes/runtime.mjs'), 'utf8')).toBe(artifact);
});
it('rejects a linked generation directory without writing outside the app', async () => {
```

with

```ts
  expect(await readFile(resolve(root, '.glirastes/runtime.mjs'), 'utf8')).toBe(artifact);
}, 30_000);
it('rejects a linked generation directory without writing outside the app', async () => {
```

- [ ] **Step 3: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
bunx vitest run tests/source-driven-build.test.ts -t "stops the normal app build" --testTimeout=1
bunx vitest run tests/source-driven-build.test.ts
bun run typecheck:tests; echo "exit=$?"
```

Expected: `Tests  1 passed | 2 skipped (3)`; `Tests  3 passed (3)`; `exit=0`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
git add tests/source-driven-build.test.ts
git commit -m "test(integration): give the build-spawning reference test a timeout"
```

---

### Task 18: P01 gate run and checkpoint (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: SDK gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1
pgrep -fl -- "--watch" | grep foundation-runtime-v1 || echo "no watcher"
bun run typecheck && bun run build && bun run typecheck:tests && bun run test
node --test --test-name-pattern "reference cleanup" tests/source-driven-browser.test.mjs
git status --short
```

Expected: `no watcher`; every command exits 0; Vitest `Test Files 130 passed (130)`, `Tests 1079 passed (1079)`; `# pass 5`; clean status.

- [ ] **Step 2: Platform gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/foundation-control-plane-v1
(cd apps/api && ./node_modules/.bin/vitest run)
(cd apps/citadel && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run)
(cd packages/db && bun test)
git status --short
git -C /Users/philipprollmann/Dev/chainmatics/glirastes-platform log --oneline -1 -- CLAUDE.md
```

Expected: API `1129 passed | 10 skipped (1139)`; Citadel `tsc` exit 0 and 250/250; DB 90/90; clean status; the Task 2 commit on `main`.

- [ ] **Step 3: GID gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/get-it-done/.worktrees/glirastes-foundation-pilot
lsof -nP -iTCP:3030 -sTCP:LISTEN || echo "no dev server"
node_modules/.bin/tsc --noEmit
node scripts/run-vitest.mjs
bun run lint
./node_modules/.bin/next build --webpack
git status --short
```

Expected: `no dev server`; `tsc` exit 0; Vitest all passed without a global timeout override (1,002 tests: baseline 1,000 plus the two guard cases); lint exit 0 with 0 errors; build exit 0 (direct `next build` skips the `prebuild` hook); clean status.

- [ ] **Step 4: Checkpoint report to Philipp**

Report: the 17 P01 commits with hashes, per repo (Platform worktree: Tasks 1, 3, 4; Platform `main`: Task 2; GID: Tasks 5–8; SDK: Tasks 9–17), the gate numbers above, the deviation in Task 5 (deletion committed instead of restored, with the parity evidence), the suite-level timeout in Task 7 (`prompt-size-baseline` siblings measured at 2.3–4.0 s), the ESLint debt baseline (96 errors in 54 files, to be paid down), and the pending approval requested by spec 9: backup push of `codex/glirastes-foundation-runtime`, `codex/glirastes-foundation-control-plane` and `codex/glirastes-foundation-pilot` to their own remote branches. Do not push.

---

## Self-Review

**Spec coverage**

| Spec item | Task |
| --- | --- |
| 9 TP0 – commit uncommitted Platform docs locally | 1 |
| 9 TP0 – Platform `CLAUDE.md` to SDK path `/Users/philipprollmann/Dev/chainmatics/glirastes` | 2 |
| 7 Platform-Hygiene / 2 Baseline – Aegis pseudonym collision across identity groups (2–4 % flake) | 3, 4 |
| 9 TP0 – `.glirastes/platform-connection.json` in GID `.gitignore` | 6 |
| 9 TP0 – clarify the stale deletion in `platform-tool-bindings.json` | 5 |
| 9 TP0 / 2 Baseline – load-sensitive GID tests get their own timeout | 7 |
| 9 TP0 – load-sensitive tests get their own timeout (SDK instance found while verifying this plan) | 17 |
| 9 TP0 / 2 Baseline – repair GID `lint` (`next lint` gone in Next 16, no ESLint config on the branch) | 8 |
| 9 TP0 / 2 Baseline – macOS `EPERM` in the SDK test cleanup | 9 |
| 9 TP0 / 2 Baseline – 92 type errors in SDK test files, test typecheck as a gate | 10–16 |
| 6 Success criterion 6 (green suites) for the P01 scope | 18 |
| 9 – backup push only after approval | 18 Step 4 (request only) |

Deliberately not in P01 (per roadmap): Drizzle journal/snapshots, API typecheck explosion, Citadel ESLint, pairing-key scope → P08; GID `bun.lock` for the `file:` SDK and deploy defects → P11; `server/testing` not loadable via CJS (spec 2) → P13 package check.

**Placeholder scan:** done – every code step carries the exact code or a patch verified with `git apply --check` against the current worktrees on 2026-10-04; the SDK patches were applied cumulatively in a scratch copy (error counts 92 → 69 → 45 → 33 → 21 → 6 → 0, full Vitest suite 1,079/1,079 afterwards); the Aegis patches were verified RED then GREEN (API suite 1,128 + 10 skipped with two of the three new tests, 1,129 with all three); the GID timeout, guard-test typing and ESLint baseline were verified in a scratch copy. Independent re-check on 2026-10-04 (scratch copies, no repo writes): all ten patches apply with `git apply --check` and reproduce the stated RED/GREEN counts (Aegis `2 failed` → `2 passed`, `1 failed` → `3 passed`, aegis dir `177 passed | 10 skipped (187)`, API `1129 passed | 10 skipped (1139)`; SDK 92 → 69 → 45 → 33 → 21 → 6 → 0, per-task Vitest counts 69/54/33/39/58/18, full suite 1,079); Task 9 RED `# pass 2 # fail 3`, GREEN `# pass 5`; GID guard RED/GREEN, describe-level timeout overrides `--testTimeout=1` for all seven tests, `tsc --noEmit` clean, ESLint `96 errors` → `54 files 96 suppressed` → `0 errors`, both probes exit 1, unused suppressions exit 2; Task 17 RED/GREEN. Every bash block now starts with an absolute `cd`.

**Type consistency:** done – `indexPseudonym(session: PiiSession, original: string, pseudonym: string, variants: readonly string[]): void` and `drawGroupSeed(session: PiiSession, locale: string): number` are used identically at all call sites; `rejectionOf(promise: Promise<unknown>): Promise<Error>` is identical in both sync test files; `stopProcessGroup(child, graceMs = 3_000, kill = systemKill)` keeps every existing two-argument call valid; the `.d.mts` types match the runtime shapes the tests read (`state.inventory.executions`, `state.tombstones`, `changes.added`, `bindings[0].inputSchemaDigest`, `createTurn(...).execute(...)`). P01 neither consumes nor produces the pinned P02+ contracts (`src/contracts/tool-policy.ts`, `src/codegen/tools/*`).
