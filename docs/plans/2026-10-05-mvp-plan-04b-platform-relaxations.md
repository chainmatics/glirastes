# Platform-Lockerungen bis Stufe 2 (P04b, D16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed Platform decision `requiresApproval: false`, pinned to the tool at the risk class the code reported, switches that tool's confirmation off in the running chat up to tier 2 (D16): in the managed local runtime source and on turn snapshots built straight from a Platform deployment. Tier 3 and `unknown`, a risk raised above the pin, an unpinned or foreign-pinned decision and every local lock in `tool-policy.json` keep the tool asking. The code report names every explicit local `requiresApproval: true` `local-policy`, shared golden vectors pin the composition for the Platform port, runners report `capabilities.policyRelaxations: 1`, and `tools status` and the docs say which confirmations the Platform may relax.

**Architecture:** Work continues in the worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools` on branch `codex/mvp-tools` at `064f8a94ee78e7f542c69fff2858bc5615eec00c` (P01–P04, P07 and the P09 SDK half, fast-forwarded from `codex/glirastes-foundation-runtime`). P04b runs before P05. Task 1 extracts the one relaxation rule of `resolveToolPolicy` as `confirmationRelaxationOutcome` (a behaviour-preserving refactor of `relaxationAllowed`), adds the local-lock rule `platformMayRelaxConfirmation` and extends `src/contracts/__vectors__/tool-policy.v1.json` by 14 `relaxation/*` vectors in the composition form the runtime and the Platform share; `TOOL_POLICY_RULES_VERSION` stays 1 and the new file digest is pinned. Task 2 makes the code report name every explicit local `requiresApproval: true` `local-policy` (`localPolicyOrigin`). Tasks 3–5 let the runtime honour the relaxation: `applyPolicyOverlay` takes `{ relaxableToolIds }` and returns a content-free `relaxations` report, `createTurnSnapshot` takes `relaxableToolIds`, and `createLocalRuntimeSource` derives them from its setup artifact with `relaxableToolIds(setupArtifact)`. Task 6 makes a runner report `capabilities.policyRelaxations: 1` exactly when it registers with its setup artifact. Task 7 shows the relaxation and the lock in `tools status`, Task 8 documents both, Task 9 runs the gate.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict), Node ≥ 20.6, Zod v4, Vitest 4, Bun; Next.js 15.5 and Playwright with the system Chrome only for the regression browser proof in the gate.

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (v1.5) sections 4.1 (data flow: "verifiziertes Platform-Overlay: einschränkend, dazu signierte, an die Risikoklasse gepinnte Lockerungen der Rückfrage bis Stufe 2, die eine lokale Härtung nie übersteuern; pro Turn gepinnt, kein Platform-Call pro Turn"), 4.5 ("Rückfrage": Lockerung per signierter Platform-Entscheidung mit `atRiskClass:'write'`, lokale Härtung gewinnt immer, Stufe 3 immer an; Lebenszyklus "eine gespeicherte Lockerung unterhalb der neuen Stufe verfällt"), 4.9 (wirksame Policy = `resolveToolPolicy(lokal wirksam, verifiziertes Platform-Overlay)`, `needsApproval = requiresApproval ODER Stufe ≥ 3`), 4.10 items 6 and 7 (code report, capability view per field origin), 4.12 ("Runtime: Overlay kann … Stufe 3 nicht lockern"), 10 item 5 ("die Platform kann eine lokale Härtung nicht lockern"). Roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md, the one "Offene Punkte" row owned here: the D16 row ("die Runtime übernimmt signierte, an die Risikoklasse gepinnte Platform-Lockerungen der Rückfrage bis Stufe 2; eine explizite lokale Härtung gewinnt; der Code-Bericht markiert jedes explizite lokale `true` als `local-policy` (gemeinsame Golden Vectors); `capabilities` meldet die Lockerung als wirksam, sobald der Runner D16 kann", SDK half: "P04-Nachtrag … meldet die Fähigkeit bei der Registrierung"). Citadel design /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-05-citadel-living-network-design.md D16 (a) and (c), 4.2.4 (form condition (a) "wirksam an mit `origin.requiresApproval = code-default`", reason "`origin = local-policy`: In `tool-policy.json` eingeschaltet"). P04 checkpoint item 1 and item 8 in /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/.superpowers/sdd/2026-10-05-mvp-plan-04-navigation-filters-ui/progress.md; P09 SDK checkpoint (merged, no overlap) in /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/.superpowers/sdd/2026-10-05-mvp-plan-09-metrics/progress.md.

## Global Constraints

- No push, merge into a main branch, npm publish or deploy; Omnify is neither read nor changed; no secret is read, printed or written; no live model or STT call (the browser proof in Task 9 uses the fixture's test model).
- Implementers never edit plan files. Shell `rm` is denied and no step needs it: the CLI smoke copy in Task 9 is removed with `node -e "require('fs').rmSync(…)"`. The Platform worktree `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform` is read-only for this plan (P08d/P09 agents work there).
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution. Agent shells reset their working directory between calls, so every command starts with an absolute `cd`. Full Vitest runs use `--maxWorkers=4`.
- **The D16 rule, one definition for the whole plan.** A signed Platform `requiresApproval: false` for a tool that asks takes effect exactly when (1) it is the only decision for that tool in the overlay, (2) `confirmationRelaxationOutcome(toolId, pin, effectiveRiskClass) === 'applies'`: the pin names this tool id, tier 0–1 relaxes freely, from tier 2 on the pin's class is at most tier 2 and not below the effective class (so a code raise or a raise in the same decision lets it lapse), tier 3 and `unknown` never, and (3) the tool is in `relaxableToolIds`. Everything else stays as the restriction composition makes it and is reported as a content-free outcome (`locked-locally`, `duplicate-decisions`, `pin-for-other-tool`, `relaxation-requires-reviewed-pin`, `tier-3-always-requires-approval`, `override-lapsed-risk-raised`). Restrictions (disable, raise, narrow roles, require confirmation, description) are unchanged from P04.
- **Local lock.** `relaxableToolIds(setupArtifact)` names a tool only when the committed code report attributes its confirmation to `code-default` and its class is tier 0–2 (`platformMayRelaxConfirmation`). An explicit `requiresApproval: true` in `tool-policy.json`, a `tool-policy.json` risk raise that brings confirmation (both report `local-policy`) and a report without provenance are locks. The Platform port composes the same way: `resolveToolPolicy({ defaults: reported values, local: { allowedRoles?, requiresApproval: true when the reported tool asks (reported requiresApproval: true) and its reported origin is not code-default }, platform: delta })`; the `relaxation/*` vectors use exactly that form. A tool the code reports as running directly gets no local `requiresApproval` in that form (a `true` there would make the Platform show a confirmation the runtime does not have), and the Platform signs a `requiresApproval: false` only for a tool the code reports as asking (today's `boundToolOverride` drops it otherwise).
- **Fail closed without information.** Without `relaxableToolIds` nothing relaxes (`applyPolicyOverlay` default, `createTurnSnapshot` default). A runner registers `capabilities.policyRelaxations: 1` only when `createManagedRuntimeSync` has its setup artifact; a caller's `register({ capabilities })` can neither add nor change it. `TOOL_POLICY_RULES_VERSION` stays 1 because `resolveToolPolicy` does not change; only the vector file grows (new sha256 `dcf3470e7553a05bcd08e7d32cef3a42949f6d50177addb26a674d6287db774e`).
- `src/runtime/__tests__/turn-snapshot.test.ts` is a fixture module that nine other test files import, so a case added there runs ten times; the snapshot cases of this plan live in the self-contained new file `turn-snapshot-relaxations.test.ts`. `src/runtime/local-runtime-source.ts` contains a literal NUL character inside `parts.join(…)` (line 119, untouched): edit that file only with the replace blocks of Task 5, never by retyping it.

## Review Focus

1. **A Platform relaxation never loosens what the code or a local lock keeps:** tier 3 and `unknown`, a risk above the pin (raised by the code or by the same decision), an unpinned or foreign-pinned decision, a second decision for the same tool, an explicit local `requiresApproval: true`, a report without provenance and a caller without the code report all keep the tool asking, in the overlay, on Platform turn snapshots and in the managed local runtime source. Pinned in Task 1 Step 1, Task 3 Step 1, Task 4 Step 1 and Task 5 Step 1.
2. **Where every condition holds, the confirmation really goes away and all three rule sources agree:** the registry's `needsApproval`, the turn guard's `resolveApproval` and `authorizeToolCall` return false, and the runtime overlay, `resolveToolPolicy` and the shared vectors agree for every risk class × pin × lock in the composition form, for every delta the Platform signs (a `requiresApproval: false` only for a tool the code reports as asking; the one unsigned-by-design divergence is named in the Self-Review). Pinned in Task 1 Step 1, Task 3 Step 1 (lock-aware parity), Task 3 Step 2, Task 4 Step 2 and Task 5 Step 2.
3. **The code report tells a lock from a default:** every explicit local `requiresApproval: true` is reported `local-policy`, also on a tool whose code default already asks. Pinned in Task 2 Step 1.
4. **Only a signed decision relaxes:** a relaxation added to a signed policy revision never verifies (content hash, then signature), and a relaxed value in the reported `toolPolicies` is no decision. Pinned in Task 3 Step 1.
5. **The Platform can only show a relaxation as effective where the runner applies it:** `capabilities.policyRelaxations` is reported exactly with the setup artifact and never through a caller's `register({ capabilities })`, and a snapshot built without the code report relaxes nothing. Pinned in Task 6 Step 1 and Task 4 Step 1.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/contracts/tool-policy.ts` | Modify (Task 1) | `confirmationRelaxationOutcome`, `platformMayRelaxConfirmation`; `relaxationAllowed` delegates |
| `src/contracts/index.ts` | Modify (Task 1) | Exports the two functions and `ConfirmationRelaxationOutcome` |
| `src/contracts/__vectors__/tool-policy.v1.json` | Modify (Task 1) | 14 `relaxation/*` vectors (refusals first) |
| `src/contracts/tool-policy-entry.ts` | Modify (Task 3) | Delta doc comment names the D16 relaxation |
| `src/sync/local-deployment-validator.ts` | Modify (Task 3) | Doc comment no longer calls Platform decisions restrict-only |
| `src/codegen/tools/pipeline.ts` | Modify (Task 2) | `localPolicyOrigin` reports an explicit local `true` as `local-policy` |
| `src/runtime/policy-overlay.ts` | Modify, whole file (Task 3) | `PolicyOverlayOptions`, `relaxations`, `relaxableToolIds`, the D16 step |
| `src/runtime/index.ts` | Modify (Task 3) | Exports `relaxableToolIds` and the new types |
| `src/runtime/turn-snapshot.ts` | Modify (Task 4) | `createTurnSnapshot({ relaxableToolIds })` |
| `src/runtime/local-runtime-source.ts` | Modify (Task 5) | Relaxable ids from the artifact; `relaxations` in the overlay report |
| `src/sync/capability-report.ts`, `src/sync/control-plane-client.ts`, `src/sync/managed-sync.ts`, `src/sync/index.ts` | Modify (Task 6) | `POLICY_RELAXATIONS_VERSION`; registration reports `policyRelaxations` |
| `src/cli/commands/tools/status.ts`, `src/cli/commands/tools/format.ts` | Modify (Task 7) | `confirmationOrigin`, `platformMayRelax`, labels and hint |
| `docs/managed-runtime-sync.md`, `README.md` | Modify (Task 8) | Code report, decisions and D16 in the managed runtime |
| `docs/tool-policy.md` | Create (Task 8) | Layers, tiers, local relaxation, Platform relaxation, lock |
| `src/contracts/__tests__/tool-policy-relaxation.test.ts` | Create (Task 1) | Shared rule, parity with `resolveToolPolicy`, local-lock rule |
| `src/contracts/__tests__/tool-policy-vectors.test.ts` | Modify, whole file (Task 1) | Digest pin, `relaxation` rule group, vectors agree with the shared rule |
| `src/contracts/__tests__/tool-policy-exports.test.ts` | Modify (Task 1) | New exports |
| `src/codegen/tools/pipeline.test.ts` | Modify (Task 2) | Local lock in the code report |
| `src/runtime/__tests__/policy-overlay.test.ts`, `src/runtime/__tests__/policy-exports.test.ts` | Modify (Task 3) | Refusals, acceptance, flipped restrict-only cases, lock-aware parity |
| `src/sync/__tests__/signature-verifier.test.ts` | Modify (Task 3) | An added relaxation never verifies |
| `src/runtime/__tests__/turn-snapshot-relaxations.test.ts` | Create (Task 4) | Platform snapshot path, self-contained |
| `src/runtime/__tests__/local-runtime-source.test.ts` | Modify (Task 5) | Managed source with relaxations; overlay report shape |
| `src/sync/__tests__/capability-report.test.ts` | Modify (Task 6) | Registration capability |
| `src/cli/commands/tools/tools-command.test.ts` | Modify (Task 7) | Status labels, JSON fields |

All commands run from `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools`. Code blocks are exact: a "replace" block matches the file byte for byte and occurs exactly once at the moment it is applied (blocks apply in document order), and "Create" or "Replace the whole content" blocks are the complete file.

Baseline at `064f8a9` (controller ledger, Wave 3 merge gate): `bunx vitest run --maxWorkers=4` reports `Test Files  210 passed (210)` and `Tests  2256 passed (2256)`; `bun run typecheck`, `bun run build` (`Generated 18 subpath shims.`) and `bun run typecheck:tests` exit 0. Before Task 1, confirm `git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools status --short` prints nothing and `git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools rev-parse HEAD` prints `064f8a94ee78e7f542c69fff2858bc5615eec00c`.

### Task 1: One relaxation rule and the D16 golden vectors

**Files:**
- Modify: `src/contracts/tool-policy.ts` (`confirmationRelaxationOutcome`, `platformMayRelaxConfirmation`, `relaxationAllowed` delegates), `src/contracts/index.ts`, `src/contracts/__vectors__/tool-policy.v1.json` (14 `relaxation/*` vectors)
- Test: `src/contracts/__tests__/tool-policy-relaxation.test.ts` (Create), `src/contracts/__tests__/tool-policy-vectors.test.ts` (whole file), `src/contracts/__tests__/tool-policy-exports.test.ts`

**Interfaces:**
- Consumes: P02 `resolveToolPolicy` with its private `relaxationAllowed` (`src/contracts/tool-policy.ts:595`), `riskTier`, `PolicyOrigin`; `ToolPolicyEntry['pin']` from the P04 leaf `tool-policy-entry.ts`.
- Produces:
  - `export type ConfirmationRelaxationOutcome = 'applies' | 'pin-for-other-tool' | 'relaxation-requires-reviewed-pin' | 'tier-3-always-requires-approval' | 'override-lapsed-risk-raised'`
  - `export function confirmationRelaxationOutcome(toolId: string, pin: ToolPolicyEntry['pin'], riskClass: ToolRiskClass): ConfirmationRelaxationOutcome` — the same checks in the same order as P02's `relaxationAllowed`, which now maps the outcome to its warning or error. `resolveToolPolicy` output is unchanged (all 44 existing vectors keep passing).
  - `export function platformMayRelaxConfirmation(riskClass: ToolRiskClass, requiresApprovalOrigin: PolicyOrigin | undefined): boolean` — true only for origin `code-default` and tier 0–2.
  - `tool-policy.v1.json`: 58 vectors (44 + 14), sha256 `dcf3470e7553a05bcd08e7d32cef3a42949f6d50177addb26a674d6287db774e`, pinned as `TOOL_POLICY_VECTORS_SHA256` in the vector test; the Platform port copies the file byte for byte (`SDK_VECTORS_SHA256` in `apps/api/src/modules/runtime-setup-v2/__tests__/tool-policy-vectors.spec.ts`).

- [ ] **Step 1: Write the failing tests and the vectors**

The `relaxation/*` vectors are the composition form the runtime (Task 3) and the Platform port share: `defaults` is the effective policy the code reported, `local` carries the reported roles plus `requiresApproval: true` when the tool asks and the report does not attribute that confirmation to the code default (the local lock), and `platform` is the signed delta. Their expected values are exactly what today's `resolveToolPolicy` returns; refusals come first, and a test pins that order.

1. Create `src/contracts/__tests__/tool-policy-relaxation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ToolRiskClass } from '../tool-policy-entry.js';
import {
  TOOL_POLICY_RULES_VERSION,
  confirmationRelaxationOutcome,
  platformMayRelaxConfirmation,
  resolveToolPolicy,
} from '../tool-policy.js';

const TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
const OTHER_TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906';
const RISK_CLASSES: ToolRiskClass[] = [
  'safe-read', 'read-sensitive', 'write', 'delete', 'financial', 'external', 'unknown',
];

describe('confirmationRelaxationOutcome (D16, the one relaxation rule)', () => {
  it.each([
    ['delete', 'write', 'override-lapsed-risk-raised'],
    ['financial', 'write', 'override-lapsed-risk-raised'],
    ['external', 'write', 'override-lapsed-risk-raised'],
    ['unknown', 'write', 'override-lapsed-risk-raised'],
    ['delete', 'delete', 'tier-3-always-requires-approval'],
    ['unknown', 'unknown', 'tier-3-always-requires-approval'],
    ['write', 'external', 'tier-3-always-requires-approval'],
    ['write', 'safe-read', 'override-lapsed-risk-raised'],
    ['write', 'read-sensitive', 'override-lapsed-risk-raised'],
  ] as const)('refuses a %s tool pinned at %s: %s', (riskClass, atRiskClass, outcome) => {
    expect(confirmationRelaxationOutcome(TOOL_ID, { toolId: TOOL_ID, atRiskClass }, riskClass))
      .toBe(outcome);
  });

  it('refuses an unpinned relaxation from tier 2 on and a pin of another tool at every tier', () => {
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'write'))
      .toBe('relaxation-requires-reviewed-pin');
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'delete'))
      .toBe('tier-3-always-requires-approval');
    for (const riskClass of RISK_CLASSES) {
      expect(confirmationRelaxationOutcome(
        TOOL_ID,
        { toolId: OTHER_TOOL_ID, atRiskClass: 'write' },
        riskClass,
      )).toBe('pin-for-other-tool');
    }
  });

  it('applies a relaxation pinned at write up to tier 2 and any relaxation at tier 0-1', () => {
    const pin = { toolId: TOOL_ID, atRiskClass: 'write' as const };
    expect(confirmationRelaxationOutcome(TOOL_ID, pin, 'write')).toBe('applies');
    expect(confirmationRelaxationOutcome(TOOL_ID, pin, 'read-sensitive')).toBe('applies');
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'read-sensitive')).toBe('applies');
    expect(confirmationRelaxationOutcome(TOOL_ID, undefined, 'safe-read')).toBe('applies');
  });

  it.each(RISK_CLASSES)('is the rule resolveToolPolicy relaxes by, for a %s tool', (riskClass) => {
    const pins = [
      undefined,
      { toolId: OTHER_TOOL_ID, atRiskClass: 'write' as const },
      ...RISK_CLASSES.map((atRiskClass) => ({ toolId: TOOL_ID, atRiskClass })),
    ];
    for (const pin of pins) {
      const { effective } = resolveToolPolicy({
        toolId: TOOL_ID,
        defaults: {
          operationGroup: 'update',
          riskClass: riskClass as Exclude<ToolRiskClass, 'unknown'>,
          requiresApproval: true,
          rulesVersion: TOOL_POLICY_RULES_VERSION,
        },
        codeEnabled: true,
        platform: { requiresApproval: false, ...(pin ? { pin } : {}) },
      });
      expect(effective.requiresApproval)
        .toBe(confirmationRelaxationOutcome(TOOL_ID, pin, riskClass) !== 'applies');
    }
  });
});

describe('platformMayRelaxConfirmation (D16 local lock)', () => {
  it('opens only a code-default confirmation of a tier 0-2 tool to the Platform', () => {
    expect(platformMayRelaxConfirmation('write', 'code-default')).toBe(true);
    expect(platformMayRelaxConfirmation('read-sensitive', 'code-default')).toBe(true);
    expect(platformMayRelaxConfirmation('write', 'local-policy')).toBe(false);
    expect(platformMayRelaxConfirmation('write', 'platform')).toBe(false);
    expect(platformMayRelaxConfirmation('write', undefined)).toBe(false);
    for (const riskClass of ['delete', 'financial', 'external', 'unknown'] as const) {
      expect(platformMayRelaxConfirmation(riskClass, 'code-default')).toBe(false);
    }
  });
});
```

2. Replace the whole content of `src/contracts/__tests__/tool-policy-vectors.test.ts` with:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  confirmationRelaxationOutcome,
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ResolveToolPolicyResult,
} from '../tool-policy.js';

interface ToolPolicyVector {
  name: string;
  input: ResolveToolPolicyInput;
  expected: ResolveToolPolicyResult;
}

/**
 * sha256 of `__vectors__/tool-policy.v1.json`. The Platform port copies the
 * file byte for byte and pins the same digest (`SDK_VECTORS_SHA256` in its
 * vector parity spec), so a changed vector changes this digest on purpose and
 * goes to the Platform together with it.
 */
