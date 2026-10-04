# Tool-Policy und Laufzeit-Durchsetzung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the shared, pure tool-policy contract (risk tiers, deterministic defaults, bounded resolution, `tool-policy.json` schema, golden vectors) and enforce it at runtime (tier-3 confirmation floor, per-tool fail-closed bindings, restrict-only Platform overlay on a local base).

**Architecture:** A new pure module `src/contracts/tool-policy.ts` holds every policy rule the generator (P03), the CLI and the Platform port (P08) share; golden vectors in `src/contracts/__vectors__/tool-policy.v1.json` pin its behaviour across repos. The runtime keeps the locally generated setup artifact as the policy base and composes a verified Platform overlay restrict-only per new turn (pinned per turn, no network), while the registry, discovery and authorization apply the tier-3 floor and disable only the tool whose binding or policy is broken. Work happens in the isolated worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools` on branch `codex/mvp-tools`, branched from `codex/glirastes-foundation-runtime` after P01 is committed there.

**Tech Stack:** TypeScript 5.7 (NodeNext, strict, `.js` import suffixes), Zod v4 (`zod@^4`), Vitest 4, Bun.

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (sections 4.1 data flow, 4.5 Risiko-Defaults und Policy-Grenzen incl. Lebenszyklus, 4.9 Laufzeit-Durchsetzung, 4.12 Runtime and Zusatzkorpus bullets, 10.5)

## Global Constraints

- Rules version: `TOOL_POLICY_RULES_VERSION = 1`, pinned by golden vectors shared with the Platform port.
- Tiers: `safe-read` 0, `read-sensitive` 1, `write` 2, `delete`/`financial`/`external` 3, `unknown` 3.
- Default table: UI action ⇒ `ui`/`safe-read`/no confirmation; GET, HEAD ⇒ `read`/`safe-read`/no; POST ⇒ `create`/`write`/yes; PUT, PATCH ⇒ `update`/`write`/yes; DELETE ⇒ `delete`/`delete`/yes; unknown method ⇒ `update`/`write`/yes.
- Escalations only upward: destructive tokens `delete`, `remove`, `destroy`, `purge`, `erase`, `wipe`, `permanent`, `hard-delete`, `empty-trash`, `revoke` on non-GET ⇒ `delete`; declared effect ⇒ matching class; external-call evidence ⇒ `external`; UI handler with mutating fetch ⇒ `write`; `unknown` is never emitted.
- `allowedRoles` defaults to empty: the endpoint's own authorization applies; an empty list means "no additional restriction".
- `riskClass`: raise only. Confirmation: tier 0–1 free; tier 2 on by default, relaxed only by an explicit reviewed entry with `atRiskClass: 'write'`; tier 3 always on, the runtime enforces it too.
- `enabled` = code ∧ local ∧ Platform; nothing enables a `needs_attention`, excluded or missing tool.
- `allowedRoles`: intersection only. Description: Platform > local > code. Protection fields across all layers: the strictest wins; the Platform can never loosen a local hardening.
- Lifecycle: risk increases are taken over automatically and a stored relaxation below the new tier lapses (`override-lapsed-risk-raised`); a code-caused decrease is held (`risk-lower-available`) until `acceptedRisk`; a reappearing tool gets a new id and old relaxations do not revive.
- `tool-policy.json` = `{ schemaVersion: 1, tools: { <stableKey>: entry }, exclude: [{ match, reason }], acceptedRisk: { <stableKey>: { riskClass, toolId } } }`; invalid file ⇒ `E-POLICY-001`; relaxing tier 3 ⇒ `E-POLICY-002`.
- `compareArtifacts` gets class `added` (no confirmation) for new tools at least as strict as their defaults; relaxed new tools stay `loosening`.
- Runtime: `needsApproval = requiresApproval || tier >= 3`; overlay ids without a local tool are ignored (`platform-tool-not-in-code`); a missing or mismatched binding disables only that tool; revocations keep blocking; the principal is re-authorized before every call; no Platform call per turn.
- Conventions: Zod v4 (not class-validator), Vitest (not Jest), `FoundationDiagnosticError` with `E-*` codes, `.js` suffixes in relative imports, Bun only.
- Git: local commits only in `codex/mvp-tools`; no push, no merge into a main branch, no publish; Conventional Commits without AI or Co-Authored-By attribution.
- Do not touch Omnify; do not read `.env*`, `.secrets/`, `platform-connection.json`, `setup-receipt.json`, `runtime-state.json`.

## Review Focus

1. **Destructive-token boundaries.** `POST /api/tasks/deleted/restore`, `GET /api/tasks/deleted`, `PATCH …/archive` and `POST /api/reminders` must not escalate, while `tasks.bulkDelete`, `permanent-delete`, `empty-trash` and `revoke` must. Owning task: Task 2 (step 1, `TOKEN_BOUNDARIES` and `ESCALATIONS` rows).
2. **Disjoint role restrictions.** Local `['admin']` ∩ Platform `['member']` must disable the tool. It must never collapse to `[]`, which would mean "everyone". Owning tasks: Task 4 (step 1, "disables a tool whose role restrictions are disjoint") and Task 13 (step 1, "disables a tool whose role restrictions do not overlap").
3. **Reappeared tool and old relaxations.** An entry pinned to an earlier `toolId` must not relax the new tool, while its hardenings (roles, disable) stay. Owning task: Task 5 (step 1, "never revives a relaxation for a reappeared tool").
4. **Raised risk versus equality checks.** A Platform or local raise must not hide or kill the tool. Today the registry, discovery and the deployment validator all demand `policy.riskClass === manifest.riskClass`. The raise must still force confirmation at tier 3. Owning task: Task 12 (step 1, registry, discovery and validator tests).
5. **Overlay change mid-turn.** A new overlay must not change an already pinned turn, because approval continuations reuse the turn id. Resolving must never touch the network. Owning task: Task 14 (step 1, "pins each turn to the overlay it started with").

---

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `src/contracts/tool-policy.ts` | Create | Shared pure policy contract: tiers, floor, defaults, entry/file schemas, `resolveToolPolicy` |
| `src/contracts/__vectors__/tool-policy.v1.json` | Create | Golden vectors for `resolveToolPolicy`, copied verbatim by the Platform port (P08) |
| `src/contracts/__tests__/tool-policy-tiers.test.ts` | Create | Tiers, floor, raise-only and role intersection |
| `src/contracts/__tests__/tool-policy-defaults.test.ts` | Create | Default table and escalations |
| `src/contracts/__tests__/tool-policy-file.test.ts` | Create | `tool-policy.json` schema and `E-POLICY-001` |
| `src/contracts/__tests__/tool-policy-resolve.test.ts` | Create | Resolution bounds, relaxation pins, ratchet, entry validation |
| `src/contracts/__tests__/tool-policy-vectors.test.ts` | Create | Runs every golden vector |
| `src/contracts/__tests__/tool-policy-exports.test.ts` | Create | Guards the `glirastes/contracts` surface |
| `src/diagnostics/foundation-diagnostic.ts` | Modify (lines 1–9) | Adds the `E-POLICY-*` code family |
| `src/contracts/index.ts` | Modify (after line 67) | Exports the tool-policy contract |
| `src/contracts/semantic-change.ts` | Modify (lines 1–66, 127) | Tier-based risk comparison, `added` classification |
| `src/contracts/__tests__/semantic-change.test.ts` | Modify (lines 92–108) | New risk expectations |
| `src/cli/commands/setup-plan.ts` | Modify (lines 4–10, 116–153) | `added` for new tools at their defaults |
| `src/cli/commands/setup-plan.test.ts` | Modify (line 1, after 109, after 192) | New-tool classification tests |
| `src/runtime/authorization.ts` | Modify (lines 1–7, 69–73) | Tier-3 floor in `requiresApproval` |
| `src/runtime/local-tool-bindings.ts` | Modify (lines 1–11, 119–156, 175–240) | Floor, per-tool fail-closed diagnostics, tier comparison |
| `src/runtime/local-runtime-source.ts` | Modify (lines 1–70, 221–275) | Floor; local base plus verified overlay (managed mode) |
| `src/runtime/policy-overlay.ts` | Create | `applyPolicyOverlay`, `policyOverlayFromRevision` |
| `src/runtime/tool-discovery.ts` | Modify (lines 1–5, 132) | Tier comparison instead of equality |
| `src/sync/local-deployment-validator.ts` | Modify (lines 1–4, 44–46) | Tier comparison instead of equality |
| `src/runtime/index.ts` | Modify (lines 47–55, append) | Exports overlay helpers and registry diagnostics |
| `src/runtime/__tests__/authorization.test.ts` | Modify (append) | Floor test |
| `src/runtime/__tests__/managed-turn.test.ts` | Modify (append) | Floor through `resolveApproval` |
| `src/runtime/__tests__/local-tool-bindings.test.ts` | Modify | Floor, per-tool disable, risk tiers |
| `src/runtime/__tests__/local-runtime-source.test.ts` | Modify | Floor, managed overlay |
| `src/runtime/__tests__/tool-discovery.test.ts` | Modify (append) | Raised risk stays discoverable |
| `src/sync/__tests__/local-deployment-validator.test.ts` | Modify (append) | Raised risk accepted, lowered rejected |
| `src/runtime/__tests__/policy-overlay.test.ts` | Create | Overlay semantics and parity with `resolveToolPolicy` |
| `src/runtime/__tests__/policy-exports.test.ts` | Create | Guards the `glirastes/runtime` surface |

All paths below are relative to `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools`. Line numbers refer to the file as it is when the task starts. If an earlier edit in the same task shifts lines, locate the change by the quoted code; the quoted code is authoritative.

---

### Task 0: Create the isolated worktree

**Files:** none changed.

**Interfaces:** Consumes the branch `codex/glirastes-foundation-runtime` with P01 committed. Produces the worktree `/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools` on `codex/mvp-tools`.

- [ ] **Step 1: Create worktree and branch**

```bash
git -C /Users/philipprollmann/Dev/chainmatics/glirastes worktree add /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools -b codex/mvp-tools codex/glirastes-foundation-runtime
```

Expected: `Preparing worktree (new branch 'codex/mvp-tools')`.

- [ ] **Step 2: Install and record the green baseline**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun install && bun run build && bun run typecheck && bun run typecheck:tests && bun run test
```

Expected: every command exits 0 (`typecheck:tests` is the gate P01 introduces). `bun run build` comes first because a fresh worktree has no `dist/`, and `tests/source-driven-*.test.ts` load `examples/source-driven-next/adapter.mjs`, which imports `glirastes/runtime`, `glirastes/codegen` and `glirastes/contracts` through the package self-reference into `dist/`. Note the passing test count for the final comparison in Task 15. If anything is red, stop and report; do not start Task 1 on a red baseline.

---

### Task 1: Risk tiers, confirmation floor, raise-only and role intersection

**Files:**
- Create: `src/contracts/tool-policy.ts`
- Test: `src/contracts/__tests__/tool-policy-tiers.test.ts`

**Interfaces:**
- Consumes: `type ToolRiskClass` from `src/contracts/revisions.ts`.
- Produces:
  - `export const TOOL_POLICY_RULES_VERSION = 1 as const;`
  - `export type RiskTier = 0 | 1 | 2 | 3;`
  - `export function riskTier(riskClass: ToolRiskClass): RiskTier;`
  - `export function confirmationFloor(riskClass: ToolRiskClass, requiresApproval: boolean): boolean;`
  - `export function mostRestrictiveRiskClass(current: ToolRiskClass, candidate: ToolRiskClass | undefined): ToolRiskClass;`
  - `export interface AllowedRolesIntersection { roles: string[]; disjoint: boolean }`
  - `export function intersectAllowedRoles(current: ReadonlyArray<string>, restriction: ReadonlyArray<string> | undefined): AllowedRolesIntersection;`

- [ ] **Step 1: Write the failing test**

Create `src/contracts/__tests__/tool-policy-tiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  confirmationFloor,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  riskTier,
} from '../tool-policy.js';

describe('riskTier', () => {
  it.each([
    ['safe-read', 0],
    ['read-sensitive', 1],
    ['write', 2],
    ['delete', 3],
    ['financial', 3],
    ['external', 3],
    ['unknown', 3],
  ] as const)('maps %s to tier %i', (riskClass, tier) => {
    expect(riskTier(riskClass)).toBe(tier);
  });

  it('pins the rules version', () => {
    expect(TOOL_POLICY_RULES_VERSION).toBe(1);
  });
});

describe('confirmationFloor', () => {
  it.each([
    ['safe-read', false, false],
    ['safe-read', true, true],
    ['read-sensitive', false, false],
    ['write', false, false],
    ['write', true, true],
    ['delete', false, true],
    ['financial', false, true],
    ['external', false, true],
    ['unknown', false, true],
  ] as const)('%s with requiresApproval=%s confirms=%s', (
    riskClass,
    requiresApproval,
    expected,
  ) => {
    expect(confirmationFloor(riskClass, requiresApproval)).toBe(expected);
  });
});

describe('mostRestrictiveRiskClass', () => {
  it.each([
    ['write', 'delete', 'delete'],
    ['delete', 'write', 'delete'],
    ['delete', 'financial', 'delete'],
    ['safe-read', undefined, 'safe-read'],
    ['write', 'unknown', 'unknown'],
  ] as const)('%s raised by %s is %s', (current, candidate, expected) => {
    expect(mostRestrictiveRiskClass(current, candidate)).toBe(expected);
  });
});

describe('intersectAllowedRoles', () => {
  it('treats an empty list as no restriction', () => {
    expect(intersectAllowedRoles([], undefined))
      .toEqual({ roles: [], disjoint: false });
    expect(intersectAllowedRoles([], ['member', 'admin', 'admin']))
      .toEqual({ roles: ['admin', 'member'], disjoint: false });
    expect(intersectAllowedRoles(['member', 'admin'], []))
      .toEqual({ roles: ['admin', 'member'], disjoint: false });
  });

  it('narrows to the shared roles', () => {
    expect(intersectAllowedRoles(['admin', 'member'], ['member', 'viewer']))
      .toEqual({ roles: ['member'], disjoint: false });
  });

  it('reports a disjoint restriction instead of returning everyone', () => {
    expect(intersectAllowedRoles(['admin'], ['member']))
      .toEqual({ roles: [], disjoint: true });
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-tiers.test.ts
```

Expected: FAIL, `Failed to load url ../tool-policy.js` (module does not exist).

- [ ] **Step 3: Minimal implementation**

Create `src/contracts/tool-policy.ts`:

```ts
import type { ToolRiskClass } from './revisions.js';

/**
 * Version of the default table and the policy bounds below. The golden
 * vectors in `__vectors__/tool-policy.v1.json` pin it; the Platform port
 * must produce byte-identical results for the same version.
 */
export const TOOL_POLICY_RULES_VERSION = 1 as const;

export type RiskTier = 0 | 1 | 2 | 3;

const RISK_TIERS: Readonly<Record<ToolRiskClass, RiskTier>> = {
  'safe-read': 0,
  'read-sensitive': 1,
  write: 2,
  delete: 3,
  financial: 3,
  external: 3,
  // An unassessed risk class is treated like the highest tier.
  unknown: 3,
};

export function riskTier(riskClass: ToolRiskClass): RiskTier {
  return RISK_TIERS[riskClass];
}

/**
 * The runtime confirmation floor: tier 3 always asks before it runs,
 * whatever any policy layer says.
 */
export function confirmationFloor(
  riskClass: ToolRiskClass,
  requiresApproval: boolean,
): boolean {
  return requiresApproval || riskTier(riskClass) >= 3;
}

/**
 * Raise-only combination. A candidate replaces the current class only from a
 * strictly higher tier; a same-tier relabel or a lower class never applies.
 */
export function mostRestrictiveRiskClass(
  current: ToolRiskClass,
  candidate: ToolRiskClass | undefined,
): ToolRiskClass {
  if (candidate === undefined) return current;
  return riskTier(candidate) > riskTier(current) ? candidate : current;
}

export interface AllowedRolesIntersection {
  /** Sorted, de-duplicated roles; empty means "no additional restriction". */
  roles: string[];
  /** Both sides restrict and nothing is left: nobody may call the tool. */
  disjoint: boolean;
}

export function intersectAllowedRoles(
  current: ReadonlyArray<string>,
  restriction: ReadonlyArray<string> | undefined,
): AllowedRolesIntersection {
  const left = normalizedRoles(current);
  const right = normalizedRoles(restriction ?? []);
  if (left.length === 0) return { roles: right, disjoint: false };
  if (right.length === 0) return { roles: left, disjoint: false };
  const roles = left.filter((role) => right.includes(role));
  return { roles, disjoint: roles.length === 0 };
}

function normalizedRoles(roles: ReadonlyArray<string>): string[] {
  return [...new Set(roles)].sort();
}
```

- [ ] **Step 4: Run the test and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-tiers.test.ts && bun run typecheck
```

Expected: PASS (25 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/tool-policy.ts src/contracts/__tests__/tool-policy-tiers.test.ts
git commit -m "feat(contracts): add tool risk tiers and confirmation floor"
```

---

### Task 2: Deterministic policy defaults with escalations

**Files:**
- Modify: `src/contracts/tool-policy.ts` (append)
- Test: `src/contracts/__tests__/tool-policy-defaults.test.ts`

**Interfaces:**
- Consumes: `riskTier`, `TOOL_POLICY_RULES_VERSION` (Task 1).
- Produces:
  - `export type DeclaredEffect = 'read' | 'write' | 'destructive' | 'external' | 'financial';`
  - `export interface ToolPolicyDefaultsInput { executionKind: 'endpoint' | 'ui'; method?: string; path?: string; definitionId: string; declaredEffect?: DeclaredEffect; evidence?: { externalCall?: boolean; uiMutation?: boolean } }`
  - `export interface ToolPolicyDefaults { operationGroup: 'read' | 'create' | 'update' | 'delete' | 'ui'; riskClass: Exclude<ToolRiskClass, 'unknown'>; requiresApproval: boolean; rulesVersion: typeof TOOL_POLICY_RULES_VERSION }`
  - `export function deriveToolPolicyDefaults(input: ToolPolicyDefaultsInput): ToolPolicyDefaults;`