const TOOL_POLICY_VECTORS_SHA256 =
  'dcf3470e7553a05bcd08e7d32cef3a42949f6d50177addb26a674d6287db774e';

const raw = readFileSync(
  new URL('../__vectors__/tool-policy.v1.json', import.meta.url),
);
const vectors = JSON.parse(raw.toString('utf8')) as ToolPolicyVector[];

const REQUIRED_RULES = [
  'enabled',
  'risk',
  'approval',
  'relaxation',
  'roles',
  'description',
  'ratchet',
  'pin',
  'invalid',
];

describe('tool policy golden vectors v1', () => {
  it('covers every rule with at least 25 uniquely named vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(25);
    expect(new Set(vectors.map((vector) => vector.name)).size)
      .toBe(vectors.length);
    expect(new Set(vectors.map((vector) => vector.name.split('/')[0])))
      .toEqual(new Set(REQUIRED_RULES));
    for (const vector of vectors) {
      expect(vector.input.defaults.rulesVersion).toBe(TOOL_POLICY_RULES_VERSION);
    }
  });

  it('pins the file the Platform port copies byte for byte', () => {
    expect(createHash('sha256').update(raw).digest('hex'))
      .toBe(TOOL_POLICY_VECTORS_SHA256);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      expect(resolveToolPolicy(vector.input)).toEqual(vector.expected);
    },
  );
});

/**
 * The `relaxation/` vectors use the composition form the runtime overlay and
 * the Platform share (D16): `defaults` is the effective policy the code
 * reported, `local` carries the reported roles plus `requiresApproval: true`
 * when the tool asks and the report does not attribute that confirmation to
 * the code default (the local lock), and `platform` is the signed decision
 * delta.
 */
describe('tool policy relaxation vectors (D16)', () => {
  const relaxations = vectors.filter((vector) => vector.name.startsWith('relaxation/'));

  it('relax exactly where the shared rule applies and no local lock holds', () => {
    expect(relaxations).toHaveLength(14);
    for (const vector of relaxations) {
      const locked = vector.input.local?.requiresApproval === true;
      const outcome = confirmationRelaxationOutcome(
        vector.input.toolId,
        vector.input.platform?.pin,
        vector.expected.effective.riskClass,
      );
      expect(vector.expected.effective.requiresApproval, vector.name)
        .toBe(locked || outcome !== 'applies');
    }
  });

  it('list every refusal before the first acceptance', () => {
    const relaxed = relaxations.map((vector) => !vector.expected.effective.requiresApproval);
    const first = relaxed.indexOf(true);
    expect(first).toBeGreaterThan(0);
    expect(relaxed.slice(first).every(Boolean)).toBe(true);
  });
});
```

3. In `src/contracts/__tests__/tool-policy-exports.test.ts`, replace:

```ts
      'confirmationFloor',
      'mostRestrictiveRiskClass',
```

with:

```ts
      'confirmationFloor',
      'confirmationRelaxationOutcome',
      'platformMayRelaxConfirmation',
      'mostRestrictiveRiskClass',
```

4. In `src/contracts/__vectors__/tool-policy.v1.json`, replace:

```json
  {
    "name": "roles/intersection",
```

with:

```json
  {
    "name": "relaxation/tier-3-delete-pinned-at-delete-refused",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "delete", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "delete" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-002", "field": "platform.requiresApproval", "reason": "tier-3-always-requires-approval" }]
    }
  },
  {
    "name": "relaxation/tier-3-financial-pinned-at-write-lapses",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "financial", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "financial", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "platform.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "relaxation/tier-3-external-unpinned-refused",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "external", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "external", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-002", "field": "platform.requiresApproval", "reason": "tier-3-always-requires-approval" }]
    }
  },
  {
    "name": "relaxation/unknown-pinned-at-write-lapses",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "unknown", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "unknown", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "platform.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "relaxation/pin-at-unknown-refused",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "unknown" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-002", "field": "platform.requiresApproval", "reason": "tier-3-always-requires-approval" }]
    }
  },
  {
    "name": "relaxation/code-raised-risk-since-the-pin-lapses",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "delete", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "platform.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "relaxation/raise-in-the-same-decision-lapses",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "riskClass": "delete", "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "platform", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "platform.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "relaxation/pinned-below-the-current-class-lapses",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "read-sensitive" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "platform.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "relaxation/local-lock-wins",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "allowedRoles": ["admin", "member"], "requiresApproval": true },
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": ["admin", "member"],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "code-default", "allowedRoles": "local-policy", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "relaxation/write-unpinned-refused",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-002", "field": "platform.requiresApproval", "reason": "relaxation-requires-reviewed-pin" }]
    }
  },
  {
    "name": "relaxation/pin-of-an-earlier-tool-id-lapses",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3906", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "policy-entry-orphaned", "field": "platform.pin.toolId" }],
      "errors": []
    }
  },
  {
    "name": "relaxation/write-pinned-at-write-applies",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "allowedRoles": ["member"] },
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "write", "allowedRoles": ["member"],
        "origin": { "enabled": "code-default", "requiresApproval": "platform", "riskClass": "code-default", "allowedRoles": "local-policy", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "relaxation/applies-beside-a-role-restriction",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "allowedRoles": ["admin", "member"] },
      "platform": { "allowedRoles": ["admin"], "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "write", "allowedRoles": ["admin"],
        "origin": { "enabled": "code-default", "requiresApproval": "platform", "riskClass": "code-default", "allowedRoles": "platform", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "relaxation/tier-1-pinned-applies",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "update", "riskClass": "read-sensitive", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "read-sensitive" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "read-sensitive", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "platform", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "roles/intersection",
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-relaxation.test.ts src/contracts/__tests__/tool-policy-vectors.test.ts src/contracts/__tests__/tool-policy-exports.test.ts`
Expected: FAIL — `confirmationRelaxationOutcome is not a function` (and `platformMayRelaxConfirmation`) in the new file and in the vector test's "relax exactly where the shared rule applies", the export list misses both names; all 58 vectors, the digest pin and the ordering test already pass, because `resolveToolPolicy` is unchanged. `Test Files  3 failed (3)`, `Tests  21 failed | 61 passed (82)`

- [ ] **Step 3: Extract the rule and export it**

1. In `src/contracts/tool-policy.ts`, replace:

```ts
  return requiresApproval || riskTier(riskClass) >= 3;
}

/**
 * Raise-only combination.
```

with:

```ts
  return requiresApproval || riskTier(riskClass) >= 3;
}

export type ConfirmationRelaxationOutcome =
  | 'applies'
  | 'pin-for-other-tool'
  | 'relaxation-requires-reviewed-pin'
  | 'tier-3-always-requires-approval'
  | 'override-lapsed-risk-raised';

/**
 * The one relaxation rule (spec 4.5, D16), shared by `resolveToolPolicy` and
 * the runtime overlay: whether a `requiresApproval: false` entry with this pin
 * takes effect at the effective risk class. A pin for another tool id (an
 * earlier incarnation) lapses. Tier 0-1 relaxes freely. From tier 2 on the
 * entry needs a reviewed pin at a tier-2 class the effective class does not
 * exceed, so the relaxation lapses as soon as the risk rises. Tier 3 never
 * relaxes, pinned or not.
 */
export function confirmationRelaxationOutcome(
  toolId: string,
  pin: ToolPolicyEntry['pin'],
  riskClass: ToolRiskClass,
): ConfirmationRelaxationOutcome {
  if (pin && pin.toolId !== toolId) return 'pin-for-other-tool';
  const tier = riskTier(riskClass);
  if (tier <= 1) return 'applies';
  if (!pin) {
    return tier >= 3
      ? 'tier-3-always-requires-approval'
      : 'relaxation-requires-reviewed-pin';
  }
  const pinnedTier = riskTier(pin.atRiskClass);
  if (pinnedTier >= 3) return 'tier-3-always-requires-approval';
  if (tier > pinnedTier) return 'override-lapsed-risk-raised';
  return 'applies';
}

/**
 * D16 local lock: may a signed Platform decision switch off this tool's
 * confirmation at all? Only a confirmation the local code report attributes
 * to the code default, on a tool of tier 0-2. Whatever tool-policy.json
 * decided (an explicit `requiresApproval: true`, or a risk raise that brings
 * confirmation) and an origin the report does not name are local locks the
 * Platform never relaxes; tier 3 always confirms.
 */
export function platformMayRelaxConfirmation(
  riskClass: ToolRiskClass,
  requiresApprovalOrigin: PolicyOrigin | undefined,
): boolean {
  return requiresApprovalOrigin === 'code-default' && riskTier(riskClass) <= 2;
}

/**
 * Raise-only combination.
```

2. In `src/contracts/tool-policy.ts`, replace:

```ts
      && relaxationAllowed(input.toolId, layer, tier, warnings, errors)
```

with:

```ts
      && relaxationAllowed(input.toolId, layer, risk.value, warnings, errors)
```

3. In `src/contracts/tool-policy.ts`, replace:

```ts
  layer: PolicyLayer,
  tier: RiskTier,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): boolean {
  const pin = layer.entry.pin;
  const field = `${layer.name}.requiresApproval`;
  if (pin && pin.toolId !== toolId) return false;
  if (tier <= 1) return true;
  if (!pin) {
    errors.push({
      code: 'E-POLICY-002',
      field,
      reason: tier >= 3
        ? 'tier-3-always-requires-approval'
        : 'relaxation-requires-reviewed-pin',
    });
    return false;
  }
  const pinnedTier = riskTier(pin.atRiskClass);
  if (pinnedTier >= 3) {
    errors.push({
      code: 'E-POLICY-002',
      field,
      reason: 'tier-3-always-requires-approval',
    });
    return false;
  }
  if (tier > pinnedTier) {
    warnings.push({ code: 'override-lapsed-risk-raised', field });
    return false;
  }
  return true;
}
```

with:

```ts
  layer: PolicyLayer,
  riskClass: ToolRiskClass,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): boolean {
  const field = `${layer.name}.requiresApproval`;
  const outcome = confirmationRelaxationOutcome(toolId, layer.entry.pin, riskClass);
  switch (outcome) {
    case 'applies':
      return true;
    case 'pin-for-other-tool':
      // Reported once as `policy-entry-orphaned` by collectPolicyLayers.
      return false;
    case 'override-lapsed-risk-raised':
      warnings.push({ code: 'override-lapsed-risk-raised', field });
      return false;
    default:
      errors.push({ code: 'E-POLICY-002', field, reason: outcome });
      return false;
  }
}
```

4. In `src/contracts/index.ts`, replace:

```ts
  ToolPolicyPinSchema,
  confirmationFloor,
  deriveToolPolicyDefaults,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  parseToolPolicyFile,
  resolveToolPolicy,
  riskTier,
} from './tool-policy.js';
export type {
  AllowedRolesIntersection,
  DeclaredEffect,
```

with:

```ts
  ToolPolicyPinSchema,
  confirmationFloor,
  confirmationRelaxationOutcome,
  deriveToolPolicyDefaults,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  parseToolPolicyFile,
  platformMayRelaxConfirmation,
  resolveToolPolicy,
  riskTier,
} from './tool-policy.js';
export type {
  AllowedRolesIntersection,
  ConfirmationRelaxationOutcome,
  DeclaredEffect,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-relaxation.test.ts src/contracts/__tests__/tool-policy-vectors.test.ts src/contracts/__tests__/tool-policy-exports.test.ts && bunx vitest run --maxWorkers=4 src/contracts && bun run typecheck`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  82 passed (82)`; the whole contracts folder `Test Files  21 passed (21)`, `Tests  451 passed (451)` (the other 18 resolve/defaults/tiers files are unchanged by the refactor); typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/__tests__/tool-policy-exports.test.ts \
  src/contracts/__tests__/tool-policy-relaxation.test.ts src/contracts/__tests__/tool-policy-vectors.test.ts \
  src/contracts/__vectors__/tool-policy.v1.json src/contracts/index.ts src/contracts/tool-policy.ts
git commit -m "feat(contracts): share the relaxation rule and pin d16 vectors"
```

### Task 2: The code report names every explicit local confirmation a lock

**Files:**
- Modify: `src/codegen/tools/pipeline.ts` (`localPolicyOrigin` takes the local `tool-policy.json` entry)
- Test: `src/codegen/tools/pipeline.test.ts`

**Interfaces:**
- Consumes: P04 `AppSetupToolProvenance.policyOrigin` (`'code-default' | 'local-policy'` per field), the parsed `tool-policy.json` entry of the tool (`inputs.policy.tools[stableKey]`), `resolveToolPolicy` origins.
- Produces: `provenance.policyOrigin.requiresApproval === 'local-policy'` for every tool whose `tool-policy.json` entry says `requiresApproval: true`, also where the code default already asks (today `resolveToolPolicy` reports `code-default` there because the hardening changes no value). Every other origin is unchanged, so `relaxableToolIds` (Task 3) and the Platform (Citadel 4.2.4, reason "In `tool-policy.json` eingeschaltet") can tell a lock from a default. An app that committed P04 outputs with such an entry sees `tools check` drift once until it runs `tools refresh`.

- [ ] **Step 1: Write the failing test**

In `src/codegen/tools/pipeline.test.ts`, replace:

```ts
    expect(artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
  }, 120_000);
});
```

with:

```ts
    expect(artifact.exclusions).toEqual([{ stableKey: 'POST /api/auth/login', origin: 'default' }]);
  }, 120_000);

  it('reports an explicit local confirmation as a local lock, also where the code asks anyway', async () => {
    const fixture = await app();
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const before = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.method, tool] as const));
    expect(before.get('POST')).toMatchObject({
      requiresApproval: true,
      provenance: { policyOrigin: { requiresApproval: 'code-default' } },
    });

    await fixture.write(TOOLS_PATHS.policy, JSON.stringify({
      schemaVersion: 1,
      tools: {
        'GET /api/tasks': { requiresApproval: true },
        'POST /api/tasks': { requiresApproval: true, reason: 'keep asking, whatever the dashboard says' },
      },
    }));
    await runToolsPipeline({ root: fixture.root, mode: 'write' });
    const after = new Map((await artifactOf(fixture)).tools.map((tool) => [tool.method, tool] as const));
    for (const method of ['GET', 'POST'] as const) {
      expect(after.get(method)).toMatchObject({
        requiresApproval: true,
        provenance: { policyOrigin: { requiresApproval: 'local-policy' } },
      });
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline.test.ts`
Expected: FAIL — the new case reports `requiresApproval: 'code-default'` for `POST /api/tasks` after the local hardening (the `GET` tool already reads `local-policy`). `Test Files  1 failed (1)`, `Tests  1 failed | 21 passed (22)`

- [ ] **Step 3: Report the local lock**

1. In `src/codegen/tools/pipeline.ts`, replace:

```ts
  riskTier,
  type EffectiveToolPolicy,
} from '../../contracts/tool-policy.js';
```

with:

```ts
  riskTier,
  type EffectiveToolPolicy,
  type ToolPolicyEntry,
} from '../../contracts/tool-policy.js';
```

2. In `src/codegen/tools/pipeline.ts`, replace:

```ts
/** A local report knows code defaults and local policy only, never a Platform origin. */
function localPolicyOrigin(origin: EffectiveToolPolicy['origin']): NonNullable<AppSetupToolProvenance['policyOrigin']> {
  const local: NonNullable<AppSetupToolProvenance['policyOrigin']> = {};
  for (const field of POLICY_FIELDS) {
    const value = origin[field];
    if (value === 'code-default' || value === 'local-policy') local[field] = value;
  }
  return local;
}
```

with:

```ts
/**
 * A local report knows code defaults and local policy only, never a Platform
 * origin. An explicit `requiresApproval: true` in tool-policy.json is a local
 * lock even where the code default asks anyway: the report names it
 * `local-policy`, so the Platform can tell a lock from a default and never
 * offers to relax it (D16); the runtime keeps it either way.
 */
function localPolicyOrigin(
  origin: EffectiveToolPolicy['origin'],
  local: ToolPolicyEntry | undefined,
): NonNullable<AppSetupToolProvenance['policyOrigin']> {
  const reported: NonNullable<AppSetupToolProvenance['policyOrigin']> = {};
  for (const field of POLICY_FIELDS) {
    const value = origin[field];
    if (value === 'code-default' || value === 'local-policy') reported[field] = value;
  }
  if (local?.requiresApproval === true) reported.requiresApproval = 'local-policy';
  return reported;
}
```

3. In `src/codegen/tools/pipeline.ts`, replace:

```ts
        policyOrigin: localPolicyOrigin(resolved.effective.origin),
```

with:

```ts
        policyOrigin: localPolicyOrigin(resolved.effective.origin, local),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/codegen/tools/pipeline.test.ts && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  22 passed (22)`; typecheck clean. The file runs real refreshes; under load a run takes about 45 s.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/codegen/tools/pipeline.test.ts src/codegen/tools/pipeline.ts
git commit -m "feat(codegen): report an explicit local confirmation as a local lock"
```

### Task 3: The overlay honours pinned Platform relaxations up to tier 2

**Files:**
- Modify: `src/runtime/policy-overlay.ts` (whole file), `src/runtime/index.ts`, `src/contracts/tool-policy-entry.ts` (doc comment of `ToolOverrideDeltaSchema`), `src/sync/local-deployment-validator.ts` (doc comment only, drops "restrict-only")
- Test: `src/runtime/__tests__/policy-overlay.test.ts`, `src/runtime/__tests__/policy-exports.test.ts`, `src/sync/__tests__/signature-verifier.test.ts`

**Interfaces:**
- Consumes: `confirmationRelaxationOutcome`, `platformMayRelaxConfirmation` (Task 1); `AppSetupArtifactSchema` and its per-tool `provenance.policyOrigin.requiresApproval` (P04, Task 2); P04 `restrictPolicy`, `overlayDescriptions`, `policyOverlayFromRevision` (unchanged behaviour).
- Produces:
  - `export interface PolicyOverlayOptions { relaxableToolIds?: ReadonlySet<string> }`
  - `export function applyPolicyOverlay(local: RuntimeToolPolicy[], overlay: PolicyOverlayEntry[], options?: PolicyOverlayOptions): PolicyOverlayResult` — restrictions as before, then the D16 step of the Global Constraints for every tool that still asks and has a `requiresApproval: false` decision.
  - `PolicyOverlayResult.relaxations: PolicyOverlayRelaxation[]` (`{ toolId, outcome }`, one per asking tool a decision tried to relax, local order); `export type PolicyOverlayRelaxationOutcome = 'applied' | 'locked-locally' | 'duplicate-decisions' | Exclude<ConfirmationRelaxationOutcome, 'applies'>`.
  - `export function relaxableToolIds(setupArtifact: unknown): Set<string>` — parses the artifact; tool ids with `platformMayRelaxConfirmation(tool.riskClass, tool.provenance?.policyOrigin?.requiresApproval)`.
  - `glirastes/runtime` exports `relaxableToolIds` and the types `PolicyOverlayOptions`, `PolicyOverlayRelaxation`, `PolicyOverlayRelaxationOutcome`.
  - Callers that pass no options (`createTurnSnapshot`, `createLocalRuntimeSource` until Tasks 4–5) keep P04 behaviour: every relaxation is `locked-locally`.

- [ ] **Step 1: Write the refusal tests first, and flip the restrict-only cases on purpose**

P04's case "cannot enable a disabled tool, lower a risk class or relax confirmation" and the parity case "pinned relaxation attempt on write" pinned the restrict-only no-op (P04 checkpoint item 1). They now say why the relaxation stays a no-op there (no code report, tier 3), and the parity check runs every case twice, once relaxable and once locked, in the composition form of the vectors. The refusal block names every tool relaxable, so only the rule can refuse. The signature test pins that a relaxation never arrives unsigned.

1. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
import {
  applyPolicyOverlay,
  overlayDescriptions,
  policyOverlayFromRevision,
} from '../policy-overlay.js';
```

with:

```ts
import {
  applyPolicyOverlay,
  overlayDescriptions,
  policyOverlayFromRevision,
  relaxableToolIds,
  type PolicyOverlayEntry,
} from '../policy-overlay.js';
```

2. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
const DELETE_ID = '33333333-3333-4333-8333-333333333333';
const REMOVED_ID = '44444444-4444-4444-8444-444444444444';
```

with:

```ts
const DELETE_ID = '33333333-3333-4333-8333-333333333333';
const REMOVED_ID = '44444444-4444-4444-8444-444444444444';
const FINANCIAL_ID = '88888888-8888-4888-8888-888888888888';
const EXTERNAL_ID = '99999999-9999-4999-8999-999999999999';
const UNKNOWN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
```

3. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
    expect(applyPolicyOverlay([READ, WRITE], []))
      .toEqual({ policies: [READ, WRITE], ignored: [] });
```

with:

```ts
    expect(applyPolicyOverlay([READ, WRITE], []))
      .toEqual({ policies: [READ, WRITE], ignored: [], relaxations: [] });
```

4. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
    ])).toEqual({
      policies: [READ],
      ignored: [{ toolId: REMOVED_ID, reason: 'platform-tool-not-in-code' }],
    });
```

with:

```ts
    ])).toEqual({
      policies: [READ],
      ignored: [{ toolId: REMOVED_ID, reason: 'platform-tool-not-in-code' }],
      relaxations: [],
    });
```

5. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
  it('cannot enable a disabled tool, lower a risk class or relax confirmation', () => {
    const { policies } = applyPolicyOverlay([{ ...READ, enabled: false }, WRITE, DELETE], [
      { toolId: READ_ID, enabled: true },
      {
        toolId: WRITE_ID,
        requiresApproval: false,
        pin: { toolId: WRITE_ID, atRiskClass: 'write' },
      },
      { toolId: DELETE_ID, riskClass: 'safe-read', requiresApproval: false },
    ]);
    expect(policies).toEqual([{ ...READ, enabled: false }, WRITE, DELETE]);
  });
```

with:

```ts
  // D16 flipped this case on purpose: a pinned relaxation of a write tool is
  // no longer a no-op as such; it stays one here only because the caller did
  // not name the tool relaxable (no local code report, fail closed).
  it('cannot enable a disabled tool or lower a risk class, and relaxes nothing it may not', () => {
    const result = applyPolicyOverlay([{ ...READ, enabled: false }, WRITE, DELETE], [
      { toolId: READ_ID, enabled: true },
      {
        toolId: WRITE_ID,
        requiresApproval: false,
        pin: { toolId: WRITE_ID, atRiskClass: 'write' },
      },
      { toolId: DELETE_ID, riskClass: 'safe-read', requiresApproval: false },
    ]);
    expect(result.policies).toEqual([{ ...READ, enabled: false }, WRITE, DELETE]);
    expect(result.relaxations).toEqual([
      { toolId: WRITE_ID, outcome: 'locked-locally' },
      { toolId: DELETE_ID, outcome: 'tier-3-always-requires-approval' },
    ]);
  });
```

6. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
    ['harden approval', READ, { requiresApproval: true }],
    ['relaxation attempt on write', WRITE, { requiresApproval: false }],
    ['pinned relaxation attempt on write', WRITE, {
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'write' },
    }],
  ];

  it.each(parityCases)('matches resolveToolPolicy for %s', (_label, local, entry) => {
    const [overlaid] = applyPolicyOverlay(
      [local],
      [{ toolId: local.toolId, ...entry }],
    ).policies;
    const resolved = resolveToolPolicy({
      toolId: local.toolId,
      defaults: {
        operationGroup: 'update',
        riskClass: local.riskClass as Exclude<ToolRiskClass, 'unknown'>,
        requiresApproval: local.requiresApproval,
        rulesVersion: TOOL_POLICY_RULES_VERSION,
      },
      codeEnabled: local.enabled,
      local: {
        ...(local.allowedRoles.length > 0
          ? { allowedRoles: local.allowedRoles }
          : {}),
        ...(local.requiresApproval ? { requiresApproval: true } : {}),
      },
      platform: entry,
    }).effective;
```

with:

```ts
    ['harden approval', READ, { requiresApproval: true }],
    ['relaxation attempt on write', WRITE, { requiresApproval: false }],
    ['pinned relaxation on write', WRITE, {
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'write' },
    }],
    ['relaxation pinned below the class', WRITE, {
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'safe-read' },
    }],
    ['relaxation with a raise to delete', WRITE, {
      riskClass: 'delete',
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'write' },
    }],
    ['relaxation pinned at delete', DELETE, {
      requiresApproval: false,
      pin: { toolId: DELETE_ID, atRiskClass: 'delete' },
    }],
    ['relaxation pinned for another tool', WRITE, {
      requiresApproval: false,
      pin: { toolId: READ_ID, atRiskClass: 'write' },
    }],
  ];

  // The composition form of the D16 vectors: the local policy is the reported
  // default, and a tool the code report does not name relaxable carries its
  // confirmation as an explicit local hardening.
  it.each(parityCases.flatMap(([label, local, entry]) => [
    [label, 'relaxable', local, entry] as const,
    [label, 'locked', local, entry] as const,
  ]))('matches resolveToolPolicy for %s (%s)', (_label, lock, local, entry) => {
    const relaxable = lock === 'relaxable';
    const [overlaid] = applyPolicyOverlay(
      [local],
      [{ toolId: local.toolId, ...entry }],
      { relaxableToolIds: new Set(relaxable ? [local.toolId] : []) },
    ).policies;
    const resolved = resolveToolPolicy({
      toolId: local.toolId,
      defaults: {
        operationGroup: 'update',
        riskClass: local.riskClass as Exclude<ToolRiskClass, 'unknown'>,
        requiresApproval: local.requiresApproval,
        rulesVersion: TOOL_POLICY_RULES_VERSION,
      },
      codeEnabled: local.enabled,
      local: {
        ...(local.allowedRoles.length > 0
          ? { allowedRoles: local.allowedRoles }
          : {}),
        ...(local.requiresApproval && !relaxable ? { requiresApproval: true } : {}),
      },
      platform: entry,
    }).effective;
```

7. In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
describe('policyOverlayFromRevision', () => {
  const revision: RuntimePolicyRevision = {
```

with:

```ts
describe('applyPolicyOverlay with Platform relaxations (D16)', () => {
  const FINANCIAL: RuntimeToolPolicy = { ...DELETE, toolId: FINANCIAL_ID, riskClass: 'financial' };
  const EXTERNAL: RuntimeToolPolicy = { ...DELETE, toolId: EXTERNAL_ID, riskClass: 'external' };
  const UNKNOWN: RuntimeToolPolicy = { ...DELETE, toolId: UNKNOWN_ID, riskClass: 'unknown' };
  const pinned = (toolId: string, atRiskClass: ToolRiskClass): PolicyOverlayEntry => ({
    toolId,
    requiresApproval: false,
    pin: { toolId, atRiskClass },
  });
  const everyTool = new Set([READ_ID, WRITE_ID, DELETE_ID, FINANCIAL_ID, EXTERNAL_ID, UNKNOWN_ID]);

  // Refusals first: each case would have to stay a no-op even for a caller
  // that names every tool relaxable.
  it('never relaxes tier 3 or an unassessed class, pinned or not', () => {
    const local = [DELETE, FINANCIAL, EXTERNAL, UNKNOWN];
    const result = applyPolicyOverlay(local, [
      pinned(DELETE_ID, 'delete'),
      pinned(FINANCIAL_ID, 'write'),
      { toolId: EXTERNAL_ID, requiresApproval: false },
      pinned(UNKNOWN_ID, 'write'),
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual(local);
    expect(result.relaxations).toEqual([
      { toolId: DELETE_ID, outcome: 'tier-3-always-requires-approval' },
      { toolId: FINANCIAL_ID, outcome: 'override-lapsed-risk-raised' },
      { toolId: EXTERNAL_ID, outcome: 'tier-3-always-requires-approval' },
      { toolId: UNKNOWN_ID, outcome: 'override-lapsed-risk-raised' },
    ]);
  });

  it('lets a relaxation lapse once the risk rises above its pin', () => {
    const raisedByTheCode = applyPolicyOverlay([DELETE], [pinned(DELETE_ID, 'write')], {
      relaxableToolIds: everyTool,
    });
    expect(raisedByTheCode.policies).toEqual([DELETE]);
    const raisedTogether = applyPolicyOverlay([WRITE], [
      { ...pinned(WRITE_ID, 'write'), riskClass: 'delete' },
    ], { relaxableToolIds: everyTool });
    expect(raisedTogether.policies).toEqual([{ ...WRITE, riskClass: 'delete', requiresApproval: true }]);
    const pinnedBelow = applyPolicyOverlay([WRITE], [pinned(WRITE_ID, 'read-sensitive')], {
      relaxableToolIds: everyTool,
    });
    expect(pinnedBelow.policies).toEqual([WRITE]);
    expect([raisedByTheCode, raisedTogether, pinnedBelow].map((result) => result.relaxations[0]?.outcome))
      .toEqual(['override-lapsed-risk-raised', 'override-lapsed-risk-raised', 'override-lapsed-risk-raised']);
  });

  it('never relaxes over a local lock or without the local report', () => {
    const lockedInPolicyFile = applyPolicyOverlay([WRITE], [pinned(WRITE_ID, 'write')], {
      relaxableToolIds: new Set([READ_ID]),
    });
    const withoutReport = applyPolicyOverlay([WRITE], [pinned(WRITE_ID, 'write')]);
    for (const result of [lockedInPolicyFile, withoutReport]) {
      expect(result.policies).toEqual([WRITE]);
      expect(result.relaxations).toEqual([{ toolId: WRITE_ID, outcome: 'locked-locally' }]);
    }
  });

  it('needs a reviewed pin for this very tool', () => {
    const result = applyPolicyOverlay([WRITE, { ...WRITE, toolId: READ_ID }], [
      { toolId: WRITE_ID, requiresApproval: false },
      { toolId: READ_ID, requiresApproval: false, pin: { toolId: WRITE_ID, atRiskClass: 'write' } },
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual([WRITE, { ...WRITE, toolId: READ_ID }]);
    expect(result.relaxations).toEqual([
      { toolId: WRITE_ID, outcome: 'relaxation-requires-reviewed-pin' },
      { toolId: READ_ID, outcome: 'pin-for-other-tool' },
    ]);
  });

  it('refuses a relaxation next to another decision for the same tool', () => {
    const result = applyPolicyOverlay([WRITE], [
      { toolId: WRITE_ID, requiresApproval: true },
      pinned(WRITE_ID, 'write'),
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual([WRITE]);
    expect(result.relaxations).toEqual([{ toolId: WRITE_ID, outcome: 'duplicate-decisions' }]);
  });

  it('takes a relaxation only from a signed decision, never from a reported copy', () => {
    const overlay = policyOverlayFromRevision({
      revisionId: '55555555-5555-4555-8555-555555555555',
      revision: 8,
      tenantId: '66666666-6666-4666-8666-666666666666',
      environmentId: '77777777-7777-4777-8777-777777777777',
      budget: BUDGET,
      toolPolicies: [{ ...WRITE, requiresApproval: false }],
      toolOverrides: [],
      publishedAt: '2026-10-05T00:00:00.000Z',
      signature: { algorithm: 'Ed25519', keyId: 'platform-key', value: 'c2lnbmF0dXJl' },
    });
    expect(applyPolicyOverlay([WRITE], overlay.entries, { relaxableToolIds: everyTool }))
      .toEqual({ policies: [WRITE], ignored: [], relaxations: [] });
  });
});

describe('policyOverlayFromRevision', () => {
  const revision: RuntimePolicyRevision = {
```

8. In `src/runtime/__tests__/policy-exports.test.ts`, replace:

```ts
    expect(typeof runtime.policyOverlayFromRevision).toBe('function');
    expect(typeof runtime.localToolBindingMismatches).toBe('function');
    expect(runtime.applyPolicyOverlay([], []))
      .toEqual({ policies: [], ignored: [] });
```

with:

```ts
    expect(typeof runtime.policyOverlayFromRevision).toBe('function');
    expect(typeof runtime.relaxableToolIds).toBe('function');
    expect(typeof runtime.localToolBindingMismatches).toBe('function');
    expect(runtime.applyPolicyOverlay([], []))
      .toEqual({ policies: [], ignored: [], relaxations: [] });
```

9. In `src/sync/__tests__/signature-verifier.test.ts`, replace:

```ts
  it('verifies signed security revocations', async () => {
```

with:

```ts
  it('never verifies a confirmation relaxation added to a signed policy (D16)', async () => {
    const verifier = new RuntimeRevisionVerifier(provider);
    const toolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
    const policy = { toolPolicies: [], toolOverrides: [] };
    const revision = signedRevision(policy);
    const relaxed = {
      ...policy,
      toolOverrides: [{ toolId, requiresApproval: false, pin: { toolId, atRiskClass: 'write' } }],
    };
    await expect(verifier.verifyRevision({ ...revision, payload: relaxed }))
      .rejects.toThrow(/content hash/i);
    await expect(verifier.verifyRevision({
      ...revision,
      payload: relaxed,
      contentHash: `sha256:${createHash('sha256')
        .update(canonicalRuntimeJson(relaxed))
        .digest('base64url')}`,
    })).rejects.toThrow(/signature is invalid/i);
  });

  it('verifies signed security revocations', async () => {
```

- [ ] **Step 2: Write the acceptance tests**

In `src/runtime/__tests__/policy-overlay.test.ts`, replace:

```ts
      .toEqual({ policies: [WRITE], ignored: [], relaxations: [] });
  });
});

describe('policyOverlayFromRevision', () => {
  const revision: RuntimePolicyRevision = {
```

with:

```ts
      .toEqual({ policies: [WRITE], ignored: [], relaxations: [] });
  });

  // Acceptance after the refusals.
  it('switches off a code-default confirmation pinned at its class, up to tier 2', () => {
    const readSensitive = { ...WRITE, toolId: READ_ID, riskClass: 'read-sensitive' as const };
    const result = applyPolicyOverlay([WRITE, readSensitive], [
      pinned(WRITE_ID, 'write'),
      pinned(READ_ID, 'read-sensitive'),
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual([
      { ...WRITE, requiresApproval: false },
      { ...readSensitive, requiresApproval: false },
    ]);
    expect(result.relaxations).toEqual([
      { toolId: WRITE_ID, outcome: 'applied' },
      { toolId: READ_ID, outcome: 'applied' },
    ]);
  });

  it('keeps every restriction of the relaxing decision and stays idempotent', () => {
    const entries = [{ ...pinned(WRITE_ID, 'write'), allowedRoles: ['admin'] }];
    const once = applyPolicyOverlay([{ ...WRITE, allowedRoles: [] }], entries, {
      relaxableToolIds: everyTool,
    });
    expect(once.policies).toEqual([{ ...WRITE, allowedRoles: ['admin'], requiresApproval: false }]);
    expect(applyPolicyOverlay(once.policies, entries, { relaxableToolIds: everyTool }).policies)
      .toEqual(once.policies);
  });
});

describe('relaxableToolIds', () => {
  const tool = (toolId: string, extra: Record<string, unknown>) => ({
    toolId,
    sourceFingerprint: `sha256:${'F'.repeat(43)}`,
    name: `tool.${toolId.slice(0, 4)}`,
    executionKind: 'endpoint',
    method: 'POST',
    path: '/api/tasks',
    operationGroup: 'create',
    riskClass: 'write',
    enabled: true,
    requiresApproval: true,
    inputSchemaDigest: `sha256:${'I'.repeat(43)}`,
    outputSchemaDigest: `sha256:${'O'.repeat(43)}`,
    ...extra,
  });
  const artifact = (tools: unknown[]) => ({
    schemaVersion: 1,
    artifactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    appId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    discoveryDigest: `sha256:${'A'.repeat(43)}`,
    assessmentMode: 'autonomous',
    status: 'ready',
    tools,
    planner: {
      plannerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      modelBindingRef: 'default',
      promptBindingRef: 'prompt:fixture',
      budgetProfileRef: 'default',
      toolIds: [],
    },
    prompts: {
      bundleDigest: `sha256:${'B'.repeat(43)}`,
      artifactRef: 'local://fixture/prompts',
      plannerDigest: `sha256:${'C'.repeat(43)}`,
      appBehaviorDigest: `sha256:${'D'.repeat(43)}`,
      responseStyleDigest: `sha256:${'E'.repeat(43)}`,
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-10-05T08:00:00.000Z',
  });

  it('names only code-default confirmations up to tier 2 from the code report', () => {
    expect(relaxableToolIds(artifact([
      tool(WRITE_ID, { provenance: { policyOrigin: { requiresApproval: 'code-default' } } }),
      tool(READ_ID, { provenance: { policyOrigin: { requiresApproval: 'local-policy' } } }),
      tool(DELETE_ID, {
        method: 'DELETE', operationGroup: 'delete', riskClass: 'delete',
        provenance: { policyOrigin: { requiresApproval: 'code-default' } },
      }),
      tool(REMOVED_ID, {}),
    ]))).toEqual(new Set([WRITE_ID]));
  });

  it('refuses an artifact that fails the contract', () => {
    expect(() => relaxableToolIds({ tools: [] })).toThrow(/schemaVersion/);
  });
});

describe('policyOverlayFromRevision', () => {
  const revision: RuntimePolicyRevision = {
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/policy-overlay.test.ts src/runtime/__tests__/policy-exports.test.ts src/sync/__tests__/signature-verifier.test.ts`
Expected: FAIL — results have no `relaxations` yet (the two P04 cases that compare whole results, the flipped case, every refusal and acceptance case and the runtime export check), `relaxableToolIds` is not a function, and the relaxable parity case "pinned relaxation on write (relaxable)" still asks. The new signature test passes already: verification is unchanged and refuses the added relaxation by content hash, then by signature. `Test Files  2 failed | 1 passed (3)`, `Tests  15 failed | 36 passed (51)`

- [ ] **Step 4: Implement the D16 step in the overlay**

1. Replace the whole content of `src/runtime/policy-overlay.ts` with:

```ts
import {
  AppSetupArtifactSchema,
  type ExecutionBudget,
  type RuntimePolicyRevision,
  type RuntimeToolPolicy,
  type ToolRiskClass,
} from '../contracts/index.js';
import {
  confirmationFloor,
  confirmationRelaxationOutcome,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  platformMayRelaxConfirmation,
  riskTier,
  type ConfirmationRelaxationOutcome,
  type ToolPolicyEntry,
} from '../contracts/tool-policy.js';

/** One Platform delta for one tool the deployed code owns. */
export type PolicyOverlayEntry = { toolId: string } & ToolPolicyEntry;

export interface PolicyOverlayIgnoredEntry {
  toolId: string;
  reason: 'platform-tool-not-in-code';
}

/**
 * What became of a Platform relaxation of confirmation for a tool that asks
 * before it runs. `locked-locally`: the local code report does not open this
 * confirmation to the Platform (tool-policy.json decided it, the report names
 * no origin, the local class is tier 3, or the caller passed no report).
 * `duplicate-decisions`: the overlay holds more than one decision for the
 * tool, which a signed revision never does. The rest come from the shared
 * rule `confirmationRelaxationOutcome`.
 */
export type PolicyOverlayRelaxationOutcome =
  | 'applied'
  | 'locked-locally'
  | 'duplicate-decisions'
  | Exclude<ConfirmationRelaxationOutcome, 'applies'>;

/** Content-free: a tool id and a code, never a value. */
export interface PolicyOverlayRelaxation {
  toolId: string;
  outcome: PolicyOverlayRelaxationOutcome;
}

export interface PolicyOverlayResult {
  policies: RuntimeToolPolicy[];
  ignored: PolicyOverlayIgnoredEntry[];
  /** One entry per asking tool a Platform decision tried to relax, in local order. */
  relaxations: PolicyOverlayRelaxation[];
}

export interface PolicyOverlayOptions {
  /**
   * Tools whose confirmation a signed Platform decision may switch off:
   * `relaxableToolIds(setupArtifact)` of the running code. Every other tool
   * keeps its local confirmation; without this set nothing relaxes.
   */
  relaxableToolIds?: ReadonlySet<string>;
}

/**
 * A Platform policy overlay whose signature the sync layer already verified.
 * The runtime reads the last accepted value; it never fetches one per turn.
 */
export interface VerifiedPolicyOverlay {
  /** Platform policy revision id; revocations of it keep matching. */
  revisionId: string;
  revision: number;
  entries: PolicyOverlayEntry[];
  /** Optional Platform budget; it can only tighten the local limits. */
  budget?: ExecutionBudget;
}

/**
 * Composes the local effective policies with a verified Platform overlay
 * (spec 4.9, resolveToolPolicy semantics). The overlay restricts: disable,
 * raise the risk class, narrow roles, require confirmation; `enabled: true`
 * and a lower risk class are no-ops. Its one relaxation is D16 (spec 4.5 as
 * amended 2026-10-05): a signed `requiresApproval: false` switches a tool's
 * confirmation off where `confirmationRelaxationOutcome` applies at the
 * effective risk class (pinned to this tool, at most tier 2, lapsing once
 * the risk rises above the pin; tier 3 and `unknown` never) and only for
 * tools in `relaxableToolIds`, so a local lock in tool-policy.json always
 * wins. Overlay ids without a local policy are ignored and reported.
 */
export function applyPolicyOverlay(
  local: RuntimeToolPolicy[],
  overlay: PolicyOverlayEntry[],
  options: PolicyOverlayOptions = {},
): PolicyOverlayResult {
  const relaxable = options.relaxableToolIds ?? new Set<string>();
  const localIds = new Set(local.map((policy) => policy.toolId));
  const entriesByToolId = new Map<string, ToolPolicyEntry[]>();
  const ignored = new Set<string>();
  for (const { toolId, ...entry } of overlay) {
    if (!localIds.has(toolId)) {
      ignored.add(toolId);
      continue;
    }
    entriesByToolId.set(toolId, [...(entriesByToolId.get(toolId) ?? []), entry]);
  }
  const relaxations: PolicyOverlayRelaxation[] = [];
  const policies = local.map((policy) => {
    const entries = entriesByToolId.get(policy.toolId) ?? [];
    const restricted = entries.reduce(restrictPolicy, policy);
    if (
      !restricted.requiresApproval
      || !entries.some((entry) => entry.requiresApproval === false)
    ) {
      return restricted;
    }
    const outcome = relaxationOutcome(
      policy.toolId,
      entries,
      restricted.riskClass,
      relaxable,
    );
    relaxations.push({ toolId: policy.toolId, outcome });
    return outcome === 'applied'
      ? { ...restricted, requiresApproval: false }
      : restricted;
  });
  return {
    policies,
    ignored: [...ignored].sort().map((toolId) => ({
      toolId,
      reason: 'platform-tool-not-in-code' as const,
    })),
    relaxations,
  };
}

function restrictPolicy(
  policy: RuntimeToolPolicy,
  entry: ToolPolicyEntry,
): RuntimeToolPolicy {
  const riskClass = mostRestrictiveRiskClass(policy.riskClass, entry.riskClass);
  const roles = intersectAllowedRoles(policy.allowedRoles, entry.allowedRoles);
  const raisedIntoConfirmation = riskTier(riskClass) >= 2
    && riskTier(riskClass) > riskTier(policy.riskClass);
  return {
    toolId: policy.toolId,
    // Disjoint role restrictions mean nobody, never everyone.
    enabled: policy.enabled && entry.enabled !== false && !roles.disjoint,
    riskClass,
    requiresApproval: confirmationFloor(
      riskClass,
      policy.requiresApproval
        || entry.requiresApproval === true
        || raisedIntoConfirmation,
    ),
    allowedRoles: roles.roles,
  };
}

/** D16 for one asking tool, checked after every restriction of its decision. */
function relaxationOutcome(
  toolId: string,
  entries: ReadonlyArray<ToolPolicyEntry>,
  riskClass: ToolRiskClass,
  relaxable: ReadonlySet<string>,
): PolicyOverlayRelaxationOutcome {
  if (entries.length !== 1) return 'duplicate-decisions';
  const outcome = confirmationRelaxationOutcome(toolId, entries[0]!.pin, riskClass);
  if (outcome !== 'applies') return outcome;
  return relaxable.has(toolId) ? 'applied' : 'locked-locally';
}

/**
 * The tools of the running code whose confirmation a signed Platform decision
 * may switch off (D16): those the committed setup artifact (the code report)
 * attributes to the code default, up to tier 2 (`platformMayRelaxConfirmation`).
 * An explicit `requiresApproval: true` or a risk raise in tool-policy.json and
 * an artifact without provenance are local locks.
 */
export function relaxableToolIds(setupArtifact: unknown): Set<string> {
  const artifact = AppSetupArtifactSchema.parse(setupArtifact);
  return new Set(artifact.tools
    .filter((tool) => platformMayRelaxConfirmation(
      tool.riskClass,
      tool.provenance?.policyOrigin?.requiresApproval,
    ))
    .map((tool) => tool.toolId));
}

/**
 * Platform descriptions for tools the deployed code has (spec 4.5: Platform >
 * local > code for prose). The last delta for a tool wins, like the policy
 * layers; deltas for tools the code does not have are ignored.
 */
export function overlayDescriptions(
  localToolIds: ReadonlySet<string>,
  overlay: ReadonlyArray<PolicyOverlayEntry>,
): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const entry of overlay) {
    if (entry.description !== undefined && localToolIds.has(entry.toolId)) {
      descriptions.set(entry.toolId, entry.description);
    }
  }
  return descriptions;
}

/**
 * Reads a Platform policy revision the sync manager already verified as an
 * overlay. The entries are the signed `toolOverrides` deltas (P08b shared
 * contract item 2), never the reported `toolPolicies`: those repeat what the
 * code reported and would freeze an old local value, and a relaxation there
 * is no decision. The revision id keeps Platform revocations matching.
 */
export function policyOverlayFromRevision(
  revision: RuntimePolicyRevision,
): VerifiedPolicyOverlay {
  return {
    revisionId: revision.revisionId,
    revision: revision.revision,
    entries: revision.toolOverrides.map((delta) => ({ ...delta })),
    budget: revision.budget,
  };
}
```

2. In `src/runtime/index.ts`, replace:

```ts
export {
  applyPolicyOverlay,
  policyOverlayFromRevision,
  type PolicyOverlayEntry,
  type PolicyOverlayIgnoredEntry,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

with:

```ts
export {
  applyPolicyOverlay,
  policyOverlayFromRevision,
  relaxableToolIds,
  type PolicyOverlayEntry,
  type PolicyOverlayIgnoredEntry,
  type PolicyOverlayOptions,
  type PolicyOverlayRelaxation,
  type PolicyOverlayRelaxationOutcome,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

3. In `src/contracts/tool-policy-entry.ts`, replace:

```ts
 * copy of the local value. The runtime applies it restrict-only.
 */
```

with:

```ts
 * copy of the local value. The runtime applies its restrictions, and its
 * `requiresApproval: false` only as the pinned D16 relaxation up to tier 2.
 */
```

4. In `src/sync/local-deployment-validator.ts`, replace:

```ts
 * instead of rejecting the whole deployment, so restrict-only Platform
 * decisions keep reaching the runtime while the Platform catches up with the
```

with:

```ts
 * instead of rejecting the whole deployment, so Platform decisions (their
 * restrictions and pinned D16 relaxations) keep reaching the runtime while the
 * Platform catches up with the
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/policy-overlay.test.ts src/runtime/__tests__/policy-exports.test.ts src/sync/__tests__/signature-verifier.test.ts && bunx vitest run --maxWorkers=4 src/runtime src/sync && bun run typecheck`
Expected: PASS — `Test Files  3 passed (3)`, `Tests  51 passed (51)`; runtime and sync `Test Files  39 passed (39)`, `Tests  402 passed (402)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/tool-policy-entry.ts src/runtime/__tests__/policy-exports.test.ts \
  src/runtime/__tests__/policy-overlay.test.ts src/runtime/index.ts src/runtime/policy-overlay.ts \
  src/sync/__tests__/signature-verifier.test.ts src/sync/local-deployment-validator.ts
git commit -m "feat(runtime): honour pinned platform relaxations up to tier 2"
```

### Task 4: Platform turn snapshots relax only with the code report

**Files:**
- Modify: `src/runtime/turn-snapshot.ts` (`relaxableToolIds` option, `withPlatformDecisions`)
- Test: `src/runtime/__tests__/turn-snapshot-relaxations.test.ts` (Create, self-contained)

**Interfaces:**
- Consumes: `applyPolicyOverlay(…, { relaxableToolIds })` (Task 3), `authorizeToolCall` (P02, `confirmationFloor` on the snapshot policy).
- Produces: `createTurnSnapshot({ …, relaxableToolIds?: ReadonlySet<string> })`. A snapshot built straight from a Platform deployment (the Get It Done pilot's managed path) applies the revision's own relaxations only for these ids; without the option it relaxes nothing (fail closed, P04 behaviour). A revision composed by the local runtime source carries no deltas and stays as signed; applying the same deltas twice changes nothing.

- [ ] **Step 1: Write the refusal tests first**

Create `src/runtime/__tests__/turn-snapshot-relaxations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  ManifestTool,
  Principal,
  RuntimePolicyRevision,
  RuntimeToolPolicy,
  ToolOverrideDelta,
} from '../../contracts/index.js';
import { authorizeToolCall } from '../authorization.js';
import { createTurnSnapshot, type TurnSnapshot } from '../turn-snapshot.js';

// Self-contained on purpose: turn-snapshot.test.ts is a fixture module that
// nine other test files import, so cases added there run ten times.
const id = (suffix: string) => `019fb004-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_ID = id('a1');
const ENVIRONMENT_ID = id('a2');
const WRITE_ID = id('1');
const LOCKED_ID = id('2');
const DELETE_ID = id('3');
const UNPINNED_ID = id('4');
const FOREIGN_PIN_ID = id('5');
const TOOL_IDS = [WRITE_ID, LOCKED_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID];

const signature = { algorithm: 'Ed25519' as const, keyId: 'platform-key', value: 'c2lnbmF0dXJl' };
const budget: ExecutionBudget = {
  maxModelSteps: 8,
  maxToolCalls: 8,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 10_000,
  maxInputTokens: 40_000,
  maxOutputTokens: 8_000,
  maxEstimatedCostUsd: 2,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

const riskOf = (toolId: string) => (toolId === DELETE_ID ? 'delete' as const : 'write' as const);

const agentRevision: AgentRevision = {
  revisionId: id('b1'),
  revision: 3,
  agentId: id('b2'),
  tenantId: TENANT_ID,
  name: 'Assistant',
  objective: 'Complete task-management outcomes.',
  modelAlias: 'standard',
  promptBindingRef: 'prompt-v3',
  toolAllowlist: TOOL_IDS,
  budget,
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature,
};

const manifestRevision: ManifestRevision = {
  revisionId: id('b3'),
  revision: 5,
  tenantId: TENANT_ID,
  targetAppId: id('b4'),
  environmentId: ENVIRONMENT_ID,
  sourceDigest: 'sha256:manifest',
  tools: TOOL_IDS.map((toolId, index): ManifestTool => ({
    toolId,
    sourceFingerprint: 'sha256:tool',
    executionKind: 'endpoint',
    name: `tasks.tool${index}`,
    description: 'Changes a task.',
    riskClass: riskOf(toolId),
    enabled: true,
    tombstone: false,
    method: toolId === DELETE_ID ? 'DELETE' : 'PATCH',
    path: `/api/tasks/${index}`,
    inputSchemaDigest: 'sha256:input',
    outputSchemaDigest: 'sha256:output',
    authBindingRef: 'session',
  })),
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature,
};

const reported: RuntimeToolPolicy[] = TOOL_IDS.map((toolId) => ({
  toolId,
  enabled: true,
  riskClass: riskOf(toolId),
  requiresApproval: true,
  allowedRoles: [],
}));

const relax = (toolId: string, pinToolId = toolId): ToolOverrideDelta => ({
  toolId,
  requiresApproval: false,
  pin: { toolId: pinToolId, atRiskClass: 'write' },
});

const policyRevision = (toolOverrides: ToolOverrideDelta[]): RuntimePolicyRevision => ({
  revisionId: id('b5'),
  revision: 9,
  tenantId: TENANT_ID,
  environmentId: ENVIRONMENT_ID,
  budget,
  toolPolicies: reported,
  toolOverrides,
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature,
});

const principal: Principal = { subjectId: 'user-1', tenantId: TENANT_ID, roles: ['member'], attributes: {} };

function snapshotFrom(
  toolOverrides: ToolOverrideDelta[],
  relaxableToolIds?: ReadonlySet<string>,
): TurnSnapshot {
  return createTurnSnapshot({
    turnId: 'turn-d16',
    agentRevision,
    manifestRevision,
    policyRevision: policyRevision(toolOverrides),
    principal,
    localLimits: budget,
    ...(relaxableToolIds ? { relaxableToolIds } : {}),
  });
}

function asksFirst(snapshot: TurnSnapshot, toolId: string): boolean {
  const authorization = authorizeToolCall({ ...snapshot, principal, toolId });
  if (!authorization.allowed) throw new Error(authorization.reason);
  return authorization.requiresApproval;
}

describe('createTurnSnapshot with a Platform relaxation (D16)', () => {
  // Every tool but LOCKED_ID is named relaxable, so only the rule can refuse.
  const relaxable = new Set([WRITE_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID]);

  it('keeps every confirmation without the local code report (fail closed)', () => {
    const snapshot = snapshotFrom([relax(WRITE_ID)]);
    expect(snapshot.policyRevision.toolPolicies).toEqual(reported);
    expect(asksFirst(snapshot, WRITE_ID)).toBe(true);
  });

  it('never relaxes a local lock, tier 3, an unpinned or a foreign-pinned decision', () => {
    const snapshot = snapshotFrom([
      relax(LOCKED_ID),
      relax(DELETE_ID),
      { toolId: UNPINNED_ID, requiresApproval: false },
      relax(FOREIGN_PIN_ID, WRITE_ID),
    ], relaxable);
    expect(snapshot.policyRevision.toolPolicies).toEqual(reported);
    for (const toolId of [LOCKED_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID]) {
      expect(asksFirst(snapshot, toolId)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Write the acceptance test**

In `src/runtime/__tests__/turn-snapshot-relaxations.test.ts`, replace:

```ts
    for (const toolId of [LOCKED_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID]) {
      expect(asksFirst(snapshot, toolId)).toBe(true);
    }
  });
});
```

with:

```ts
    for (const toolId of [LOCKED_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID]) {
      expect(asksFirst(snapshot, toolId)).toBe(true);
    }
  });

  it('runs a code-default write tool without asking once the relaxation is signed', () => {
    const snapshot = snapshotFrom([relax(WRITE_ID)], relaxable);
    expect(snapshot.policyRevision.toolPolicies[0]).toEqual({ ...reported[0], requiresApproval: false });
    expect(snapshot.policyRevision.toolOverrides).toEqual([relax(WRITE_ID)]);
    expect(asksFirst(snapshot, WRITE_ID)).toBe(false);
    expect(asksFirst(snapshot, LOCKED_ID)).toBe(true);
    expect(Object.isFrozen(snapshot.policyRevision.toolPolicies[0])).toBe(true);
  });

  it('keeps a revision without decisions exactly as signed', () => {
    expect(snapshotFrom([], relaxable).policyRevision).toEqual(policyRevision([]));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/turn-snapshot-relaxations.test.ts`
Expected: FAIL — only the acceptance case fails (`requiresApproval` stays `true`, the option is ignored); the refusals and the unchanged-revision case pass on the restrict-only parent by design. `Test Files  1 failed (1)`, `Tests  1 failed | 3 passed (4)`

- [ ] **Step 4: Pass the relaxable ids through the snapshot**

1. In `src/runtime/turn-snapshot.ts`, replace:

```ts
   * The pinned policy revision. Its `toolPolicies` are the effective ones:
   * the signed values restricted by the revision's own signed `toolOverrides`
   * deltas (restrict-only), so every consumer of the snapshot obeys Platform
   * decisions, whichever path built it.
```

with:

```ts
   * The pinned policy revision. Its `toolPolicies` are the effective ones:
   * the signed values composed with the revision's own signed `toolOverrides`
   * deltas (restrictions, plus the D16 relaxations the local code report
   * allows), so every consumer of the snapshot obeys Platform decisions,
   * whichever path built it.
```

2. In `src/runtime/turn-snapshot.ts`, replace:

```ts
/**
 * Applies the signed `toolOverrides` deltas of a Platform policy revision to
 * its reported `toolPolicies`, restrict-only. A revision composed by the local
 * runtime source carries no deltas and stays as it is; one a consumer takes
 * straight from a Platform deployment no longer runs a tool the Platform
 * disabled. Applying the same deltas twice changes nothing.
 */
function withPlatformDecisions(policyRevision: RuntimePolicyRevision): RuntimePolicyRevision {
  const deltas = policyRevision.toolOverrides ?? [];
  if (deltas.length === 0) return policyRevision;
  return {
    ...policyRevision,
    toolPolicies: applyPolicyOverlay(policyRevision.toolPolicies, deltas).policies,
  };
}
```

with:

```ts
/**
 * Applies the signed `toolOverrides` deltas of a Platform policy revision to
 * its reported `toolPolicies` (`applyPolicyOverlay`). A revision composed by
 * the local runtime source carries no deltas and stays as it is; one a
 * consumer takes straight from a Platform deployment no longer runs a tool
 * the Platform disabled, and switches a confirmation off only for tools the
 * local code report names in `relaxableToolIds` (D16). Applying the same
 * deltas twice changes nothing.
 */
function withPlatformDecisions(
  policyRevision: RuntimePolicyRevision,
  relaxableToolIds: ReadonlySet<string> | undefined,
): RuntimePolicyRevision {
  const deltas = policyRevision.toolOverrides ?? [];
  if (deltas.length === 0) return policyRevision;
  return {
    ...policyRevision,
    toolPolicies: applyPolicyOverlay(
      policyRevision.toolPolicies,
      deltas,
      relaxableToolIds ? { relaxableToolIds } : {},
    ).policies,
  };
}
```

3. In `src/runtime/turn-snapshot.ts`, replace:

```ts
  localLimits: ExecutionBudget;
  promptPin?: PromptPin;
  startedAt?: string;
}): TurnSnapshot {
```

with:

```ts
  localLimits: ExecutionBudget;
  promptPin?: PromptPin;
  startedAt?: string;
  /**
   * D16: the tools whose confirmation a signed Platform decision may switch
   * off, `relaxableToolIds(setupArtifact)` of the running code. Without it a
   * snapshot built straight from a Platform deployment relaxes nothing.
   */
  relaxableToolIds?: ReadonlySet<string>;
}): TurnSnapshot {
```

4. In `src/runtime/turn-snapshot.ts`, replace:

```ts
    policyRevision: clone(withPlatformDecisions(policyRevision)),
```

with:

```ts
    policyRevision: clone(withPlatformDecisions(policyRevision, options.relaxableToolIds)),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/turn-snapshot-relaxations.test.ts src/runtime/__tests__/turn-snapshot.test.ts && bunx vitest run --maxWorkers=4 src/runtime src/server && bun run typecheck`
Expected: PASS — `Test Files  2 passed (2)`, `Tests  15 passed (15)`; runtime and server `Test Files  67 passed (67)`, `Tests  728 passed (728)` (the nine files that import `turn-snapshot.test.ts` keep their counts); typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/__tests__/turn-snapshot-relaxations.test.ts src/runtime/turn-snapshot.ts
git commit -m "feat(runtime): apply d16 relaxations on platform turn snapshots"
```

### Task 5: The managed local runtime source relaxes by the code report's locks

**Files:**
- Modify: `src/runtime/local-runtime-source.ts` (relaxable ids from the artifact, `relaxations` in the overlay report; replace blocks only, see the NUL note)
- Test: `src/runtime/__tests__/local-runtime-source.test.ts`

**Interfaces:**
- Consumes: `relaxableToolIds`, `applyPolicyOverlay(…, { relaxableToolIds })` (Task 3); the P02 `policyOverlay`/`platformRevisions` coupling (unchanged).
- Produces: in managed mode the composed policy revision switches a confirmation off exactly per D16 with `relaxableToolIds(setupArtifact)`; `LocalRuntimeSourceOptions.onPolicyOverlayApplied` receives `{ revisionId, ignored, relaxations }` (new field `relaxations: PolicyOverlayResult['relaxations']`). Standalone mode is unchanged.

- [ ] **Step 1: Write the refusal tests first**

The overlay report gains `relaxations`, so the two P04 assertions on it name them: the `delete` raise with `requiresApproval: false` is refused as tier 3, the disabled UI tool has none. The new block turns the fixture's endpoint tool into a writing route with a given code-report origin.

1. In `src/runtime/__tests__/local-runtime-source.test.ts`, replace:

```ts
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: REMOVED_TOOL_ID, reason: 'platform-tool-not-in-code' }],
    });
```

with:

```ts
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: REMOVED_TOOL_ID, reason: 'platform-tool-not-in-code' }],
      relaxations: [{ toolId: ENDPOINT_TOOL_ID, outcome: 'tier-3-always-requires-approval' }],
    });
```

2. In `src/runtime/__tests__/local-runtime-source.test.ts`, replace:

```ts
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: UI_TOOL_ID, reason: 'platform-tool-not-in-code' }],
    });
```

with:

```ts
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: UI_TOOL_ID, reason: 'platform-tool-not-in-code' }],
      relaxations: [],
    });
```

3. In `src/runtime/__tests__/local-runtime-source.test.ts`, replace:

```ts
  it('refuses managed mode without the Platform tenant and environment', () => {
```

with:

```ts
  describe('and a signed relaxation of confirmation (D16)', () => {
    /** The endpoint tool as a writing route with the given code report origin. */
    function writeArtifact(
      riskClass: 'write' | 'delete',
      requiresApprovalOrigin?: 'code-default' | 'local-policy',
    ): unknown {
      const artifact = fixtureArtifact() as { tools: Array<Record<string, unknown>> };
      Object.assign(artifact.tools[0]!, {
        method: riskClass === 'delete' ? 'DELETE' : 'POST',
        operationGroup: riskClass === 'delete' ? 'delete' : 'create',
        riskClass,
        requiresApproval: true,
        ...(requiresApprovalOrigin
          ? { provenance: { policyOrigin: { requiresApproval: requiresApprovalOrigin } } }
          : {}),
      });
      return artifact;
    }

    function relaxedTurn(setupArtifact: unknown, atRiskClass: 'write' = 'write') {
      const artifact = setupArtifact as { tools: Array<{ method: 'POST' | 'DELETE' }> };
      const bindings = fixtureBindings().map((binding) => (
        binding.executionKind === 'endpoint'
          ? { ...binding, method: artifact.tools[0]!.method }
          : binding
      ));
      const applied = vi.fn();
      const source = createLocalRuntimeSource(fixtureOptions({
        setupArtifact,
        bindings,
        identity: PLATFORM_IDENTITY,
        policyOverlay: () => overlay([{
          toolId: ENDPOINT_TOOL_ID,
          requiresApproval: false,
          pin: { toolId: ENDPOINT_TOOL_ID, atRiskClass },
        }]),
        platformRevisions: () => PLATFORM_REVISIONS,
        onPolicyOverlayApplied: applied,
      }));
      const snapshot = source.resolveTurnSnapshot({ turnId: 't-relaxed', principal });
      const registry = materializeManifestToolRegistry({ snapshot, bindings });
      const guard = createManagedTurnGuard({ snapshot, resolvePrincipal: async () => principal });
      return { applied, registry, guard };
    }

    // Refusals first.
    it('keeps a confirmation tool-policy.json locks or the report does not explain', async () => {
      for (const artifact of [writeArtifact('write', 'local-policy'), writeArtifact('write')]) {
        const { applied, registry, guard } = relaxedTurn(artifact);
        expect(registry.tasks_listTasks!.needsApproval).toBe(true);
        await expect(guard.resolveApproval({ toolName: 'tasks_listTasks', input: {} })).resolves.toBe(true);
        expect(applied).toHaveBeenCalledWith(expect.objectContaining({
          relaxations: [{ toolId: ENDPOINT_TOOL_ID, outcome: 'locked-locally' }],
        }));
      }
    });

    it('keeps tier 3 confirmed when the code raised the risk above the pin', async () => {
      const { applied, registry, guard } = relaxedTurn(writeArtifact('delete', 'code-default'));
      expect(registry.tasks_listTasks!.needsApproval).toBe(true);
      await expect(guard.resolveApproval({ toolName: 'tasks_listTasks', input: {} })).resolves.toBe(true);
      expect(applied).toHaveBeenCalledWith(expect.objectContaining({
        relaxations: [{ toolId: ENDPOINT_TOOL_ID, outcome: 'override-lapsed-risk-raised' }],
      }));
    });
  });

  it('refuses managed mode without the Platform tenant and environment', () => {
```

- [ ] **Step 2: Write the acceptance test**

In `src/runtime/__tests__/local-runtime-source.test.ts`, replace:

```ts
        relaxations: [{ toolId: ENDPOINT_TOOL_ID, outcome: 'override-lapsed-risk-raised' }],
      }));
    });
  });

  it('refuses managed mode without the Platform tenant and environment', () => {
```

with:

```ts
        relaxations: [{ toolId: ENDPOINT_TOOL_ID, outcome: 'override-lapsed-risk-raised' }],
      }));
    });

    // Acceptance.
    it('runs a code-default write tool without asking', async () => {
      const { applied, registry, guard } = relaxedTurn(writeArtifact('write', 'code-default'));
      expect(registry.tasks_listTasks!.needsApproval).toBe(false);
      await expect(guard.resolveApproval({ toolName: 'tasks_listTasks', input: {} })).resolves.toBe(false);
      expect(applied).toHaveBeenCalledWith({
        revisionId: OVERLAY_REVISION_ID,
        ignored: [],
        relaxations: [{ toolId: ENDPOINT_TOOL_ID, outcome: 'applied' }],
      });
    });
  });

  it('refuses managed mode without the Platform tenant and environment', () => {
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/local-runtime-source.test.ts`
Expected: FAIL — the report has no `relaxations` (two P04 cases and both refusals) and the code-default write tool still asks. `Test Files  1 failed (1)`, `Tests  5 failed | 21 passed (26)`

- [ ] **Step 4: Derive the relaxable tools from the setup artifact**

1. In `src/runtime/local-runtime-source.ts`, replace:

```ts
import {
  applyPolicyOverlay,
  overlayDescriptions,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

with:

```ts
import {
  applyPolicyOverlay,
  overlayDescriptions,
  relaxableToolIds,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

2. In `src/runtime/local-runtime-source.ts`, replace:

```ts
   * Managed mode only: returns the latest verified, restrict-only Platform
   * overlay, e.g. `policyOverlayFromRevision(revisions.policyRevision)` for
   * the deployment the sync manager accepted. Called synchronously when a new
   * turn starts; it must read local state, never the network.
```

with:

```ts
   * Managed mode only: returns the latest verified Platform overlay, e.g.
   * `policyOverlayFromRevision(revisions.policyRevision)` for the deployment
   * the sync manager accepted. It restricts the local policy and may switch a
   * confirmation off only where the setup artifact allows it (D16). Called
   * synchronously when a new turn starts; it must read local state, never
   * the network.
```

3. In `src/runtime/local-runtime-source.ts`, replace:

```ts
  /** Content-free report each time a new overlay revision is composed. */
  onPolicyOverlayApplied?: (report: {
    revisionId: string;
    ignored: PolicyOverlayResult['ignored'];
  }) => void;
```

with:

```ts
  /** Content-free report each time a new overlay revision is composed. */
  onPolicyOverlayApplied?: (report: {
    revisionId: string;
    ignored: PolicyOverlayResult['ignored'];
    relaxations: PolicyOverlayResult['relaxations'];
  }) => void;
```

4. In `src/runtime/local-runtime-source.ts`, replace:

```ts
  /**
   * Local code is the base; a verified Platform overlay can only restrict
   * it (spec 4.9). The composed revision keeps the Platform revision id so
   * revocations of that policy revision keep matching.
   */
  const composePolicyRevision = (
    overlay: VerifiedPolicyOverlay,
  ): RuntimePolicyRevision => {
    if (composed?.overlay === overlay) return composed.revision;
    const applied = applyPolicyOverlay(localToolPolicies, overlay.entries);
```

with:

```ts
  // D16: the code report decides which confirmations the Platform may relax.
  const relaxable = relaxableToolIds(artifact);

  /**
   * Local code is the base; a verified Platform overlay restricts it (spec
   * 4.9) and switches a confirmation off only for relaxable tools, pinned and
   * up to tier 2 (D16). The composed revision keeps the Platform revision id
   * so revocations of that policy revision keep matching.
   */
  const composePolicyRevision = (
    overlay: VerifiedPolicyOverlay,
  ): RuntimePolicyRevision => {
    if (composed?.overlay === overlay) return composed.revision;
    const applied = applyPolicyOverlay(localToolPolicies, overlay.entries, {
      relaxableToolIds: relaxable,
    });
```

5. In `src/runtime/local-runtime-source.ts`, replace:

```ts
    options.onPolicyOverlayApplied?.({
      revisionId: overlay.revisionId,
      ignored: applied.ignored,
    });
```

with:

```ts
    options.onPolicyOverlayApplied?.({
      revisionId: overlay.revisionId,
      ignored: applied.ignored,
      relaxations: applied.relaxations,
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/local-runtime-source.test.ts && bunx vitest run --maxWorkers=4 src/runtime src/server && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  26 passed (26)`; runtime and server `Test Files  67 passed (67)`, `Tests  731 passed (731)`; typecheck clean. `git diff --stat` still lists `src/runtime/local-runtime-source.ts` as `Bin` (the NUL byte survived).

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/__tests__/local-runtime-source.test.ts src/runtime/local-runtime-source.ts
git commit -m "feat(runtime): relax managed confirmations by the code report locks"
```

### Task 6: Runners report D16 support at registration

**Files:**
- Modify: `src/sync/capability-report.ts` (`POLICY_RELAXATIONS_VERSION`), `src/sync/control-plane-client.ts` (`policyRelaxations` option, registration), `src/sync/managed-sync.ts` (claims it with the setup artifact), `src/sync/index.ts`
- Test: `src/sync/__tests__/capability-report.test.ts`

**Interfaces:**
- Consumes: P04 `createManagedRuntimeSync({ setupArtifact })`, `RuntimeControlPlaneClient.register` (merges `discoveryDigest`). Platform side (read, unchanged): `runtime-connection.controller.ts` accepts `capabilities` as `z.record(z.string(), z.unknown())`, `runtime-connection.service.ts` checks it with `assertControlPlaneSafe` (`policyRelaxations` is no forbidden key) and only validates `discoveryDigest`, and stores the record in `runtime_runners.capabilities` (jsonb), so P08c can read `capabilities.policyRelaxations` without a Platform change here.
- Produces: `export const POLICY_RELAXATIONS_VERSION = 1` (`glirastes/sync`); `RuntimeControlPlaneClient` option `policyRelaxations?: boolean`; with it, every registration carries `capabilities.policyRelaxations: 1`; a caller-provided `policyRelaxations` that differs from what the runtime reports (also any value without the option) throws before anything is sent; `createManagedRuntimeSync` passes `policyRelaxations: true` exactly when it has a setup artifact.

- [ ] **Step 1: Write the refusal test first**

1. In `src/sync/__tests__/capability-report.test.ts`, replace:

```ts
import {
  capabilityReportFrom,
  uploadCapabilityReport,
} from '../capability-report.js';
```

with:

```ts
import {
  capabilityReportFrom,
  POLICY_RELAXATIONS_VERSION,
  uploadCapabilityReport,
} from '../capability-report.js';
```

2. In `src/sync/__tests__/capability-report.test.ts`, replace:

```ts
  it('refuses a code version that is not a sha256 digest', () => {
```

with:

```ts
  // Refusal first: the Platform shows a relaxation as effective only for a
  // runner that reports D16 support, so nothing may claim it by accident.
  it('never reports relaxation support without the code report, nor lets a caller claim it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ runnerId: id('7') })));
    const runtime = createManagedRuntimeSync({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      push: false,
    });

    await runtime.client.register({ capabilities: { engine: 'vercel-ai-sdk' } });
    await expect(runtime.client.register({ capabilities: { policyRelaxations: 1 } }))
      .rejects.toThrow(/policyRelaxations/);

    expect(requests(fetchImpl).map((request) => request.body))
      .toEqual([expect.objectContaining({ capabilities: { engine: 'vercel-ai-sdk' } })]);
  });

  it('refuses a code version that is not a sha256 digest', () => {
```

- [ ] **Step 2: Write the acceptance test**

In `src/sync/__tests__/capability-report.test.ts`, replace:

```ts
      .toEqual([expect.objectContaining({ capabilities: { engine: 'vercel-ai-sdk' } })]);
  });

  it('refuses a code version that is not a sha256 digest', () => {
```

with:

```ts
      .toEqual([expect.objectContaining({ capabilities: { engine: 'vercel-ai-sdk' } })]);
  });

  it('reports relaxation support next to the code version once the sync has the setup artifact', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ runnerId: id('7') })));
    const runtime = createManagedRuntimeSync({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-key',
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runnerKey: 'runner-a',
      version: '1.0.0',
      setupArtifact: artifact,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      push: false,
    });

    await runtime.client.register({ capabilities: { policyRelaxations: POLICY_RELAXATIONS_VERSION } });
    await expect(runtime.client.register({ capabilities: { policyRelaxations: 2 } }))
      .rejects.toThrow(/policyRelaxations/);

    expect(POLICY_RELAXATIONS_VERSION).toBe(1);
    expect(requests(fetchImpl)[0]?.body).toMatchObject({
      capabilities: { discoveryDigest: DISCOVERY_DIGEST, policyRelaxations: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a code version that is not a sha256 digest', () => {
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/sync/__tests__/capability-report.test.ts`
Expected: FAIL — the client sends a caller's `policyRelaxations` unchecked, and `POLICY_RELAXATIONS_VERSION` is undefined, so the managed sync sends no claim. `Test Files  1 failed (1)`, `Tests  2 failed | 7 passed (9)`

- [ ] **Step 4: Report the capability**

1. In `src/sync/capability-report.ts`, replace:

```ts
/** `sha256:` plus 43 base64url characters, the form the Platform registers (P08b Task 9). */
export const DISCOVERY_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
```

with:

```ts
/** `sha256:` plus 43 base64url characters, the form the Platform registers (P08b Task 9). */
export const DISCOVERY_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

/**
 * Runner capability `policyRelaxations` (D16): the version of the relaxation
 * rule this runner applies to signed Platform decisions (pinned, up to tier 2,
 * never over a local lock of its code report). The Platform shows a stored
 * relaxation of confirmation as effective only for environments whose runner
 * reports it; everywhere else it stays pending.
 */
export const POLICY_RELAXATIONS_VERSION = 1 as const;
```

2. In `src/sync/control-plane-client.ts`, replace:

```ts
import { DISCOVERY_DIGEST_PATTERN } from './capability-report.js';
```

with:

```ts
import {
  DISCOVERY_DIGEST_PATTERN,
  POLICY_RELAXATIONS_VERSION,
} from './capability-report.js';
```

3. In `src/sync/control-plane-client.ts`, replace:

```ts
    discoveryDigest?: string;
    manager: RuntimeSyncManager;
```

with:

```ts
    discoveryDigest?: string;
    /**
     * True when this runner composes signed Platform decisions with the
     * local code report (`createLocalRuntimeSource`, or `createTurnSnapshot`
     * with `relaxableToolIds`), so a Platform relaxation of confirmation takes
     * effect here (D16). Registration then reports `policyRelaxations`.
     */
    policyRelaxations?: boolean;
    manager: RuntimeSyncManager;
```

4. In `src/sync/control-plane-client.ts`, replace:

```ts
      capabilities.discoveryDigest = digest;
    }
    this.assertTechnicalMetadata(capabilities);
```

with:

```ts
      capabilities.discoveryDigest = digest;
    }
    const relaxations = this.options.policyRelaxations
      ? POLICY_RELAXATIONS_VERSION
      : undefined;
    if (
      capabilities.policyRelaxations !== undefined
      && capabilities.policyRelaxations !== relaxations
    ) {
      // Claiming D16 without applying it would show relaxations as effective
      // while the chat keeps asking, or the other way round.
      throw new Error('capabilities.policyRelaxations is reported by the runtime');
    }
    if (relaxations !== undefined) capabilities.policyRelaxations = relaxations;
    this.assertTechnicalMetadata(capabilities);
```

5. In `src/sync/managed-sync.ts`, replace:

```ts
  /**
   * The committed setup artifact of the running code, e.g. the generated
   * module's `setupArtifact`. Its discovery digest goes into every runner
   * registration, and `reportCapabilities()` uploads it as the capability
   * report (spec 4.10.6). Content-free; it never enables a tool.
   */
  setupArtifact?: unknown;
```

with:

```ts
  /**
   * The committed setup artifact of the running code, e.g. the generated
   * module's `setupArtifact`. Its discovery digest goes into every runner
   * registration, and `reportCapabilities()` uploads it as the capability
   * report (spec 4.10.6). Content-free; it never enables a tool. With it the
   * runner also reports `policyRelaxations` (D16): compose the turns from
   * the same artifact (`createLocalRuntimeSource`, or `createTurnSnapshot`
   * with `relaxableToolIds(setupArtifact)`).
   */
  setupArtifact?: unknown;
```

6. In `src/sync/managed-sync.ts`, replace:

```ts
    ...(report ? { discoveryDigest: report.discoveryDigest } : {}),
    manager,
```

with:

```ts
    ...(report ? { discoveryDigest: report.discoveryDigest } : {}),
    policyRelaxations: report !== undefined,
    manager,
```

7. In `src/sync/index.ts`, replace:

```ts
export {
  capabilityReportFrom,
  DISCOVERY_DIGEST_PATTERN,
  uploadCapabilityReport,
} from './capability-report.js';
```

with:

```ts
export {
  capabilityReportFrom,
  DISCOVERY_DIGEST_PATTERN,
  POLICY_RELAXATIONS_VERSION,
  uploadCapabilityReport,
} from './capability-report.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/sync/__tests__/capability-report.test.ts && bunx vitest run --maxWorkers=4 src/sync && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  9 passed (9)`; sync `Test Files  14 passed (14)`, `Tests  71 passed (71)`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/sync/__tests__/capability-report.test.ts src/sync/capability-report.ts \
  src/sync/control-plane-client.ts src/sync/index.ts src/sync/managed-sync.ts
git commit -m "feat(sync): report d16 relaxation support at runner registration"
```

### Task 7: `tools status` says which confirmations the Platform may relax

**Files:**
- Modify: `src/cli/commands/tools/status.ts` (`confirmationOrigin`, `platformMayRelax`), `src/cli/commands/tools/format.ts` (labels and hint)
- Test: `src/cli/commands/tools/tools-command.test.ts`

**Interfaces:**
- Consumes: `platformMayRelaxConfirmation`, `riskTier` (Task 1); the per-tool `provenance.policyOrigin.requiresApproval` of the committed setup artifact (Task 2).
- Produces: `ToolStatusEntry.confirmationOrigin: 'code-default' | 'local-policy' | null` and `ToolStatusEntry.platformMayRelax: boolean` (also in `tools status --json`, `schemaVersion` stays 1, fields only added). Human labels: `asks first, Platform may relax`, `asks first, locked in tool-policy.json` (tier ≤ 2 with origin `local-policy`), `asks first` (tier 3 or no origin), `runs directly`; one hint under the list when any tool may be relaxed. `tools policy show` does not exist yet (P05, roadmap row "CLI `tools policy …`"); P05 reuses these labels and `platformMayRelaxConfirmation` there.

- [ ] **Step 1: Write the failing tests**

1. In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
import { runToolsCommand } from './index.js';
```

with:

```ts
import { ToolsPipelineFailure } from '../../../codegen/tools/pipeline.js';
import { formatToolStatus, type ToolStatusEntry } from './format.js';
import { runToolsCommand } from './index.js';
```

2. In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
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
```

with:

```ts
    expect(out.join('\n')).toContain('What can my chat do? 2 active tools, 0 need attention.');
    expect(out.join('\n')).toContain('+ tasks.create  POST /api/tasks  write, asks first, Platform may relax');
    out.length = 0;
    expect(await runToolsCommand(['status', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      schemaVersion: 1,
      tools: [
        {
          name: 'tasks.create', route: 'POST /api/tasks', confirmation: true, confirmationOrigin: 'code-default',
          platformMayRelax: true, contractSource: 'derived', schemaQuality: 'field-names',
        },
        {
          name: 'tasks.list', route: 'GET /api/tasks', confirmation: false, confirmationOrigin: 'code-default',
          platformMayRelax: false, contractSource: 'derived', descriptionQuality: 'template',
        },
      ],
    });
```

3. In `src/cli/commands/tools/tools-command.test.ts`, replace:

```ts
  it('asks for a refresh when status finds no outputs', async () => {
```

with:

```ts
  it('says which confirmations a connected Platform may relax and which tool-policy.json locks', () => {
    const entry = (name: string, extra: Partial<ToolStatusEntry>): ToolStatusEntry => ({
      toolId: `019fb004-0000-7000-8000-00000000000${name.length}`,
      name,
      route: `POST /api/${name}`,
      enabled: true,
      needsAttention: false,
      riskClass: 'write',
      confirmation: true,
      confirmationOrigin: 'code-default',
      platformMayRelax: true,
      contractSource: 'native',
      descriptionQuality: 'code',
      schemaQuality: 'zod',
      ...extra,
    });
    const status = formatToolStatus([
      entry('create', {}),
      entry('archive', { confirmationOrigin: 'local-policy', platformMayRelax: false }),
      entry('purge', { riskClass: 'delete', platformMayRelax: false }),
      entry('list', { route: 'GET /api/list', riskClass: 'safe-read', confirmation: false, platformMayRelax: false }),
    ]);
    expect(status).toContain('+ create  POST /api/create  write, asks first, Platform may relax');
    expect(status).toContain('+ archive  POST /api/archive  write, asks first, locked in tool-policy.json');
    expect(status).toContain('+ purge  POST /api/purge  delete, asks first\n');
    expect(status).toContain('+ list  GET /api/list  safe-read, runs directly');
    expect(status).toContain('A Platform owner or admin can switch off a confirmation marked "Platform may relax"');
    expect(formatToolStatus([entry('archive', { confirmationOrigin: 'local-policy', platformMayRelax: false })]))
      .not.toContain('Platform may relax');
  });

  it('asks for a refresh when status finds no outputs', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts`
Expected: FAIL — status prints `asks first` without the origin and the JSON has neither new field. `Test Files  1 failed (1)`, `Tests  2 failed | 5 passed (7)`

- [ ] **Step 3: Label the confirmations**

1. In `src/cli/commands/tools/format.ts`, replace:

```ts
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';
```

with:

```ts
import { AppSetupArtifactSchema, type ToolRiskClass } from '../../../contracts/index.js';
import { riskTier } from '../../../contracts/tool-policy.js';
```

2. In `src/cli/commands/tools/format.ts`, replace:

```ts
  riskClass: ToolRiskClass;
  confirmation: boolean;
  contractSource: ContractSource | null;
```

with:

```ts
  riskClass: ToolRiskClass;
  confirmation: boolean;
  /** Where the code report says the confirmation comes from; null when it does not say. */
  confirmationOrigin: 'code-default' | 'local-policy' | null;
  /** D16: asks first, and a connected Platform's owner or admin may switch that off. */
  platformMayRelax: boolean;
  contractSource: ContractSource | null;
```

3. In `src/cli/commands/tools/format.ts`, replace:

```ts
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

with:

```ts
function confirmationLabel(entry: ToolStatusEntry): string {
  if (!entry.confirmation) return 'runs directly';
  if (entry.platformMayRelax) return 'asks first, Platform may relax';
  if (entry.confirmationOrigin === 'local-policy' && riskTier(entry.riskClass) <= 2) {
    return 'asks first, locked in tool-policy.json';
  }
  return 'asks first';
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
        + `${confirmationLabel(entry)}${state}`,
      `      contract: ${entry.contractSource ?? 'none'}, description: ${entry.descriptionQuality}, schema: ${entry.schemaQuality}`,
    );
  }
  if (entries.some((entry) => entry.platformMayRelax)) {
    lines.push(
      '',
      'A Platform owner or admin can switch off a confirmation marked "Platform may relax" for a connected app.',
      'To keep one, set "requiresApproval": true for the tool in .glirastes/tool-policy.json.',
    );
  }
  return lines.join('\n');
}
```

4. In `src/cli/commands/tools/status.ts`, replace:

```ts
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
```

with:

```ts
import { AppSetupArtifactSchema } from '../../../contracts/index.js';
import { platformMayRelaxConfirmation } from '../../../contracts/tool-policy.js';
```

5. In `src/cli/commands/tools/status.ts`, replace:

```ts
  return artifact.tools.map((tool): ToolStatusEntry => {
    const entry = reported.get(tool.toolId);
    return {
```

with:

```ts
  return artifact.tools.map((tool): ToolStatusEntry => {
    const entry = reported.get(tool.toolId);
    const confirmationOrigin = tool.provenance?.policyOrigin?.requiresApproval ?? null;
    return {
```

6. In `src/cli/commands/tools/status.ts`, replace:

```ts
      riskClass: tool.riskClass,
      confirmation: tool.requiresApproval,
      contractSource: entry?.contractSource ?? null,
```

with:

```ts
      riskClass: tool.riskClass,
      confirmation: tool.requiresApproval,
      confirmationOrigin,
      platformMayRelax: tool.requiresApproval
        && platformMayRelaxConfirmation(tool.riskClass, confirmationOrigin ?? undefined),
      contractSource: entry?.contractSource ?? null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/tools/tools-command.test.ts && bunx vitest run --maxWorkers=4 src/cli && bun run typecheck`
Expected: PASS — `Test Files  1 passed (1)`, `Tests  7 passed (7)`; cli `Test Files  30 passed (30)`, `Tests  278 passed (278)`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/cli/commands/tools/format.ts src/cli/commands/tools/status.ts \
  src/cli/commands/tools/tools-command.test.ts
git commit -m "feat(cli): show which confirmations the platform may relax"
```

### Task 8: Document the Platform relaxation

**Files:**
- Modify: `docs/managed-runtime-sync.md` (setup artifact in the example, new section "Code report and Platform decisions"), `README.md` (link)
- Create: `docs/tool-policy.md`

**Interfaces:**
- Consumes: the names of Tasks 1–7 (`relaxableToolIds`, `policyOverlayFromRevision`, `onPolicyOverlayApplied` with `relaxations`, `capabilities.policyRelaxations`, the `tools status` labels).
- Produces: user documentation only; no code, no test change. The skills (`skills/**`) are P05's (roadmap row P05 "sieben Skills"); see the Self-Review follow-ups.

- [ ] **Step 1: Write the documentation**

1. In `docs/managed-runtime-sync.md`, replace:

````markdown
```ts
import { createManagedRuntimeSync } from 'glirastes/sync';

const runtimeSync = createManagedRuntimeSync({
  baseUrl: process.env.GLIRASTES_URL!,
  apiKey: process.env.GLIRASTES_RUNTIME_KEY!,
  appId: process.env.GLIRASTES_APP_ID!,
  environmentId: process.env.GLIRASTES_ENVIRONMENT_ID!,
  runnerKey: 'get-it-done-production',
  version: '1.0.0',
  stateFilePath: '.glirastes/runtime-state.json',
````

with:

````markdown
```ts
import { createManagedRuntimeSync } from 'glirastes/sync';
import { setupArtifact } from './src/generated/glirastes/tools.generated';

const runtimeSync = createManagedRuntimeSync({
  baseUrl: process.env.GLIRASTES_URL!,
  apiKey: process.env.GLIRASTES_RUNTIME_KEY!,
  appId: process.env.GLIRASTES_APP_ID!,
  environmentId: process.env.GLIRASTES_ENVIRONMENT_ID!,
  runnerKey: 'get-it-done-production',
  version: '1.0.0',
  stateFilePath: '.glirastes/runtime-state.json',
  setupArtifact,
````

2. In `docs/managed-runtime-sync.md`, replace:

````markdown
await runtimeSync.client.register({
  capabilities: { aiSdk: true },
  technicalMetadata: { runtimeVersion: '1.0.0' },
});
void runtimeSync.client.start();
```
````

with:

````markdown
await runtimeSync.client.register({
  capabilities: { aiSdk: true },
  technicalMetadata: { runtimeVersion: '1.0.0' },
});
await runtimeSync.reportCapabilities();
void runtimeSync.client.start();
```
````

3. In `docs/managed-runtime-sync.md`, replace:

```markdown
## Runtime metrics
```

with:

````markdown
## Code report and Platform decisions

With `setupArtifact` (the committed, content-free code report the generated
module exports) every registration carries the code version
(`capabilities.discoveryDigest`) and `capabilities.policyRelaxations: 1`, and
`reportCapabilities()` uploads the report once per process. Without it the
runner registers neither.

The chat runs on the local code. Compose each turn from the deployment the
sync manager accepted, so Platform decisions apply without a Platform call per
turn:

```ts
import {
  createLocalRuntimeSource,
  policyOverlayFromRevision,
} from 'glirastes/runtime';
import type { MaterializedDeploymentRevisions } from 'glirastes/sync';

let accepted: MaterializedDeploymentRevisions | undefined; // the active deployment

const source = createLocalRuntimeSource({
  setupArtifact,
  bindings,
  localLimits,
  identity: { tenantId, targetAppId: appId, environmentId },
  policyOverlay: () => accepted && policyOverlayFromRevision(accepted.policyRevision),
  platformRevisions: () => accepted,
  onPolicyOverlayApplied: (report) => console.info('glirastes policy overlay', report),
});
```

A signed decision (`toolOverrides` of the policy revision) disables a tool,
raises its risk class, narrows its roles, requires confirmation, or replaces
its model-facing description. It never enables a tool the code lacks or keeps
disabled, and never lowers a risk class. It switches a confirmation off only
under all of these conditions (D16, see [tool policy](./tool-policy.md)):

- the decision is pinned to this tool at the risk class the code reported;
- the effective risk class is at most tier 2 (`write`) and not above the pin;
  a higher risk lets the relaxation lapse, and tier 3 always asks;
- the code report attributes the confirmation to the code default, so an
  explicit `"requiresApproval": true` in `.glirastes/tool-policy.json` (a local
  lock) always wins.

`onPolicyOverlayApplied` reports every attempted relaxation with its outcome
(`applied`, `locked-locally`, `override-lapsed-risk-raised`, …), content-free.
A runner that builds turn snapshots straight from Platform revisions passes
`relaxableToolIds: relaxableToolIds(setupArtifact)` to `createTurnSnapshot`;
without it nothing relaxes there, so register such a runner with
`setupArtifact` only once its snapshots get `relaxableToolIds`.

## Runtime metrics
````

4. In `README.md`, replace:

```markdown
See [managed local runtime sync](./docs/managed-runtime-sync.md).
```

with:

```markdown
See [managed local runtime sync](./docs/managed-runtime-sync.md) and
[tool policy](./docs/tool-policy.md) for what local policy and Platform
decisions may change, including the Platform relaxation of a confirmation.
```

5. Create `docs/tool-policy.md`:

````markdown
# Tool policy

`glirastes tools refresh` derives every tool from the code with deterministic
defaults: reads run directly, writes ask first, deletes and anything external
or financial always ask. Two layers may change a tool, and across all layers
the strictest value wins.

| Layer | Where | Written by |
| --- | --- | --- |
| Code defaults | method, destructive path tokens, declared effects | the generator |
| Local policy | `.glirastes/tool-policy.json`, committed | the developer or the CLI, never an agent |
| Platform decisions | signed `toolOverrides` of the deployed configuration | owners and admins of a connected app |

## Risk tiers and confirmation

| Tier | Risk classes | Confirmation |
| --- | --- | --- |
| 0 | `safe-read` | off |
| 1 | `read-sensitive` | off |
| 2 | `write` | on; a reviewed, pinned entry may switch it off |
| 3 | `delete`, `financial`, `external`, `unknown` | always on, enforced by the runtime |

Every layer may disable a tool, raise its risk class, narrow its roles and
require confirmation. No layer enables a tool the code disabled or lacks,
lowers a risk class or adds roles.

## Switching a confirmation off locally

A tier-2 relaxation needs a reviewed entry pinned to the tool id and its
current class. It lapses when the code raises the risk above the pin.

```json
{
  "schemaVersion": 1,
  "tools": {
    "PATCH /api/tasks/:id": {
      "requiresApproval": false,
      "reason": "reviewed in PR 42",
      "pin": { "toolId": "<toolId from .glirastes/setup-artifact.json>", "atRiskClass": "write" }
    }
  }
}
```

## Platform relaxations (connected apps)

An owner or admin can switch a tool's confirmation off in the dashboard. The
signed decision takes effect in the running chat only when all of this holds:

1. It is part of a verified configuration and pinned to this tool id at the
   risk class the code reported when it was saved.
2. The tool's effective risk class is at most tier 2 and not above the pin.
   When the code or a later decision raises the risk, the relaxation lapses
   and the tool asks again. Tier 3 and `unknown` never relax.
3. The code report attributes the confirmation to the code default. Anything
   `tool-policy.json` decided is a local lock the Platform never relaxes: an
   explicit `"requiresApproval": true` (also on a tool that asks anyway) and a
   risk raise that brings confirmation.
4. The runner reports relaxation support at registration
   (`capabilities.policyRelaxations`), which it does when it registers with
   its setup artifact. The dashboard shows the relaxation as effective only
   for such runners; everywhere else it stays pending and the tool asks.

To keep a confirmation whatever the dashboard says, lock it:

```json
{
  "schemaVersion": 1,
  "tools": {
    "POST /api/invoices": { "requiresApproval": true, "reason": "always confirm invoices" }
  }
}
```

After `glirastes tools refresh` the code report names the confirmation
`local-policy`. `glirastes tools status` shows each asking tool as
`asks first, Platform may relax` or `asks first, locked in tool-policy.json`
(tier 3 just `asks first`).
````

- [ ] **Step 2: Check the documentation**

Run: `cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && git add -N docs/tool-policy.md && git diff --check && grep -c 'tool-policy.md' README.md docs/managed-runtime-sync.md && ! grep -n 'restrict-only' README.md docs/managed-runtime-sync.md docs/tool-policy.md`
Expected: `git add -N` makes the new file visible to `git diff --check`, which prints nothing (no trailing whitespace in any of the three files); the counts read `README.md:1` and `docs/managed-runtime-sync.md:1`; no doc says "restrict-only"; exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add README.md docs/managed-runtime-sync.md docs/tool-policy.md
git commit -m "docs: explain platform relaxations of a confirmation"
```

### Task 9: Full gate, browser proof and CLI smoke

**Files:** none (verification only, no commit).

- [ ] **Step 1: Run every gate**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run typecheck && bun run build && bun run typecheck:tests && bunx vitest run --maxWorkers=4
```

Expected: every command exits 0 — the build prints `Generated 18 subpath shims.`; Vitest reports `Test Files  212 passed (212)` and `Tests  2330 passed (2330)` (baseline 210 files and 2256 tests plus 2 files and 74 tests: Task 1 +36, Task 2 +1, Task 3 +27, Task 4 +4, Task 5 +3, Task 6 +2, Task 7 +1); measured 101 s at load 14–21 and 305 s at load 13–32, without a timeout. A 5-second timeout confined to the known timing files (`src/codegen/tools/handler-analysis.test.ts`, `program.test.ts`, `schema-probe.test.ts`, `src/react/components/__tests__/voice-push-to-talk.test.tsx`, the embed timing tests) is rerun alone with `bunx vitest run <file>` and counts as load noise only if it passes alone; any other failure is real.

- [ ] **Step 2: Run the browser proof (regression of the managed handler path)**

`createGeneratedRuntimeSource` → `createLocalRuntimeSource` now parses the artifact for `relaxableToolIds` at boot, on the path the browser shell uses. Check that nothing listens on port 3191 (`lsof -i :3191` prints nothing), then run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools \
  && export PLAYWRIGHT_MODULE=/Users/philipprollmann/Dev/chainmatics/design-studio/node_modules/playwright/index.mjs \
  && PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs \
  && REFERENCE_NEXT_MODE=production PLAYWRIGHT_CHANNEL=chrome node --test --test-reporter=spec tests/source-driven-browser.test.mjs
```

Expected: both runs end with `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`, and the diagnostic reads "Verified real Next HTTP + SSE, scoped endpoint results, generated navigation, URL filter and client action tools through the app router and bus, and common desktop/mobile layout geometry and draft retention. Test model only; no LLM/STT/timing claim."; no browser is downloaded and no `.browser-proof-*` directory is left in `examples/source-driven-next`. Other worktrees and scratch replays run the same proof on port 3191: a run that fails with `listen EADDRINUSE: address already in use 127.0.0.1:3191` collided with one of them and is rerun once `lsof -i :3191` has printed nothing for half a minute. Under heavy load (seen at load 36 during the plan check) the main test can print the diagnostic and still fail with `AggregateError: Reference cleanup failed` / `Browser cleanup timed out`; rerun that mode once the port is free again, and count either case as noise only if the rerun reports `ℹ pass 6`. Any other failure is real.

- [ ] **Step 3: Smoke the built CLI on a copy of the fixture, with a local lock**

Run:

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools \
  && SMOKE=$(mktemp -d examples/source-driven-next/.smoke-XXXXXX) \
  && cp -R examples/source-driven-next/native/. "$SMOKE" \
  && mkdir -p "$SMOKE/node_modules" && ln -s "$PWD" "$SMOKE/node_modules/glirastes" \
  && node dist/cli/bin.js tools refresh --root "$SMOKE" \
  && node dist/cli/bin.js tools check --root "$SMOKE" \
  && node dist/cli/bin.js tools check --integrity-only --root "$SMOKE" \
  && node dist/cli/bin.js tools status --root "$SMOKE" \
  && printf '%s\n' '{ "schemaVersion": 1, "tools": { "GET /api/tasks": { "requiresApproval": true, "reason": "smoke: keep asking" } } }' > "$SMOKE/.glirastes/tool-policy.json" \
  && node dist/cli/bin.js tools refresh --root "$SMOKE" \
  && node dist/cli/bin.js tools status --root "$SMOKE"; \
  STATUS=$?; node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" "$SMOKE"; exit $STATUS
```

Expected: exit 0. The first refresh prints `Glirastes tools (write): 4 added, 0 changed, 0 removed` with `+ tasks.list  GET /api/tasks  [safe-read]` and the three UI tools; both checks print `Tool outputs match the code.` and `Tool outputs verified (integrity).`; the first status prints `What can my chat do? 4 active tools, 0 need attention.` with `+ tasks.list  GET /api/tasks  safe-read, runs directly` and no hint (P04 output unchanged). After the lock the refresh prints `Updated 5 file(s). Commit them together with your code.` and the second status shows `+ tasks.list  GET /api/tasks  safe-read, asks first, locked in tool-policy.json`. The copy is gone afterwards.

- [ ] **Step 4: Record the checkpoint (no commit)**

Note in the P04b checkpoint report: gate results and test counts, both browser runs, the smoke, the vector digest `dcf3470e7553a05bcd08e7d32cef3a42949f6d50177addb26a674d6287db774e` for the Platform re-sync, and the open items of the Self-Review (Platform lockstep, P05/P08c/P11/P13 follow-ups, roadmap rows to update).

---

## Self-Review

**Spec coverage (requirement → task):**

| Requirement | Covered by |
| --- | --- |
| Spec 4.1/4.5/4.9, Citadel D16 (a): the overlay and the turn snapshot honour a signed `requiresApproval: false` pinned with `atRiskClass` at the tool's class, exactly per `relaxationAllowed` of `resolveToolPolicy`, up to tier 2 | Tasks 1, 3, 4, 5 |
| Lapses when the risk rises (code raise or raise in the same decision; spec 4.5 Lebenszyklus), never tier 3 or `unknown` (spec 4.5, 4.12 "Runtime: … Stufe 3 nicht lockern") | Tasks 1, 3, 4, 5 (refusal steps) |
| Never over an explicit local `requiresApproval: true` (spec 4.5, 10 item 5); Citadel D16 (c): the code report marks every explicit local `true` `local-policy` | Tasks 2, 3, 5 |
| Shared golden vectors extended with relaxation cases for the Platform port (new digest) | Task 1 |
| The runner reports D16 support at registration so P08c shows a relaxation as effective only for such runners (roadmap D16 row; Platform accepts extra capability keys) | Task 6 |
| Flip the existing restrict-only tests on purpose (P04 checkpoint item 1: `policy-overlay.test.ts` and the parity case "pinned relaxation attempt on write") | Task 3 Step 1 |
| Docs (`docs/managed-runtime-sync.md`, tool policy docs) and the CLI output mention the Platform relaxation | Tasks 7, 8 |
| Security first: refusal tests (tier 3, unknown, risk raised, local lock, unsigned/unpinned) before the acceptance tests | Task 1 (vector order pinned), Tasks 3–6 (separate refusal steps) |

Not in P04b: the Platform half of D16 (`boundToolOverride`, `capabilities`, Citadel form; P08c/P08d per the roadmap), `tools policy show` (P05, not yet existing), skills text (P05), Get It Done wiring (P11).

**Deliberate decisions and deviations (veto possible):**
- One rule, extracted rather than re-implemented: `confirmationRelaxationOutcome` is the body of P02's `relaxationAllowed` (same checks, same order), and `resolveToolPolicy` maps its outcome to the same warnings and errors as before. All 44 existing vectors stay green, so `TOOL_POLICY_RULES_VERSION` stays 1 and the Platform port needs no rule change, only the byte copy of the vector file and its new digest. The 14 new vectors live in `tool-policy.v1.json` under a new rule group `relaxation`.
- The runtime does not re-run `resolveToolPolicy` per tool: it keeps P04's restriction composition (an out-of-enum Platform risk class still raises to `unknown` instead of disabling the tool) and adds the D16 step on top. Parity with `resolveToolPolicy` is proven per case in the composition form (Task 3, every case relaxable and locked) and per class × pin (Task 1). One divergence is deliberate and unreachable from a signed revision: a delta that raises a tool which runs directly into confirmation (`safe-read` → `write`) and carries a pinned `requiresApproval: false` in the same entry keeps asking in the runtime unless the tool is relaxable, whereas `resolveToolPolicy` in the composition form (no local `requiresApproval`, the tool does not ask) relaxes it. The Platform never signs that delta (`boundToolOverride` keeps a `requiresApproval: false` only when the code reports the tool as asking, and the Citadel form never relaxes in a draft that raises the risk, 4.2.4 (c)), so the runtime keeps the stricter result instead of a second lock rule; checked by a scratch probe at the Task 3 tree (overlay `locked-locally`, `resolveToolPolicy` `requiresApproval: false`).
- Local lock = "the report does not attribute the confirmation to `code-default`". That is stricter than `resolveToolPolicy` on raw layers in one case: a `tool-policy.json` risk raise from `safe-read` to `write` brings a confirmation that `resolveToolPolicy` would let a Platform relaxation pinned at `write` switch off (vector `approval/local-raise-lets-platform-relaxation-lapse` shows the pinned-below variant). Here it is a lock, matching the Citadel form (offers "Ausschalten" only for `origin = code-default`, 4.2.4 (a)) and spec 10 item 5 ("das Strengste gewinnt"). A missing provenance (pre-P04 artifact) is a lock as well.
- Fail closed by default: `applyPolicyOverlay` without `relaxableToolIds` and `createTurnSnapshot` without them relax nothing. Only the two SDK paths that hold the code report pass them (`createLocalRuntimeSource` itself; a snapshot consumer via `relaxableToolIds(setupArtifact)`).
- More than one decision for a tool in one overlay is `duplicate-decisions` and never relaxes; a signed revision cannot carry that (P04 schema: one delta per `toolId`), but `applyPolicyOverlay` is public.
- `capabilities.policyRelaxations` is tied to the setup artifact in `createManagedRuntimeSync`: a runner that reports its code (and therefore its locks) and composes turns from it claims D16. The Get It Done pilot today registers without the artifact and builds snapshots without the code report, so it claims nothing and its relaxations stay pending, which is truthful. A consumer that runs `createLocalRuntimeSource` in managed mode but registers without the artifact would apply relaxations the Platform shows as pending; it also has no code report, so the Platform shows no per-tool view for it (Citadel "Code-Stand nicht gemeldet"), and the docs require the artifact (Task 8).
- Outcomes are reported, not thrown: `PolicyOverlayResult.relaxations` and `onPolicyOverlayApplied` carry tool ids and codes only, so a runner can log why a relaxation did not apply (spec 4.4 warning `override-lapsed-risk-raised` at runtime).
- The snapshot cases live in a new self-contained file instead of `turn-snapshot.test.ts`, whose tests nine importing files re-register (P04 ledger X5).
- `tools status` gains two JSON fields within `schemaVersion: 1` (additive) and changes the human label only for asking tools; P04's smoke output for the fixture (no asking tool) is unchanged.

**Platform lockstep requests (not done here; owners per roadmap D16 row: P08c API tasks, P08d):**
- Vectors: copy `src/contracts/__vectors__/tool-policy.v1.json` byte for byte to `apps/api/src/modules/runtime-setup-v2/__vectors__/tool-policy.v1.json`, set `SDK_VECTORS_SHA256` to `dcf3470e7553a05bcd08e7d32cef3a42949f6d50177addb26a674d6287db774e` and the README commit to the Task 1 commit. No port change is needed for the rule (the extracted function is behaviour-preserving): a scratch copy of the port's `tool-policy.ts` at `mvp-platform` `7ede1a5` reproduces all 58 vectors serialised byte for byte, as its parity spec compares them.
- `boundToolOverride` / `reportedToolPolicy`: read `provenance.policyOrigin.requiresApproval` of the uploaded artifact and compose like the runtime — `local: { allowedRoles?, requiresApproval: true }` when the reported tool asks (`requiresApproval: true`) and its reported origin is not `code-default` (a missing origin included), and no local `requiresApproval` for a tool that runs directly — so a relaxation over a local lock resolves to `requiresApproval: true` with origin `local-policy` (vector `relaxation/local-lock-wins`); refusing to save such a relaxation (422) matches the form, which does not offer it. Keep today's rule that a `requiresApproval: false` is signed only for a tool the code reports as asking (see the parity divergence above). The capability view keeps taking `origin` from the report for every field the Platform did not change (it already does in `capability-view.service.ts`), because `resolveToolPolicy` names an explicit local `true` on an asking tool `code-default` when no relaxation is in play.
- `capabilities` / `relaxationPending`: report a stored, in-bounds relaxation as effective (`requiresApproval = false`, `origin.requiresApproval = platform`, `relaxationPending = false`) only for environments whose registered runner has `capabilities.policyRelaxations >= 1` (stored on the runner row by the existing registration; no schema change), and keep `relaxationPending = true` elsewhere. A relaxation the D16 rule refuses at the reported class (tier 3, pin below the class) stays pending or is clamped, as today.
- Registration needs no change: the controller schema accepts any capability record, `assertControlPlaneSafe` lets `policyRelaxations` through, only `discoveryDigest` is validated, and the record lands in `runtime_runners.capabilities` (checked read-only at `mvp-platform` `7ede1a5`).

**Follow-ups for other plans (to add to the roadmap, controller):**
- Roadmap D16 row: SDK half delivered by P04b; P04 Ziel 1 ("loosen on none") is superseded for `requiresApproval: false`. P08c's Citadel form condition (e) "D16 geliefert" becomes "runner reports `capabilities.policyRelaxations`". Add a P04b row to the "Teilpläne" table (SDK `mvp-tools`, after P04 and the Wave 3 merge, before P05).
- P05 and P07b plans written in parallel against `064f8a9`: P04b runs first on the same worktree and changes `src/contracts/tool-policy.ts`, `src/contracts/index.ts`, `src/contracts/__vectors__/tool-policy.v1.json` (new digest), `src/codegen/tools/pipeline.ts` and `pipeline.test.ts`, `src/runtime/policy-overlay.ts` (whole file), `src/runtime/index.ts`, `src/runtime/turn-snapshot.ts`, `src/runtime/local-runtime-source.ts`, `src/sync/{capability-report,control-plane-client,managed-sync,index,local-deployment-validator}.ts`, `src/cli/commands/tools/{format,status}.ts` and `tools-command.test.ts`, `README.md` and `docs/managed-runtime-sync.md`; their replace blocks and measured counts for these files must be rebased on the P04b result (controller), and the baseline for P05 is the P04b gate (`212` files, `2330` tests).
- P05: `tools policy show` (and `relax`/`confirm`) print the same labels as `tools status` (`Platform may relax`, `locked in tool-policy.json`) through `platformMayRelaxConfirmation`; `tools policy confirm` on a tool that already asks now writes a local lock (Task 2 reports it `local-policy`), so its output says that the dashboard can no longer relax it and `tools policy reset` lifts the lock; `skills/maintaining-glirastes-tools` explains the lock (`"requiresApproval": true`) and that the dashboard may relax code-default confirmations up to tier 2.
- P07b: direct `tool` commands (no model call) take the confirmation from the turn snapshot (`authorizeToolCall`, or the registry's `needsApproval` built from it), never from the setup artifact's `requiresApproval`, so D16 relaxations and local locks apply to them exactly as to model tool calls.
- P11 (Get It Done): either move the managed path to `createLocalRuntimeSource` with `policyOverlay`/`platformRevisions` (P04 checkpoint item 9), or pass `relaxableToolIds(setupArtifact)` to `createTurnSnapshot` before registering with `setupArtifact`; otherwise the runner claims `policyRelaxations` while its snapshots relax nothing (fails safe: the chat keeps asking, the dashboard says "Gelockert"). Log `onPolicyOverlayApplied` reports.
- P05/P13 with P08b/P10 (roadmap row "Registrierter `discoveryDigest` deckt nur das Endpunkt-Inventar ab", P04 ledger X12): a local lock lives in `tool-policy.json`, which does not change the registered `discoveryDigest`. Until the digest covers the whole artifact, an environment whose code still has a lock that newer code with the same endpoint inventory removed is shown as relaxable (and a stored relaxation as effective) while its runtime keeps asking (`locked-locally`); the reverse case only hides the offer. Both fail safe; P08c labels `codeVersion` as the endpoint inventory version meanwhile.
- P13: release notes for 0.5.0 name the new exports (`confirmationRelaxationOutcome`, `platformMayRelaxConfirmation`, `relaxableToolIds`, `POLICY_RELAXATIONS_VERSION`) and the `onPolicyOverlayApplied` report field.

**Placeholder scan:** done — every step carries complete code (new files in full, `policy-overlay.ts` as whole content, other files as exact replace blocks that each occur once when applied in order) or exact commands; no TBD/TODO, no "similar to Task N". RED and GREEN counts were measured by replaying every task on a `git archive` copy of `064f8a9` with the worktree's `node_modules` linked: each task's test steps on its parent (RED), then the task (GREEN), with `--maxWorkers=4` for folder runs at load 13–32. The rendered plan was then applied mechanically (every Create, whole-content and replace block, in document order) to a fresh `git archive` of `064f8a9`; the result is byte-identical to the tested tree (8 commits, subjects 52–68 characters, every `git add` list equal to the files the task touches), and the full gate, both browser runs and the smoke ran on it. Independent plan check (2026-10-05, own parser, fresh `git archive` of `064f8a9`): every block applied once in document order; every RED and GREEN count above reproduced task by task; the 58 vectors hash to the pinned digest and the Platform port at `mvp-platform` `7ede1a5` serialises all 58 identically; the checker's edits (wording of the composition form, a doc comment in `local-deployment-validator.ts`, one test comment) changed no count, and the final plan text gave `212` files / `2330` tests, typecheck, build (`Generated 18 subpath shims.`) and `typecheck:tests` 0. The smoke output above and both browser modes `ℹ pass 6` were reproduced on the tree before those comment-only edits (the first dev run hit `Browser cleanup timed out` at load 36, the next two collided with another replay on port 3191; the rerun on a free port passed).

**Type consistency check:** done — names used verbatim across tasks: `ConfirmationRelaxationOutcome`/`confirmationRelaxationOutcome`, `platformMayRelaxConfirmation`, `PolicyOverlayOptions`, `PolicyOverlayRelaxation`/`PolicyOverlayRelaxationOutcome`, `PolicyOverlayResult.relaxations`, `relaxableToolIds` (function, option of `applyPolicyOverlay` and `createTurnSnapshot`), `onPolicyOverlayApplied({ revisionId, ignored, relaxations })`, `POLICY_RELAXATIONS_VERSION`, `capabilities.policyRelaxations`, `ToolStatusEntry.confirmationOrigin`/`platformMayRelax`, `TOOL_POLICY_VECTORS_SHA256`. Compile-time proof: `bun run typecheck:tests` over every new and changed test (Task 9 Step 1).