- [ ] **Step 1: Write the failing test**

Create `src/contracts/__tests__/tool-policy-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  deriveToolPolicyDefaults,
  type ToolPolicyDefaults,
  type ToolPolicyDefaultsInput,
} from '../tool-policy.js';

type Expected = Pick<
  ToolPolicyDefaults,
  'operationGroup' | 'riskClass' | 'requiresApproval'
>;

const READ: Expected = {
  operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false,
};
const CREATE: Expected = {
  operationGroup: 'create', riskClass: 'write', requiresApproval: true,
};
const UPDATE: Expected = {
  operationGroup: 'update', riskClass: 'write', requiresApproval: true,
};
const DELETE: Expected = {
  operationGroup: 'delete', riskClass: 'delete', requiresApproval: true,
};
const UI: Expected = {
  operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false,
};

function endpoint(
  method: string | undefined,
  path: string,
  definitionId: string,
  extra: Partial<ToolPolicyDefaultsInput> = {},
): ToolPolicyDefaultsInput {
  return {
    executionKind: 'endpoint',
    ...(method === undefined ? {} : { method }),
    path,
    definitionId,
    ...extra,
  };
}

function ui(
  definitionId: string,
  extra: Partial<ToolPolicyDefaultsInput> = {},
): ToolPolicyDefaultsInput {
  return { executionKind: 'ui', definitionId, ...extra };
}

const TABLE: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['UI action', ui('ui.navigate'), UI],
  ['GET', endpoint('GET', '/api/tasks', 'tasks.list'), READ],
  ['HEAD', endpoint('HEAD', '/api/tasks', 'tasks.head'), READ],
  ['lowercase get', endpoint('get', '/api/tasks', 'tasks.list'), READ],
  ['POST', endpoint('POST', '/api/tasks', 'tasks.create'), CREATE],
  ['PUT', endpoint('PUT', '/api/tasks/[id]', 'tasks.replace'), UPDATE],
  ['PATCH', endpoint('PATCH', '/api/tasks/[id]', 'tasks.update'), UPDATE],
  ['DELETE', endpoint('DELETE', '/api/tasks/[id]', 'tasks.delete'), DELETE],
  ['missing method', endpoint(undefined, '/api/tasks/sync', 'tasks.sync'), UPDATE],
  ['unknown method', endpoint('OPTIONS', '/api/tasks', 'tasks.options'), UPDATE],
];

const ESCALATIONS: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['destructive path segment',
    endpoint('POST', '/api/tasks/bulk/delete', 'tasks.bulk'), DELETE],
  ['hyphenated permanent-delete',
    endpoint('POST', '/api/tasks/bulk/permanent-delete', 'tasks.bulkPermanent'),
    DELETE],
  ['empty-trash pair',
    endpoint('POST', '/api/trash/empty-trash', 'trash.empty'), DELETE],
  ['camelCase definitionId',
    endpoint('PATCH', '/api/users/[id]', 'users.hardDelete'), DELETE],
  ['camelCase bulk delete',
    endpoint('POST', '/api/tasks/bulk', 'tasks.bulkDelete'), DELETE],
  ['revoke',
    endpoint('POST', '/api/keys/[keyId]/revoke', 'apiKeys.revoke'), DELETE],
  ['declared financial',
    endpoint('POST', '/api/invoices/[id]/pay', 'invoices.pay', {
      declaredEffect: 'financial',
    }),
    { operationGroup: 'create', riskClass: 'financial', requiresApproval: true }],
  ['declared destructive',
    endpoint('POST', '/api/tasks/[id]/close', 'tasks.close', {
      declaredEffect: 'destructive',
    }),
    DELETE],
  ['declared external on GET',
    endpoint('GET', '/api/calendar/sync', 'calendar.sync', {
      declaredEffect: 'external',
    }),
    { operationGroup: 'read', riskClass: 'external', requiresApproval: true }],
  ['external-call evidence',
    endpoint('GET', '/api/export', 'exports.download', {
      evidence: { externalCall: true },
    }),
    { operationGroup: 'read', riskClass: 'external', requiresApproval: true }],
  ['UI mutation evidence',
    ui('tasks.quickAdd', { evidence: { uiMutation: true } }),
    { operationGroup: 'ui', riskClass: 'write', requiresApproval: true }],
  ['UI mutation with destructive id',
    ui('tasks.deleteSelected', { evidence: { uiMutation: true } }),
    { operationGroup: 'ui', riskClass: 'delete', requiresApproval: true }],
  ['UI external evidence',
    ui('maps.openExternal', { evidence: { externalCall: true } }),
    { operationGroup: 'ui', riskClass: 'external', requiresApproval: true }],
];

const NEVER_LOWER: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['declared read on POST',
    endpoint('POST', '/api/search', 'search.run', { declaredEffect: 'read' }),
    CREATE],
  ['declared write on DELETE',
    endpoint('DELETE', '/api/tasks/[id]', 'tasks.delete', {
      declaredEffect: 'write',
    }),
    DELETE],
];

// Review focus: tokens match whole words only, never on reads, and UI ids
// only escalate with evidence that the handler mutates.
const TOKEN_BOUNDARIES: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['GET of deleted items',
    endpoint('GET', '/api/tasks/deleted', 'tasks.listDeleted'), READ],
  ['restore of deleted items',
    endpoint('POST', '/api/tasks/deleted/restore', 'tasks.restoreDeleted'),
    CREATE],
  ['archive is not a token',
    endpoint('PATCH', '/api/tasks/[taskId]/archive', 'tasks.archive'), UPDATE],
  ['reminders are not remove',
    endpoint('POST', '/api/reminders', 'reminders.create'), CREATE],
  ['UI id without mutation evidence', ui('ui.trash.emptyTrash'), UI],
];

const ALL = [...TABLE, ...ESCALATIONS, ...NEVER_LOWER, ...TOKEN_BOUNDARIES];

describe('deriveToolPolicyDefaults', () => {
  it.each(ALL)('%s', (_label, input, expected) => {
    expect(deriveToolPolicyDefaults(input)).toEqual({
      ...expected,
      rulesVersion: TOOL_POLICY_RULES_VERSION,
    });
  });

  it('never emits the unassessed risk class', () => {
    for (const [, input] of ALL) {
      expect(deriveToolPolicyDefaults(input).riskClass).not.toBe('unknown');
    }
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-defaults.test.ts
```

Expected: FAIL, `deriveToolPolicyDefaults is not a function` for every row.

- [ ] **Step 3: Minimal implementation**

Append to `src/contracts/tool-policy.ts`:

```ts
export type DeclaredEffect =
  | 'read'
  | 'write'
  | 'destructive'
  | 'external'
  | 'financial';

export interface ToolPolicyDefaultsInput {
  executionKind: 'endpoint' | 'ui';
  method?: string;
  path?: string;
  definitionId: string;
  declaredEffect?: DeclaredEffect;
  evidence?: { externalCall?: boolean; uiMutation?: boolean };
}

export interface ToolPolicyDefaults {
  operationGroup: 'read' | 'create' | 'update' | 'delete' | 'ui';
  riskClass: Exclude<ToolRiskClass, 'unknown'>;
  requiresApproval: boolean;
  rulesVersion: typeof TOOL_POLICY_RULES_VERSION;
}

type AssessedRiskClass = Exclude<ToolRiskClass, 'unknown'>;
type PolicyDefaultsCore = Omit<ToolPolicyDefaults, 'rulesVersion'>;

const METHOD_DEFAULTS = new Map<string, PolicyDefaultsCore>([
  ['GET', { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false }],
  ['HEAD', { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false }],
  ['POST', { operationGroup: 'create', riskClass: 'write', requiresApproval: true }],
  ['PUT', { operationGroup: 'update', riskClass: 'write', requiresApproval: true }],
  ['PATCH', { operationGroup: 'update', riskClass: 'write', requiresApproval: true }],
  ['DELETE', { operationGroup: 'delete', riskClass: 'delete', requiresApproval: true }],
]);

const UNKNOWN_METHOD_DEFAULTS: PolicyDefaultsCore = {
  operationGroup: 'update',
  riskClass: 'write',
  requiresApproval: true,
};

const UI_DEFAULTS: PolicyDefaultsCore = {
  operationGroup: 'ui',
  riskClass: 'safe-read',
  requiresApproval: false,
};

const DESTRUCTIVE_WORDS = new Set([
  'delete',
  'remove',
  'destroy',
  'purge',
  'erase',
  'wipe',
  'permanent',
  'revoke',
]);

/** Multi-word tokens; `hard-delete` is already covered by `delete`. */
const DESTRUCTIVE_WORD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['empty', 'trash'],
];

const DECLARED_EFFECT_RISK: Readonly<Record<DeclaredEffect, AssessedRiskClass>> = {
  read: 'safe-read',
  write: 'write',
  destructive: 'delete',
  external: 'external',
  financial: 'financial',
};

function segmentWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** Whole-word match per path or definitionId segment (camelCase aware). */
function hasDestructiveToken(
  ...sources: ReadonlyArray<string | undefined>
): boolean {
  for (const source of sources) {
    for (const segment of (source ?? '').split(/[/.]/)) {
      const words = segmentWords(segment);
      if (words.some((word) => DESTRUCTIVE_WORDS.has(word))) return true;
      for (let index = 0; index + 1 < words.length; index += 1) {
        if (DESTRUCTIVE_WORD_PAIRS.some(([first, second]) =>
          words[index] === first && words[index + 1] === second)) {
          return true;
        }
      }
    }
  }
  return false;
}

function raiseAssessed(
  current: AssessedRiskClass,
  candidate: AssessedRiskClass,
): AssessedRiskClass {
  return riskTier(candidate) > riskTier(current) ? candidate : current;
}

/**
 * Deterministic stage-1 defaults (spec 4.5). Escalations only ever raise;
 * `unknown` is never produced. Roles are not part of the defaults: the
 * endpoint's own authorization applies.
 */
export function deriveToolPolicyDefaults(
  input: ToolPolicyDefaultsInput,
): ToolPolicyDefaults {
  const isUi = input.executionKind === 'ui';
  const method = input.method?.toUpperCase();
  const base = isUi
    ? UI_DEFAULTS
    : METHOD_DEFAULTS.get(method ?? '') ?? UNKNOWN_METHOD_DEFAULTS;
  let operationGroup = base.operationGroup;
  let riskClass = base.riskClass;

  const readOnlyMethod = !isUi && (method === 'GET' || method === 'HEAD');
  const tokensApply = isUi
    ? input.evidence?.uiMutation === true
    : !readOnlyMethod;
  if (tokensApply && hasDestructiveToken(input.path, input.definitionId)) {
    riskClass = raiseAssessed(riskClass, 'delete');
    if (!isUi) operationGroup = 'delete';
  }
  if (input.declaredEffect !== undefined) {
    riskClass = raiseAssessed(
      riskClass,
      DECLARED_EFFECT_RISK[input.declaredEffect],
    );
    if (input.declaredEffect === 'destructive' && !isUi) {
      operationGroup = 'delete';
    }
  }
  if (input.evidence?.externalCall) {
    riskClass = raiseAssessed(riskClass, 'external');
  }
  if (isUi && input.evidence?.uiMutation) {
    riskClass = raiseAssessed(riskClass, 'write');
  }

  return {
    operationGroup,
    riskClass,
    requiresApproval: base.requiresApproval || riskTier(riskClass) >= 2,
    rulesVersion: TOOL_POLICY_RULES_VERSION,
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-defaults.test.ts src/contracts/__tests__/tool-policy-tiers.test.ts && bun run typecheck
```

Expected: PASS (31 + 25 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/tool-policy.ts src/contracts/__tests__/tool-policy-defaults.test.ts
git commit -m "feat(contracts): derive deterministic tool policy defaults"
```

---

### Task 3: Policy entry and `tool-policy.json` schema with `E-POLICY-001`

**Files:**
- Modify: `src/diagnostics/foundation-diagnostic.ts:1-9`
- Modify: `src/contracts/tool-policy.ts` (import line 1; append)
- Test: `src/contracts/__tests__/tool-policy-file.test.ts`

**Interfaces:**
- Consumes: `ToolRiskClassSchema` (`src/contracts/revisions.ts`), `findSensitiveStringPath` (`src/contracts/content-boundary.ts`), `FoundationDiagnosticError` (`src/diagnostics/index.ts`).
- Produces:
  - `FoundationDiagnosticCode` gains `` `E-POLICY-${string}` ``.
  - `export const ToolPolicyPinSchema`, `export const ToolPolicyEntrySchema` (strict).
  - `export interface ToolPolicyEntry { enabled?: boolean; requiresApproval?: boolean; riskClass?: ToolRiskClass; allowedRoles?: string[]; description?: string; reason?: string; pin?: { toolId: string; atRiskClass: ToolRiskClass } }`
  - `export const ToolPolicyFileSchema` (zod v4); `export type ToolPolicyFile = z.infer<typeof ToolPolicyFileSchema>;`
  - `export function parseToolPolicyFile(value: unknown): ToolPolicyFile;` throws `FoundationDiagnosticError` `{ code: 'E-POLICY-001', operation: 'tools.policy', remediation: 'repair-tool-policy-file', path: '.glirastes/tool-policy.json', identifier?: <issue path> }`.

- [ ] **Step 1: Write the failing test**

Create `src/contracts/__tests__/tool-policy-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import {
  ToolPolicyEntrySchema,
  parseToolPolicyFile,
} from '../tool-policy.js';

const TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';

function expectPolicyError(
  value: unknown,
  identifier: string | undefined,
): FoundationDiagnosticError {
  try {
    parseToolPolicyFile(value);
  } catch (error) {
    expect(error).toBeInstanceOf(FoundationDiagnosticError);
    const diagnostic = error as FoundationDiagnosticError;
    expect(diagnostic.code).toBe('E-POLICY-001');
    expect(diagnostic.operation).toBe('tools.policy');
    expect(diagnostic.remediation).toBe('repair-tool-policy-file');
    expect(diagnostic.path).toBe('.glirastes/tool-policy.json');
    expect(diagnostic.identifier).toBe(identifier);
    return diagnostic;
  }
  throw new Error('parseToolPolicyFile accepted an invalid policy file');
}

describe('parseToolPolicyFile', () => {
  it('parses the documented file shape', () => {
    const file = {
      schemaVersion: 1,
      tools: {
        'DELETE /api/tasks/[id]': {
          enabled: false,
          requiresApproval: true,
          riskClass: 'delete',
          allowedRoles: ['admin'],
          description: 'Delete one task permanently.',
          reason: 'Only admins clean up.',
          pin: { toolId: TOOL_ID, atRiskClass: 'write' },
        },
      },
      exclude: [{ match: 'POST /api/internal/**', reason: 'internal' }],
      acceptedRisk: {
        'POST /api/tasks/[id]/archive': { riskClass: 'write', toolId: TOOL_ID },
      },
    };
    expect(parseToolPolicyFile(file)).toEqual(file);
  });

  it('fills absent sections with empty defaults', () => {
    expect(parseToolPolicyFile({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
      tools: {},
      exclude: [],
      acceptedRisk: {},
    });
  });

  it.each([
    ['an unsupported schema version', { schemaVersion: 2 }, 'schemaVersion'],
    ['an unknown top-level key', { schemaVersion: 1, overrides: {} }, undefined],
    ['a non-boolean approval', {
      schemaVersion: 1,
      tools: { 'GET /api/tasks': { requiresApproval: 'no' } },
    }, 'tools.GET /api/tasks.requiresApproval'],
    ['a pin without a tool id', {
      schemaVersion: 1,
      tools: {
        'POST /api/tasks': {
          requiresApproval: false,
          pin: { toolId: 'not-a-uuid', atRiskClass: 'write' },
        },
      },
    }, 'tools.POST /api/tasks.pin.toolId'],
    ['an exclusion without a reason', {
      schemaVersion: 1,
      exclude: [{ match: 'POST /api/internal/**' }],
    }, 'exclude.0.reason'],
    ['an empty role name', {
      schemaVersion: 1,
      tools: { 'GET /api/tasks': { allowedRoles: [''] } },
    }, 'tools.GET /api/tasks.allowedRoles.0'],
  ])('rejects %s with E-POLICY-001', (_label, value, identifier) => {
    expectPolicyError(value, identifier);
  });

  it('rejects secret-like content without echoing it', () => {
    const secret = `sk-or-v1-${'a1B2c3D4'.repeat(4)}`;
    const diagnostic = expectPolicyError({
      schemaVersion: 1,
      tools: { 'POST /api/tasks': { description: `Use ${secret} to call.` } },
    }, 'tools.POST /api/tasks.description');
    expect(JSON.stringify(diagnostic.toJSON())).not.toContain(secret);
    expect(diagnostic.message).not.toContain(secret);
  });

  it('does not treat stable keys as content', () => {
    expect(parseToolPolicyFile({
      schemaVersion: 1,
      tools: { 'POST /api/auth/token-refresh': { enabled: false } },
    }).tools['POST /api/auth/token-refresh']).toEqual({ enabled: false });
  });
});

describe('ToolPolicyEntrySchema', () => {
  it('is strict so stray fields never pass as policy', () => {
    expect(ToolPolicyEntrySchema.safeParse({ enabled: true, toolId: TOOL_ID })
      .success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-file.test.ts
```

Expected: FAIL, `parseToolPolicyFile is not a function` / `Cannot read properties of undefined (reading 'safeParse')`.

- [ ] **Step 3: Minimal implementation**

In `src/diagnostics/foundation-diagnostic.ts` replace lines 1–9 with:

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
  | `E-POLICY-${string}`;
```

In `src/contracts/tool-policy.ts` replace line 1 (`import type { ToolRiskClass } from './revisions.js';`) with:

```ts
import { z } from 'zod';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { findSensitiveStringPath } from './content-boundary.js';
import { ToolRiskClassSchema, type ToolRiskClass } from './revisions.js';
```

Append to `src/contracts/tool-policy.ts`:

```ts
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const stableKey = z.string().min(1).max(512);

export const ToolPolicyPinSchema = z.object({
  toolId: z.uuid(),
  atRiskClass: ToolRiskClassSchema,
}).strict();

/** One policy layer entry: the same shape for local files and Platform deltas. */
export const ToolPolicyEntrySchema = z.object({
  enabled: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  riskClass: ToolRiskClassSchema.optional(),
  allowedRoles: z.array(boundedText(200)).max(100).optional(),
  description: boundedText(4_000).optional(),
  reason: boundedText(500).optional(),
  pin: ToolPolicyPinSchema.optional(),
}).strict();

export interface ToolPolicyEntry {
  enabled?: boolean;
  requiresApproval?: boolean;
  riskClass?: ToolRiskClass;
  allowedRoles?: string[];
  description?: string;
  reason?: string;
  pin?: { toolId: string; atRiskClass: ToolRiskClass };
}

/**
 * `.glirastes/tool-policy.json`. Written by the developer or the CLI only,
 * never by an agent; `tools refresh` never rewrites it.
 */
export const ToolPolicyFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.record(stableKey, ToolPolicyEntrySchema).default({}),
  exclude: z.array(z.object({
    match: boundedText(2_048),
    reason: boundedText(500),
  }).strict()).max(500).default([]),
  acceptedRisk: z.record(stableKey, z.object({
    riskClass: ToolRiskClassSchema,
    toolId: z.uuid(),
  }).strict()).default({}),
}).strict().superRefine((file, context) => {
  // Values only: stable keys such as "POST /api/auth/token" are not content.
  const sensitivePath = findSensitiveStringPath(file);
  if (sensitivePath) {
    context.addIssue({
      code: 'custom',
      message: 'Tool policy contains secret-like content',
      path: sensitivePath,
    });
  }
});

export type ToolPolicyFile = z.infer<typeof ToolPolicyFileSchema>;

export function parseToolPolicyFile(value: unknown): ToolPolicyFile {
  const parsed = ToolPolicyFileSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // The issue path names the field; the offending value is never echoed.
  const identifier = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
  throw new FoundationDiagnosticError({
    code: 'E-POLICY-001',
    operation: 'tools.policy',
    message: 'The tool policy file is invalid.',
    remediation: 'repair-tool-policy-file',
    path: '.glirastes/tool-policy.json',
    ...(identifier ? { identifier } : {}),
  });
}
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-file.test.ts src/diagnostics/foundation-diagnostic.test.ts && bun run typecheck
```

Expected: PASS (11 + 2 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/diagnostics/foundation-diagnostic.ts src/contracts/tool-policy.ts src/contracts/__tests__/tool-policy-file.test.ts
git commit -m "feat(contracts): validate tool policy files with e-policy codes"
```

---

### Task 4: `resolveToolPolicy` core (restrict-only layers)

**Files:**
- Modify: `src/contracts/tool-policy.ts` (append)
- Test: `src/contracts/__tests__/tool-policy-resolve.test.ts`

**Interfaces:**
- Consumes: `ToolPolicyDefaults` (Task 2), `ToolPolicyEntry` (Task 3), `riskTier`, `mostRestrictiveRiskClass`, `intersectAllowedRoles` (Task 1).
- Produces:
  - `export type PolicyOrigin = 'code-default' | 'local-policy' | 'platform';`
  - `export interface EffectiveToolPolicy { enabled: boolean; requiresApproval: boolean; riskClass: ToolRiskClass; allowedRoles: string[]; description?: string; origin: { enabled: PolicyOrigin; requiresApproval: PolicyOrigin; riskClass: PolicyOrigin; allowedRoles: PolicyOrigin; description: PolicyOrigin } }`
  - `export type ToolPolicyWarningCode = 'override-lapsed-risk-raised' | 'risk-lower-available' | 'policy-entry-orphaned';`
  - `export interface ResolveToolPolicyInput { toolId: string; defaults: ToolPolicyDefaults; codeEnabled: boolean; local?: ToolPolicyEntry; platform?: ToolPolicyEntry; acceptedRisk?: { riskClass: ToolRiskClass; toolId: string }; previousEffectiveRiskClass?: ToolRiskClass }`
  - `export interface ResolveToolPolicyResult { effective: EffectiveToolPolicy; warnings: Array<{ code: ToolPolicyWarningCode; field?: string }>; errors: Array<{ code: 'E-POLICY-001' | 'E-POLICY-002'; field: string; reason: string }> }`
  - `export function resolveToolPolicy(input: ResolveToolPolicyInput): ResolveToolPolicyResult;`

- [ ] **Step 1: Write the failing test**

Create `src/contracts/__tests__/tool-policy-resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ToolRiskClass } from '../revisions.js';
import {
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ToolPolicyDefaults,
} from '../tool-policy.js';

const TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
const OTHER_TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906';

const READ: ToolPolicyDefaults = {
  operationGroup: 'read',
  riskClass: 'safe-read',
  requiresApproval: false,
  rulesVersion: 1,
};
const WRITE: ToolPolicyDefaults = {
  operationGroup: 'create',
  riskClass: 'write',
  requiresApproval: true,
  rulesVersion: 1,
};
const DELETE: ToolPolicyDefaults = {
  operationGroup: 'delete',
  riskClass: 'delete',
  requiresApproval: true,
  rulesVersion: 1,
};

function resolve(overrides: Partial<ResolveToolPolicyInput> = {}) {
  return resolveToolPolicy({
    toolId: TOOL_ID,
    defaults: READ,
    codeEnabled: true,
    ...overrides,
  });
}

function pin(atRiskClass: ToolRiskClass, toolId: string = TOOL_ID) {
  return { toolId, atRiskClass };
}

describe('resolveToolPolicy', () => {
  it('returns the code defaults when no layer speaks', () => {
    expect(resolve()).toEqual({
      effective: {
        enabled: true,
        requiresApproval: false,
        riskClass: 'safe-read',
        allowedRoles: [],
        origin: {
          enabled: 'code-default',
          requiresApproval: 'code-default',
          riskClass: 'code-default',
          allowedRoles: 'code-default',
          description: 'code-default',
        },
      },
      warnings: [],
      errors: [],
    });
  });

  it('lets every layer disable and nothing enable', () => {
    expect(resolve({ local: { enabled: false } }).effective)
      .toMatchObject({ enabled: false, origin: { enabled: 'local-policy' } });
    expect(resolve({ platform: { enabled: false } }).effective)
      .toMatchObject({ enabled: false, origin: { enabled: 'platform' } });
    expect(resolve({
      codeEnabled: false,
      local: { enabled: true },
      platform: { enabled: true },
    }).effective)
      .toMatchObject({ enabled: false, origin: { enabled: 'code-default' } });
  });

  it('only raises the risk class and confirms once raised into write', () => {
    expect(resolve({ local: { riskClass: 'write' } }).effective).toMatchObject({
      riskClass: 'write',
      requiresApproval: true,
      origin: { riskClass: 'local-policy', requiresApproval: 'local-policy' },
    });
    expect(resolve({ defaults: WRITE, platform: { riskClass: 'safe-read' } })
      .effective)
      .toMatchObject({ riskClass: 'write', origin: { riskClass: 'code-default' } });
    expect(resolve({ defaults: DELETE, local: { riskClass: 'financial' } })
      .effective)
      .toMatchObject({ riskClass: 'delete', origin: { riskClass: 'code-default' } });
    expect(resolve({ defaults: WRITE, platform: { riskClass: 'external' } })
      .effective).toMatchObject({
      riskClass: 'external',
      requiresApproval: true,
      origin: { riskClass: 'platform' },
    });
  });

  it('intersects role restrictions where an empty list restricts nothing', () => {
    expect(resolve({
      local: { allowedRoles: ['member', 'admin'] },
      platform: { allowedRoles: ['viewer', 'member'] },
    }).effective)
      .toMatchObject({ allowedRoles: ['member'], origin: { allowedRoles: 'platform' } });
    expect(resolve({
      local: { allowedRoles: ['admin'] },
      platform: { allowedRoles: [] },
    }).effective)
      .toMatchObject({ allowedRoles: ['admin'], origin: { allowedRoles: 'local-policy' } });
  });

  it('disables a tool whose role restrictions are disjoint instead of opening it to everyone', () => {
    expect(resolve({
      local: { allowedRoles: ['admin'] },
      platform: { allowedRoles: ['member'] },
    }).effective).toMatchObject({
      enabled: false,
      allowedRoles: [],
      origin: { enabled: 'platform', allowedRoles: 'platform' },
    });
  });

  it('prefers platform over local descriptions', () => {
    expect(resolve({
      local: { description: 'Local text.' },
      platform: { description: 'Platform text.' },
    }).effective)
      .toMatchObject({ description: 'Platform text.', origin: { description: 'platform' } });
    expect(resolve({ local: { description: 'Local text.' } }).effective)
      .toMatchObject({ description: 'Local text.', origin: { description: 'local-policy' } });
    expect(resolve().effective).not.toHaveProperty('description');
  });

  it('lets any layer require confirmation and keeps tier 3 confirmed', () => {
    expect(resolve({ local: { requiresApproval: true } }).effective).toMatchObject({
      requiresApproval: true,
      origin: { requiresApproval: 'local-policy' },
    });
    expect(resolve({ defaults: DELETE }).effective).toMatchObject({
      requiresApproval: true,
      origin: { requiresApproval: 'code-default' },
    });
    expect(resolve({ defaults: { ...DELETE, requiresApproval: false } }).effective)
      .toMatchObject({ requiresApproval: true, origin: { requiresApproval: 'code-default' } });
    expect(resolve({ defaults: WRITE, platform: { requiresApproval: false } })
      .effective.requiresApproval).toBe(true);
  });
});

// Keeps the helpers referenced until Task 5 appends its block.
void pin;
void OTHER_TOOL_ID;
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-resolve.test.ts
```

Expected: FAIL, `resolveToolPolicy is not a function`.

- [ ] **Step 3: Minimal implementation**

Append to `src/contracts/tool-policy.ts`:

```ts
export type PolicyOrigin = 'code-default' | 'local-policy' | 'platform';

export interface EffectiveToolPolicy {
  enabled: boolean;
  requiresApproval: boolean;
  riskClass: ToolRiskClass;
  allowedRoles: string[];
  description?: string;
  origin: {
    enabled: PolicyOrigin;
    requiresApproval: PolicyOrigin;
    riskClass: PolicyOrigin;
    allowedRoles: PolicyOrigin;
    description: PolicyOrigin;
  };
}

export type ToolPolicyWarningCode =
  | 'override-lapsed-risk-raised'
  | 'risk-lower-available'
  | 'policy-entry-orphaned';

export interface ResolveToolPolicyInput {
  toolId: string;
  defaults: ToolPolicyDefaults;
  /** False for needs_attention, excluded or missing tools; nothing re-enables them. */
  codeEnabled: boolean;
  local?: ToolPolicyEntry;
  platform?: ToolPolicyEntry;
  acceptedRisk?: { riskClass: ToolRiskClass; toolId: string };
  /** The riskClass this toolId resolved to in the previous committed refresh. */
  previousEffectiveRiskClass?: ToolRiskClass;
}

export interface ResolveToolPolicyResult {
  effective: EffectiveToolPolicy;
  warnings: Array<{ code: ToolPolicyWarningCode; field?: string }>;
  errors: Array<{
    code: 'E-POLICY-001' | 'E-POLICY-002';
    field: string;
    reason: string;
  }>;
}

type PolicyWarning = ResolveToolPolicyResult['warnings'][number];
type PolicyError = ResolveToolPolicyResult['errors'][number];

interface PolicyLayer {
  name: 'local' | 'platform';
  origin: Exclude<PolicyOrigin, 'code-default'>;
  entry: ToolPolicyEntry;
}

interface CollectedLayers {
  layers: PolicyLayer[];
  invalidOrigin?: PolicyOrigin;
}

interface ResolvedField<T> {
  value: T;
  origin: PolicyOrigin;
}

/**
 * Pure policy resolution shared with the Platform port via golden vectors.
 * Code defaults are the base; local and Platform entries restrict, except a
 * reviewed, pinned relaxation of confirmation up to tier 2. Across all layers
 * the most restrictive protection value wins.
 */
export function resolveToolPolicy(
  input: ResolveToolPolicyInput,
): ResolveToolPolicyResult {
  const warnings: PolicyWarning[] = [];
  const errors: PolicyError[] = [];
  const { layers, invalidOrigin } = collectPolicyLayers(input, warnings, errors);
  const risk = resolveRiskClass(input, layers, warnings);
  const roles = resolveAllowedRoles(layers);
  const enabled = resolveEnabled(
    input.codeEnabled,
    layers,
    roles.disjointOrigin,
    invalidOrigin,
  );
  const approval = resolveApproval(input, layers, risk, warnings, errors);
  const description = resolveDescription(layers);
  return {
    effective: {
      enabled: enabled.value,
      requiresApproval: approval.value,
      riskClass: risk.value,
      allowedRoles: roles.value,
      ...(description.value === undefined
        ? {}
        : { description: description.value }),
      origin: {
        enabled: enabled.origin,
        requiresApproval: approval.origin,
        riskClass: risk.origin,
        allowedRoles: roles.origin,
        description: description.origin,
      },
    },
    warnings,
    errors,
  };
}

function collectPolicyLayers(
  input: ResolveToolPolicyInput,
  _warnings: PolicyWarning[],
  _errors: PolicyError[],
): CollectedLayers {
  const layers: PolicyLayer[] = [];
  if (input.local) {
    layers.push({ name: 'local', origin: 'local-policy', entry: input.local });
  }
  if (input.platform) {
    layers.push({ name: 'platform', origin: 'platform', entry: input.platform });
  }
  return { layers };
}

function resolveRiskClass(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  _warnings: PolicyWarning[],
): ResolvedField<ToolRiskClass> {
  let value: ToolRiskClass = input.defaults.riskClass;
  let origin: PolicyOrigin = 'code-default';
  for (const layer of layers) {
    const raised = mostRestrictiveRiskClass(value, layer.entry.riskClass);
    if (raised !== value) {
      value = raised;
      origin = layer.origin;
    }
  }
  return { value, origin };
}

function sameRoles(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return left.length === right.length
    && left.every((role, index) => role === right[index]);
}

function resolveAllowedRoles(
  layers: ReadonlyArray<PolicyLayer>,
): ResolvedField<string[]> & { disjointOrigin?: PolicyOrigin } {
  let value: string[] = [];
  let origin: PolicyOrigin = 'code-default';
  for (const layer of layers) {
    const restriction = layer.entry.allowedRoles;
    if (!restriction || restriction.length === 0) continue;
    const next = intersectAllowedRoles(value, restriction);
    if (next.disjoint) {
      // [] would read as "everyone"; a disjoint restriction means nobody.
      return { value: [], origin: layer.origin, disjointOrigin: layer.origin };
    }
    if (!sameRoles(next.roles, value)) {
      value = next.roles;
      origin = layer.origin;
    }
  }
  return { value, origin };
}

function resolveEnabled(
  codeEnabled: boolean,
  layers: ReadonlyArray<PolicyLayer>,
  disjointOrigin: PolicyOrigin | undefined,
  invalidOrigin: PolicyOrigin | undefined,
): ResolvedField<boolean> {
  if (!codeEnabled) return { value: false, origin: 'code-default' };
  if (invalidOrigin) return { value: false, origin: invalidOrigin };
  const disabledBy = layers.find((layer) => layer.entry.enabled === false);
  if (disabledBy) return { value: false, origin: disabledBy.origin };
  if (disjointOrigin) return { value: false, origin: disjointOrigin };
  return { value: true, origin: 'code-default' };
}

function resolveApproval(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  risk: ResolvedField<ToolRiskClass>,
  _warnings: PolicyWarning[],
  _errors: PolicyError[],
): ResolvedField<boolean> {
  const tier = riskTier(risk.value);
  const raisedIntoConfirmation = tier >= 2
    && tier > riskTier(input.defaults.riskClass);
  const baseline = input.defaults.requiresApproval || raisedIntoConfirmation;
  const baselineOrigin: PolicyOrigin =
    !input.defaults.requiresApproval && raisedIntoConfirmation
      ? risk.origin
      : 'code-default';
  const hardenedBy = layers.find(
    (layer) => layer.entry.requiresApproval === true,
  );
  if (hardenedBy) {
    return {
      value: true,
      origin: baseline ? baselineOrigin : hardenedBy.origin,
    };
  }
  if (!baseline && tier >= 3) return { value: true, origin: 'code-default' };
  return { value: baseline, origin: baselineOrigin };
}

function resolveDescription(
  layers: ReadonlyArray<PolicyLayer>,
): ResolvedField<string | undefined> {
  let result: ResolvedField<string | undefined> = {
    value: undefined,
    origin: 'code-default',
  };
  for (const layer of layers) {
    if (layer.entry.description !== undefined) {
      result = { value: layer.entry.description, origin: layer.origin };
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-resolve.test.ts && bun run typecheck
```

Expected: PASS (7 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/tool-policy.ts src/contracts/__tests__/tool-policy-resolve.test.ts
git commit -m "feat(contracts): resolve tool policy layers restrict-only"
```

---

### Task 5: Reviewed relaxations, lapse and orphaned pins

**Files:**
- Modify: `src/contracts/tool-policy.ts` (replace `collectPolicyLayers` and `resolveApproval`, add `relaxationAllowed`)
- Test: `src/contracts/__tests__/tool-policy-resolve.test.ts` (append)

**Interfaces:**
- Consumes: Task 4 internals.
- Produces: unchanged public signatures. `resolveToolPolicy` now emits `E-POLICY-002` with `reason` `'tier-3-always-requires-approval'` or `'relaxation-requires-reviewed-pin'`, plus the warnings `override-lapsed-risk-raised` (`field: '<layer>.requiresApproval'`) and `policy-entry-orphaned` (`field: '<layer>.pin.toolId'`).

- [ ] **Step 1: Write the failing test**

In `src/contracts/__tests__/tool-policy-resolve.test.ts`, delete the two trailing lines (`void pin;`, `void OTHER_TOOL_ID;`) together with the comment above them. Then append:

```ts
describe('resolveToolPolicy relaxation bounds', () => {
  it('relaxes tiers 0 and 1 freely', () => {
    expect(resolve({
      defaults: { ...READ, riskClass: 'read-sensitive', requiresApproval: true },
      local: { requiresApproval: false },
    })).toMatchObject({
      effective: {
        requiresApproval: false,
        origin: { requiresApproval: 'local-policy' },
      },
      warnings: [],
      errors: [],
    });
  });

  it('relaxes write only through a reviewed entry pinned at write', () => {
    expect(resolve({
      defaults: WRITE,
      local: { requiresApproval: false, reason: 'reviewed', pin: pin('write') },
    })).toMatchObject({
      effective: {
        requiresApproval: false,
        origin: { requiresApproval: 'local-policy' },
      },
      warnings: [],
      errors: [],
    });
    expect(resolve({
      defaults: WRITE,
      platform: { requiresApproval: false, pin: pin('write') },
    }).effective).toMatchObject({
      requiresApproval: false,
      origin: { requiresApproval: 'platform' },
    });
  });

  it('lets a hardening win over a valid relaxation', () => {
    expect(resolve({
      defaults: WRITE,
      local: { requiresApproval: true },
      platform: { requiresApproval: false, pin: pin('write') },
    }).effective).toMatchObject({
      requiresApproval: true,
      origin: { requiresApproval: 'local-policy' },
    });
  });

  it.each([
    ['write without a pin', WRITE, {}, 'relaxation-requires-reviewed-pin'],
    ['delete without a pin', DELETE, {}, 'tier-3-always-requires-approval'],
    ['delete pinned at delete', DELETE, { pin: pin('delete') },
      'tier-3-always-requires-approval'],
  ] as const)('rejects relaxing %s with E-POLICY-002', (
    _label,
    defaults,
    extra,
    reason,
  ) => {
    const result = resolve({
      defaults,
      local: { requiresApproval: false, ...extra },
    });
    expect(result.effective.requiresApproval).toBe(true);
    expect(result.errors).toEqual([
      { code: 'E-POLICY-002', field: 'local.requiresApproval', reason },
    ]);
  });

  it('lets a pinned relaxation lapse with a warning when the risk rises', () => {
    expect(resolve({
      defaults: DELETE,
      local: { requiresApproval: false, pin: pin('write') },
    })).toMatchObject({
      effective: { requiresApproval: true },
      warnings: [
        { code: 'override-lapsed-risk-raised', field: 'local.requiresApproval' },
      ],
      errors: [],
    });
    expect(resolve({
      defaults: WRITE,
      local: { requiresApproval: false, pin: pin('safe-read') },
    })).toMatchObject({
      effective: { requiresApproval: true },
      warnings: [
        { code: 'override-lapsed-risk-raised', field: 'local.requiresApproval' },
      ],
      errors: [],
    });
  });

  it('never revives a relaxation for a reappeared tool but keeps its hardenings', () => {
    expect(resolve({
      defaults: WRITE,
      local: {
        requiresApproval: false,
        allowedRoles: ['admin'],
        pin: pin('write', OTHER_TOOL_ID),
      },
    })).toEqual({
      effective: {
        enabled: true,
        requiresApproval: true,
        riskClass: 'write',
        allowedRoles: ['admin'],
        origin: {
          enabled: 'code-default',
          requiresApproval: 'code-default',
          riskClass: 'code-default',
          allowedRoles: 'local-policy',
          description: 'code-default',
        },
      },
      warnings: [{ code: 'policy-entry-orphaned', field: 'local.pin.toolId' }],
      errors: [],
    });
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-resolve.test.ts
```

Expected: all 8 new tests FAIL. "relaxes tiers 0 and 1 freely" and "relaxes write only…" fail because `requiresApproval` is `true`. "lets a hardening win…" fails on origin `code-default`. "rejects relaxing …" fails because `errors` is `[]`. "lets a pinned relaxation lapse…" and "never revives…" fail because `warnings` is `[]`. The 7 Task 4 tests stay green.

- [ ] **Step 3: Minimal implementation**

In `src/contracts/tool-policy.ts` replace the whole `collectPolicyLayers` function with:

```ts
function collectPolicyLayers(
  input: ResolveToolPolicyInput,
  warnings: PolicyWarning[],
  _errors: PolicyError[],
): CollectedLayers {
  const layers: PolicyLayer[] = [];
  if (input.local) {
    layers.push({ name: 'local', origin: 'local-policy', entry: input.local });
  }
  if (input.platform) {
    layers.push({ name: 'platform', origin: 'platform', entry: input.platform });
  }
  for (const layer of layers) {
    // A pin from an earlier incarnation: relaxations lapse, hardenings stay.
    if (layer.entry.pin && layer.entry.pin.toolId !== input.toolId) {
      warnings.push({
        code: 'policy-entry-orphaned',
        field: `${layer.name}.pin.toolId`,
      });
    }
  }
  return { layers };
}
```

Replace the whole `resolveApproval` function with:

```ts
function resolveApproval(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  risk: ResolvedField<ToolRiskClass>,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): ResolvedField<boolean> {
  const tier = riskTier(risk.value);
  const raisedIntoConfirmation = tier >= 2
    && tier > riskTier(input.defaults.riskClass);
  const baseline = input.defaults.requiresApproval || raisedIntoConfirmation;
  const baselineOrigin: PolicyOrigin =
    !input.defaults.requiresApproval && raisedIntoConfirmation
      ? risk.origin
      : 'code-default';
  let hardenedBy: PolicyLayer | undefined;
  let relaxedBy: PolicyLayer | undefined;
  for (const layer of layers) {
    if (layer.entry.requiresApproval === true) {
      hardenedBy ??= layer;
    } else if (
      layer.entry.requiresApproval === false
      && relaxationAllowed(input.toolId, layer, tier, warnings, errors)
    ) {
      relaxedBy = layer;
    }
  }
  let result: ResolvedField<boolean>;
  if (hardenedBy) {
    result = {
      value: true,
      origin: baseline && !relaxedBy ? baselineOrigin : hardenedBy.origin,
    };
  } else if (relaxedBy) {
    result = { value: false, origin: relaxedBy.origin };
  } else {
    result = { value: baseline, origin: baselineOrigin };
  }
  // Tier 3 always confirms, whatever any layer says.
  return !result.value && tier >= 3
    ? { value: true, origin: 'code-default' }
    : result;
}

function relaxationAllowed(
  toolId: string,
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

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-resolve.test.ts && bun run typecheck
```

Expected: PASS (15 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/tool-policy.ts src/contracts/__tests__/tool-policy-resolve.test.ts
git commit -m "feat(contracts): bound approval relaxations by reviewed pins"
```

---

### Task 6: Risk ratchet, acceptance and fail-closed entry validation

**Files:**
- Modify: `src/contracts/tool-policy.ts` (replace `collectPolicyLayers` and `resolveRiskClass`)
- Test: `src/contracts/__tests__/tool-policy-resolve.test.ts` (append)

**Interfaces:**
- Consumes: `ToolPolicyEntrySchema` (Task 3).
- Produces: unchanged public signatures. A code-caused decrease below `previousEffectiveRiskClass` is held, with warning `risk-lower-available` and `field: 'riskClass'`, unless `acceptedRisk` matches `{ toolId, riskClass }` exactly. A malformed layer adds `E-POLICY-001` with `field: '<layer>[.<path>]'` and `reason: 'invalid-entry'`, and disables the tool with that layer as origin.

- [ ] **Step 1: Write the failing test**

In `src/contracts/__tests__/tool-policy-resolve.test.ts` replace the import from `'../tool-policy.js'` with:

```ts
import {
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ToolPolicyDefaults,
  type ToolPolicyEntry,
} from '../tool-policy.js';
```

Then append:

```ts
describe('resolveToolPolicy ratchet and entry validation', () => {
  it('holds a code-caused risk decrease until it is accepted', () => {
    expect(resolve({ previousEffectiveRiskClass: 'write' })).toMatchObject({
      effective: {
        riskClass: 'write',
        requiresApproval: true,
        origin: { riskClass: 'code-default' },
      },
      warnings: [{ code: 'risk-lower-available', field: 'riskClass' }],
    });
    expect(resolve({
      previousEffectiveRiskClass: 'write',
      acceptedRisk: { riskClass: 'safe-read', toolId: TOOL_ID },
    })).toMatchObject({
      effective: { riskClass: 'safe-read', requiresApproval: false },
      warnings: [],
    });
  });

  it.each([
    ['another tool id', { riskClass: 'safe-read', toolId: OTHER_TOOL_ID }],
    ['another risk class', { riskClass: 'read-sensitive', toolId: TOOL_ID }],
  ] as const)('ignores an acceptance for %s', (_label, acceptedRisk) => {
    expect(resolve({ previousEffectiveRiskClass: 'write', acceptedRisk }))
      .toMatchObject({
        effective: { riskClass: 'write' },
        warnings: [{ code: 'risk-lower-available', field: 'riskClass' }],
      });
  });

  it('takes risk increases over automatically and counts layer raises', () => {
    expect(resolve({ defaults: DELETE, previousEffectiveRiskClass: 'write' }))
      .toMatchObject({ effective: { riskClass: 'delete' }, warnings: [] });
    expect(resolve({
      local: { riskClass: 'write' },
      previousEffectiveRiskClass: 'write',
    })).toMatchObject({
      effective: { riskClass: 'write', origin: { riskClass: 'local-policy' } },
      warnings: [],
    });
  });

  it('fails a malformed entry closed with E-POLICY-001', () => {
    expect(resolve({
      defaults: WRITE,
      platform: { riskClass: 'critical' } as unknown as ToolPolicyEntry,
    })).toMatchObject({
      effective: {
        enabled: false,
        riskClass: 'write',
        requiresApproval: true,
        origin: { enabled: 'platform' },
      },
      errors: [
        { code: 'E-POLICY-001', field: 'platform.riskClass', reason: 'invalid-entry' },
      ],
    });
    expect(resolve({
      local: { enabled: true, toolId: TOOL_ID } as unknown as ToolPolicyEntry,
    }).errors).toEqual([
      { code: 'E-POLICY-001', field: 'local', reason: 'invalid-entry' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-resolve.test.ts
```

Expected: 4 FAIL. "holds a code-caused risk decrease…" fails because `riskClass` is `safe-read`. Both "ignores an acceptance…" rows fail. "fails a malformed entry closed…" fails because `enabled` is `true` and `errors` is `[]`. "takes risk increases over automatically…" already passes, since raises need no ratchet.

- [ ] **Step 3: Minimal implementation**

In `src/contracts/tool-policy.ts` replace the whole `collectPolicyLayers` function with:

```ts
function collectPolicyLayers(
  input: ResolveToolPolicyInput,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): CollectedLayers {
  const layers: PolicyLayer[] = [];
  let invalidOrigin: PolicyOrigin | undefined;
  const candidates = [
    { name: 'local', origin: 'local-policy', entry: input.local },
    { name: 'platform', origin: 'platform', entry: input.platform },
  ] as const;
  for (const candidate of candidates) {
    if (candidate.entry === undefined) continue;
    const parsed = ToolPolicyEntrySchema.safeParse(candidate.entry);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
      errors.push({
        code: 'E-POLICY-001',
        field: path ? `${candidate.name}.${path}` : candidate.name,
        reason: 'invalid-entry',
      });
      // A layer we cannot read must not silently drop its restrictions.
      invalidOrigin ??= candidate.origin;
      continue;
    }
    const layer: PolicyLayer = {
      name: candidate.name,
      origin: candidate.origin,
      entry: parsed.data,
    };
    // A pin from an earlier incarnation: relaxations lapse, hardenings stay.
    if (layer.entry.pin && layer.entry.pin.toolId !== input.toolId) {
      warnings.push({
        code: 'policy-entry-orphaned',
        field: `${layer.name}.pin.toolId`,
      });
    }
    layers.push(layer);
  }
  return { layers, ...(invalidOrigin ? { invalidOrigin } : {}) };
}
```

Replace the whole `resolveRiskClass` function with:

```ts
function resolveRiskClass(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  warnings: PolicyWarning[],
): ResolvedField<ToolRiskClass> {
  let value: ToolRiskClass = input.defaults.riskClass;
  let origin: PolicyOrigin = 'code-default';
  for (const layer of layers) {
    const raised = mostRestrictiveRiskClass(value, layer.entry.riskClass);
    if (raised !== value) {
      value = raised;
      origin = layer.origin;
    }
  }
  // Ratchet: a code-caused decrease is held until `tools policy accept`.
  const previous = input.previousEffectiveRiskClass;
  if (previous !== undefined && riskTier(previous) > riskTier(value)) {
    const acceptedRisk = input.acceptedRisk;
    const accepted = acceptedRisk !== undefined
      && acceptedRisk.toolId === input.toolId
      && acceptedRisk.riskClass === value;
    if (!accepted) {
      warnings.push({ code: 'risk-lower-available', field: 'riskClass' });
      return { value: previous, origin: 'code-default' };
    }
  }
  return { value, origin };
}
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-resolve.test.ts && bun run typecheck
```

Expected: PASS (20 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/tool-policy.ts src/contracts/__tests__/tool-policy-resolve.test.ts
git commit -m "feat(contracts): hold code risk decreases until accepted"
```

---

### Task 7: Golden vectors v1

**Files:**
- Create: `src/contracts/__vectors__/tool-policy.v1.json`
- Test: `src/contracts/__tests__/tool-policy-vectors.test.ts`

**Interfaces:**
- Consumes: `resolveToolPolicy`, `TOOL_POLICY_RULES_VERSION`, `ResolveToolPolicyInput`, `ResolveToolPolicyResult`.
- Produces: `src/contracts/__vectors__/tool-policy.v1.json`, an array of `{ name: string; input: ResolveToolPolicyInput; expected: ResolveToolPolicyResult }`. Names have the form `<rule>/<case>`, where rule is one of `enabled`, `risk`, `approval`, `roles`, `description`, `ratchet`, `pin` or `invalid`. P08 copies the file verbatim for its parity test.

- [ ] **Step 1: Write the failing test**

Create `src/contracts/__tests__/tool-policy-vectors.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ResolveToolPolicyResult,
} from '../tool-policy.js';

interface ToolPolicyVector {
  name: string;
  input: ResolveToolPolicyInput;
  expected: ResolveToolPolicyResult;
}

const vectors = JSON.parse(readFileSync(
  new URL('../__vectors__/tool-policy.v1.json', import.meta.url),
  'utf8',
)) as ToolPolicyVector[];

const REQUIRED_RULES = [
  'enabled',
  'risk',
  'approval',
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

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      expect(resolveToolPolicy(vector.input)).toEqual(vector.expected);
    },
  );
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-vectors.test.ts
```

Expected: FAIL, `ENOENT: no such file or directory, open '…/src/contracts/__vectors__/tool-policy.v1.json'`.

- [ ] **Step 3: Minimal implementation**

Create `src/contracts/__vectors__/tool-policy.v1.json`:

```json
[
  {
    "name": "enabled/defaults-only-read",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "enabled/local-disables",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "enabled": false, "reason": "maintenance window" }
    },
    "expected": {
      "effective": {
        "enabled": false, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "local-policy", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "enabled/platform-disables-write",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "enabled": false }
    },
    "expected": {
      "effective": {
        "enabled": false, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "platform", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "enabled/nothing-enables-code-disabled",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": false,
      "local": { "enabled": true },
      "platform": { "enabled": true }
    },
    "expected": {
      "effective": {
        "enabled": false, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "risk/local-raises-read-to-write",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "riskClass": "write" }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "local-policy", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "risk/platform-cannot-lower-write",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "riskClass": "safe-read" }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "risk/same-tier-relabel-ignored",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "delete", "riskClass": "delete", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "riskClass": "financial" }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "risk/platform-raises-write-to-external",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "riskClass": "external" }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "external", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "platform", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "approval/local-hardens-read",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": true }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "approval/tier-3-floor",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "delete", "riskClass": "delete", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "approval/write-relaxed-with-reviewed-pin",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": false, "reason": "reviewed in PR 42", "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "approval/platform-relaxes-write-with-pin",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "platform", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "approval/hardening-beats-relaxation",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": true },
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "approval/write-relax-without-pin-rejected",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": false }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-002", "field": "local.requiresApproval", "reason": "relaxation-requires-reviewed-pin" }]
    }
  },
  {
    "name": "approval/delete-relax-rejected",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "delete", "riskClass": "delete", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": false }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-002", "field": "local.requiresApproval", "reason": "tier-3-always-requires-approval" }]
    }
  },
  {
    "name": "approval/delete-relax-pinned-at-delete-rejected",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "delete", "riskClass": "delete", "requiresApproval": true, "rulesVersion": 1 },
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
    "name": "approval/relaxation-lapses-when-risk-raised-to-delete",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "delete", "riskClass": "delete", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "local.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "approval/relaxation-lapses-when-read-becomes-write",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "safe-read" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "local.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "approval/tier-1-relaxation-free",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "read-sensitive", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": false }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "read-sensitive", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "approval/local-raise-lets-platform-relaxation-lapse",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "riskClass": "write" },
      "platform": { "requiresApproval": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905", "atRiskClass": "safe-read" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "local-policy", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "override-lapsed-risk-raised", "field": "platform.requiresApproval" }],
      "errors": []
    }
  },
  {
    "name": "roles/intersection",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "allowedRoles": ["member", "admin"] },
      "platform": { "allowedRoles": ["viewer", "member"] }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": ["member"],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "platform", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "roles/empty-platform-list-keeps-local",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "allowedRoles": ["admin"] },
      "platform": { "allowedRoles": [] }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": ["admin"],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "local-policy", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "roles/disjoint-disables",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "allowedRoles": ["admin"] },
      "platform": { "allowedRoles": ["member"] }
    },
    "expected": {
      "effective": {
        "enabled": false, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "platform", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "platform", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "roles/dedupe-and-sort",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "allowedRoles": ["member", "admin", "member"] }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": ["admin", "member"],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "platform", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "description/platform-over-local",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "description": "Local text." },
      "platform": { "description": "Platform text." }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [], "description": "Platform text.",
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "platform" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "description/local-only",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "description": "Local text." }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [], "description": "Local text.",
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "local-policy" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "ratchet/code-lowering-held",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "previousEffectiveRiskClass": "write"
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "risk-lower-available", "field": "riskClass" }],
      "errors": []
    }
  },
  {
    "name": "ratchet/accepted-lowering",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "previousEffectiveRiskClass": "write",
      "acceptedRisk": { "riskClass": "safe-read", "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905" }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "ratchet/acceptance-for-old-tool-id-ignored",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "previousEffectiveRiskClass": "write",
      "acceptedRisk": { "riskClass": "safe-read", "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3906" }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "risk-lower-available", "field": "riskClass" }],
      "errors": []
    }
  },
  {
    "name": "ratchet/raise-is-automatic",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "delete", "riskClass": "delete", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "previousEffectiveRiskClass": "write"
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "delete", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "ratchet/local-raise-meets-previous",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "riskClass": "write" },
      "previousEffectiveRiskClass": "write"
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "code-default", "requiresApproval": "local-policy", "riskClass": "local-policy", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [], "errors": []
    }
  },
  {
    "name": "pin/orphaned-relaxation-lapses-hardening-stays",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "requiresApproval": false, "allowedRoles": ["admin"], "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3906", "atRiskClass": "write" } }
    },
    "expected": {
      "effective": {
        "enabled": true, "requiresApproval": true, "riskClass": "write", "allowedRoles": ["admin"],
        "origin": { "enabled": "code-default", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "local-policy", "description": "code-default" }
      },
      "warnings": [{ "code": "policy-entry-orphaned", "field": "local.pin.toolId" }],
      "errors": []
    }
  },
  {
    "name": "pin/orphaned-disable-stays",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "enabled": false, "pin": { "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3906", "atRiskClass": "safe-read" } }
    },
    "expected": {
      "effective": {
        "enabled": false, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "platform", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [{ "code": "policy-entry-orphaned", "field": "platform.pin.toolId" }],
      "errors": []
    }
  },
  {
    "name": "invalid/platform-entry-fails-closed",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "create", "riskClass": "write", "requiresApproval": true, "rulesVersion": 1 },
      "codeEnabled": true,
      "platform": { "riskClass": "critical" }
    },
    "expected": {
      "effective": {
        "enabled": false, "requiresApproval": true, "riskClass": "write", "allowedRoles": [],
        "origin": { "enabled": "platform", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-001", "field": "platform.riskClass", "reason": "invalid-entry" }]
    }
  },
  {
    "name": "invalid/local-unknown-key",
    "input": {
      "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905",
      "defaults": { "operationGroup": "read", "riskClass": "safe-read", "requiresApproval": false, "rulesVersion": 1 },
      "codeEnabled": true,
      "local": { "enabled": true, "toolId": "019fa9a9-d5f7-7ec3-a3c7-8899de1d3905" }
    },
    "expected": {
      "effective": {
        "enabled": false, "requiresApproval": false, "riskClass": "safe-read", "allowedRoles": [],
        "origin": { "enabled": "local-policy", "requiresApproval": "code-default", "riskClass": "code-default", "allowedRoles": "code-default", "description": "code-default" }
      },
      "warnings": [],
      "errors": [{ "code": "E-POLICY-001", "field": "local", "reason": "invalid-entry" }]
    }
  }
]
```

- [ ] **Step 4: Run the vector test**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-vectors.test.ts
```

Expected: PASS (36 tests: 1 coverage check + 35 vectors). If a vector fails, compare it against spec 4.5 and the bounds in Tasks 4–6. Fix whichever side contradicts the spec, and never edit a vector merely to match the code.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/__vectors__/tool-policy.v1.json src/contracts/__tests__/tool-policy-vectors.test.ts
git commit -m "test(contracts): add tool policy golden vectors v1"
```

---

### Task 8: Export the tool-policy contract from `glirastes/contracts`

**Files:**
- Modify: `src/contracts/index.ts` (insert after line 67, the end of the `semantic-change.js` type export)
- Test: `src/contracts/__tests__/tool-policy-exports.test.ts`

**Interfaces:**
- Consumes: everything exported by `src/contracts/tool-policy.ts`.
- Produces: the same names re-exported from `glirastes/contracts`.

- [ ] **Step 1: Write the failing test**

Create `src/contracts/__tests__/tool-policy-exports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as contracts from '../index.js';

describe('glirastes/contracts tool policy surface', () => {
  it('exports the shared tool policy contract', () => {
    expect(contracts.TOOL_POLICY_RULES_VERSION).toBe(1);
    for (const name of [
      'riskTier',
      'confirmationFloor',
      'mostRestrictiveRiskClass',
      'intersectAllowedRoles',
      'deriveToolPolicyDefaults',
      'parseToolPolicyFile',
      'resolveToolPolicy',
    ] as const) {
      expect(typeof contracts[name]).toBe('function');
    }
    expect(contracts.ToolPolicyFileSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
      tools: {},
      exclude: [],
      acceptedRisk: {},
    });
    expect(contracts.ToolPolicyEntrySchema.safeParse({ enabled: false }).success)
      .toBe(true);
    expect(contracts.ToolPolicyPinSchema.safeParse({
      toolId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
      atRiskClass: 'write',
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-exports.test.ts
```

Expected: FAIL, `expected undefined to be 1`.

- [ ] **Step 3: Minimal implementation**

In `src/contracts/index.ts` insert after line 67 (`} from './semantic-change.js';`):

```ts

export {
  TOOL_POLICY_RULES_VERSION,
  ToolPolicyEntrySchema,
  ToolPolicyFileSchema,
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
  EffectiveToolPolicy,
  PolicyOrigin,
  ResolveToolPolicyInput,
  ResolveToolPolicyResult,
  RiskTier,
  ToolPolicyDefaults,
  ToolPolicyDefaultsInput,
  ToolPolicyEntry,
  ToolPolicyFile,
  ToolPolicyWarningCode,
} from './tool-policy.js';
```

- [ ] **Step 4: Run the tests, typecheck and the subpath guard**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/tool-policy-exports.test.ts src/public-subpaths.test.ts && bun run typecheck
```

Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/index.ts src/contracts/__tests__/tool-policy-exports.test.ts
git commit -m "feat(contracts): export the tool policy contract"
```

---

### Task 9: Tier-based semantic risk comparison

**Files:**
- Modify: `src/contracts/semantic-change.ts:1-2, 31-66, 127`
- Test: `src/contracts/__tests__/semantic-change.test.ts:92-108`

**Interfaces:**
- Consumes: `riskTier` (Task 1).
- Produces: `classifyToolSemanticChange` keeps its signature. A change between equal tiers is now `'neutral'`, and `unknown` counts as tier 3. Neither case throws `E-SEMANTICS-003` any more; incomparable role sets still do.

- [ ] **Step 1: Write the failing test**

In `src/contracts/__tests__/semantic-change.test.ts` replace lines 92–108 (the `it.each([...])('fails closed for %s', …)` block) with:

```ts
  it.each([
    ['safe-read', 'unknown', 'hardening', false],
    ['unknown', 'write', 'loosening', true],
    ['delete', 'external', 'neutral', false],
    ['unknown', 'delete', 'neutral', false],
  ] as const)('classifies risk %s -> %s as %s', (
    beforeRisk,
    afterRisk,
    classification,
    requiresConfirmation,
  ) => {
    expect(classifyToolSemanticChange(
      { ...base, riskClass: beforeRisk },
      { ...base, riskClass: afterRisk },
    )).toEqual({
      toolId: base.toolId,
      classification,
      fields: ['riskClass'],
      requiresConfirmation,
    });
  });

  it('still fails closed for incomparable role sets', () => {
    expect(() => classifyToolSemanticChange(
      { ...base, allowedRoles: ['admin'] },
      { ...base, allowedRoles: ['editor'] },
    )).toThrowError(expect.objectContaining<Partial<FoundationDiagnosticError>>({
      code: 'E-SEMANTICS-003',
      operation: 'setup.semantic-change',
    }));
  });
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/semantic-change.test.ts
```

Expected: FAIL in all four `classifies risk …` rows with `FoundationDiagnosticError: A semantic change cannot be classified safely.`

- [ ] **Step 3: Minimal implementation**

In `src/contracts/semantic-change.ts` replace lines 1–2 with:

```ts
import type { ToolPresentation, ToolRiskClass } from './revisions.js';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { riskTier } from './tool-policy.js';
```

Delete the `RISK_TIER` constant (lines 31–38) and replace the whole `compareRisk` function (lines 50–66) with:

```ts
function compareRisk(
  before: ToolRiskClass,
  after: ToolRiskClass,
): SemanticChangeClassification {
  if (before === after) return 'unchanged';
  const beforeTier = riskTier(before);
  const afterTier = riskTier(after);
  // Equal-tier relabels (the unassessed 'unknown' counts as tier 3) change
  // no protection, so they never need confirmation.
  if (beforeTier === afterTier) return 'neutral';
  return afterTier > beforeTier ? 'hardening' : 'loosening';
}
```

Replace the call at line 127:

```ts
  add('riskClass', compareRisk(before.riskClass, after.riskClass, after.toolId));
```

with:

```ts
  add('riskClass', compareRisk(before.riskClass, after.riskClass));
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/contracts/__tests__/semantic-change.test.ts src/cli/commands/setup-plan.test.ts && bun run typecheck
```

Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/semantic-change.ts src/contracts/__tests__/semantic-change.test.ts
git commit -m "fix(contracts): classify equal-tier risk relabels as neutral"
```

---

### Task 10: `added` classification for new tools in the setup plan

**Files:**
- Modify: `src/contracts/semantic-change.ts:5-9` (the `SemanticChangeClassification` union; Task 9 moved it down by one line)
- Modify: `src/cli/commands/setup-plan.ts:4-10, 116-153`
- Test: `src/cli/commands/setup-plan.test.ts` (line 1; new helper after line 109; new tests after line 192)

**Interfaces:**
- Consumes: `deriveToolPolicyDefaults`, `riskTier`, `type AppSetupToolCandidate` from `src/contracts/index.ts`.
- Produces:
  - `export type SemanticChangeClassification = 'unchanged' | 'added' | 'hardening' | 'neutral' | 'loosening';`
  - In `compareArtifacts` (private), a tool that is new in the proposal yields `{ classification: 'added', fields: ['toolId'], requiresConfirmation: false }` when its policy is at least as strict as its defaults. Otherwise it yields `{ classification: 'loosening', fields: ['toolId', ...relaxedFields], requiresConfirmation: true }`.

Note: the existing test at lines 167–192 ("marks a loosening and binds confirmation to its exact digest") relaxes `requiresApproval` on an *existing* tool. Under spec 4.5 that stays a confirmable loosening, so the test stays unchanged. The new-tool expectations are added beside it.

- [ ] **Step 1: Write the failing test**

In `src/cli/commands/setup-plan.test.ts` replace line 1 with:

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
```

Insert after the `fixture()` function (after line 109):

```ts

async function firstSetupFixture(
  proposed: ReturnType<typeof artifact>,
): Promise<string> {
  const root = await fixture();
  await rm(join(root, '.glirastes/setup-artifact.json'));
  await rm(join(root, '.glirastes/previous-setup-artifact.json'));
  await writeFile(
    join(root, '.glirastes/proposed-setup.json'),
    `${JSON.stringify(proposed)}\n`,
  );
  return root;
}
```

Insert after the existing test "marks a loosening and binds confirmation to its exact digest" (after line 192):

```ts

  it('adds a new tool at its route defaults without confirmation', async () => {
    const root = await fixture();
    const previous = artifact({
      toolId: id('9'),
      name: 'tasks.archived',
      modelName: 'tasks_archived',
      path: '/api/tasks/archived',
    });
    previous.planner.toolIds = [id('9')];
    await writeFile(
      join(root, '.glirastes/previous-setup-artifact.json'),
      `${JSON.stringify(previous)}\n`,
    );

    const plan = await createSetupPlan({ rootDir: root });

    expect(plan.semanticChanges).toEqual([
      {
        toolId: id('4'),
        classification: 'added',
        fields: ['toolId'],
        requiresConfirmation: false,
      },
      {
        toolId: id('9'),
        classification: 'hardening',
        fields: ['toolId'],
        requiresConfirmation: false,
      },
    ]);
    expect(plan.requiresConfirmation).toBe(false);
    expect(() => assertSetupPlanConfirmation(plan, {})).not.toThrow();
  });

  it('needs no confirmation for a first setup at the defaults', async () => {
    const root = await firstSetupFixture(artifact({
      name: 'tasks.create',
      modelName: 'tasks_create',
      method: 'POST',
      operationGroup: 'create',
      riskClass: 'write',
      requiresApproval: true,
    }));

    const plan = await createSetupPlan({
      rootDir: root,
      artifactPath: '.glirastes/proposed-setup.json',
    });

    expect(plan.semanticChanges).toEqual([{
      toolId: id('4'),
      classification: 'added',
      fields: ['toolId'],
      requiresConfirmation: false,
    }]);
    expect(plan.requiresConfirmation).toBe(false);
  });

  it.each([
    ['an unconfirmed write', {
      name: 'tasks.create',
      modelName: 'tasks_create',
      method: 'POST',
      operationGroup: 'create',
      riskClass: 'write',
      requiresApproval: false,
    }, ['toolId', 'requiresApproval']],
    ['a delete below its default risk', {
      name: 'tasks.delete',
      modelName: 'tasks_delete',
      method: 'DELETE',
      path: '/api/tasks/[id]',
      operationGroup: 'delete',
      riskClass: 'write',
      requiresApproval: true,
    }, ['toolId', 'riskClass']],
  ])('keeps %s on a new tool as a confirmable loosening', async (
    _label,
    overrides,
    fields,
  ) => {
    const root = await firstSetupFixture(artifact(overrides));

    const plan = await createSetupPlan({
      rootDir: root,
      artifactPath: '.glirastes/proposed-setup.json',
    });

    expect(plan.semanticChanges).toEqual([{
      toolId: id('4'),
      classification: 'loosening',
      fields,
      requiresConfirmation: true,
    }]);
    expect(() => assertSetupPlanConfirmation(plan, {}))
      .toThrowError(expect.objectContaining({ code: 'E-SEMANTICS-004' }));
  });
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/setup-plan.test.ts
```

Expected: FAIL in "adds a new tool…" and "needs no confirmation…" (`classification: 'loosening'`, fields `['toolId']`), and in both `keeps … loosening` rows (fields `['toolId']` instead of the relaxed fields).

- [ ] **Step 3: Minimal implementation**

In `src/contracts/semantic-change.ts` replace lines 5–9 (after Task 9's three-line import block):

```ts
export type SemanticChangeClassification =
  | 'unchanged'
  | 'hardening'
  | 'neutral'
  | 'loosening';
```

with:

```ts
export type SemanticChangeClassification =
  | 'unchanged'
  | 'added'
  | 'hardening'
  | 'neutral'
  | 'loosening';
```

In `src/cli/commands/setup-plan.ts` replace lines 4–10 with:

```ts
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
```

Replace the whole `compareArtifacts` function (lines 116–153) with:

```ts
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

function compareArtifacts(
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
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/cli/commands/setup-plan.test.ts src/cli/commands/apply-setup-plan.test.ts src/cli/commands/doctor.test.ts src/contracts/__tests__/semantic-change.test.ts && bun run typecheck
```

Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/contracts/semantic-change.ts src/cli/commands/setup-plan.ts src/cli/commands/setup-plan.test.ts
git commit -m "feat(cli): classify new tools at their defaults as added"
```

---

### Task 11: Tier-3 confirmation floor at runtime

**Files:**
- Modify: `src/runtime/authorization.ts:1-7, 69-73`
- Modify: `src/runtime/local-tool-bindings.ts:1-4, 235`
- Modify: `src/runtime/local-runtime-source.ts:1-28, 236-239`
- Test: `src/runtime/__tests__/authorization.test.ts`, `src/runtime/__tests__/managed-turn.test.ts`, `src/runtime/__tests__/local-tool-bindings.test.ts`, `src/runtime/__tests__/local-runtime-source.test.ts`

**Interfaces:**
- Consumes: `confirmationFloor` (Task 1).
- Produces: `authorizeToolCall(...).requiresApproval`, `ManagedTurnGuard.resolveApproval`, the registry's `needsApproval` and standalone `toolPolicies[].requiresApproval` all equal `confirmationFloor(riskClass, requiresApproval)`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('authorizeToolCall', …)` in `src/runtime/__tests__/authorization.test.ts` (before its closing `});`):

```ts

  it('always confirms tier-3 tools even when the policy does not ask for it', () => {
    expect(authorizeToolCall({
      principal,
      agentRevision,
      manifestRevision: {
        ...manifestRevision,
        tools: [{ ...manifestRevision.tools[0]!, riskClass: 'delete' }],
      },
      policyRevision: {
        ...policyRevision,
        toolPolicies: [{
          ...policyRevision.toolPolicies[0]!,
          riskClass: 'delete',
          requiresApproval: false,
        }],
      },
      toolId: agentRevision.toolAllowlist[0]!,
    })).toEqual({ allowed: true, requiresApproval: true, riskClass: 'delete' });
  });
```

Append inside `describe('createManagedTurnGuard', …)` in `src/runtime/__tests__/managed-turn.test.ts` (before its closing `});`):

```ts

  it('confirms a tier-3 call even if its pinned policy says no', async () => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-tier-3',
      agentRevision,
      manifestRevision: {
        ...manifestRevision,
        tools: manifestRevision.tools.map((tool) => ({
          ...tool,
          riskClass: 'delete' as const,
        })),
      },
      policyRevision: {
        ...policyRevision,
        toolPolicies: policyRevision.toolPolicies.map((policy) => ({
          ...policy,
          riskClass: 'delete' as const,
          requiresApproval: false,
        })),
      },
      principal,
      localLimits,
    });
    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: async () => principal,
    });

    await expect(guard.resolveApproval({
      toolName: 'list_tasks',
      input: {},
    })).resolves.toBe(true);
  });
```

Insert before the closing `});` of `describe('materializeManifestToolRegistry', …)` (line 221) in `src/runtime/__tests__/local-tool-bindings.test.ts`:

```ts

  it('confirms tier-3 tools even when the policy does not ask for it', () => {
    const base = snapshot();
    const tierThree = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{ ...base.manifestRevision.tools[0]!, riskClass: 'delete' as const }],
      },
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [{
          ...base.policyRevision.toolPolicies[0]!,
          riskClass: 'delete' as const,
          requiresApproval: false,
        }],
      },
    };
    expect(materializeManifestToolRegistry({
      snapshot: tierThree,
      bindings: [binding],
    }).list_tasks?.needsApproval).toBe(true);
  });

  it('keeps a reviewed write relaxation unconfirmed', () => {
    const base = snapshot();
    const relaxedWrite = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{ ...base.manifestRevision.tools[0]!, riskClass: 'write' as const }],
      },
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [{
          ...base.policyRevision.toolPolicies[0]!,
          riskClass: 'write' as const,
          requiresApproval: false,
        }],
      },
    };
    expect(materializeManifestToolRegistry({
      snapshot: relaxedWrite,
      bindings: [binding],
    }).list_tasks?.needsApproval).toBe(false);
  });
```

Insert before the closing `});` of `describe('createLocalRuntimeSource', …)` in `src/runtime/__tests__/local-runtime-source.test.ts`:

```ts

  it('never lets a tier-3 tool run unattended', () => {
    const artifact = fixtureArtifact() as {
      tools: Array<Record<string, unknown>>;
    };
    artifact.tools[0]!.riskClass = 'delete';
    artifact.tools[0]!.requiresApproval = false;
    const source = createLocalRuntimeSource(
      fixtureOptions({ setupArtifact: artifact }),
    );
    const snapshot = source.resolveTurnSnapshot({
      turnId: 't-1',
      principal: fixturePrincipal(source.identity.tenantId),
    });
    expect(snapshot.policyRevision.toolPolicies[0]).toMatchObject({
      toolId: ENDPOINT_TOOL_ID,
      riskClass: 'delete',
      requiresApproval: true,
    });
  });
```

- [ ] **Step 2: Run the tests and see them fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/authorization.test.ts src/runtime/__tests__/managed-turn.test.ts src/runtime/__tests__/local-tool-bindings.test.ts src/runtime/__tests__/local-runtime-source.test.ts
```

Expected: FAIL in the four tier-3 tests (`expected false to be true` / `requiresApproval: false`). "keeps a reviewed write relaxation unconfirmed" already passes.

- [ ] **Step 3: Minimal implementation**

`src/runtime/authorization.ts`: replace lines 1–7 with:

```ts
import type {
  AgentRevision,
  ManifestRevision,
  Principal,
  RuntimePolicyRevision,
  ToolRiskClass,
} from '../contracts/index.js';
import { confirmationFloor } from '../contracts/tool-policy.js';
```

and replace the final return block (lines 69–73 before the import edit, 70–74 after it):

```ts
  return {
    allowed: true,
    requiresApproval: policy.requiresApproval,
    riskClass: policy.riskClass,
  };
```

with:

```ts
  return {
    allowed: true,
    // Tier 3 always confirms, whatever the pinned policy says.
    requiresApproval: confirmationFloor(policy.riskClass, policy.requiresApproval),
    riskClass: policy.riskClass,
  };
```

`src/runtime/local-tool-bindings.ts`: replace lines 1–4 with:

```ts
import { createHash } from 'node:crypto';
import type {
  ManifestTool,
} from '../contracts/revisions.js';
import { confirmationFloor } from '../contracts/tool-policy.js';
```

and replace the line `      needsApproval: policy.requiresApproval,` (line 235 before the import edit) with:

```ts
      needsApproval: confirmationFloor(policy.riskClass, policy.requiresApproval),
```

`src/runtime/local-runtime-source.ts`: after line 18 (`} from '../contracts/index.js';`) insert:

```ts
import { confirmationFloor } from '../contracts/tool-policy.js';
```

and replace lines 236–239:

```ts
          // An unassessed risk class never runs unattended.
          requiresApproval: tool.riskClass === 'unknown'
            ? true
            : tool.requiresApproval,
```

with:

```ts
          // Unassessed ('unknown') and tier-3 tools never run unattended.
          requiresApproval: confirmationFloor(tool.riskClass, tool.requiresApproval),
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime src/sync && bun run typecheck
```

Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/authorization.ts src/runtime/local-tool-bindings.ts src/runtime/local-runtime-source.ts src/runtime/__tests__/authorization.test.ts src/runtime/__tests__/managed-turn.test.ts src/runtime/__tests__/local-tool-bindings.test.ts src/runtime/__tests__/local-runtime-source.test.ts
git commit -m "fix(runtime): enforce the tier-3 confirmation floor at runtime"
```

---

### Task 12: Per-tool fail-closed bindings and tier-based risk checks

**Files:**
- Modify: `src/runtime/local-tool-bindings.ts` (imports; replace `assertLocalToolBindingMatches` lines 120–157 and `materializeManifestToolRegistry` lines 176–241; Task 11 added one import line)
- Modify: `src/runtime/tool-discovery.ts:1-5, 132`
- Modify: `src/sync/local-deployment-validator.ts:1-4, 44-46`
- Test: `src/runtime/__tests__/local-tool-bindings.test.ts`, `src/runtime/__tests__/tool-discovery.test.ts`, `src/sync/__tests__/local-deployment-validator.test.ts`

**Interfaces:**
- Consumes: `riskTier`, `confirmationFloor` (Task 1).
- Produces:
  - `export type ToolRegistryDiagnosticReason = 'local-binding-missing' | 'local-binding-mismatch' | 'runtime-policy-missing' | 'runtime-policy-risk-below-manifest';`
  - `export interface ToolRegistryDiagnostic { code: 'E-BINDING-010' | 'E-BINDING-011' | 'E-POLICY-010' | 'E-POLICY-011'; reason: ToolRegistryDiagnosticReason; toolId: string; mismatches?: string[] }`
  - `export function localToolBindingMismatches(binding: LocalToolBinding, manifestTool: ManifestTool): string[];`
  - `export function assertLocalToolBindingMatches(binding: LocalToolBinding, manifestTool: ManifestTool): void;` (unchanged behaviour)
  - `export function materializeManifestToolRegistry(options: { snapshot: TurnSnapshot; bindings: ReadonlyArray<LocalToolBinding>; onToolUnavailable?: (diagnostic: ToolRegistryDiagnostic) => void }): ToolRegistry;`. A missing or mismatched binding, a missing policy, or a policy below the manifest tier now skips only that tool and reports it. The default reporter is a content-free `console.warn`. Duplicate bindings and name collisions still throw.
  - Discovery and `validateLocalDeploymentBindings` accept `riskTier(policy) >= riskTier(manifest)` and reject lower.

- [ ] **Step 1: Write the failing tests**

In `src/runtime/__tests__/local-tool-bindings.test.ts`:

Replace line 1 with:

```ts
import { describe, expect, it, vi } from 'vitest';
```

Replace lines 13–17 with:

```ts
import {
  createLocalSchemaDigest,
  materializeManifestToolRegistry,
  type LocalToolBinding,
  type ToolRegistryDiagnostic,
} from '../local-tool-bindings.js';
```

In the test "materializes a UI action binding without an HTTP endpoint", replace its final assertion:

```ts
    expect(() => materializeManifestToolRegistry({
      snapshot: uiSnapshot,
      bindings: [{
        ...uiBinding,
        actionBindingRef: 'task-details.wrong',
      }],
    })).toThrow(/local tool binding mismatch/i);
```

with:

```ts
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: uiSnapshot,
      bindings: [{
        ...uiBinding,
        actionBindingRef: 'task-details.wrong',
      }],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-011',
      reason: 'local-binding-mismatch',
      toolId: endpointManifestTool.toolId,
      mismatches: ['action binding'],
    }]);
```

Replace the `it.each([...])('fails closed on a mismatched %s', …)` test (lines 144–155) with:

```ts
  it.each([
    ['source fingerprint', { sourceFingerprint: 'sha256:changed' }],
    ['method', { method: 'POST' as const }],
    ['path', { path: '/api/other' }],
    ['input schema digest', { inputSchemaDigest: 'sha256:changed' }],
    ['output schema digest', { outputSchemaDigest: 'sha256:changed' }],
  ])('disables only the tool with a mismatched %s', (label, override) => {
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: snapshot(),
      bindings: [{ ...binding, ...override }],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-011',
      reason: 'local-binding-mismatch',
      toolId: binding.toolId,
      mismatches: [label],
    }]);
  });
```

Replace the test "fails closed when an enabled manifest tool has no local binding" (lines 215–220) with:

```ts
  it('disables a tool without a local binding and reports it', () => {
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: snapshot(),
      bindings: [],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-010',
      reason: 'local-binding-missing',
      toolId: binding.toolId,
    }]);
  });

  it('keeps every other tool when one binding is missing', () => {
    const base = snapshot();
    const first = base.manifestRevision.tools[0]!;
    const secondToolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a10';
    const twoTools = {
      ...base,
      agentRevision: {
        ...base.agentRevision,
        toolAllowlist: [first.toolId, secondToolId],
      },
      manifestRevision: {
        ...base.manifestRevision,
        tools: [first, { ...first, toolId: secondToolId, name: 'archive_tasks' }],
      },
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [
          ...base.policyRevision.toolPolicies,
          { ...base.policyRevision.toolPolicies[0]!, toolId: secondToolId },
        ],
      },
    };
    const diagnostics: ToolRegistryDiagnostic[] = [];

    const registry = materializeManifestToolRegistry({
      snapshot: twoTools,
      bindings: [binding],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(Object.keys(registry)).toEqual(['list_tasks']);
    expect(diagnostics).toEqual([{
      code: 'E-BINDING-010',
      reason: 'local-binding-missing',
      toolId: secondToolId,
    }]);
  });

  it('accepts a policy that raises the manifest risk and confirms it', () => {
    const base = snapshot();
    const raised = {
      ...base,
      policyRevision: {
        ...base.policyRevision,
        toolPolicies: [{
          ...base.policyRevision.toolPolicies[0]!,
          riskClass: 'delete' as const,
          requiresApproval: false,
        }],
      },
    };
    expect(materializeManifestToolRegistry({
      snapshot: raised,
      bindings: [binding],
    }).list_tasks?.needsApproval).toBe(true);
  });

  it('disables a tool whose policy sits below the manifest risk', () => {
    const base = snapshot();
    const lowered = {
      ...base,
      manifestRevision: {
        ...base.manifestRevision,
        tools: [{ ...base.manifestRevision.tools[0]!, riskClass: 'write' as const }],
      },
    };
    const diagnostics: ToolRegistryDiagnostic[] = [];
    expect(materializeManifestToolRegistry({
      snapshot: lowered,
      bindings: [binding],
      onToolUnavailable: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual({});
    expect(diagnostics).toEqual([{
      code: 'E-POLICY-011',
      reason: 'runtime-policy-risk-below-manifest',
      toolId: binding.toolId,
    }]);
  });

  it('reports an unavailable tool through console.warn by default without content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(materializeManifestToolRegistry({
        snapshot: snapshot(),
        bindings: [],
      })).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[glirastes] tool disabled for this turn',
        {
          code: 'E-BINDING-010',
          reason: 'local-binding-missing',
          toolId: binding.toolId,
        },
      );
      expect(JSON.stringify(warn.mock.calls))
        .not.toMatch(/description|schema|execute/i);
    } finally {
      warn.mockRestore();
    }
  });
```

Append inside `describe('createTurnToolDiscovery', …)` in `src/runtime/__tests__/tool-discovery.test.ts` (before its closing `});`):

```ts

  it('keeps a tool whose policy raised its risk and drops one whose policy lowered it', () => {
    const raised = fixture();
    raised.snapshot.policyRevision.toolPolicies[0]!.riskClass = 'delete';
    expect(createTurnToolDiscovery(raised).eligibleNames)
      .toContain('tasks_listTasks');

    const lowered = fixture();
    lowered.snapshot.manifestRevision.tools[0]!.riskClass = 'write';
    expect(createTurnToolDiscovery(lowered).eligibleNames)
      .not.toContain('tasks_listTasks');
  });
```

Append inside `describe('validateLocalDeploymentBindings', …)` in `src/sync/__tests__/local-deployment-validator.test.ts` (before its closing `});`):

```ts

  it('accepts a policy that raises the manifest risk', () => {
    const deployment = revisions();
    deployment.policyRevision.toolPolicies[0]!.riskClass = 'write';

    expect(() => validateLocalDeploymentBindings({
      revisions: deployment,
      bindings: bindings(),
    })).not.toThrow();
  });

  it('rejects a policy below the manifest risk', () => {
    const deployment = revisions();
    deployment.manifestRevision.tools[0]!.riskClass = 'write';

    expect(() => validateLocalDeploymentBindings({
      revisions: deployment,
      bindings: bindings(),
    })).toThrow(/risk below manifest/i);
  });
```

- [ ] **Step 2: Run the tests and see them fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/local-tool-bindings.test.ts src/runtime/__tests__/tool-discovery.test.ts src/sync/__tests__/local-deployment-validator.test.ts
```

Expected: FAIL. The registry still throws `Local tool binding mismatch`, `Missing local tool binding` and `Runtime tool policy mismatch`. Discovery drops the raised tool. The validator throws `Runtime tool policy risk mismatch` for the raised policy and the wrong message for the lowered one.

- [ ] **Step 3: Minimal implementation**

`src/runtime/local-tool-bindings.ts`: replace the tool-policy import line added in Task 11 with:

```ts
import { confirmationFloor, riskTier } from '../contracts/tool-policy.js';
```

Replace the whole `assertLocalToolBindingMatches` function (lines 120–157 at task start; 119–156 in the original file) with:

```ts
/**
 * Names of the technical facts on which a local binding disagrees with its
 * signed manifest entry. Names only, never values or content.
 */
export function localToolBindingMismatches(
  binding: LocalToolBinding,
  manifestTool: ManifestTool,
): string[] {
  const mismatches: string[] = [];
  if (binding.executionKind !== manifestTool.executionKind) {
    mismatches.push('execution kind');
  }
  if (binding.sourceFingerprint !== manifestTool.sourceFingerprint) {
    mismatches.push('source fingerprint');
  }
  if (binding.inputSchemaDigest !== manifestTool.inputSchemaDigest) {
    mismatches.push('input schema digest');
  }
  if (binding.outputSchemaDigest !== manifestTool.outputSchemaDigest) {
    mismatches.push('output schema digest');
  }
  if (
    binding.executionKind === 'endpoint'
    && manifestTool.executionKind === 'endpoint'
  ) {
    if (binding.method !== manifestTool.method) mismatches.push('method');
    if (binding.path !== manifestTool.path) mismatches.push('path');
  }
  if (
    binding.executionKind === 'ui'
    && manifestTool.executionKind === 'ui'
    && binding.actionBindingRef !== manifestTool.actionBindingRef
  ) {
    mismatches.push('action binding');
  }
  return mismatches;
}

export function assertLocalToolBindingMatches(
  binding: LocalToolBinding,
  manifestTool: ManifestTool,
): void {
  const mismatches = localToolBindingMismatches(binding, manifestTool);
  if (mismatches.length > 0) {
    throw new Error(
      `Local tool binding mismatch (${manifestTool.toolId}): `
      + mismatches.join(', '),
    );
  }
}
```

Replace the whole `materializeManifestToolRegistry` function (lines 176–241 at task start; 175–240 in the original file) with:

```ts
export type ToolRegistryDiagnosticReason =
  | 'local-binding-missing'
  | 'local-binding-mismatch'
  | 'runtime-policy-missing'
  | 'runtime-policy-risk-below-manifest';

export interface ToolRegistryDiagnostic {
  code: 'E-BINDING-010' | 'E-BINDING-011' | 'E-POLICY-010' | 'E-POLICY-011';
  reason: ToolRegistryDiagnosticReason;
  toolId: string;
  /** Names of mismatched technical facts; never values or content. */
  mismatches?: string[];
}

function reportUnavailableTool(diagnostic: ToolRegistryDiagnostic): void {
  console.warn('[glirastes] tool disabled for this turn', diagnostic);
}

export function materializeManifestToolRegistry(options: {
  snapshot: TurnSnapshot;
  bindings: ReadonlyArray<LocalToolBinding>;
  /** Receives one content-free diagnostic per tool that stays unavailable. */
  onToolUnavailable?: (diagnostic: ToolRegistryDiagnostic) => void;
}): ToolRegistry {
  const report = options.onToolUnavailable ?? reportUnavailableTool;
  const bindingsByToolId = new Map<string, LocalToolBinding>();
  for (const binding of options.bindings) {
    if (bindingsByToolId.has(binding.toolId)) {
      throw new Error(`Duplicate local tool binding: ${binding.toolId}`);
    }
    bindingsByToolId.set(binding.toolId, binding);
  }

  const policiesByToolId = new Map(
    options.snapshot.policyRevision.toolPolicies.map(
      (policy) => [policy.toolId, policy] as const,
    ),
  );
  const allowedToolIds = new Set(
    options.snapshot.agentRevision.toolAllowlist,
  );
  const registry: ToolRegistry = {};

  for (const manifestTool of options.snapshot.manifestRevision.tools) {
    if (
      !manifestTool.enabled
      || manifestTool.tombstone
      || !allowedToolIds.has(manifestTool.toolId)
    ) {
      continue;
    }
    const toolId = manifestTool.toolId;

    // Each failure below disables only this tool; the rest keep working.
    const policy = policiesByToolId.get(toolId);
    if (!policy) {
      report({ code: 'E-POLICY-010', reason: 'runtime-policy-missing', toolId });
      continue;
    }
    if (!policy.enabled) continue;
    // A policy may raise the manifest risk (overlay), never lower it.
    if (riskTier(policy.riskClass) < riskTier(manifestTool.riskClass)) {
      report({
        code: 'E-POLICY-011',
        reason: 'runtime-policy-risk-below-manifest',
        toolId,
      });
      continue;
    }

    const binding = bindingsByToolId.get(toolId);
    if (!binding) {
      report({ code: 'E-BINDING-010', reason: 'local-binding-missing', toolId });
      continue;
    }
    const mismatches = localToolBindingMismatches(binding, manifestTool);
    if (mismatches.length > 0) {
      report({
        code: 'E-BINDING-011',
        reason: 'local-binding-mismatch',
        toolId,
        mismatches,
      });
      continue;
    }

    const modelName = modelFacingToolName(manifestTool.name);
    if (registry[modelName]) {
      throw new Error(
        `Manifest tool names collide after model-safe encoding: ${modelName}`,
      );
    }

    registry[modelName] = {
      ...binding.tool,
      id: toolId,
      description: manifestTool.description,
      method: manifestTool.executionKind === 'endpoint'
        ? manifestTool.method
        : undefined,
      needsApproval: confirmationFloor(policy.riskClass, policy.requiresApproval),
    };
  }

  return registry;
}
```

`src/runtime/tool-discovery.ts`: after line 1 (`import type { ToolPresentation } from '../contracts/index.js';`) insert:

```ts
import { riskTier } from '../contracts/tool-policy.js';
```

and replace line 132:

```ts
      || policy.riskClass !== manifestTool.riskClass
```

with:

```ts
      || riskTier(policy.riskClass) < riskTier(manifestTool.riskClass)
```

`src/sync/local-deployment-validator.ts`: replace lines 1–4 with:

```ts
import { riskTier } from '../contracts/tool-policy.js';
import {
  assertLocalToolBindingMatches,
  type LocalToolBinding,
} from '../runtime/local-tool-bindings.js';
```

and replace lines 44–46:

```ts
    if (policy.riskClass !== manifestTool.riskClass) {
      throw new Error(`Runtime tool policy risk mismatch: ${toolId}`);
    }
```

with:

```ts
    // A policy may raise the manifest risk, never lower it.
    if (riskTier(policy.riskClass) < riskTier(manifestTool.riskClass)) {
      throw new Error(`Runtime tool policy risk below manifest: ${toolId}`);
    }
```

Note for the merge after P07: P07 edits `src/runtime/tool-discovery.ts` in `codex/mvp-chat`. Keep this one-line condition and the import when you resolve conflicts.

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run typecheck && bun run build && bunx vitest run src/runtime src/sync tests/source-driven-next.test.ts
```

Expected: PASS, typecheck exit 0. The rebuild matters: `tests/source-driven-next.test.ts` drives `materializeManifestToolRegistry` through `glirastes/runtime`, which resolves to `dist/`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/local-tool-bindings.ts src/runtime/tool-discovery.ts src/sync/local-deployment-validator.ts src/runtime/__tests__/local-tool-bindings.test.ts src/runtime/__tests__/tool-discovery.test.ts src/sync/__tests__/local-deployment-validator.test.ts
git commit -m "fix(runtime): disable only the tool with a broken binding"
```

---

### Task 13: Restrict-only Platform policy overlay

**Files:**
- Create: `src/runtime/policy-overlay.ts`
- Test: `src/runtime/__tests__/policy-overlay.test.ts`

**Interfaces:**
- Consumes: `RuntimeToolPolicy`, `RuntimePolicyRevision`, `ExecutionBudget` (`src/contracts/index.ts`); `confirmationFloor`, `intersectAllowedRoles`, `mostRestrictiveRiskClass`, `riskTier`, `ToolPolicyEntry` (`src/contracts/tool-policy.ts`).
- Produces:
  - `export type PolicyOverlayEntry = { toolId: string } & ToolPolicyEntry;`
  - `export interface PolicyOverlayIgnoredEntry { toolId: string; reason: 'platform-tool-not-in-code' }`
  - `export interface PolicyOverlayResult { policies: RuntimeToolPolicy[]; ignored: PolicyOverlayIgnoredEntry[] }`
  - `export interface VerifiedPolicyOverlay { revisionId: string; revision: number; entries: PolicyOverlayEntry[]; budget?: ExecutionBudget }`
  - `export function applyPolicyOverlay(local: RuntimeToolPolicy[], overlay: Array<{ toolId: string } & ToolPolicyEntry>): { policies: RuntimeToolPolicy[]; ignored: Array<{ toolId: string; reason: 'platform-tool-not-in-code' }> };`
  - `export function policyOverlayFromRevision(revision: RuntimePolicyRevision): VerifiedPolicyOverlay;`

- [ ] **Step 1: Write the failing test**

Create `src/runtime/__tests__/policy-overlay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type {
  ExecutionBudget,
  RuntimePolicyRevision,
  RuntimeToolPolicy,
  ToolRiskClass,
} from '../../contracts/index.js';
import {
  TOOL_POLICY_RULES_VERSION,
  resolveToolPolicy,
  type ToolPolicyEntry,
} from '../../contracts/tool-policy.js';
import {
  applyPolicyOverlay,
  policyOverlayFromRevision,
} from '../policy-overlay.js';

const READ_ID = '11111111-1111-4111-8111-111111111111';
const WRITE_ID = '22222222-2222-4222-8222-222222222222';
const DELETE_ID = '33333333-3333-4333-8333-333333333333';
const REMOVED_ID = '44444444-4444-4444-8444-444444444444';

const READ: RuntimeToolPolicy = {
  toolId: READ_ID,
  enabled: true,
  riskClass: 'safe-read',
  requiresApproval: false,
  allowedRoles: [],
};
const WRITE: RuntimeToolPolicy = {
  toolId: WRITE_ID,
  enabled: true,
  riskClass: 'write',
  requiresApproval: true,
  allowedRoles: ['member'],
};
const DELETE: RuntimeToolPolicy = {
  toolId: DELETE_ID,
  enabled: true,
  riskClass: 'delete',
  requiresApproval: true,
  allowedRoles: [],
};

const BUDGET: ExecutionBudget = {
  maxModelSteps: 8,
  maxToolCalls: 16,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 10_000,
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

describe('applyPolicyOverlay', () => {
  it('keeps local policies untouched without overlay entries', () => {
    expect(applyPolicyOverlay([READ, WRITE], []))
      .toEqual({ policies: [READ, WRITE], ignored: [] });
  });

  it('ignores overlay ids that the deployed code does not have', () => {
    expect(applyPolicyOverlay([READ], [
      { toolId: REMOVED_ID, enabled: true, requiresApproval: false },
      { toolId: REMOVED_ID, allowedRoles: ['admin'] },
    ])).toEqual({
      policies: [READ],
      ignored: [{ toolId: REMOVED_ID, reason: 'platform-tool-not-in-code' }],
    });
  });

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

  it('applies disabling, risk raises, role narrowing and confirmation', () => {
    const { policies } = applyPolicyOverlay([READ, WRITE, DELETE], [
      { toolId: READ_ID, riskClass: 'write' },
      { toolId: WRITE_ID, allowedRoles: ['admin', 'member'] },
      { toolId: DELETE_ID, enabled: false },
    ]);
    expect(policies).toEqual([
      { ...READ, riskClass: 'write', requiresApproval: true },
      { ...WRITE, allowedRoles: ['member'] },
      { ...DELETE, enabled: false },
    ]);
  });

  it('disables a tool whose role restrictions do not overlap', () => {
    expect(applyPolicyOverlay([WRITE], [
      { toolId: WRITE_ID, allowedRoles: ['admin'] },
    ]).policies).toEqual([{ ...WRITE, enabled: false, allowedRoles: [] }]);
  });

  const parityCases: Array<[string, RuntimeToolPolicy, ToolPolicyEntry]> = [
    ['disable', READ, { enabled: false }],
    ['raise read to write', READ, { riskClass: 'write' }],
    ['raise relaxed write to delete', { ...WRITE, requiresApproval: false }, {
      riskClass: 'delete',
    }],
    ['narrow roles', WRITE, { allowedRoles: ['admin', 'member'] }],
    ['disjoint roles', WRITE, { allowedRoles: ['admin'] }],
    ['harden approval', READ, { requiresApproval: true }],
    ['relaxation attempt on write', WRITE, { requiresApproval: false }],
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
    expect(overlaid).toEqual({
      toolId: local.toolId,
      enabled: resolved.enabled,
      riskClass: resolved.riskClass,
      requiresApproval: resolved.requiresApproval,
      allowedRoles: resolved.allowedRoles,
    });
  });
});

describe('policyOverlayFromRevision', () => {
  it('maps a verified policy revision to entries and keeps its identity', () => {
    const revision: RuntimePolicyRevision = {
      revisionId: '55555555-5555-4555-8555-555555555555',
      revision: 7,
      tenantId: '66666666-6666-4666-8666-666666666666',
      environmentId: '77777777-7777-4777-8777-777777777777',
      budget: BUDGET,
      toolPolicies: [WRITE],
      publishedAt: '2026-10-04T00:00:00.000Z',
      signature: {
        algorithm: 'Ed25519',
        keyId: 'platform-key',
        value: 'c2lnbmF0dXJl',
      },
    };

    expect(policyOverlayFromRevision(revision)).toEqual({
      revisionId: revision.revisionId,
      revision: 7,
      budget: BUDGET,
      entries: [{
        toolId: WRITE_ID,
        enabled: true,
        requiresApproval: true,
        riskClass: 'write',
        allowedRoles: ['member'],
      }],
    });
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/policy-overlay.test.ts
```

Expected: FAIL, `Failed to load url ../policy-overlay.js`.

- [ ] **Step 3: Minimal implementation**

Create `src/runtime/policy-overlay.ts`:

```ts
import type {
  ExecutionBudget,
  RuntimePolicyRevision,
  RuntimeToolPolicy,
} from '../contracts/index.js';
import {
  confirmationFloor,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  riskTier,
  type ToolPolicyEntry,
} from '../contracts/tool-policy.js';

/** One Platform delta for one tool the deployed code owns. */
export type PolicyOverlayEntry = { toolId: string } & ToolPolicyEntry;

export interface PolicyOverlayIgnoredEntry {
  toolId: string;
  reason: 'platform-tool-not-in-code';
}

export interface PolicyOverlayResult {
  policies: RuntimeToolPolicy[];
  ignored: PolicyOverlayIgnoredEntry[];
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
 * Composes the local effective policies with a verified Platform overlay,
 * restrict-only (spec 4.9, resolveToolPolicy semantics): disable, raise the
 * risk class, narrow roles, require confirmation. `enabled: true`, a lower
 * risk class and `requiresApproval: false` are no-ops, pinned or not. Overlay
 * ids without a local policy are ignored and reported.
 */
export function applyPolicyOverlay(
  local: RuntimeToolPolicy[],
  overlay: PolicyOverlayEntry[],
): PolicyOverlayResult {
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
  return {
    policies: local.map((policy) =>
      (entriesByToolId.get(policy.toolId) ?? []).reduce(restrictPolicy, policy)),
    ignored: [...ignored].sort().map((toolId) => ({
      toolId,
      reason: 'platform-tool-not-in-code' as const,
    })),
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

/**
 * Reads a Platform policy revision the sync manager already verified as an
 * overlay. Values that copy the local base are harmless: composition is
 * restrict-only, so a copy resolves to the local value.
 */
export function policyOverlayFromRevision(
  revision: RuntimePolicyRevision,
): VerifiedPolicyOverlay {
  return {
    revisionId: revision.revisionId,
    revision: revision.revision,
    entries: revision.toolPolicies.map((policy) => ({
      toolId: policy.toolId,
      enabled: policy.enabled,
      requiresApproval: policy.requiresApproval,
      riskClass: policy.riskClass,
      allowedRoles: [...policy.allowedRoles],
    })),
    budget: revision.budget,
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/policy-overlay.test.ts && bun run typecheck
```

Expected: PASS (13 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/policy-overlay.ts src/runtime/__tests__/policy-overlay.test.ts
git commit -m "feat(runtime): compose restrict-only platform policy overlays"
```

---

### Task 14: Managed mode on the local base plus verified overlay

**Files:**
- Modify: `src/runtime/local-runtime-source.ts` (lines as of Task 14 start, after Task 11: imports lines 1–29, options lines 33–51, interface lines 59–71, policy block lines 222–243, return block lines 251–274)
- Test: `src/runtime/__tests__/local-runtime-source.test.ts` (imports lines 1–18; append a new `describe`)

**Interfaces:**
- Consumes: `applyPolicyOverlay`, `VerifiedPolicyOverlay`, `PolicyOverlayResult` (Task 13); `confirmationFloor` (Task 1).
- Produces:
  - `LocalRuntimeSourceOptions` gains `policyOverlay?: () => VerifiedPolicyOverlay | undefined` and `onPolicyOverlayApplied?: (report: { revisionId: string; ignored: PolicyOverlayResult['ignored'] }) => void`.
  - `LocalRuntimeSource.mode` becomes `'standalone' | 'managed'`, and is `'managed'` when `policyOverlay` is set.
  - `createLocalRuntimeSource` throws when `policyOverlay` is set without `identity.tenantId` and `identity.environmentId`, because Platform revocations only match the Platform environment.
  - Each new turn pins `policyRevision`, built as local base policies ⊕ overlay. The overlay keeps the Platform `revisionId`/`revision`, its budget is `overlay.budget ?? localLimits` (the snapshot takes the minimum), and it is recomposed only when the overlay object changes. P11 wires Get It Done's managed mode to this option.

- [ ] **Step 1: Write the failing test**

In `src/runtime/__tests__/local-runtime-source.test.ts` replace lines 1–18 (the import block) with:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRevisionSchema,
  ManifestRevisionSchema,
  RuntimePolicyRevisionSchema,
  type ExecutionBudget,
  type Principal,
  type SecurityRevocation,
} from '../../contracts/index.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';
import {
  materializeManifestToolRegistry,
  type LocalToolBinding,
} from '../local-tool-bindings.js';
import {
  createLocalRuntimeSource,
  type LocalRuntimeSourceOptions,
} from '../local-runtime-source.js';
import { createManagedTurnGuard } from '../managed-turn.js';
import type { VerifiedPolicyOverlay } from '../policy-overlay.js';
import { isToolRevoked } from '../turn-snapshot.js';
```

Append at the end of the file:

```ts

describe('createLocalRuntimeSource with a verified Platform overlay', () => {
  const PLATFORM_IDENTITY = {
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    targetAppId: APP_ID,
    environmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const OVERLAY_REVISION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const REMOVED_TOOL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const principal = fixturePrincipal(PLATFORM_IDENTITY.tenantId);

  function overlay(
    entries: VerifiedPolicyOverlay['entries'],
    extra: Partial<VerifiedPolicyOverlay> = {},
  ): VerifiedPolicyOverlay {
    return { revisionId: OVERLAY_REVISION_ID, revision: 3, entries, ...extra };
  }

  function managedSource(
    policyOverlay: () => VerifiedPolicyOverlay | undefined,
    onPolicyOverlayApplied?: LocalRuntimeSourceOptions['onPolicyOverlayApplied'],
  ) {
    return createLocalRuntimeSource(fixtureOptions({
      identity: PLATFORM_IDENTITY,
      policyOverlay,
      ...(onPolicyOverlayApplied ? { onPolicyOverlayApplied } : {}),
    }));
  }

  it('runs a new local tool that the Platform has not seen yet', () => {
    expect(createLocalRuntimeSource(fixtureOptions()).mode).toBe('standalone');
    const source = managedSource(() => overlay([
      { toolId: ENDPOINT_TOOL_ID, enabled: true },
    ]));
    expect(source.mode).toBe('managed');

    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });

    expect(Object.keys(registry).sort()).toEqual(['tasks_listTasks', 'ui_navigate']);
  });

  it('applies the overlay restrict-only and ignores ids the code does not have', async () => {
    const applied = vi.fn();
    const source = managedSource(() => overlay([
      { toolId: ENDPOINT_TOOL_ID, riskClass: 'delete', requiresApproval: false },
      { toolId: UI_TOOL_ID, enabled: false },
      { toolId: REMOVED_TOOL_ID, enabled: true, requiresApproval: false },
    ]), applied);

    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });

    expect(snapshot.policyRevision.revisionId).toBe(OVERLAY_REVISION_ID);
    expect(snapshot.policyRevision.toolPolicies).toEqual([
      {
        toolId: ENDPOINT_TOOL_ID,
        enabled: true,
        riskClass: 'delete',
        requiresApproval: true,
        allowedRoles: ['member'],
      },
      {
        toolId: UI_TOOL_ID,
        enabled: false,
        riskClass: 'safe-read',
        requiresApproval: false,
        allowedRoles: ['member'],
      },
    ]);
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: REMOVED_TOOL_ID, reason: 'platform-tool-not-in-code' }],
    });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });
    expect(Object.keys(registry)).toEqual(['tasks_listTasks']);
    expect(registry.tasks_listTasks!.needsApproval).toBe(true);

    const guard = createManagedTurnGuard({
      snapshot,
      resolvePrincipal: async () => principal,
    });
    await expect(guard.beforeToolCall({
      toolName: 'tasks_removedTask',
      input: {},
    })).rejects.toThrow(/manifest_tool_unavailable/);
  });

  it('pins each turn to the overlay it started with and never calls the network', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      let current = overlay([{ toolId: ENDPOINT_TOOL_ID, enabled: true }]);
      const getOverlay = vi.fn(() => current);
      const source = managedSource(getOverlay);

      const first = source.resolveTurnSnapshot({ turnId: 't-1', principal });
      current = overlay(
        [{ toolId: ENDPOINT_TOOL_ID, enabled: false }],
        { revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', revision: 4 },
      );

      expect(source.resolveTurnSnapshot({ turnId: 't-1', principal }))
        .toBe(first);
      const next = source.resolveTurnSnapshot({ turnId: 't-2', principal });
      expect(first.policyRevision.toolPolicies[0])
        .toMatchObject({ toolId: ENDPOINT_TOOL_ID, enabled: true });
      expect(next.policyRevision.toolPolicies[0])
        .toMatchObject({ toolId: ENDPOINT_TOOL_ID, enabled: false });
      expect(getOverlay).toHaveBeenCalledTimes(2);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps revocations of the Platform policy revision effective', () => {
    const source = managedSource(() => overlay([]));
    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    const revocation: SecurityRevocation = {
      revocationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      environmentId: PLATFORM_IDENTITY.environmentId,
      effectiveAt: '2026-08-12T00:00:00.000Z',
      reasonCode: 'security-disable',
      toolIds: [],
      agentRevisionIds: [],
      policyRevisionIds: [OVERLAY_REVISION_ID],
      signature: {
        algorithm: 'Ed25519',
        keyId: 'platform-key',
        value: 'c2lnbmF0dXJl',
      },
    };

    expect(isToolRevoked(
      snapshot,
      ENDPOINT_TOOL_ID,
      [revocation],
      new Date('2026-08-12T00:00:01.000Z'),
    )).toBe(true);
  });

  it('applies an overlay budget only as a further restriction', () => {
    const tighter = managedSource(() => overlay([], {
      budget: { ...budget(), maxToolCalls: 4 },
    }));
    const looser = managedSource(() => overlay([], {
      budget: { ...budget(), maxToolCalls: 99 },
    }));

    expect(tighter.resolveTurnSnapshot({ turnId: 't-1', principal })
      .budget.maxToolCalls).toBe(4);
    expect(looser.resolveTurnSnapshot({ turnId: 't-1', principal })
      .budget.maxToolCalls).toBe(16);
  });

  it('never enables a tool the local artifact keeps disabled', () => {
    const artifact = fixtureArtifact() as {
      tools: Array<Record<string, unknown>>;
    };
    artifact.tools[1]!.operationGroup = 'needs_attention';
    artifact.tools[1]!.enabled = false;
    const applied = vi.fn();
    const source = createLocalRuntimeSource(fixtureOptions({
      setupArtifact: artifact,
      identity: PLATFORM_IDENTITY,
      policyOverlay: () => overlay([
        { toolId: UI_TOOL_ID, enabled: true, requiresApproval: false },
      ]),
      onPolicyOverlayApplied: applied,
    }));

    const snapshot = source.resolveTurnSnapshot({ turnId: 't-1', principal });
    const registry = materializeManifestToolRegistry({
      snapshot,
      bindings: fixtureBindings(),
    });

    expect(Object.keys(registry)).toEqual(['tasks_listTasks']);
    expect(applied).toHaveBeenCalledWith({
      revisionId: OVERLAY_REVISION_ID,
      ignored: [{ toolId: UI_TOOL_ID, reason: 'platform-tool-not-in-code' }],
    });
  });

  it('refuses managed mode without the Platform tenant and environment', () => {
    expect(() => createLocalRuntimeSource(fixtureOptions({
      policyOverlay: () => overlay([]),
    }))).toThrow(/Platform tenantId and environmentId/);
    expect(() => createLocalRuntimeSource(fixtureOptions({
      identity: { tenantId: PLATFORM_IDENTITY.tenantId },
      policyOverlay: () => overlay([]),
    }))).toThrow(/Platform tenantId and environmentId/);
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/local-runtime-source.test.ts
```

Expected: FAIL in all seven overlay tests. `mode` is `'standalone'`, `policyRevision.revisionId` is the derived standalone id, the UI tool stays enabled, `applied` is never called, the overlay budget is ignored, and a source with an overlay but no Platform identity is created without error.

- [ ] **Step 3: Minimal implementation**

In `src/runtime/local-runtime-source.ts`:

Replace lines 1–18 (the first import block, which ends with `} from '../contracts/index.js';`) with:

```ts
import { createHash } from 'node:crypto';
import {
  AgentRevisionSchema,
  AppSetupArtifactSchema,
  ExecutionBudgetSchema,
  ManifestRevisionSchema,
  PromptBundleSchema,
  RuntimePolicyRevisionSchema,
  type AgentRevision,
  type AppSetupArtifact,
  type AppSetupToolCandidate,
  type ExecutionBudget,
  type ManifestRevision,
  type ManifestTool,
  type Principal,
  type PromptPin,
  type RuntimePolicyRevision,
  type RuntimeToolPolicy,
} from '../contracts/index.js';
```

(The `confirmationFloor` import added in Task 11 stays directly below.) After the `import type { LocalToolBinding } from './local-tool-bindings.js';` line insert:

```ts
import {
  applyPolicyOverlay,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

In `interface LocalRuntimeSourceOptions`, insert before `signer?: LocalRevisionSigner;`:

```ts
  /**
   * Managed mode only: returns the latest verified, restrict-only Platform
   * overlay, e.g. `policyOverlayFromRevision(revisions.policyRevision)` for
   * the deployment the sync manager accepted. Called synchronously when a new
   * turn starts; it must read local state, never the network.
   */
  policyOverlay?: () => VerifiedPolicyOverlay | undefined;
  /** Content-free report each time a new overlay revision is composed. */
  onPolicyOverlayApplied?: (report: {
    revisionId: string;
    ignored: PolicyOverlayResult['ignored'];
  }) => void;
```

In `interface LocalRuntimeSource`, replace `readonly mode: 'standalone';` with:

```ts
  readonly mode: 'standalone' | 'managed';
```

In `createLocalRuntimeSource`, insert directly before `const identity: LocalRuntimeSourceIdentity = {`:

```ts
  if (
    options.policyOverlay
    && (!options.identity?.tenantId || !options.identity.environmentId)
  ) {
    // Platform revocations match on the Platform environment; a derived
    // standalone identity would silently never match them.
    throw new Error(
      'Managed mode needs the Platform tenantId and environmentId so '
      + 'Platform revocations keep matching.',
    );
  }

```

Replace the whole `const policyRevision: RuntimePolicyRevision = RuntimePolicyRevisionSchema …;` statement (the block ending just before `const promptPin =`) with:

```ts
  const localToolPolicies: RuntimeToolPolicy[] = enabledTools.map((tool) => ({
    toolId: tool.toolId,
    enabled: true,
    riskClass: tool.riskClass,
    // Unassessed ('unknown') and tier-3 tools never run unattended.
    requiresApproval: confirmationFloor(tool.riskClass, tool.requiresApproval),
    allowedRoles: tool.allowedRoles ?? [],
  }));

  const basePolicyRevision: RuntimePolicyRevision = RuntimePolicyRevisionSchema
    .parse(
      signer.sign({
        revisionId: deriveUuid(
          'glirastes-standalone', 'policy', artifact.appId,
          artifact.discoveryDigest,
        ),
        revision: 1,
        tenantId: identity.tenantId,
        environmentId: identity.environmentId,
        budget: localLimits,
        toolPolicies: localToolPolicies,
        publishedAt: artifact.generatedAt,
      }),
    );

  let composed: {
    overlay: VerifiedPolicyOverlay;
    revision: RuntimePolicyRevision;
  } | undefined;

  /**
   * Local code is the base; a verified Platform overlay can only restrict
   * it (spec 4.9). The composed revision keeps the Platform revision id so
   * revocations of that policy revision keep matching.
   */
  const currentPolicyRevision = (): RuntimePolicyRevision => {
    const overlay = options.policyOverlay?.();
    if (!overlay) return basePolicyRevision;
    if (composed?.overlay === overlay) return composed.revision;
    const applied = applyPolicyOverlay(localToolPolicies, overlay.entries);
    const revision = RuntimePolicyRevisionSchema.parse(
      signer.sign({
        revisionId: overlay.revisionId,
        revision: overlay.revision,
        tenantId: identity.tenantId,
        environmentId: identity.environmentId,
        budget: overlay.budget ?? localLimits,
        toolPolicies: applied.policies,
        publishedAt: artifact.generatedAt,
      }),
    );
    composed = { overlay, revision };
    options.onPolicyOverlayApplied?.({
      revisionId: overlay.revisionId,
      ignored: applied.ignored,
    });
    return revision;
  };
```

In the returned object replace `mode: 'standalone',` with:

```ts
    mode: options.policyOverlay ? 'managed' : 'standalone',
```

and inside `resolveTurnSnapshot` replace `policyRevision,` (the shorthand property passed to `createTurnSnapshot`) with:

```ts
        policyRevision: currentPolicyRevision(),
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bun run typecheck && bun run build && bunx vitest run src/runtime src/sync tests/source-driven-next.test.ts
```

Expected: PASS (including `source-parity`, `standalone-network-silence` and the existing standalone tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/local-runtime-source.ts src/runtime/__tests__/local-runtime-source.test.ts
git commit -m "feat(runtime): run managed turns on local tools plus overlay"
```

---

### Task 15: Runtime exports and full verification

**Files:**
- Modify: `src/runtime/index.ts:47-55` (local-tool-bindings export block), append the overlay export block
- Test: `src/runtime/__tests__/policy-exports.test.ts`

**Interfaces:**
- Consumes: Tasks 12–14.
- Produces: `glirastes/runtime` exports `applyPolicyOverlay`, `policyOverlayFromRevision`, `localToolBindingMismatches`, and the types `PolicyOverlayEntry`, `PolicyOverlayIgnoredEntry`, `PolicyOverlayResult`, `VerifiedPolicyOverlay`, `ToolRegistryDiagnostic` and `ToolRegistryDiagnosticReason`.

- [ ] **Step 1: Write the failing test**

Create `src/runtime/__tests__/policy-exports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as runtime from '../index.js';

describe('glirastes/runtime policy surface', () => {
  it('exports overlay composition and binding diagnostics', () => {
    expect(typeof runtime.applyPolicyOverlay).toBe('function');
    expect(typeof runtime.policyOverlayFromRevision).toBe('function');
    expect(typeof runtime.localToolBindingMismatches).toBe('function');
    expect(runtime.applyPolicyOverlay([], []))
      .toEqual({ policies: [], ignored: [] });
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/policy-exports.test.ts
```

Expected: FAIL, `expected 'undefined' to be 'function'`.

- [ ] **Step 3: Minimal implementation**

In `src/runtime/index.ts` replace lines 47–55 with:

```ts
export {
  assertLocalToolBindingMatches,
  createLocalSchemaDigest,
  localToolBindingMismatches,
  materializeManifestToolRegistry,
  modelFacingToolName,
  type LocalEndpointToolBinding,
  type LocalToolBinding,
  type LocalUiToolBinding,
  type ToolRegistryDiagnostic,
  type ToolRegistryDiagnosticReason,
} from './local-tool-bindings.js';
export {
  applyPolicyOverlay,
  policyOverlayFromRevision,
  type PolicyOverlayEntry,
  type PolicyOverlayIgnoredEntry,
  type PolicyOverlayResult,
  type VerifiedPolicyOverlay,
} from './policy-overlay.js';
```

- [ ] **Step 4: Run the full gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools && bunx vitest run src/runtime/__tests__/policy-exports.test.ts && bun run typecheck && bun run typecheck:tests && bun run build && bun run test
```

Expected: every command exits 0. The test count equals the Task 0 baseline plus the tests added here, and nothing is skipped that was green before. `bun run build` runs before `bun run test` so the `tests/` suites, which import `glirastes/*` from `dist/`, exercise this branch's code; it also regenerates the subpath shims without errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/mvp-tools
git add src/runtime/index.ts src/runtime/__tests__/policy-exports.test.ts
git commit -m "feat(runtime): export policy overlay helpers"
```

---

## Self-Review

### Spec coverage

| Spec item | Task(s) |
| --- | --- |
| 4.5 default table, `RULES_VERSION 1` | Tasks 1, 2 |
| 4.5 escalations (tokens, declared effect, external evidence, UI mutation), `unknown` never emitted | Task 2 |
| 4.5 `allowedRoles` empty by default (endpoint authorization applies) | Task 4 (defaults-only result), Task 1 (`[]` = no restriction) |
| 4.5 bounds: risk raise only, confirmation tiers, `enabled` AND, roles intersection, description precedence, strictest wins | Tasks 4, 5 |
| 4.5 golden vectors shared with the Platform port | Task 7 |
| 4.5 `tool-policy.json` shape | Task 3 |
| 4.5 Lebenszyklus: new tool `added` without confirmation, `loosening` only by committed relaxation | Task 10 |
| 4.5 Lebenszyklus: risk increase taken over, relaxation lapses (`override-lapsed-risk-raised`) | Task 5 |
| 4.5 Lebenszyklus: decrease held (`risk-lower-available`) until accepted | Task 6 |
| 4.5 Lebenszyklus: reappearance gets new id, old overrides do not revive | Task 5 (pin mismatch), Task 13/14 (removed ids ignored, direct call ⇒ `manifest_tool_unavailable`) |
| 4.9 effective policy = resolve(local, verified overlay) per snapshot | Tasks 13, 14 |
| 4.9 `needsApproval = requiresApproval || tier >= 3` (`local-tool-bindings.ts:235`) | Task 11 |
| 4.9 overlay ids without local binding ignored (`platform-tool-not-in-code`) | Task 13 |
| 4.9 missing or mismatched binding disables only that tool | Task 12 |
| 4.9 revocations keep blocking, principal re-authorized | Task 14 (policy-revision revocation; managed mode refuses a derived identity that Platform revocations could never match), existing `managed-turn` tests (principal) |
| 4.9 trust-model change: new code tools run before the Platform saw them | Task 14 ("runs a new local tool …") |
| 4.12 Runtime: overlay cannot enable unknown or `needs_attention` ids or loosen tier 3; revocation; new local tool active; one missing binding; no network per turn | Tasks 12, 13, 14 (`needs_attention`: "never enables a tool the local artifact keeps disabled") |
| 4.12 Zusatzkorpus: lapse on risk rise, decrease held until `accept`, relaxing DELETE ⇒ `E-POLICY-002` | Tasks 5, 6, 7 |
| `semantic-change.ts` treats `unknown` as tier 3, equal tiers neutral | Task 9 |
| Contracts exported, public subpaths intact | Tasks 8, 15 |

Not in this plan (owned elsewhere): wiring `resolveToolPolicy` and `deriveToolPolicyDefaults` into the generator and `runtime-manifest.json` `policyDigest` (P03); the `tools policy …` CLI that writes pins and `acceptedRisk` (later SDK plan); the Platform port `boundToolOverride`, migration 0044 and the parity test against `tool-policy.v1.json` (P08); switching Get It Done's managed bindings to `policyOverlay` (P11).

### Resolved spec ambiguities

1. **Tier-2 relaxation without a pin.** It is an error, `E-POLICY-002` with reason `relaxation-requires-reviewed-pin`, so it never silently fails to apply. A pin below the current tier lapses with `override-lapsed-risk-raised`. A pin at tier 3, or an unpinned tier-3 relaxation, is `E-POLICY-002` with reason `tier-3-always-requires-approval`.
2. **`riskClass` in an entry.** A lower class or a same-tier relabel is a no-op, never an error, so a stale raise below a newer code risk cannot break a refresh. Only a strictly higher tier applies.
3. **Disjoint role intersection.** It disables the tool, with the narrowing layer as origin, because `[]` means "no restriction".
4. **`pin.toolId` mismatch.** It emits `policy-entry-orphaned` with `field '<layer>.pin.toolId'`. Only `requiresApproval: false` lapses; hardenings stay.
5. **Ratchet comparison.** The ratchet compares `previousEffectiveRiskClass` against defaults plus layer raises. Acceptance requires an exact `{ toolId, riskClass }` match with the lowered class, and the held value reports origin `code-default`.
6. **Destructive tokens.** They match whole words per path or definitionId segment, camelCase aware. For UI actions they apply only together with `uiMutation` evidence. A destructive escalation of an endpoint also sets `operationGroup: 'delete'`.
7. **Runtime overlay is restrict-only, even for pinned relaxations.** This matches decision 10.5. Platform relaxations, which need a security approval per 4.10, reach code only through `resolveToolPolicy`'s platform layer in the generator and the Platform.
8. **Managed wiring.** The SDK had no in-SDK managed merge; Get It Done composes Platform revisions verbatim. P02 therefore adds local base plus overlay to `createLocalRuntimeSource`, with the `policyOverlay` option and mode `'managed'`, and adds `policyOverlayFromRevision`. The composed revision reuses the Platform revision id so policy revocations still match, and managed mode requires the Platform `tenantId` and `environmentId` because `isToolRevoked` matches revocations on the manifest environment. The overlay budget can only tighten the limits. The sync-side `validateLocalDeploymentBindings` still rejects a whole Platform deployment that allowlists a tool without a local binding; P11 must not gate overlay updates on it once Get It Done switches to `policyOverlay`.
9. **The `setup-plan.test.ts` test at lines 167–192 stays unchanged.** It relaxes an existing tool, which remains a `loosening` under 4.5. The new-tool expectations are added beside it.
10. **Per-tool disabling covers more than bindings.** A missing policy (`E-POLICY-010`) or a policy below the manifest tier (`E-POLICY-011`) also disables only that tool. Exact `riskClass` equality checks in the registry, discovery and the deployment validator become tier comparisons. Duplicate bindings and name collisions still throw.
11. **`unknown` in policy entries.** It is accepted in entries and files and counts as tier 3. The `E-POLICY-*` family is added to `FoundationDiagnosticCode`.

### Placeholder scan

No TBD/TODO entries, no "add error handling" placeholders, no "similar to Task N" back-references. Every code step contains complete code. Every command is runnable from the worktree path.

### Type consistency check

- `ToolPolicyDefaults.riskClass` is `Exclude<ToolRiskClass, 'unknown'>` everywhere. Tests build defaults as typed constants. The Task 13 parity test casts `RuntimeToolPolicy.riskClass` explicitly.
- `ResolveToolPolicyResult.warnings` and `.errors` codes and fields match between the implementation (Tasks 4–6), the unit tests and all 35 vectors (`local.requiresApproval`, `platform.requiresApproval`, `local.pin.toolId`, `platform.pin.toolId`, `riskClass`, `platform.riskClass`, `local`).
- `applyPolicyOverlay` takes `PolicyOverlayEntry[]` and returns `PolicyOverlayResult`, which are structurally identical to the pinned signature. `VerifiedPolicyOverlay.entries` uses the same type. `LocalRuntimeSourceOptions.onPolicyOverlayApplied` reuses `PolicyOverlayResult['ignored']`.
- `ToolRegistryDiagnostic` codes `E-BINDING-010/011` and `E-POLICY-010/011` fit `FoundationDiagnosticCode` after Task 3, and the test expectations use the exact same objects.
- `SemanticChangeClassification` gains `'added'` (Task 10) before `classifyNewTool` returns it.
- Import paths: runtime and sync files import `riskTier` and `confirmationFloor` from `../contracts/tool-policy.js`, and contracts files use `./tool-policy.js`. No cycle: `tool-policy.ts` imports only `revisions.js`, `content-boundary.js`, `../diagnostics/index.js` and `zod`.
