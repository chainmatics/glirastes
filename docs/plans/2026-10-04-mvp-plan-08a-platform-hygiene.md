# Platform-Hygiene (P08a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Platform defects that block a release: Drizzle migrations that `drizzle-kit migrate` cannot apply, an API typecheck that never finishes, a Citadel without ESLint, a pairing key that is far more powerful than the CLI needs, a pairing flow that answers malformed input with 500 and cannot be denied, and the open Aegis follow-ups. Afterwards every Platform gate (API Vitest and typecheck, Citadel `tsc`/Vitest/ESLint, DB tests including a from-scratch migration run) is green and deterministic.

**Architecture:** One new local branch `codex/mvp-platform` in a new worktree `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform`, created from `codex/glirastes-foundation-control-plane` at `39f0eeb`. Every task is a small, separately committed TDD cycle. The database work is proved offline: migrations are applied to an in-process PGlite PostgreSQL inside `bun test`, the schema snapshot is regenerated with `drizzle-kit` in a temporary copy, and production is only touched later through a printed, reviewed baseline. App scope for API keys is enforced in `ApiKeyGuard` through two route metadata keys, so every controller states its rule declaratively. The broader `/connect` and `/manage` UX redesign stays in P08b.

**Tech Stack:** TypeScript 5.9, Bun 1.3, NestJS 11, Vitest 3.2 (API, Citadel), `bun:test` (DB), Drizzle ORM 0.39.3 and drizzle-kit 0.30.6, `@electric-sql/pglite` 0.5.8 (new dev dependency), AI SDK 6 with zod 3.25 (`zod/v4` subpath), `@modelcontextprotocol/sdk` 1.29, Next.js 15.5, ESLint 9.39.4 with `eslint-config-next` 15.5.14 through `@eslint/eslintrc` 3.3.5 `FlatCompat` (new dev dependency).

**Spec:** /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-completion-design.md (v1.3) section 7 "Platform-Hygiene (Voraussetzung für Release)" and section 7 "Verbinden" (deny path, `user_code` prefill, `connected_free_limit_reached`), section 2 "Ausgangslage" (Platform row); roadmap /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/docs/plans/2026-10-04-mvp-plan-00-roadmap.md rows P08 and "Offene Punkte" (Aegis batch test, `drawGroupSeed` regressions and exhaustion, working document).

## Global Constraints

- No pushes, merges into `main`, npm publishes, deployments or database changes outside this worktree without Philipp's explicit approval (spec 1, 11). All commits are local on `codex/mvp-platform`.
- Never connect to Neon or any shared database. `drizzle-kit` runs only from a temporary copy with its own config or with `DATABASE_URL=postgres://offline.invalid/unused`, so `packages/db/drizzle.config.ts` never loads a `.env` file; `generate` and `check` do not connect.
- Never open, print or copy `.env*`, `.secrets/` or `.npmrc` contents. `bun install` and `bun add` read `.npmrc` themselves; that is fine.
- Shell `rm` is denied in this environment. No step creates a file inside the repository that a later step has to delete: lint probes use `eslint --stdin`, temporary edits of tracked files are restored from a copy in a `mktemp -d` directory outside the repository, scratch configs live in `mktemp -d` directories, and tests clean up their own temporary directories through Node's `fs`.
- Implementers never edit this plan file.
- Patches are applied from the worktree root with `git apply`, which is all-or-nothing. They were generated against `39f0eeb` and applied cumulatively in task order; if one does not apply, stop and report instead of editing by hand. New files are written with exactly the content shown.
- TDD: verify RED first, then the minimal change, then GREEN. Do not weaken protections; do not delete compatibility code (spec 1). The deferred Advisor module keeps compiling and stays wired.
- Conventional Commits, lowercase imperative subject of at most 72 characters, no AI or Co-Authored-By attribution.
- Agent shells reset the working directory between calls, and the session's default directory is the Platform main checkout (which has its own `apps/api`). Every bash block below therefore starts with an absolute `cd`.
- Commands: API tests `cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run <path>`; API typecheck `bun run typecheck` in `apps/api` (from Task 9); Citadel `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/vitest run`, `bun run lint` (from Task 14) in `apps/citadel`; DB `bun test` in `packages/db`.
- Baseline at `39f0eeb` (P01 Task 18 and a fresh copy, 2026-10-04): API `Test Files 114 passed (114)`, `Tests 1130 passed | 10 skipped (1140)`; Citadel `tsc` exit 0, `38` files, `250` tests; DB `90 pass` in `15` files.
- Production follow-ups are prepared and requested, never executed: the migration baseline for the shared database (Task 6 runbook) and the remediation of pairing keys issued before Task 17 (Task 23 checkpoint).

### Decisions taken in this plan (veto possible)

| Topic | Decision | Why |
| --- | --- | --- |
| Pairing key | Scopes `['runtime']`, bound to the paired app, 90 days (`PAIRING_KEY_LIFETIME_DAYS`) | Least privilege; 90 days is the existing API key default. Rotation (`784ac72`, `67cc575`, `c860d10`) deliberately keeps scopes and the absolute expiry, so it replaces a leaked key; renewal is a new `glirastes connect`. |
| Setup writes with a runtime key | `@AllowAppScopedRuntimeKey()` on exactly `getRun`, `createRun`, `updateStatus`, `putArtifact` of `/v2/apps/:appId/runtime-setup` | These are the calls of the SDK's `AppSetupClient` (`glirastes sync`, `setup sync`, `setup status`). Governance (overrides, publish, apply) still needs a dashboard user. App-bound runtime credentials from `/runtime-credentials` gain the same four routes for their own app only. |
| Tenant administration | `@TenantWideOnly()` on `ApiKeyController`, `TenantController` and `POST /v1/apps` | Without it an app-bound management key (the one-day setup credential) mints a tenant-wide key and reaches every app, so a `/v1/apps` check alone would not close the gap. |
| `/v1/apps` reads | An app-bound key sees only its app; any other id answers 404 like an unknown app | No enumeration of the tenant's apps. |
| Pairing deny | Only a `pending` pairing can be denied (owner or admin, by user code) | A pending pairing belongs to no tenant yet; an authorized one belongs to the approving tenant, so another tenant's owner who learned the code must not cancel it. A mistaken approval is ended by revoking the key. |
| Orphan SQL `0022_lean_steel_serpent`, `0023_cultured_vulture` | Registered at their chronological place (right after `0022_burly_nova`); `idx` equals the file prefix | The `0022` snapshot already contains both tables; a fresh database otherwise lacks `oauth_clients` and `optimization_suggestions`; shared databases skip them by `when`. |
| `backfill-target-apps.sql` | Stays where it is, unregistered, documented as manual history | It reads `pii_configs.api_key_id`, which no longer exists. Moving it needs a ruling. |
| Snapshots | `meta/0043_snapshot.json` regenerated by `drizzle-kit generate` from the current schema (`prevId` = `0029`); a test keeps it current | The next `generate` then emits only real changes; spec's `0044_bounded_tool_overrides` keeps its number. |
| Hand-written constraint names | The Drizzle schema names the five constraints exactly as `0038`/`0042` created them | A future generated migration must address the real names. |
| Advisor typecheck | `advisor.tools.ts` imports `zod/v4` (shipped inside zod 3.25.76) | AI SDK 6 infers `tool()` input from zod 4 cheaply (73 k instantiations) but explodes on zod 3 (out of memory after 2 min). Runtime behaviour was checked with `asSchema`. |
| Spec typecheck | Separate `tsconfig.spec.json` (`module: esnext`, `moduleResolution: bundler`, no decorator metadata) | Specs and scripts use `import.meta` and run as ESM in Vitest and Bun; production keeps the CommonJS build config. |
| Aegis exhaustion | Random draws, then a fixed-order search through pool names and double-barrelled surnames (8,000 per locale), then fail closed | Never share a pseudonym; ordinary sessions keep random names. |

## Review Focus

1. **An app-bound key cannot see other apps or administer the tenant.** A key with `targetAppId` lists only its own app, gets 404 for any other app id on `/v1/apps`, and is refused on tenant administration (API keys, members, app creation) even when it carries `management`. Pinned in Task 15 Step 1 (guard) and Task 16 Step 1 (wiring and `/v1/apps`). Management modules outside this list that do not compare `targetAppId` (for example webhooks, billing, optimizer) are reported in the Task 23 checkpoint, not closed here; after Task 17 only one-day setup credentials and legacy pairing keys combine `management` with `targetAppId`.
2. **The pairing key keeps exactly the access `glirastes connect` and `glirastes sync` need.** It is runtime-only, bound to the paired app and expires after 90 days, and it replaces `management` on exactly four setup routes and nowhere else. Pinned in Task 16 Step 1 (the wiring test enumerates the exact route set and scans the API sources for any other use) and Task 17 Step 1.
3. **A fresh database is the schema.** All migrations apply in journal order to an empty PostgreSQL, the result has exactly the schema's tables, columns and nullability and every declared constraint and index name, objects that exist only in SQL are an explicit list, and `drizzle-kit generate` re-emits nothing. Pinned in Task 2 Step 1, Task 3 Step 1 and Task 4 Step 1.
4. **The shared database is never migrated twice.** On a database that got `0036`-`0043` by hand, `drizzle-kit migrate` fails without the baseline and applies nothing after it, even when the baseline ran twice. Pinned in Task 5 Step 1.
5. **No two people share a pseudonym, however many there are.** Each group-creation path draws a fresh identity on collision; once random draws are exhausted the identity space is searched in a fixed order and finally fails closed; a group's later pseudonyms derive from its stored names. Pinned in Task 20 Steps 1-3 (per-path pins with mutation proof) and Task 21 Step 1.

---

## File Structure

All paths are relative to the worktree root `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform`.

| File | Action | Responsibility |
| --- | --- | --- |
| `packages/db/package.json`, `bun.lock` | Modify (Task 1, via `bun add`) | PGlite dev dependency |
| `packages/db/drizzle/meta/_journal.json` | Modify (Task 2) | Register `0022_lean_steel_serpent`, `0023_cultured_vulture`, `0036`-`0043` |
| `packages/db/drizzle/0036_tenant_member_roles.sql`, `0038_setup_tool_overrides.sql`, `0039_override_scoped_to_tool.sql`, `0040_approve_every_revision_type.sql`, `0042_connected_platform_pairing.sql` | Modify (Task 2) | `--> statement-breakpoint` between statements |
| `packages/db/src/__tests__/migration-journal.test.ts` | Create (Task 2) | Every SQL file registered once; ordering |
| `packages/db/src/__tests__/migrations-from-scratch.test.ts` | Create (Task 2), extend (Task 3) | Apply all migrations to PGlite; schema parity |
| `packages/db/src/schema/runtime-app-setup-tool-overrides.ts`, `runtime-connection-pairings.ts` | Modify (Task 3) | Constraint names as created by `0038`/`0042` |
| `packages/db/drizzle/meta/0043_snapshot.json` | Create (Task 4, generated) | Current schema snapshot for drizzle-kit |
| `packages/db/src/__tests__/schema-snapshot.test.ts` | Create (Task 4) | Snapshot equals schema |
| `packages/db/scripts/print-migration-baseline.ts` | Create (Task 5) | Print the baseline SQL for hand-migrated databases |
| `packages/db/src/__tests__/migration-baseline.test.ts` | Create (Task 5) | Hand-migrated database resumes after the baseline |
| `packages/db/MIGRATIONS.md`, `CLAUDE.md` | Create / modify (Task 6) | Migration rules and runbook |
| `apps/api/src/modules/advisor/advisor.tools.ts` | Modify (Task 7) | `zod/v4`, `Tool` instead of the removed `CoreTool` |
| `apps/api/src/modules/mcp/mcp-server.service.ts` | Modify (Task 8) | Passthrough schema typed as the MCP SDK's `AnySchema` |
| `apps/api/tsconfig.typecheck.json`, `apps/api/tsconfig.spec.json` | Create (Task 9) | Typecheck sources (build file set) and specs/scripts |
| `apps/api/package.json`, `turbo.json`, `package.json`, `CLAUDE.md` | Modify (Task 9) | `typecheck` scripts and turbo task |
| 6 runtime source files under `apps/api/src/modules/runtime-*` | Modify (Task 10) | 12 production type errors |
| `apps/api/src/modules/{acp,billing,auth,registry}/…` (4 files) | Modify (Task 11) | 7 production type errors |
| 9 runtime spec files | Modify (Task 12) | 39 spec type errors |
| 10 spec files and `apps/api/scripts/verify-connected-free-rehearsal.ts` | Modify (Task 13) | 37 spec and script type errors |
| `apps/citadel/eslint.config.mjs`, `apps/citadel/eslint-suppressions.json`, `apps/citadel/package.json`, `bun.lock` | Create / generate / modify (Task 14) | ESLint flat config with a recorded debt baseline |
| `apps/api/src/common/decorators/app-scope.decorator.ts`, `apps/api/src/common/guards/api-key.guard.ts`, `apps/api/src/common/__tests__/api-key.guard.spec.ts` | Create / modify (Task 15) | Route metadata for app-bound keys |
| `apps/api/src/common/__tests__/app-scope-wiring.spec.ts`, `apps/api/src/modules/apps/apps.controller.ts` (+ spec), `apps/api/src/modules/auth/api-key.controller.ts`, `apps/api/src/modules/auth/tenant.controller.ts`, `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts` | Create / modify (Task 16) | App scope on `/v1/apps`, tenant administration, setup routes |
| `apps/api/src/modules/runtime-connect/*` (store interface, Drizzle store, service, claim controller, three specs) | Modify (Tasks 17-18) | Runtime-only expiring pairing key; deny; 400 for malformed device codes; prefilled URI |
| `apps/citadel/src/lib/runtime-connect-client.ts` (+ test), `apps/citadel/src/lib/runtime-pairing-feedback.ts` (+ test), `apps/citadel/src/app/(dashboard)/connect/pair/page.tsx` (+ test) | Modify / create (Task 19) | Deny button, plan-limit message |
| `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts` | Modify (Tasks 20-21) | Batched collision proof, per-path pins, stored-name derivation |
| `apps/api/src/modules/aegis/group-pseudonym-generator.ts`, `aegis.service.ts`, `__tests__/group-identity-space.spec.ts` | Modify / create (Task 21) | Identity space beyond the random draws |
| `docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md` | Modify (Task 22) | Record the resolved Aegis flake |

---

### Task 0: Create the worktree and record the baseline (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Preconditions**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform
git rev-parse codex/glirastes-foundation-control-plane
git branch --list codex/mvp-platform
test -e .worktrees/mvp-platform && echo exists || echo free
```

Expected: `39f0eeba6c05516314e252b97adf98964ace2eae`; no branch listed; `free`. Anything else: stop and report.

- [ ] **Step 2: Create the worktree**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform
git worktree add -b codex/mvp-platform .worktrees/mvp-platform codex/glirastes-foundation-control-plane
git -C .worktrees/mvp-platform log --oneline -1
```

Expected: `Preparing worktree (new branch 'codex/mvp-platform')` and `39f0eeb fix(aegis): never give two identity groups one full pseudonym`. `.worktrees/` is ignored by the main checkout.

- [ ] **Step 3: Install and build the DB package**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
bun install --frozen-lockfile
cd packages/db && ./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
cd .. && cd .. && git status --short
```

Expected: `2479 packages installed` (measured in a copy of `39f0eeb`; the count may differ by cache state, the exit code must be 0); `db-build=0` (`packages/db/dist` is ignored and feeds the API's `@glirastes/db` types); empty status. If the install fails on registry authentication, stop and report; do not open `.npmrc`.

- [ ] **Step 4: Baseline gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api && ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel && ./node_modules/.bin/tsc --noEmit; echo "citadel-tsc=$?"; ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db && bun test 2>&1 | tail -4
```

Expected: API `Test Files  114 passed (114)`, `Tests  1130 passed | 10 skipped (1140)`; `citadel-tsc=0`, `Test Files  38 passed (38)`, `Tests  250 passed (250)`; DB `90 pass`, `0 fail`, `Ran 90 tests across 15 files.` Any difference: stop and report before Task 1.

---

### Task 1: DB – add PGlite as an offline test database

**Files:**
- Modify (generated by `bun add`): `packages/db/package.json`, `bun.lock`
- Test: install check in Step 2

**Interfaces:** Produces the dev dependency `@electric-sql/pglite` 0.5.8 (in-process PostgreSQL 17, no network at test time) for `drizzle-orm/pglite`. Docker is installed but its daemon is not running here, and no PGlite copy exists in the workspace, so PGlite is the offline option.

- [ ] **Step 1: Confirm it is missing**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
test -e node_modules/@electric-sql/pglite && echo present || echo missing
```

Expected: `missing`.

- [ ] **Step 2: Add it with an exact version**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun add -d @electric-sql/pglite@0.5.8
cd ../.. && git diff --stat && git diff packages/db/package.json
bun install --frozen-lockfile > /dev/null; echo "frozen=$?"
```

Expected (measured in a copy): `bun.lock | 3 +++`, `packages/db/package.json | 1 +`, the package diff adds exactly `"@electric-sql/pglite": "0.5.8",` as the first `devDependencies` entry; `frozen=0`.

- [ ] **Step 3: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/package.json bun.lock
git commit -m "build(db): add pglite for offline migration tests"
```

---

### Task 2: DB – register the hand-applied migrations in the journal

**Files:**
- Create: `packages/db/src/__tests__/migration-journal.test.ts`, `packages/db/src/__tests__/migrations-from-scratch.test.ts`
- Modify: `packages/db/drizzle/meta/_journal.json` (insert after the `0022_burly_nova` entry, line 166; append after the `0035` entry), `packages/db/drizzle/0036_tenant_member_roles.sql:9,15`, `0038_setup_tool_overrides.sql:22`, `0039_override_scoped_to_tool.sql:13`, `0040_approve_every_revision_type.sql:12`, `0042_connected_platform_pairing.sql:2,16,19,53`
- Test: the two new files

**Interfaces:**
- Consumes: `migrate(db, { migrationsFolder })` from `drizzle-orm/pglite/migrator` (reads `meta/_journal.json`, splits each file on `--> statement-breakpoint`, runs every entry whose `when` exceeds the newest `created_at` in `drizzle.__drizzle_migrations`); `getTableConfig` from `drizzle-orm/pg-core`; `src/schema` exports.
- Produces: journal entries `0022_lean_steel_serpent` (`idx` 22, `when` 1775460970788), `0023_cultured_vulture` (`idx` 23, `when` 1775460970789), `0036`-`0043` (`idx` 36-43, `when` = commit time of each file in ms: 1785441195000, 1785483697000, 1785486257000, 1785490994000, 1785518284000, 1785835612000, 1786714863000, 1786722103000). The next generated migration gets `idx` 44.

The journal stops at `0035`; `0036`-`0043` were applied by hand. The two orphans from `11df0c9` lost the journal to `0022_burly_nova` in a merge although the `0022` snapshot already contains their tables. The hand-written files also put several statements into one chunk, which the migrator sends as one prepared statement; PostgreSQL rejects several commands in one prepared statement (`cannot insert multiple commands into a prepared statement`; PGlite reproduces it exactly).

- [ ] **Step 1: Write the failing tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/migration-journal.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * SQL files in drizzle/ that are deliberately not migrations. Each one was
 * run by hand once and is kept as history; see MIGRATIONS.md.
 */
const MANUAL_SQL = ['backfill-target-apps.sql'];

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const journal = JSON.parse(
  readFileSync(`${migrationsDir}/meta/_journal.json`, 'utf8'),
) as { version: string; dialect: string; entries: JournalEntry[] };
const sqlFiles = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));

describe('Drizzle migration journal', () => {
  it('registers every SQL migration exactly once', () => {
    const registered = journal.entries.map((entry) => `${entry.tag}.sql`);

    expect(new Set(registered).size).toBe(registered.length);
    expect(sqlFiles.filter((name) => !MANUAL_SQL.includes(name)).sort())
      .toEqual([...registered].sort());
    for (const name of MANUAL_SQL) expect(sqlFiles).toContain(name);
  });

  it('applies migrations in strictly increasing order', () => {
    const when = journal.entries.map((entry) => entry.when);

    for (let index = 1; index < when.length; index++) {
      expect(when[index]).toBeGreaterThan(when[index - 1]);
    }
  });

  it('keeps each entry consistent with its file name', () => {
    for (const entry of journal.entries) {
      expect(entry.idx).toBe(Number(entry.tag.slice(0, 4)));
      expect(entry.version).toBe('7');
      expect(entry.breakpoints).toBe(true);
    }
  });
});
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/migrations-from-scratch.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../schema';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const tables = Object.values(schema)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder });
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe('migrations applied to an empty database', () => {
  it('records every journal entry as applied', async () => {
    const journal = await Bun.file(`${migrationsFolder}/meta/_journal.json`).json() as {
      entries: unknown[];
    };
    const { rows } = await client.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );

    expect(rows[0].applied).toBe(journal.entries.length);
  });

  it('creates every table and column the Drizzle schema declares', async () => {
    const { rows } = await client.query<{
      table_name: string;
      column_name: string;
      is_nullable: 'YES' | 'NO';
    }>(
      `select table_name, column_name, is_nullable
         from information_schema.columns where table_schema = 'public'`,
    );
    const database = new Map(rows.map((row) => [
      `${row.table_name}.${row.column_name}`,
      row.is_nullable === 'NO',
    ]));
    const declared = new Map(tables.flatMap((table) => table.columns.map(
      (column) => [`${table.name}.${column.name}`, column.notNull] as const,
    )));

    expect([...database.keys()].sort()).toEqual([...declared.keys()].sort());
    for (const [column, notNull] of declared) {
      expect(`${column} notNull=${database.get(column)}`).toBe(`${column} notNull=${notNull}`);
    }
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/migration-journal.test.ts 2>&1 | tail -4
bun test src/__tests__/migrations-from-scratch.test.ts 2>&1 | tail -4
```

Expected: journal `2 pass`, `1 fail` ("registers every SQL migration exactly once"; the received list has 10 more files: the two orphans and `0036`-`0043`); from-scratch `1 pass`, `1 fail` ("creates every table and column": the database lacks 54 declared columns, among them the tables `oauth_clients`, `optimization_suggestions`, `runtime_app_setup_tool_overrides`, `runtime_connection_pairings`). The applied-count test passes because the journal and the table agree on 36 entries.

- [ ] **Step 3: Register the journal entries**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/packages/db/drizzle/meta/_journal.json
+++ b/packages/db/drizzle/meta/_journal.json
@@ -164,6 +164,20 @@
       "breakpoints": true
     },
     {
+      "idx": 22,
+      "version": "7",
+      "when": 1775460970788,
+      "tag": "0022_lean_steel_serpent",
+      "breakpoints": true
+    },
+    {
+      "idx": 23,
+      "version": "7",
+      "when": 1775460970789,
+      "tag": "0023_cultured_vulture",
+      "breakpoints": true
+    },
+    {
       "idx": 23,
       "version": "7",
       "when": 1777295070997,
@@ -252,6 +266,62 @@
       "version": "7",
       "when": 1785408000000,
       "tag": "0035_runtime_prompt_deployment_binding",
+      "breakpoints": true
+    },
+    {
+      "idx": 36,
+      "version": "7",
+      "when": 1785441195000,
+      "tag": "0036_tenant_member_roles",
+      "breakpoints": true
+    },
+    {
+      "idx": 37,
+      "version": "7",
+      "when": 1785483697000,
+      "tag": "0037_platform_authored_prompt",
+      "breakpoints": true
+    },
+    {
+      "idx": 38,
+      "version": "7",
+      "when": 1785486257000,
+      "tag": "0038_setup_tool_overrides",
+      "breakpoints": true
+    },
+    {
+      "idx": 39,
+      "version": "7",
+      "when": 1785490994000,
+      "tag": "0039_override_scoped_to_tool",
+      "breakpoints": true
+    },
+    {
+      "idx": 40,
+      "version": "7",
+      "when": 1785518284000,
+      "tag": "0040_approve_every_revision_type",
+      "breakpoints": true
+    },
+    {
+      "idx": 41,
+      "version": "7",
+      "when": 1785835612000,
+      "tag": "0041_republishable_prompt_bundles",
+      "breakpoints": true
+    },
+    {
+      "idx": 42,
+      "version": "7",
+      "when": 1786714863000,
+      "tag": "0042_connected_platform_pairing",
+      "breakpoints": true
+    },
+    {
+      "idx": 43,
+      "version": "7",
+      "when": 1786722103000,
+      "tag": "0043_resumable_setup_publication",
       "breakpoints": true
     }
   ]
PATCH
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/migration-journal.test.ts 2>&1 | tail -4
bun test src/__tests__/migrations-from-scratch.test.ts 2>&1 | grep -E "cannot insert multiple commands|pass|fail" | head -3
```

Expected: journal `3 pass`; from-scratch still RED, now in the hook with `cannot insert multiple commands into a prepared statement` (`0036` has three statements and no breakpoints).

- [ ] **Step 4: Add the statement breakpoints**

The statements are unchanged; only the `--> statement-breakpoint` marker is appended to every statement-ending line except the last of each file.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/packages/db/drizzle/0036_tenant_member_roles.sql
+++ b/packages/db/drizzle/0036_tenant_member_roles.sql
@@ -6,13 +6,13 @@
 -- security-approver at the same time.
 
 ALTER TABLE "tenant_members"
-  ADD COLUMN IF NOT EXISTS "roles" text[] DEFAULT ARRAY['member']::text[] NOT NULL;
+  ADD COLUMN IF NOT EXISTS "roles" text[] DEFAULT ARRAY['member']::text[] NOT NULL;--> statement-breakpoint
 
 -- Existing memberships keep exactly the authority they already had.
 UPDATE "tenant_members"
   SET "roles" = ARRAY["role"]::text[]
   WHERE "roles" = ARRAY['member']::text[]
-    AND "role" <> 'member';
+    AND "role" <> 'member';--> statement-breakpoint
 
 CREATE INDEX IF NOT EXISTS "tenant_members_roles_idx"
   ON "tenant_members" USING GIN ("roles");
--- a/packages/db/drizzle/0038_setup_tool_overrides.sql
+++ b/packages/db/drizzle/0038_setup_tool_overrides.sql
@@ -19,7 +19,7 @@
   "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
   CONSTRAINT "runtime_app_setup_tool_overrides_run_id_tool_id_unique"
     UNIQUE ("run_id", "tool_id")
-);
+);--> statement-breakpoint
 
 CREATE INDEX IF NOT EXISTS "runtime_app_setup_tool_overrides_run_idx"
   ON "runtime_app_setup_tool_overrides" ("tenant_id", "run_id");
--- a/packages/db/drizzle/0039_override_scoped_to_tool.sql
+++ b/packages/db/drizzle/0039_override_scoped_to_tool.sql
@@ -10,7 +10,7 @@
 
 ALTER TABLE "runtime_app_setup_tool_overrides"
   ADD CONSTRAINT "runtime_app_setup_tool_overrides_app_tool_unique"
-  UNIQUE ("target_app_id", "tool_id");
+  UNIQUE ("target_app_id", "tool_id");--> statement-breakpoint
 
 CREATE INDEX IF NOT EXISTS "runtime_app_setup_tool_overrides_app_idx"
   ON "runtime_app_setup_tool_overrides" ("tenant_id", "target_app_id");
--- a/packages/db/drizzle/0040_approve_every_revision_type.sql
+++ b/packages/db/drizzle/0040_approve_every_revision_type.sql
@@ -9,7 +9,7 @@
 -- removed. No table, column, or row is dropped.
 
 ALTER TABLE "runtime_revision_approvals"
-  DROP CONSTRAINT IF EXISTS "runtime_revision_approvals_type_check";
+  DROP CONSTRAINT IF EXISTS "runtime_revision_approvals_type_check";--> statement-breakpoint
 
 ALTER TABLE "runtime_revision_approvals"
   ADD CONSTRAINT "runtime_revision_approvals_type_check"
--- a/packages/db/drizzle/0042_connected_platform_pairing.sql
+++ b/packages/db/drizzle/0042_connected_platform_pairing.sql
@@ -1,5 +1,5 @@
 ALTER TABLE "runtime_environments"
-  ADD COLUMN "promotion_order" integer;
+  ADD COLUMN "promotion_order" integer;--> statement-breakpoint
 
 WITH "ranked_environments" AS (
   SELECT
@@ -13,10 +13,10 @@
 UPDATE "runtime_environments" AS "environment"
 SET "promotion_order" = "ranked_environments"."promotion_order"
 FROM "ranked_environments"
-WHERE "environment"."id" = "ranked_environments"."id";
+WHERE "environment"."id" = "ranked_environments"."id";--> statement-breakpoint
 
 ALTER TABLE "runtime_environments"
-  ALTER COLUMN "promotion_order" SET NOT NULL;
+  ALTER COLUMN "promotion_order" SET NOT NULL;--> statement-breakpoint
 
 CREATE TABLE "runtime_connection_pairings" (
   "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
@@ -50,7 +50,7 @@
     REFERENCES "public"."runtime_environments"("tenant_id", "target_app_id", "id") ON DELETE cascade,
   CONSTRAINT "runtime_connection_pairings_api_key_fk"
     FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id")
-);
+);--> statement-breakpoint
 
 CREATE INDEX "runtime_connection_pairings_status_expiry_idx"
   ON "runtime_connection_pairings" USING btree ("status", "expires_at");
PATCH
```

- [ ] **Step 5: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/migration-journal.test.ts src/__tests__/migrations-from-scratch.test.ts 2>&1 | tail -4
bun test 2>&1 | tail -4
```

Expected: `5 pass`, `0 fail`; full DB suite `95 pass`, `0 fail`, `Ran 95 tests across 17 files.` (the existing `connected-platform-migration`, `setup-tool-overrides` and `tenant-member-roles` content tests stay green: the markers follow the `;` and change no matched text).

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/drizzle packages/db/src/__tests__/migration-journal.test.ts packages/db/src/__tests__/migrations-from-scratch.test.ts
git commit -m "fix(db): register hand-applied migrations 0036-0043 in the journal"
```

---

### Task 3: DB – name the hand-written constraints in the Drizzle schema

**Files:**
- Modify: `packages/db/src/__tests__/migrations-from-scratch.test.ts` (adds `SQL_ONLY_OBJECTS` and the third test)
- Modify: `packages/db/src/schema/runtime-app-setup-tool-overrides.ts:27-32,49`, `packages/db/src/schema/runtime-connection-pairings.ts:27,30,43`
- Test: `packages/db/src/__tests__/migrations-from-scratch.test.ts`

**Interfaces:** Consumes `foreignKey({ columns, foreignColumns, name })` and `unique(name).on(...)` from `drizzle-orm/pg-core`. Produces no API change; column types are unchanged, only constraint metadata is named.

`0038` declared its foreign keys inline (`REFERENCES`), so PostgreSQL named them `runtime_app_setup_tool_overrides_target_app_id_fkey` and `..._run_id_fkey`; `0039` named the uniqueness `runtime_app_setup_tool_overrides_app_tool_unique`; `0042` named `runtime_connection_pairings_tenant_fk` (`ON DELETE CASCADE`) and `..._api_key_fk`. The schema used Drizzle's default names, so a future generated migration would drop or alter constraints that do not exist.

- [ ] **Step 1: Write the failing test**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/packages/db/src/__tests__/migrations-from-scratch.test.ts
+++ b/packages/db/src/__tests__/migrations-from-scratch.test.ts
@@ -8,6 +8,25 @@
 import * as schema from '../schema';
 
 const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
+
+/**
+ * Objects that exist only in hand-written SQL (checks, extra foreign keys,
+ * a GIN index, the per-run override uniqueness kept by 0039). drizzle-kit
+ * does not track them, so a generated migration never touches them. A new
+ * entry here needs a reason; see MIGRATIONS.md.
+ */
+const SQL_ONLY_OBJECTS = [
+  'audit_events:audit_events_content_tier_check',
+  'audit_events:audit_events_legal_hold_case_check',
+  'audit_events:audit_events_tier_retention_check',
+  'runtime_app_setup_tool_overrides:runtime_app_setup_tool_overrides_app_idx',
+  'runtime_app_setup_tool_overrides:runtime_app_setup_tool_overrides_run_id_tool_id_unique',
+  'runtime_config_revisions:runtime_config_revisions_parent_revision_fk',
+  'runtime_deployments:runtime_deployments_promoted_from_scope_fk',
+  'runtime_deployments:runtime_deployments_prompt_digest_idx',
+  'runtime_deployments:runtime_deployments_runtime_digest_idx',
+  'tenant_members:tenant_members_roles_idx',
+];
 
 const tables = Object.values(schema)
   .filter((value): value is PgTable => is(value, PgTable))
@@ -58,4 +77,30 @@
       expect(`${column} notNull=${database.get(column)}`).toBe(`${column} notNull=${notNull}`);
     }
   });
+
+  it('names every declared constraint and index exactly as the database does', async () => {
+    const { rows } = await client.query<{ object: string }>(
+      `select c.conrelid::regclass::text || ':' || c.conname as object
+         from pg_constraint c
+         join pg_namespace n on n.oid = c.connamespace
+        where n.nspname = 'public' and c.contype in ('u', 'f', 'c')
+       union
+       select i.tablename || ':' || i.indexname
+         from pg_indexes i
+        where i.schemaname = 'public'
+          and not exists (select 1 from pg_constraint c where c.conname = i.indexname)`,
+    );
+    const database = new Set(rows.map((row) => row.object.replaceAll('"', '')));
+    const declared = new Set(tables.flatMap((table) => [
+      ...table.indexes.map((index) => index.config.name!),
+      ...table.uniqueConstraints.map((unique) => unique.getName()),
+      ...table.foreignKeys.map((foreignKey) => foreignKey.getName()),
+      ...table.checks.map((check) => check.name),
+      ...table.columns.filter((column) => column.isUnique).map((column) => column.uniqueName!),
+    ].map((name) => `${table.name}:${name.slice(0, 63)}`)));
+
+    expect([...declared].filter((object) => !database.has(object))).toEqual([]);
+    expect([...database].filter((object) => !declared.has(object)).sort())
+      .toEqual(SQL_ONLY_OBJECTS);
+  });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/migrations-from-scratch.test.ts 2>&1 | grep -E "^\+|^-|pass|fail" | head -14
```

Expected: `2 pass`, `1 fail`; the first expectation lists exactly the five declared names the database lacks: `runtime_app_setup_tool_overrides:runtime_app_setup_tool_overrides_target_app_id_tool_id_unique`, `..._target_app_id_target_apps_id_f` (truncated to 63 characters like PostgreSQL), `..._run_id_runtime_app_setup_runs_`, `runtime_connection_pairings:runtime_connection_pairings_tenant_id_tenants_id_fk`, `runtime_connection_pairings:runtime_connection_pairings_api_key_id_api_keys_id_fk`.

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/packages/db/src/schema/runtime-app-setup-tool-overrides.ts
+++ b/packages/db/src/schema/runtime-app-setup-tool-overrides.ts
@@ -1,5 +1,6 @@
 import {
   boolean,
+  foreignKey,
   index,
   pgTable,
   text,
@@ -24,12 +25,8 @@
   {
     id: uuid('id').primaryKey().defaultRandom(),
     tenantId: uuid('tenant_id').notNull(),
-    targetAppId: uuid('target_app_id')
-      .notNull()
-      .references(() => targetApps.id),
-    runId: uuid('run_id')
-      .notNull()
-      .references(() => runtimeAppSetupRuns.id),
+    targetAppId: uuid('target_app_id').notNull(),
+    runId: uuid('run_id').notNull(),
     toolId: uuid('tool_id').notNull(),
     description: text('description'),
     riskClass: text('risk_class'),
@@ -46,7 +43,22 @@
   (t) => [
     // The decision belongs to the tool, so it survives a re-scan. The run is
     // still recorded, but only as the audit trail of who decided when.
-    unique().on(t.targetAppId, t.toolId),
+    unique('runtime_app_setup_tool_overrides_app_tool_unique').on(
+      t.targetAppId,
+      t.toolId,
+    ),
     index('runtime_app_setup_tool_overrides_run_idx').on(t.tenantId, t.runId),
+    // Names as created by the hand-written 0038 (inline REFERENCES, so
+    // Postgres chose the default "<table>_<column>_fkey" names).
+    foreignKey({
+      columns: [t.targetAppId],
+      foreignColumns: [targetApps.id],
+      name: 'runtime_app_setup_tool_overrides_target_app_id_fkey',
+    }),
+    foreignKey({
+      columns: [t.runId],
+      foreignColumns: [runtimeAppSetupRuns.id],
+      name: 'runtime_app_setup_tool_overrides_run_id_fkey',
+    }),
   ],
 );
--- a/packages/db/src/schema/runtime-connection-pairings.ts
+++ b/packages/db/src/schema/runtime-connection-pairings.ts
@@ -24,10 +24,10 @@
     localAppId: uuid('local_app_id').notNull(),
     localAppName: text('local_app_name').notNull(),
     artifactDigest: text('artifact_digest').notNull(),
-    tenantId: uuid('tenant_id').references(() => tenants.id),
+    tenantId: uuid('tenant_id'),
     targetAppId: uuid('target_app_id'),
     environmentId: uuid('environment_id'),
-    apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
+    apiKeyId: uuid('api_key_id'),
     authorizedBy: text('authorized_by'),
     expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
     authorizedAt: timestamp('authorized_at', { withTimezone: true }),
@@ -40,6 +40,16 @@
       .defaultNow(),
   },
   (t) => [
+    foreignKey({
+      columns: [t.tenantId],
+      foreignColumns: [tenants.id],
+      name: 'runtime_connection_pairings_tenant_fk',
+    }).onDelete('cascade'),
+    foreignKey({
+      columns: [t.apiKeyId],
+      foreignColumns: [apiKeys.id],
+      name: 'runtime_connection_pairings_api_key_fk',
+    }),
     foreignKey({
       columns: [t.tenantId, t.targetAppId],
       foreignColumns: [targetApps.tenantId, targetApps.id],
PATCH
```

- [ ] **Step 4: Run and see GREEN, rebuild the package**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test 2>&1 | tail -4
./node_modules/.bin/tsc -p tsconfig.json; echo "db-build=$?"
cd ../../apps/api && ./node_modules/.bin/vitest run src/modules/runtime-connect src/modules/runtime-setup-v2 2>&1 | grep -E "Test Files|Tests "
```

Expected: `96 pass`, `0 fail`, `Ran 96 tests across 17 files.`; `db-build=0`; the API specs around both tables stay green: `Test Files  19 passed (19)`, `Tests  163 passed (163)` (the path filter also matches `runtime-connections`).

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/src/schema/runtime-app-setup-tool-overrides.ts packages/db/src/schema/runtime-connection-pairings.ts packages/db/src/__tests__/migrations-from-scratch.test.ts
git commit -m "fix(db): name hand-written constraints in the drizzle schema"
```

---

### Task 4: DB – record a current schema snapshot for drizzle-kit

**Files:**
- Create: `packages/db/src/__tests__/schema-snapshot.test.ts`
- Create (generated, never hand-edited): `packages/db/drizzle/meta/0043_snapshot.json`
- Test: `packages/db/src/__tests__/schema-snapshot.test.ts`, `drizzle-kit check`, a `drizzle-kit generate` dry run in a temporary copy

**Interfaces:** Consumes `generateDrizzleJson(imports, prevId)` and `generateMigration(prev, cur): Promise<string[]>` from `drizzle-kit/api` (0.30.6), which is what `drizzle-kit generate` diffs. Produces the newest snapshot (`version` 7, 56 tables, `prevId` = id of `0029_snapshot.json`).

`drizzle-kit generate` diffs `src/schema` against the lexicographically last `meta/*_snapshot.json`. That is `0029`, so today it would re-emit 245 statements for `0030`-`0043`. The snapshot is produced by the real CLI in a temporary copy (its journal and SQL output are discarded with the copy) and only the snapshot JSON is kept, under the number of the last journal entry.

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/schema-snapshot.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../schema';

const metaDir = fileURLToPath(new URL('../../drizzle/meta', import.meta.url));

describe('Drizzle schema snapshot', () => {
  const snapshots = readdirSync(metaDir).filter((name) => name.endsWith('_snapshot.json')).sort();
  const journal = JSON.parse(readFileSync(`${metaDir}/_journal.json`, 'utf8')) as {
    entries: Array<{ idx: number }>;
  };

  it('keeps the latest snapshot at the latest journal entry', () => {
    const lastIdx = journal.entries[journal.entries.length - 1].idx;

    expect(snapshots[snapshots.length - 1])
      .toBe(`${String(lastIdx).padStart(4, '0')}_snapshot.json`);
  });

  it('matches the schema, so drizzle-kit generate re-emits nothing', async () => {
    const latest = JSON.parse(
      readFileSync(`${metaDir}/${snapshots[snapshots.length - 1]}`, 'utf8'),
    );

    const statements = await generateMigration(
      latest,
      generateDrizzleJson(schema, latest.id),
    );

    expect(statements).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/schema-snapshot.test.ts 2>&1 | grep -E "Expected|Received|pass|fail" | head -8
```

Expected: `0 pass`, `2 fail`: `Expected: "0043_snapshot.json"`, `Received: "0029_snapshot.json"`, and the diff test receives a non-empty statement list (`Received + 245`, starting with `CREATE TABLE "audit_archives"`).

- [ ] **Step 3: Generate the snapshot in a temporary copy**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
T="$(mktemp -d)"
cp -R drizzle src package.json "$T/"
ln -s "$PWD/node_modules" "$T/node_modules"
cat > "$T/drizzle.config.ts" <<'EOF'
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema',
  out: './drizzle',
  dialect: 'postgresql',
});
EOF
(cd "$T" && ./node_modules/.bin/drizzle-kit generate --name current_schema_baseline > "$T/generate.log" 2>&1; echo "generate-exit=$?"; tail -1 "$T/generate.log")
cp "$T/drizzle/meta/0044_snapshot.json" drizzle/meta/0043_snapshot.json
node -e 'const s=require("./drizzle/meta/0043_snapshot.json");const p=require("./drizzle/meta/0029_snapshot.json");console.log(s.prevId===p.id, s.version, s.dialect, Object.keys(s.tables).length)'
git status --short
```

Expected: `generate-exit=0` and `Your SQL migration file ➜ drizzle/0044_current_schema_baseline.sql` (inside `$T` only); `true 7 postgresql 56`; status `?? drizzle/meta/0043_snapshot.json` plus the untracked test from Step 1. The temporary config has no credentials, so no `.env` is read and nothing connects.

- [ ] **Step 4: Run and see GREEN; prove generate is quiet**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/schema-snapshot.test.ts 2>&1 | tail -3
DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check 2>&1 | tail -1
T="$(mktemp -d)"
cp -R drizzle src package.json "$T/"
ln -s "$PWD/node_modules" "$T/node_modules"
printf "import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ schema: './src/schema', out: './drizzle', dialect: 'postgresql' });\n" > "$T/drizzle.config.ts"
(cd "$T" && ./node_modules/.bin/drizzle-kit generate --name probe 2>&1 | tail -1)
bun test 2>&1 | tail -4
```

Expected: `2 pass`, `0 fail`; `Everything's fine 🐶🔥`; `No schema changes, nothing to migrate 😴`; full DB suite `98 pass`, `0 fail`, `Ran 98 tests across 18 files.`

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/drizzle/meta/0043_snapshot.json packages/db/src/__tests__/schema-snapshot.test.ts
git commit -m "build(db): record a current schema snapshot for drizzle-kit"
```

---

### Task 5: DB – print the migration baseline for hand-migrated databases

**Files:**
- Create: `packages/db/src/__tests__/migration-baseline.test.ts`, `packages/db/scripts/print-migration-baseline.ts`
- Test: `packages/db/src/__tests__/migration-baseline.test.ts`

**Interfaces:** Produces `migrationBaselineSql(migrationsFolder: string, throughTag: string): string` and the CLI `bun scripts/print-migration-baseline.ts --through <tag>`. Consumes the migrator's bookkeeping: `drizzle.__drizzle_migrations (id serial, hash text, created_at bigint)`, `hash` = sha256 hex of the whole SQL file, `created_at` = journal `when`. The script never connects; precedent: `packages/db/scripts/backfill-journal.ts` recorded `0000`-`0021` the same way, but against the database directly.

The shared database recorded migrations through `0035` and got `0036`-`0043` by hand. With the new journal, `drizzle-kit migrate` would run them again and fail at `0039` (`ADD CONSTRAINT` without `IF NOT EXISTS`); `0042` would even recompute `promotion_order`. The test reproduces that database in PGlite: migrate with the journal as it was before Task 2, then apply the hand-applied files with `exec` (simple protocol, several statements allowed).

- [ ] **Step 1: Write the failing test**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/src/__tests__/migration-baseline.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { migrationBaselineSql } from '../../scripts/print-migration-baseline';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const journal = JSON.parse(
  readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
) as { entries: Array<{ tag: string }> };
const HAND_APPLIED = [
  '0022_lean_steel_serpent',
  '0023_cultured_vulture',
  ...journal.entries.map(({ tag }) => tag).filter((tag) => tag >= '0036'),
];
const workDir = mkdtempSync(join(tmpdir(), 'glirastes-migration-baseline-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * The shared database as it stood before this baseline: drizzle-kit migrate
 * applied the journal through 0035, everything after it arrived by hand.
 */
async function handMigratedDatabase(): Promise<PGlite> {
  const legacyFolder = join(workDir, `legacy-${crypto.randomUUID()}`);
  cpSync(migrationsFolder, legacyFolder, { recursive: true });
  const legacyJournal = JSON.parse(
    readFileSync(`${legacyFolder}/meta/_journal.json`, 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  legacyJournal.entries = legacyJournal.entries
    .filter(({ tag }) => !HAND_APPLIED.includes(tag));
  writeFileSync(`${legacyFolder}/meta/_journal.json`, JSON.stringify(legacyJournal));

  const client = new PGlite();
  await migrate(drizzle(client), { migrationsFolder: legacyFolder });
  for (const tag of HAND_APPLIED) {
    await client.exec(readFileSync(`${migrationsFolder}/${tag}.sql`, 'utf8'));
  }
  return client;
}

describe('baseline for a database migrated by hand', () => {
  it('cannot resume drizzle-kit migrate without the baseline', async () => {
    const client = await handMigratedDatabase();

    await expect(migrate(drizzle(client), { migrationsFolder })).rejects.toThrow();
    await client.close();
  }, 60_000);

  it('resumes drizzle-kit migrate after the printed baseline without reapplying anything', async () => {
    const client = await handMigratedDatabase();
    const lastTag = journal.entries[journal.entries.length - 1].tag;

    const baseline = migrationBaselineSql(migrationsFolder, lastTag);
    await client.exec(baseline);
    await client.exec(baseline);
    await migrate(drizzle(client), { migrationsFolder });

    const { rows } = await client.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    );
    expect(rows[0].applied).toBe(journal.entries.length);
    await client.close();
  }, 60_000);

  it('records only the requested prefix of the journal', () => {
    const sql = migrationBaselineSql(migrationsFolder, '0001_last_spacker_dave');

    expect(sql.match(/INSERT INTO/g)).toHaveLength(2);
    expect(() => migrationBaselineSql(migrationsFolder, '9999_unknown'))
      .toThrow('Unknown migration tag: 9999_unknown');
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/migration-baseline.test.ts 2>&1 | grep -E "Cannot find module|pass|fail" | head -3
```

Expected: the file fails to load with `Cannot find module '../../scripts/print-migration-baseline'`; `0 pass`, `1 fail`.

- [ ] **Step 3: Minimal implementation**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/scripts/print-migration-baseline.ts`:

```ts
/**
 * Prints SQL that records migrations as already applied in
 * drizzle.__drizzle_migrations, so `drizzle-kit migrate` resumes after them.
 * It is meant for a database that received migrations by hand (the shared
 * database got 0036-0043 that way). The script never connects anywhere:
 * review the output, then run it against the target database yourself.
 * See MIGRATIONS.md.
 *
 *   bun scripts/print-migration-baseline.ts --through 0043_resumable_setup_publication
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface JournalEntry {
  tag: string;
  when: number;
}

export function migrationBaselineSql(
  migrationsFolder: string,
  throughTag: string,
): string {
  const { entries } = JSON.parse(
    readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
  ) as { entries: JournalEntry[] };
  const through = entries.findIndex((entry) => entry.tag === throughTag);
  if (through === -1) throw new Error(`Unknown migration tag: ${throughTag}`);

  const inserts = entries.slice(0, through + 1).map((entry) => {
    // Same hash drizzle-orm's migrator stores: sha256 of the whole file.
    const hash = createHash('sha256')
      .update(readFileSync(`${migrationsFolder}/${entry.tag}.sql`, 'utf8'))
      .digest('hex');
    return [
      `-- ${entry.tag}`,
      'INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")',
      `SELECT '${hash}', ${entry.when}`,
      'WHERE NOT EXISTS (',
      `  SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${entry.when}`,
      ');',
    ].join('\n');
  });

  return [
    `-- Marks migrations through ${throughTag} as applied. Generated by`,
    '-- packages/db/scripts/print-migration-baseline.ts; safe to run twice.',
    'CREATE SCHEMA IF NOT EXISTS "drizzle";',
    'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (',
    '  id SERIAL PRIMARY KEY,',
    '  hash text NOT NULL,',
    '  created_at bigint',
    ');',
    ...inserts,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--through');
  const throughTag = flag === -1 ? undefined : process.argv[flag + 1];
  if (!throughTag) {
    console.error('Usage: bun scripts/print-migration-baseline.ts --through <tag>');
    process.exit(1);
  }
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  process.stdout.write(migrationBaselineSql(migrationsFolder, throughTag));
}
```

- [ ] **Step 4: Run and see GREEN, try the CLI**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun test src/__tests__/migration-baseline.test.ts 2>&1 | tail -3
bun scripts/print-migration-baseline.ts --through 0043_resumable_setup_publication | grep -c "INSERT INTO"
bun scripts/print-migration-baseline.ts; echo "usage-exit=$?"
bun test 2>&1 | tail -4
git status --short
```

Expected: `3 pass`, `0 fail`; `46`; `Usage: bun scripts/print-migration-baseline.ts --through <tag>` and `usage-exit=1`; full DB suite `101 pass`, `0 fail`, `Ran 101 tests across 19 files.`; status lists only the two new files (the test removes its own temporary directory).

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/scripts/print-migration-baseline.ts packages/db/src/__tests__/migration-baseline.test.ts
git commit -m "feat(db): print the migration baseline for hand-migrated databases"
```

---

### Task 6: DB – document the migration strategy

**Files:**
- Create: `packages/db/MIGRATIONS.md`
- Modify: `CLAUDE.md` (Database command block, after line 59)
- Test: the runbook query in Step 2 against a migrated PGlite

**Interfaces:** none. Docs only; the runbook steps for the shared database are for Philipp and are not executed here.

- [ ] **Step 1: Write the documentation**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db/MIGRATIONS.md`:

````markdown
# Database migrations

`drizzle-kit migrate` (`bun run db:migrate`) applies `drizzle/*.sql` in the
order of `drizzle/meta/_journal.json`. The migrator compares each entry's
`when` with the newest `created_at` in `drizzle.__drizzle_migrations` and runs
every entry that is newer, so `when` must grow strictly with the journal
order. `bun test` in this package proves the whole chain on an empty
in-process PostgreSQL (PGlite, no network):

- `migration-journal.test.ts`: every SQL file is registered exactly once,
  `when` grows strictly, `idx` equals the file's numeric prefix;
- `migrations-from-scratch.test.ts`: all migrations apply to an empty
  database, the result has exactly the tables, columns and nullability of
  `src/schema`, every constraint and index the schema names exists under that
  name, and every object that exists only in SQL is listed on purpose;
- `schema-snapshot.test.ts`: the newest snapshot matches `src/schema`, so
  `drizzle-kit generate` re-emits nothing;
- `migration-baseline.test.ts`: a database that received migrations by hand
  resumes `drizzle-kit migrate` after the printed baseline.

## Writing a migration

1. Change `src/schema` first.
2. Generate with a placeholder `DATABASE_URL`, so `drizzle.config.ts` never
   loads a `.env` file. `generate` and `check` never connect to a database:

   ```bash
   cd packages/db
   DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit generate --name <what_it_does>
   DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check
   ```

   This writes `drizzle/<idx>_<what_it_does>.sql`, `drizzle/meta/<idx>_snapshot.json`
   and the journal entry together. The next index after this baseline is
   `0044`.
3. If the SQL has to be written by hand (data backfills, checks, triggers),
   keep the generated journal entry and snapshot and edit only the SQL. Put
   `--> statement-breakpoint` between statements: the migrator sends each
   chunk as one prepared statement, and PostgreSQL rejects several commands in
   one prepared statement.
4. Run `bun test`. A SQL file missing from the journal, a snapshot that lags
   behind `src/schema`, or a migration that does not apply on an empty
   database fails there. An object that exists only in SQL must be added to
   `SQL_ONLY_OBJECTS` in `migrations-from-scratch.test.ts` with a reason.

## Snapshots

`drizzle-kit generate` diffs `src/schema` against the newest
`meta/*_snapshot.json` (sorted by file name). History up to `0029` has
generated snapshots; `0007` and `0013` never had one, and the `prevId` chain is
already broken at `0022` (it points to a snapshot from a merged branch). None
of that is used any more. `0030`-`0043` were written by hand without
snapshots, so until 2026-10-04 `generate` would have re-emitted all of them.

`meta/0043_snapshot.json` is the current baseline. It was produced by
`drizzle-kit generate` in a temporary copy of this package after `0043` (its
`prevId` is the `0029` snapshot) and describes `src/schema` exactly. The
`schema-snapshot` test keeps it honest. The `drizzle-kit check` collision
report stays clean because no two snapshots share a `prevId`.

Objects that exist only in hand-written SQL are invisible to drizzle-kit and
are never touched by a generated migration. The from-scratch test pins the
list (audit checks from `0031`, two composite foreign keys and two digest
indexes from `0034`/`0035`, the GIN index from `0036`, and the per-run
override uniqueness plus app index that `0039` kept).

## Files that are not plain journal history

| File | Status |
| --- | --- |
| `0022_lean_steel_serpent.sql` (`optimization_suggestions`) and `0023_cultured_vulture.sql` (`oauth_clients`) | Created in `11df0c9` on a branch whose journal lost to `0022_burly_nova` in a merge. The shared database got both tables from `scripts/create-oauth-clients.ts` and `db:push`; a fresh database had neither. They are now registered right after `0022_burly_nova` (`when` 1775460970788 and 1775460970789, `idx` 22 and 23 like their file names), so only databases created from scratch run them. |
| `0036`-`0043` | Applied to the shared database by hand, registered in the journal on 2026-10-04 with the commit time of each file as `when`. `0036`, `0038`, `0039`, `0040` and `0042` gained `--> statement-breakpoint` markers; the statements themselves are unchanged. |
| `backfill-target-apps.sql` | One-time data backfill from 2026-03-31 (`b021800`), run by hand between `0017` and the removal of `pii_configs.api_key_id`. It is history, not a migration, and must never be registered: it reads a column that no longer exists. Moving it to `scripts/` needs an explicit decision. |

## A database that received migrations by hand

The shared database recorded migrations through `0035` and then received
`0036`-`0043` by hand. Running `drizzle-kit migrate` there now would try
`0036`-`0043` again and fail at `0039` (`ADD CONSTRAINT` of an existing
constraint). Before the first migrate after 2026-10-04, record what is already
there. This changes production data, so it needs Philipp's approval and is
never run by an agent.

1. Confirm that the hand-applied objects exist. Every column must be `true`;
   if one is not, stop and apply that migration instead of recording it:

   ```sql
   SELECT
     to_regclass('public.oauth_clients') IS NOT NULL AS has_0023_cultured_vulture,
     to_regclass('public.optimization_suggestions') IS NOT NULL AS has_0022_lean_steel_serpent,
     EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'tenant_members' AND column_name = 'roles') AS has_0036,
     EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'runtime_prompt_revisions' AND column_name = 'sections') AS has_0037,
     to_regclass('public.runtime_app_setup_tool_overrides') IS NOT NULL AS has_0038,
     EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'runtime_app_setup_tool_overrides_app_tool_unique') AS has_0039,
     EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'runtime_revision_approvals_type_check'
               AND pg_get_constraintdef(oid) LIKE '%config%') AS has_0040,
     NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'runtime_prompt_revisions_app_digest_unique') AS has_0041,
     to_regclass('public.runtime_connection_pairings') IS NOT NULL AS has_0042,
     EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'runtime_app_setup_runs' AND column_name = 'publication_state') AS has_0043;
   ```

2. Print the baseline and review it. It contains only `CREATE ... IF NOT
   EXISTS` and guarded `INSERT`s into `drizzle.__drizzle_migrations`, and it
   is safe to run twice:

   ```bash
   cd packages/db
   bun scripts/print-migration-baseline.ts --through 0043_resumable_setup_publication > /tmp/glirastes-migration-baseline.sql
   ```

3. Run the reviewed file against the database, then `bun run db:migrate`,
   which must report nothing to apply.
````

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -57,6 +57,7 @@
 bun run db:generate                  # Generate migration files from schema changes
 bun run db:push                      # Push schema directly to Neon (dev)
 bun run db:migrate                   # Apply migrations (needs DATABASE_URL)
+# Migration rules, snapshots, hand-migrated baseline: packages/db/MIGRATIONS.md
 
 # Docker (Redis + Presidio)
 docker compose up -d                 # Start Redis and Presidio sidecar
PATCH
```

- [ ] **Step 2: Prove the runbook query on a fresh database**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/packages/db
bun -e "
const { PGlite } = await import('@electric-sql/pglite');
const { drizzle } = await import('drizzle-orm/pglite');
const { migrate } = await import('drizzle-orm/pglite/migrator');
const doc = await Bun.file('MIGRATIONS.md').text();
const query = doc.match(/\`\`\`sql\n([\s\S]*?)\`\`\`/)[1];
const client = new PGlite();
await migrate(drizzle(client), { migrationsFolder: './drizzle' });
const { rows } = await client.query(query);
console.log(Object.values(rows[0]).every((value) => value === true), Object.keys(rows[0]).length);
await client.close();
"
```

Expected: `true 10` (every hand-applied object exists after a full migration, so the query cannot pass on a database that is missing one).

- [ ] **Step 3: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add packages/db/MIGRATIONS.md CLAUDE.md
git commit -m "docs(db): document the migration strategy"
```

---
### Task 7: API – stop the Advisor tool schemas from exhausting the type checker

**Files:**
- Modify: `apps/api/src/modules/advisor/advisor.tools.ts:1,3,25-27,200,357`
- Test: a single-file type probe (Steps 1 and 3) and the Advisor, Optimizer and worker specs

**Interfaces:**
- Consumes: `tool<INPUT, OUTPUT>(tool: Tool<INPUT, OUTPUT>)` and `type Tool` from `ai` 6.0.146 (`CoreTool` no longer exists in AI SDK 6); `z` from `zod/v4` (zod 3.25.76 ships zod 4 under this subpath; `z.record` takes key and value schemas there).
- Produces: unchanged `buildAdvisorTools(db: Database, tenantId: string): Record<string, Tool>` and `recommendationToToolCall(...)`.

`tsc` on this one file runs out of memory after about two minutes (4 GB): every `tool({ inputSchema, outputSchema, execute })` call makes AI SDK 6 infer its input type through zod 3's types across four overloads. With `zod/v4` the same file needs 73,388 instantiations and under a second. The Advisor is deferred in the foundation product profile but stays wired (`product-profile.ts`, `advisor-recommendations.worker.ts`, `optimizer.service.ts`) and keeps working: AI SDK 6 validates and converts zod 4 schemas natively (checked with `asSchema(...).validate` and `.jsonSchema` while writing this plan).

- [ ] **Step 1: See RED (the probe does not finish)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
T="$(mktemp -d)"
cat > "$T/advisor.json" <<JSON
{
  "extends": "$PWD/tsconfig.json",
  "compilerOptions": { "noEmit": true, "incremental": false },
  "include": [],
  "files": ["$PWD/src/modules/advisor/advisor.tools.ts"]
}
JSON
perl -e 'alarm 60; exec @ARGV' ./node_modules/.bin/tsc -p "$T/advisor.json" --extendedDiagnostics > "$T/red.log" 2>&1; echo "exit=$?"
echo "$T"
```

Expected: `exit=142` (SIGALRM after 60 s, no output).

- [ ] **Step 2: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/advisor/advisor.tools.ts
+++ b/apps/api/src/modules/advisor/advisor.tools.ts
@@ -1,6 +1,6 @@
-import { z } from 'zod';
+import { z } from 'zod/v4';
 import { eq, and, gte, desc, sql } from 'drizzle-orm';
-import { tool, type CoreTool } from 'ai';
+import { tool, type Tool } from 'ai';
 import type { Database } from '@glirastes/db';
 import {
   rbacRoles,
@@ -22,9 +22,9 @@
 
 /**
  * Build the full set of advisor tools, each scoped to a tenant via closure.
- * Returns a Record<string, CoreTool> ready for Vercel AI SDK's streamText().
+ * Returns a Record<string, Tool> ready for Vercel AI SDK's streamText().
  */
-export function buildAdvisorTools(db: Database, tenantId: string): Record<string, CoreTool> {
+export function buildAdvisorTools(db: Database, tenantId: string): Record<string, Tool> {
   return {
     advisor_update_rbac_role: tool({
       description:
@@ -197,7 +197,7 @@
       }),
       outputSchema: z.object({
         days: z.number(),
-        rows: z.array(z.record(z.unknown())),
+        rows: z.array(z.record(z.string(), z.unknown())),
       }),
       execute: async (input) => {
         const since = new Date(
@@ -354,7 +354,7 @@
         days: z.number().min(1).max(30).default(7),
       }),
       outputSchema: z.object({
-        agents: z.array(z.record(z.unknown())),
+        agents: z.array(z.record(z.string(), z.unknown())),
       }),
       execute: async (input) => {
         const since = new Date(
PATCH
```

- [ ] **Step 3: See GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
T="$(mktemp -d)"
cat > "$T/advisor.json" <<JSON
{
  "extends": "$PWD/tsconfig.json",
  "compilerOptions": { "noEmit": true, "incremental": false },
  "include": [],
  "files": ["$PWD/src/modules/advisor/advisor.tools.ts"]
}
JSON
./node_modules/.bin/tsc -p "$T/advisor.json" --extendedDiagnostics > "$T/green.log" 2>&1; echo "exit=$?"
grep -E "error TS|^Instantiations|^Check time" "$T/green.log"
./node_modules/.bin/vitest run src/modules/advisor src/modules/optimizer src/workers 2>&1 | grep -E "Test Files|Tests "
```

Expected: `exit=0`; no `error TS`; `Instantiations: 73388`; `Check time` of a few seconds (1.2 s on an idle machine, 6 s under load); `Test Files  8 passed (8)`, `Tests  60 passed (60)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/advisor/advisor.tools.ts
git commit -m "fix(advisor): stop the tool schemas from exhausting the type checker"
```

---

### Task 8: API – type the MCP passthrough schema as the SDK's own schema type

**Files:**
- Modify: `apps/api/src/modules/mcp/mcp-server.service.ts:7-14`
- Test: single-file type probe and the MCP specs

**Interfaces:** Consumes `type AnySchema` from `@modelcontextprotocol/sdk/server/zod-compat.js` (1.29.0, a type-only import that is erased at runtime) and `McpServer.registerTool<OutputArgs, InputArgs>(name, config, cb)`. Produces no API change.

`registerTool` types its schemas against the MCP SDK's own zod copy (zod 4.3.6 with `zod/v3` and `zod/v4/core`). Comparing this app's zod 3.25 object structurally with that copy costs 5.24 million instantiations and ends in TS2589 at line 196; it is the single most expensive file of the API. At runtime the SDK detects a zod 3 schema by its `_def` and validates with it, so only the static type changes.

- [ ] **Step 1: See RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
T="$(mktemp -d)"
cat > "$T/mcp.json" <<JSON
{
  "extends": "$PWD/tsconfig.json",
  "compilerOptions": { "noEmit": true, "incremental": false },
  "include": [],
  "files": ["$PWD/src/modules/mcp/mcp-server.service.ts"]
}
JSON
./node_modules/.bin/tsc -p "$T/mcp.json" --extendedDiagnostics > "$T/red.log" 2>&1; echo "exit=$?"
grep -E "error TS|^Instantiations" "$T/red.log"
```

Expected: `exit=2`; `src/modules/mcp/mcp-server.service.ts(196,9): error TS2589: Type instantiation is excessively deep and possibly infinite.`; `Instantiations: 5237954`.

- [ ] **Step 2: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/mcp/mcp-server.service.ts
+++ b/apps/api/src/modules/mcp/mcp-server.service.ts
@@ -5,13 +5,21 @@
 import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
 import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
+import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
 import { boundedErrorType } from '../../common/bounded-error';
 import { z } from 'zod';
 import { McpToolDiscoveryService } from './mcp-tool-discovery.service';
 import { McpToolExecutorService } from './mcp-tool-executor.service';
 import { McpOAuthService } from './oauth/oauth.service';
 
-const PASSTHROUGH_SCHEMA = z.object({}).passthrough();
+/**
+ * The MCP SDK types its schemas against its own zod copy (zod 4 with the v3
+ * compatibility layer). Comparing this app's zod 3 object with that copy
+ * structurally exceeds the compiler's instantiation limit (TS2589), so the
+ * schema is handed over as the SDK's own schema type. At runtime the SDK
+ * detects zod 3 schemas by their `_def` and validates with them unchanged.
+ */
+const PASSTHROUGH_SCHEMA = z.object({}).passthrough() as unknown as AnySchema;
 
 interface SessionEntry {
   transport: StreamableHTTPServerTransport;
PATCH
```

- [ ] **Step 3: See GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
T="$(mktemp -d)"
cat > "$T/mcp.json" <<JSON
{
  "extends": "$PWD/tsconfig.json",
  "compilerOptions": { "noEmit": true, "incremental": false },
  "include": [],
  "files": ["$PWD/src/modules/mcp/mcp-server.service.ts"]
}
JSON
./node_modules/.bin/tsc -p "$T/mcp.json" --extendedDiagnostics > "$T/green.log" 2>&1; echo "exit=$?"
grep -E "error TS|^Instantiations" "$T/green.log"
./node_modules/.bin/vitest run src/modules/mcp 2>&1 | grep -E "Test Files|Tests "
```

Expected: `exit=0`; no `error TS`; `Instantiations: 45995`; `Test Files  3 passed (3)`, `Tests  27 passed (27)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/mcp/mcp-server.service.ts
git commit -m "fix(mcp): hand the passthrough schema over as the sdk schema type"
```

---

### Task 9: API – add the typecheck gate

**Files:**
- Create: `apps/api/tsconfig.typecheck.json`, `apps/api/tsconfig.spec.json`
- Modify: `apps/api/package.json:11` (scripts), `turbo.json:18` (tasks), `package.json:22` (root scripts), `CLAUDE.md:53` (commands)
- Test: `bun run typecheck` in `apps/api`

**Interfaces:** Produces the scripts `apps/api` `"typecheck": "tsc -p tsconfig.typecheck.json && tsc -p tsconfig.spec.json"` and root `"typecheck": "turbo run typecheck"` (turbo builds `@glirastes/db` first, then type-checks API and Citadel).

`tsconfig.typecheck.json` extends `tsconfig.build.json`, so it checks exactly the files `nest build` compiles (the build sets `noCheck: true` and never type-checks). Specs and scripts use `import.meta` and run as ESM under Vitest and Bun, which CommonJS rejects (TS1343); `tsconfig.spec.json` therefore uses `module: esnext` with bundler resolution. It also switches off `emitDecoratorMetadata`, which only matters for emitted code and would otherwise raise TS1272 for type-only imports in decorated controller signatures under ESM settings. Production files are checked twice (once per config), which also proves they compile under both module settings.

- [ ] **Step 1: See RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
bun run typecheck; echo "exit=$?"
```

Expected: `error: Script not found "typecheck"`, non-zero exit.

- [ ] **Step 2: Create the configs and scripts**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/tsconfig.typecheck.json`:

```json
{
  "extends": "./tsconfig.build.json",
  "compilerOptions": {
    "noEmit": true,
    "noCheck": false
  }
}
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/tsconfig.spec.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "incremental": false,
    "rootDir": ".",
    "module": "esnext",
    "moduleResolution": "bundler",
    "emitDecoratorMetadata": false
  },
  "include": ["src/**/*.spec.ts", "src/**/__tests__/**/*.ts", "scripts/**/*.ts"]
}
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/package.json
+++ b/apps/api/package.json
@@ -9,6 +9,7 @@
     "start:debug": "NODE_OPTIONS='--max-old-space-size=8192' nest start --debug --watch",
     "start:prod": "node dist/main",
     "test": "vitest run",
+    "typecheck": "tsc -p tsconfig.typecheck.json && tsc -p tsconfig.spec.json",
     "test:pii-bulk": "REQUIRE_PII_BULK_DATA=1 vitest run src/modules/aegis/__tests__/pii-bulk-validation.spec.ts",
     "runtime:verify-rollback": "bun scripts/verify-runtime-rollback-rehearsal.ts",
     "lint": "echo 'lint not configured yet'",
--- a/turbo.json
+++ b/turbo.json
@@ -15,6 +15,9 @@
     "lint": {
       "dependsOn": ["^build"]
     },
+    "typecheck": {
+      "dependsOn": ["^build"]
+    },
     "db:generate": {
       "cache": false
     },
--- a/package.json
+++ b/package.json
@@ -20,6 +20,7 @@
     "dev": "turbo run dev",
     "test": "turbo run test",
     "lint": "turbo run lint",
+    "typecheck": "turbo run typecheck",
     "runtime:verify-rollback": "bun apps/api/scripts/verify-runtime-rollback-rehearsal.ts",
     "runtime:verify-connected": "bun run --cwd apps/api test src/modules/runtime-connect/__tests__/connected-free-rehearsal.spec.ts && bun run --cwd apps/citadel test src/app/\\(dashboard\\)/manage/managed-pipeline-wiring.test.ts",
     "runtime:verify-connected-free": "bun apps/api/scripts/verify-connected-free-rehearsal.ts",
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -51,6 +51,7 @@
 # Individual apps
 cd apps/api && bun run dev           # API only (watch mode)
 cd apps/api && bun run test          # API tests only (vitest run)
+cd apps/api && bun run typecheck     # API typecheck: build sources, then specs and scripts
 cd apps/citadel && bun run dev       # Dashboard only
 
 # Database (Drizzle)
PATCH
```

- [ ] **Step 3: Record the error baseline**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
L="$(mktemp -d)"
./node_modules/.bin/tsc -p tsconfig.typecheck.json > "$L/src.log" 2>&1; grep -c "error TS" "$L/src.log"
./node_modules/.bin/tsc -p tsconfig.spec.json > "$L/spec.log" 2>&1; grep -c "error TS" "$L/spec.log"
grep "error TS" "$L/spec.log" | grep -cE "__tests__|\.spec\.ts|^scripts/"
grep "error TS" "$L/src.log" | sed -E 's/\(.*//' | sort | uniq -c
```

Expected: `19` source errors; `95` errors under the spec config, `76` of them in specs and scripts (the other 19 are the same source errors seen through imports); per source file (path prefix `src/modules/` omitted): `4 acp/acp.service.ts`, `1 auth/auth.controller.ts`, `1 billing/stripe.service.ts`, `1 registry/generated-assets.service.ts`, `1 runtime-deployments/runtime-desired-state-derivation.service.ts`, `5 runtime-revisions/drizzle-runtime-revision.store.ts`, `1 runtime-revisions/runtime-revision.controller.ts`, `3 runtime-setup-v2/publish-and-deploy.service.ts`, `1 runtime-setup-v2/runtime-setup-v2.service.ts`, `1 runtime-setup/drizzle-runtime-setup.store.ts`. Each `tsc` run takes from about 5 seconds to under a minute, depending on machine load. Before Tasks 7 and 8 the source config died out of memory instead.

- [ ] **Step 4: Commit (the gate stays red until Task 13)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/tsconfig.typecheck.json apps/api/tsconfig.spec.json apps/api/package.json turbo.json package.json CLAUDE.md
git commit -m "build(api): add a typecheck gate for sources, specs and scripts"
```

---

### Task 10: API – fix the type errors in revision, deployment and setup flows (12)

**Files:**
- Modify: `apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts:17,57`, `runtime-revisions/runtime-revision.controller.ts:147-152`, `runtime-deployments/runtime-desired-state-derivation.service.ts:22-25,121`, `runtime-setup-v2/publish-and-deploy.service.ts:9-14,26,235`, `runtime-setup-v2/runtime-setup-v2.service.ts:459-468`, `runtime-setup/drizzle-runtime-setup.store.ts:246-249`
- Test: `bun run typecheck` (scoped counts) and the runtime specs

**Interfaces:**
- Consumes: `AnyPgColumn` (`drizzle-orm/pg-core`); `RuntimeDeploymentRecord { id; status; healthStatus } & RuntimeDeploymentScope` (`runtime-deployment.service.ts:31`); `AppSetupPublicationState` (`runtime-setup-v2.service.ts:76`, `revisionScopes: Array<{ type: 'tool' | 'agent' | 'prompt' | 'config'; revisionId: string }>`); `ReviewedAppSetupArtifact` (`app-configuration.service.ts:47`).
- Produces: `DeployLatestPublishedResult.deployment: RuntimeDeploymentRecord` (was `{ id: string } & Record<string, unknown>`).

| Error | Site | Fix |
| --- | --- | --- |
| TS2345 x5 | `drizzle-runtime-revision.store.ts:65,75,80,85,90` | `conditions` was typed for `agentRevisions.id` only; accept any `AnyPgColumn`. |
| TS2345 | `runtime-revision.controller.ts:147` | zod 3 infers `payload?: unknown` from `z.unknown()`; pass `payload: body.payload` explicitly (same value). |
| TS2322 | `runtime-desired-state-derivation.service.ts:331` | The declared result was an index-signature record; it returns `RuntimeDeploymentRecord`. Typing it so also fixes `publish-and-deploy.service.ts:173,189` (TS2345 x2), which read `healthStatus`. |
| TS2322 | `publish-and-deploy.service.ts:121` | `revisionScopes()` returned `RuntimeRevisionType` incl. `manifest`/`policy`; return the publication state's own element type. |
| TS2352 | `runtime-setup-v2.service.ts:459` | The stored artifact passed `appSetupArtifactSchema` at upload; cast through `unknown` with the reason in a comment. |
| TS2322 | `drizzle-runtime-setup.store.ts:247` | `RuntimeActor` is an interface without an index signature; spread it into a fresh object. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/tsc -p tsconfig.typecheck.json 2>&1 | grep "error TS" | grep -cE "^src/modules/runtime-(revisions|deployments|setup-v2|setup)/"
```

Expected: `12`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
+++ b/apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts
@@ -15,6 +15,7 @@
   type Database,
 } from '@glirastes/db';
 import { and, desc, eq, inArray, lt } from 'drizzle-orm';
+import type { AnyPgColumn } from 'drizzle-orm/pg-core';
 import {
   type RuntimeApprovalRecord,
   type RuntimeBatchPublication,
@@ -54,7 +55,7 @@
   }
 
   async findRevision(scope: RuntimeRevisionScope): Promise<StoredRuntimeRevision | null> {
-    const conditions = (idColumn: typeof agentRevisions.id) => and(
+    const conditions = (idColumn: AnyPgColumn) => and(
       eq(idColumn, scope.revisionId),
       eq(this.tableFor(scope.type).tenantId, scope.tenantId),
       eq(this.tableFor(scope.type).targetAppId, scope.targetAppId),
--- a/apps/api/src/modules/runtime-revisions/runtime-revision.controller.ts
+++ b/apps/api/src/modules/runtime-revisions/runtime-revision.controller.ts
@@ -149,6 +149,7 @@
       targetAppId: appId,
       type,
       ...body,
+      payload: body.payload,
     }, this.actor(tenant));
   }
 
--- a/apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts
+++ b/apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts
@@ -21,6 +21,7 @@
 } from '../runtime-revisions/runtime-signing.service';
 import {
   RuntimeDeploymentService,
+  type RuntimeDeploymentRecord,
   type RuntimeDeploymentScope,
 } from './runtime-deployment.service';
 
@@ -118,7 +119,7 @@
 }
 
 export interface DeployLatestPublishedResult {
-  deployment: { id: string } & Record<string, unknown>;
+  deployment: RuntimeDeploymentRecord;
   configurationRevisionId: string;
   agentRevisionId: string;
   manifestRevisionId: string;
--- a/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts
@@ -10,7 +10,6 @@
   actorRoles,
   RuntimeRevisionService,
   type RuntimeActor,
-  type RuntimeRevisionScope,
 } from '../runtime-revisions/runtime-revision.service';
 import {
   canPublish,
@@ -23,7 +22,10 @@
 import {
   RuntimeDesiredStateDerivationService,
 } from '../runtime-deployments/runtime-desired-state-derivation.service';
-import { RuntimeSetupV2Service } from './runtime-setup-v2.service';
+import {
+  RuntimeSetupV2Service,
+  type AppSetupPublicationState,
+} from './runtime-setup-v2.service';
 import { publishAndDeployId } from './publish-and-deploy-id';
 
 export interface PublishAndDeployResult {
@@ -232,7 +234,7 @@
       promptRevisionId: string;
       toolRevisions: Array<{ revisionId: string }>;
     },
-  ): Array<Pick<RuntimeRevisionScope, 'type' | 'revisionId'>> {
+  ): AppSetupPublicationState['revisionScopes'] {
     return [
       ...configuration.toolRevisions.map((tool) => ({
         type: 'tool' as const,
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts
@@ -465,7 +465,10 @@
       tools,
       planner: payload.planner,
       prompts: payload.prompts,
-    } as ReviewedAppSetupArtifact;
+      // The stored artifact passed appSetupArtifactSchema at upload and an
+      // override only replaces fields that schema already validated, so these
+      // records carry the reviewed shapes; the JSON column cannot say so.
+    } as unknown as ReviewedAppSetupArtifact;
   }
 
   /**
--- a/apps/api/src/modules/runtime-setup/drizzle-runtime-setup.store.ts
+++ b/apps/api/src/modules/runtime-setup/drizzle-runtime-setup.store.ts
@@ -244,7 +244,7 @@
     input: Parameters<RuntimeSetupStore['appendAudit']>[0],
   ): Promise<void> {
     const sanitized = sanitizeStandardAuditRecord({
-      actor: input.actor,
+      actor: { ...input.actor },
       payload: input.payload,
     });
     await this.db.insert(auditEvents).values({
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/tsc -p tsconfig.typecheck.json 2>&1 | grep "error TS" | grep -cE "^src/modules/runtime-(revisions|deployments|setup-v2|setup)/"
./node_modules/.bin/tsc -p tsconfig.typecheck.json 2>&1 | grep -c "error TS"
./node_modules/.bin/tsc -p tsconfig.spec.json 2>&1 | grep -c "error TS"
./node_modules/.bin/vitest run src/modules/runtime-revisions src/modules/runtime-deployments src/modules/runtime-setup 2>&1 | grep -E "Test Files|Tests "
```

Expected: `0`; `7`; `83`; `Test Files  26 passed (26)`, `Tests  271 passed (271)` (the last filter also matches `runtime-setup-v2`).

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-revisions/drizzle-runtime-revision.store.ts apps/api/src/modules/runtime-revisions/runtime-revision.controller.ts apps/api/src/modules/runtime-deployments/runtime-desired-state-derivation.service.ts apps/api/src/modules/runtime-setup-v2/publish-and-deploy.service.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.service.ts apps/api/src/modules/runtime-setup/drizzle-runtime-setup.store.ts
git commit -m "fix(runtime): repair type errors in revision and deployment flows"
```

---

### Task 11: API – fix the type errors in deferred billing, auth and asset code (7)

**Files:**
- Modify: `apps/api/src/modules/acp/acp.service.ts:283-287,416-420,593-603,740-745`, `billing/stripe.service.ts:472` (+ helper at the end of the file), `auth/auth.controller.ts:113`, `registry/generated-assets.service.ts:833`
- Test: scoped counts and the module specs

**Interfaces:**
- Consumes: `EventBatch = z.infer<typeof eventBatchSchema>` (`proctor.service.ts:33`; the parsed shape requires `tokensIn`/`tokensOut`); `Stripe.Subscription` (stripe 20.4.1 reports `current_period_end` on subscription items since API 2025-03-31); Better Auth `databaseHooks.user.create.after(user, context: GenericEndpointContext | null)`.
- Produces: module-private `subscriptionPeriodEnd(subscription: Stripe.Subscription): number` in `stripe.service.ts`.

| Error | Site | Fix |
| --- | --- | --- |
| TS2739 x4 | `acp.service.ts:283,416,593,740` | Proctor events are typed as the parsed batch; pass `tokensIn: 0, tokensOut: 0`, the values the schema defaults would produce (the aggregation queue received `undefined` before). |
| TS2339 | `stripe.service.ts:472` | Read the period end from the first item, fall back to the legacy top-level field (the existing fixture), fail loudly if neither exists instead of `new Date(NaN)`. |
| TS2322 | `auth.controller.ts:111` | Better Auth passes `null` when there is no endpoint context; accept it. |
| TS2749 | `generated-assets.service.ts:833` | The class is loaded lazily; type the variable as `InstanceType<typeof SkillLlmOptimizerService>`. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/tsc -p tsconfig.typecheck.json 2>&1 | grep "error TS" | grep -cE "^src/modules/(acp|billing|auth|registry)/"
```

Expected: `7`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/acp/acp.service.ts
+++ b/apps/api/src/modules/acp/acp.service.ts
@@ -284,6 +284,8 @@
           eventType: 'acp.addon.activated',
           payload: { addon, monthly_cost_cents: monthlyCostCents },
           actor: { source: 'mcp_agent' },
+          tokensIn: 0,
+          tokensOut: 0,
         }],
       })
       .catch((error: Error) => this.logger.warn(
@@ -417,6 +419,8 @@
           eventType: 'acp.checkout.created',
           payload: { plan: input.plan, aegisAddon: input.aegisAddon ?? false, checkoutId: row.id },
           actor: { source: 'mcp_agent' },
+          tokensIn: 0,
+          tokensOut: 0,
         }],
       })
       .catch((error: Error) => this.logger.warn(
@@ -600,6 +604,8 @@
             checkoutId: input.checkoutId,
           },
           actor: { source: 'mcp_agent' },
+          tokensIn: 0,
+          tokensOut: 0,
         }],
       })
       .catch((error: Error) => this.logger.warn(
@@ -741,6 +747,8 @@
             eventType: 'acp.account.created',
             payload: { plan: targetPlan, email: input.email, spt: !!input.sharedPaymentToken },
             actor: { source: 'mcp_agent' },
+            tokensIn: 0,
+            tokensOut: 0,
           },
         ],
       })
--- a/apps/api/src/modules/billing/stripe.service.ts
+++ b/apps/api/src/modules/billing/stripe.service.ts
@@ -469,7 +469,9 @@
     return {
       planActivated: true,
       plan,
-      nextBillingDate: new Date(subscription.current_period_end * 1000).toISOString().slice(0, 10),
+      nextBillingDate: new Date(subscriptionPeriodEnd(subscription) * 1000)
+        .toISOString()
+        .slice(0, 10),
       amountCents,
       currency: 'eur',
       subscriptionId: subscription.id,
@@ -907,3 +909,16 @@
     return null;
   }
 }
+
+/**
+ * Stripe API versions from 2025-03-31 report the billing period on each
+ * subscription item; older versions put it on the subscription itself.
+ */
+function subscriptionPeriodEnd(subscription: Stripe.Subscription): number {
+  const itemPeriodEnd = subscription.items.data[0]?.current_period_end;
+  if (typeof itemPeriodEnd === 'number') return itemPeriodEnd;
+  const legacy = (subscription as unknown as { current_period_end?: unknown })
+    .current_period_end;
+  if (typeof legacy === 'number') return legacy;
+  throw new Error('Stripe subscription carries no billing period end');
+}
--- a/apps/api/src/modules/auth/auth.controller.ts
+++ b/apps/api/src/modules/auth/auth.controller.ts
@@ -110,7 +110,7 @@
               // the session/account rows already created upstream of this hook.
               after: async (
                 createdUser: { id: string; email: string },
-                context: { body?: { workspaceName?: string } } | undefined,
+                context: { body?: { workspaceName?: string } } | null | undefined,
               ) => {
                 await runSignupAfterHook(
                   { id: createdUser.id, email: createdUser.email },
--- a/apps/api/src/modules/registry/generated-assets.service.ts
+++ b/apps/api/src/modules/registry/generated-assets.service.ts
@@ -830,7 +830,7 @@
     try {
       // Lazy-load optimizer to avoid circular dependency
       const { SkillLlmOptimizerService } = await import('../optimizer/skill-llm-optimizer.service');
-      let optimizer: SkillLlmOptimizerService | undefined;
+      let optimizer: InstanceType<typeof SkillLlmOptimizerService> | undefined;
       try {
         optimizer = this.moduleRef.get(SkillLlmOptimizerService, { strict: false });
       } catch (err) {
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/tsc -p tsconfig.typecheck.json; echo "src-exit=$?"
./node_modules/.bin/tsc -p tsconfig.spec.json 2>&1 | grep -c "error TS"
./node_modules/.bin/vitest run src/modules/acp src/modules/billing src/modules/auth src/modules/registry src/modules/proctor 2>&1 | grep -E "Test Files|Tests "
```

Expected: `src-exit=0` (no output); `76`; `Test Files  18 passed (18)`, `Tests  178 passed (178)` (`stripe-acp.spec.ts` still derives `nextBillingDate` from its top-level fixture field).

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/acp/acp.service.ts apps/api/src/modules/billing/stripe.service.ts apps/api/src/modules/auth/auth.controller.ts apps/api/src/modules/registry/generated-assets.service.ts
git commit -m "fix(api): repair type errors in deferred billing and asset modules"
```

---

### Task 12: API – fix the spec type errors in the runtime modules (39)

**Files:**
- Modify: `apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts` (19), `runtime-setup-v2.service.spec.ts` (8), `publish-and-deploy.service.spec.ts:347` (1), `apps/api/src/modules/runtime-deployments/__tests__/runtime-deployment.controller.spec.ts:21,81` (2), `runtime-deployment.service.spec.ts:24` (1), `runtime-desired-state-derivation.spec.ts:301,316,320` (3), `apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts:121` (1), `runtime-revision.service.spec.ts:37,415` (2), `apps/api/src/modules/runtime-setup/__tests__/runtime-setup.service.spec.ts:519,583` (2)
- Test: spec config count and the nine spec files

**Interfaces:** Consumes the current constructors `RuntimeSetupV2Controller(setup, configurations, publishAndDeploy, connectedOverview)`, `RuntimeDeploymentController(deployments, derivation)`; store interfaces `RuntimeDeploymentStore` (+ `findAppBindings`, `findDeploymentBindings`), `RuntimeRevisionStore` (+ `listRevisions`, `publishSet`, `publicationAuditsComplete`), `RuntimeAppSetupStore` (+ `ensureTools`, `ensureAgent`); `FoundationDraftInput` without `agentId`; `vi.mocked` (Vitest 3.2). Produces none.

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS2554 x16 | `runtime-setup-v2.controller.spec.ts` | The controller gained three collaborators; a local `controllerWith(setup)` passes `{} as never` for them. |
| TS2339 | `runtime-setup-v2.controller.spec.ts:346` | `.catch(thrown => thrown)` keeps the success type; use `.then(() => throw, thrown => thrown)`. |
| TS2698 x2 | `runtime-setup-v2.controller.spec.ts:444,471` | `dashboardTenant` is `never`; spread `(dashboardTenant as object)` like line 154 already does. |
| TS2739 x3, TS2741 | store mocks | Add the missing store methods as `vi.fn()` (the tests never reach them). |
| TS2322 x2 | `runtime-setup-v2.service.spec.ts:277,302` | Cast to the update DTO's status type, not the run record's. |
| TS2339 x4, TS7006 | `runtime-setup-v2.service.spec.ts:727-749` | Read mock calls through `vi.mocked(...)`. |
| TS7006 x4 | derivation and publish specs | Annotate callback parameters. |
| TS2554 x2 | `runtime-deployment.controller.spec.ts` | Pass the derivation collaborator. |
| TS2698 | `runtime-revision.service.spec.ts:415` | `payload` is `unknown`; spread it as `Record<string, unknown>`. |
| TS2353 x2 | `runtime-setup.service.spec.ts:519,583` | `agentId` left `FoundationDraftInput` and was ignored; drop it from the inputs (the expectation at line 468 keeps it, it is part of the result). |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/tsc -p tsconfig.spec.json 2>&1 | grep "error TS" | grep -cE "^src/modules/runtime-(setup-v2|deployments|revisions|setup)/__tests__/"
```

Expected: `39`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts
@@ -81,10 +81,18 @@
   updatedAt: '2026-07-30T10:00:00.000Z',
 };
 
+/** Controller under test with only the setup service wired. */
+const controllerWith = (setup: unknown) => new RuntimeSetupV2Controller(
+  setup as never,
+  {} as never,
+  {} as never,
+  {} as never,
+);
+
 describe('RuntimeSetupV2Controller', () => {
   it('creates a run for an app-scoped setup key', async () => {
     const createRun = vi.fn().mockResolvedValue(runView);
-    const controller = new RuntimeSetupV2Controller({ createRun } as never);
+    const controller = controllerWith({ createRun } as never);
 
     await expect(controller.createRun(
       setupKeyTenant,
@@ -100,7 +108,7 @@
 
   it('does not require or accept an environment identifier', async () => {
     const createRun = vi.fn().mockResolvedValue(runView);
-    const controller = new RuntimeSetupV2Controller({ createRun } as never);
+    const controller = controllerWith({ createRun } as never);
 
     await controller.createRun(setupKeyTenant, APP_ID, createBody);
 
@@ -114,7 +122,7 @@
 
   it('rejects a setup key outside its target-app scope', async () => {
     const createRun = vi.fn();
-    const controller = new RuntimeSetupV2Controller({ createRun } as never);
+    const controller = controllerWith({ createRun } as never);
 
     await expect(controller.createRun(
       { ...(setupKeyTenant as object), targetAppId: OTHER_APP_ID } as never,
@@ -131,7 +139,7 @@
 
   it('rejects a missing, ambiguous, or suspended principal', async () => {
     const createRun = vi.fn();
-    const controller = new RuntimeSetupV2Controller({ createRun } as never);
+    const controller = controllerWith({ createRun } as never);
 
     await expect(controller.createRun(
       { id: TENANT_ID, status: 'active' } as never,
@@ -165,7 +173,7 @@
 
   it('accepts a verified dashboard principal', async () => {
     const createRun = vi.fn().mockResolvedValue(runView);
-    const controller = new RuntimeSetupV2Controller({ createRun } as never);
+    const controller = controllerWith({ createRun } as never);
 
     await controller.createRun(dashboardTenant, APP_ID, createBody);
 
@@ -177,7 +185,7 @@
   });
 
   it('rejects identifiers that are not app or run UUIDs', async () => {
-    const controller = new RuntimeSetupV2Controller({
+    const controller = controllerWith({
       createRun: vi.fn(),
       updateStatus: vi.fn(),
     } as never);
@@ -196,7 +204,7 @@
   });
 
   it('prefers the scope denial over the identifier format for a keyed caller', async () => {
-    const controller = new RuntimeSetupV2Controller({
+    const controller = controllerWith({
       createRun: vi.fn(),
     } as never);
 
@@ -209,7 +217,7 @@
 
   it('validates the create body strictly', async () => {
     const createRun = vi.fn();
-    const controller = new RuntimeSetupV2Controller({ createRun } as never);
+    const controller = controllerWith({ createRun } as never);
 
     for (const body of [
       { ...createBody, discoveryDigest: 'sha256:short' },
@@ -228,7 +236,7 @@
 
   it('accepts bounded progress and rejects impossible progress', async () => {
     const updateStatus = vi.fn().mockResolvedValue(runView);
-    const controller = new RuntimeSetupV2Controller({ updateStatus } as never);
+    const controller = controllerWith({ updateStatus } as never);
 
     await controller.updateStatus(setupKeyTenant, APP_ID, RUN_ID, {
       status: 'assessing',
@@ -258,7 +266,7 @@
 
   it('never lets the setup transport publish a revision', async () => {
     const updateStatus = vi.fn();
-    const controller = new RuntimeSetupV2Controller({ updateStatus } as never);
+    const controller = controllerWith({ updateStatus } as never);
 
     await expect(controller.updateStatus(
       setupKeyTenant,
@@ -275,7 +283,7 @@
       status: 'review',
       artifactDigest: digest('X'),
     });
-    const controller = new RuntimeSetupV2Controller({ saveArtifact } as never);
+    const controller = controllerWith({ saveArtifact } as never);
 
     await expect(controller.putArtifact(
       setupKeyTenant,
@@ -295,7 +303,7 @@
 
   it('rejects artifacts that carry prohibited content', async () => {
     const saveArtifact = vi.fn();
-    const controller = new RuntimeSetupV2Controller({ saveArtifact } as never);
+    const controller = controllerWith({ saveArtifact } as never);
 
     for (const body of [
       { ...artifact, sourceCode: 'const a = 1;' },
@@ -328,7 +336,7 @@
   });
 
   it('reports validation field paths without echoing rejected values', async () => {
-    const controller = new RuntimeSetupV2Controller({
+    const controller = controllerWith({
       saveArtifact: vi.fn(),
     } as never);
 
@@ -340,7 +348,10 @@
         ...artifact,
         planner: { ...artifact.planner, clientSecret: 'super-secret-value' },
       },
-    ).catch((thrown: unknown) => thrown as BadRequestException);
+    ).then(
+      () => { throw new Error('expected the artifact to be rejected'); },
+      (thrown: unknown) => thrown as BadRequestException,
+    );
 
     expect(error).toBeInstanceOf(BadRequestException);
     const response = JSON.stringify(error.getResponse());
@@ -351,7 +362,7 @@
 
   it('rejects an artifact addressed to another app or run', async () => {
     const saveArtifact = vi.fn();
-    const controller = new RuntimeSetupV2Controller({ saveArtifact } as never);
+    const controller = controllerWith({ saveArtifact } as never);
 
     await expect(controller.putArtifact(
       setupKeyTenant,
@@ -371,7 +382,7 @@
   it('reads the app setup and a single run within the verified scope', async () => {
     const getLatestSetup = vi.fn().mockResolvedValue({ appId: APP_ID });
     const getRun = vi.fn().mockResolvedValue(runView);
-    const controller = new RuntimeSetupV2Controller({
+    const controller = controllerWith({
       getLatestSetup,
       getRun,
     } as never);
@@ -393,7 +404,7 @@
 
   it('fails closed when reading with an out-of-scope setup key', async () => {
     const getRun = vi.fn();
-    const controller = new RuntimeSetupV2Controller({
+    const controller = controllerWith({
       getLatestSetup: vi.fn(),
       getRun,
     } as never);
@@ -441,7 +452,7 @@
     );
 
     await expect(controller.applyConnectedUpdate(
-      { ...dashboardTenant, memberRole: 'owner' } as never,
+      { ...(dashboardTenant as object), memberRole: 'owner' } as never,
       APP_ID,
       RUN_ID,
       { environmentId: ENVIRONMENT_ID },
@@ -468,7 +479,7 @@
     );
 
     await expect(controller.applyConnectedUpdate(
-      { ...dashboardTenant, memberRole: 'owner' } as never,
+      { ...(dashboardTenant as object), memberRole: 'owner' } as never,
       APP_ID,
       RUN_ID,
       { environmentId: ENVIRONMENT_ID, reason: 'client controlled' },
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts
@@ -99,6 +99,8 @@
   generatedAt: '2026-07-30T10:00:00.000Z',
 };
 
+type UpdatableStatus = Parameters<RuntimeSetupV2Service['updateStatus']>[2]['status'];
+
 describe('RuntimeSetupV2Service', () => {
   let store: RuntimeAppSetupStore;
   let streams: { publish: ReturnType<typeof vi.fn> };
@@ -140,6 +142,8 @@
         }),
       ),
       appendAudit: vi.fn().mockResolvedValue(undefined),
+      ensureTools: vi.fn(),
+      ensureAgent: vi.fn(),
     };
     streams = { publish: vi.fn().mockResolvedValue(undefined) };
     service = new RuntimeSetupV2Service(store, streams as never);
@@ -274,7 +278,7 @@
     const result = await service.updateStatus(
       scope,
       RUN_ID,
-      { status: to as AppSetupRunRecord['status'] },
+      { status: to as UpdatableStatus },
       actor,
     );
 
@@ -299,7 +303,7 @@
     await expect(service.updateStatus(
       scope,
       RUN_ID,
-      { status: to as AppSetupRunRecord['status'] },
+      { status: to as UpdatableStatus },
       actor,
     )).rejects.toThrow(ConflictException);
     expect(store.updateRun).not.toHaveBeenCalled();
@@ -724,8 +728,8 @@
     await expect(service.markPublished(scope, RUN_ID, actor, composite))
       .resolves.toBeUndefined();
 
-    const firstAudits = store.markPublishedWithAudits.mock.calls[0][2];
-    const retryAudits = store.markPublishedWithAudits.mock.calls[1][2];
+    const firstAudits = vi.mocked(store.markPublishedWithAudits).mock.calls[0][2];
+    const retryAudits = vi.mocked(store.markPublishedWithAudits).mock.calls[1][2];
     expect(retryAudits).toEqual(firstAudits);
     expect(retryAudits.map((audit) => audit.eventType)).toEqual([
       'runtime.app_setup.published',
@@ -745,8 +749,8 @@
     await service.appendCompositeAudit(scope, actor, payload);
 
     expect(store.appendVerifiedAudit).toHaveBeenCalledTimes(2);
-    expect(store.appendVerifiedAudit.mock.calls[0][1])
-      .toEqual(store.appendVerifiedAudit.mock.calls[1][1]);
+    expect(vi.mocked(store.appendVerifiedAudit).mock.calls[0][1])
+      .toEqual(vi.mocked(store.appendVerifiedAudit).mock.calls[1][1]);
     expect(store.appendAudit).not.toHaveBeenCalled();
   });
 
--- a/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts
@@ -344,7 +344,7 @@
     expect(f.configurations.createFromReviewedSetup).toHaveBeenCalledOnce();
     expect(f.revisions.publishBatchResumable).toHaveBeenCalledTimes(2);
     expect(f.revisions.publishBatchResumable.mock.calls[1][0])
-      .toEqual(persisted.revisionScopes.map((revision) => ({
+      .toEqual(persisted.revisionScopes.map((revision: Record<string, unknown>) => ({
         ...scope,
         ...revision,
       })));
--- a/apps/api/src/modules/runtime-deployments/__tests__/runtime-deployment.controller.spec.ts
+++ b/apps/api/src/modules/runtime-deployments/__tests__/runtime-deployment.controller.spec.ts
@@ -18,7 +18,7 @@
 describe('RuntimeDeploymentController', () => {
   it('lists deployments only through the verified tenant/app/environment scope', async () => {
     const deployments = { list: vi.fn().mockResolvedValue([]) };
-    const controller = new RuntimeDeploymentController(deployments as never);
+    const controller = new RuntimeDeploymentController(deployments as never, {} as never);
 
     await controller.list(tenant, appId, environmentId);
 
@@ -78,7 +78,7 @@
 
   it('requires a server-verified dashboard actor for rollback', () => {
     const deployments = { rollback: vi.fn() };
-    const controller = new RuntimeDeploymentController(deployments as never);
+    const controller = new RuntimeDeploymentController(deployments as never, {} as never);
 
     expect(() => controller.rollback(
       { ...tenant, userId: undefined, memberRole: undefined },
--- a/apps/api/src/modules/runtime-deployments/__tests__/runtime-deployment.service.spec.ts
+++ b/apps/api/src/modules/runtime-deployments/__tests__/runtime-deployment.service.spec.ts
@@ -59,6 +59,8 @@
         healthStatus: 'healthy',
       }),
       appendAudit: vi.fn().mockResolvedValue(undefined),
+      findAppBindings: vi.fn(),
+      findDeploymentBindings: vi.fn(),
     };
     streams = { publish: vi.fn().mockResolvedValue(undefined) };
     signing = {
--- a/apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts
+++ b/apps/api/src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts
@@ -298,7 +298,7 @@
   it('uses one exact derived revision set across parallel composite deploys', async () => {
     const compositeId = '99999999-9999-4999-8999-999999999999';
     revisions.createDraftSet.mockImplementation(async (inputs) => inputs.map(
-      (input) => ({ id: input.id, type: input.type }),
+      (input: { id: string; type: string }) => ({ id: input.id, type: input.type }),
     ));
 
     await Promise.all([
@@ -313,11 +313,11 @@
     ]);
 
     const identities = revisions.createDraftSet.mock.calls.map(([inputs]) => (
-      inputs.map((input) => input.id)
+      inputs.map((input: { id: string }) => input.id)
     ));
     expect(identities[0]).toEqual(identities[1]);
     expect(identities[0]).toHaveLength(2);
-    expect(identities[0].every((id) => typeof id === 'string')).toBe(true);
+    expect(identities[0].every((id: unknown) => typeof id === 'string')).toBe(true);
     expect(revisions.publishBatchResumable).toHaveBeenCalledTimes(2);
     expect(revisions.publish).not.toHaveBeenCalled();
     expect(deployments.create).toHaveBeenCalledTimes(2);
--- a/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
+++ b/apps/api/src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts
@@ -137,6 +137,9 @@
       addApproval: vi.fn().mockResolvedValue(undefined),
       publish: vi.fn(),
       appendAudit: vi.fn().mockResolvedValue(undefined),
+      listRevisions: vi.fn().mockResolvedValue([]),
+      publishSet: vi.fn(),
+      publicationAuditsComplete: vi.fn().mockResolvedValue(true),
     };
     revisions = new RuntimeRevisionService(store, {
       sign: vi.fn(),
--- a/apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.service.spec.ts
+++ b/apps/api/src/modules/runtime-revisions/__tests__/runtime-revision.service.spec.ts
@@ -64,6 +64,7 @@
       )),
       publicationAuditsComplete: vi.fn().mockResolvedValue(true),
       appendAudit: vi.fn().mockResolvedValue(undefined),
+      listRevisions: vi.fn().mockResolvedValue([]),
     };
     service = new RuntimeRevisionService(
       store,
@@ -412,7 +413,10 @@
       id: 'previous',
       revision: 0,
       status: 'published',
-      payload: { ...baseRevision.payload, modelAlias: 'previous-model' },
+      payload: {
+        ...(baseRevision.payload as Record<string, unknown>),
+        modelAlias: 'previous-model',
+      },
     });
 
     await expect(service.publish({
--- a/apps/api/src/modules/runtime-setup/__tests__/runtime-setup.service.spec.ts
+++ b/apps/api/src/modules/runtime-setup/__tests__/runtime-setup.service.spec.ts
@@ -516,7 +516,6 @@
     ]);
 
     await service.createFoundationDrafts(scope, {
-      agentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3910',
       name: 'Get It Done',
       objective: 'Help users manage their work.',
       modelAlias: 'balanced',
@@ -580,7 +579,6 @@
     }]);
 
     await expect(service.createFoundationDrafts(scope, {
-      agentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3910',
       name: 'Get It Done',
       objective: 'Help users manage their work.',
       modelAlias: 'balanced',
PATCH
```

- [ ] **Step 3: See GREEN for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/tsc -p tsconfig.spec.json 2>&1 | grep "error TS" | grep -cE "^src/modules/runtime-(setup-v2|deployments|revisions|setup)/__tests__/"
./node_modules/.bin/tsc -p tsconfig.spec.json 2>&1 | grep -c "error TS"
./node_modules/.bin/vitest run src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.controller.spec.ts src/modules/runtime-setup-v2/__tests__/runtime-setup-v2.service.spec.ts src/modules/runtime-setup-v2/__tests__/publish-and-deploy.service.spec.ts src/modules/runtime-deployments/__tests__/runtime-deployment.controller.spec.ts src/modules/runtime-deployments/__tests__/runtime-deployment.service.spec.ts src/modules/runtime-deployments/__tests__/runtime-desired-state-derivation.spec.ts src/modules/runtime-revisions/__tests__/app-configuration.service.spec.ts src/modules/runtime-revisions/__tests__/runtime-revision.service.spec.ts src/modules/runtime-setup/__tests__/runtime-setup.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
```

Expected: `0`; `37`; `Test Files  9 passed (9)`, `Tests  148 passed (148)`.

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-setup-v2/__tests__ apps/api/src/modules/runtime-deployments/__tests__ apps/api/src/modules/runtime-revisions/__tests__ apps/api/src/modules/runtime-setup/__tests__
git commit -m "test(runtime): fix spec type errors under the api typecheck"
```

---

### Task 13: API – fix the remaining spec and script type errors (37)

**Files:**
- Modify: `apps/api/src/common/guards/__tests__/dashboard-auth.guard.spec.ts:9-10` (2), `apps/api/src/modules/acp/__tests__/acp.service.spec.ts:89-90` (2), `analytics/__tests__/analytics-latency.spec.ts` (2), `analytics/__tests__/analytics.service.spec.ts` (10), `apps/__tests__/environment-pipeline.store.spec.ts:113` (5), `apps/__tests__/runtime-environment-defaults.spec.ts:11` (1), `auth/__tests__/agent-token.controller.spec.ts:25` (2), `auth/__tests__/agent-token.service.spec.ts:15` (3), `auth/__tests__/api-key.service.spec.ts:81,113,135` (3), `registry/__tests__/generated-assets.service.spec.ts:67,182-184` (4), `apps/api/scripts/verify-connected-free-rehearsal.ts:222,369-377` (3)
- Test: `bun run typecheck` and the ten spec files

**Interfaces:** Consumes `AnalyticsService(db, redis)`, `AppsService(db, entitlement, environmentPipeline)`, `GeneratedAssetsService(db, r2, moduleRef)`, `ApiKeyService(db, redis, databaseTransport: 'neon-http' | 'neon-websocket' | 'postgres')`, `runtimeDeployments.rolledBackFromId`/`configRevisionId` columns. Produces none.

| Error | Sites | Fix pattern |
| --- | --- | --- |
| TS2538 x2 | `dashboard-auth.guard.spec.ts:226,328` | The request is indexed by the `TENANT_CONTEXT` symbol; type it `Record<string \| symbol, unknown>`. |
| TS2322 x2 | `acp.service.spec.ts:278-279` | The fixture's `null` fields are overridden with strings; type them `string \| null`. |
| TS2554 x14 | analytics (12), apps (1), registry (1) specs | Constructors gained collaborators the tested methods never touch; pass `{} as never`. |
| TS2783 x5 | `environment-pipeline.store.spec.ts:97-112` | `input as State` claimed every key; spread `structuredClone(input)` as the partial it is. |
| TS2339 x5 | agent-token specs | Declare `introspect`/`verify` in the mock factories (the tests assign them later). |
| TS2353 x3 | `api-key.service.spec.ts` | `env` was removed from `ApiKeyCreateInput` and ignored; drop it. |
| TS18046 x3 | `generated-assets.service.spec.ts:182-184` | `config` is `unknown`; narrow it once. |
| TS2554, TS2339 x2 | `verify-connected-free-rehearsal.ts` | Pass the script's transport `'neon-websocket'`; read `rolledBackFromId`/`configRevisionId` from the persisted row instead of the narrow return type. The import.meta errors (TS1343) disappear under `tsconfig.spec.json`. |

- [ ] **Step 1: See RED for this area**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/tsc -p tsconfig.spec.json 2>&1 | grep -c "error TS"
```

Expected: `37`.

- [ ] **Step 2: Apply the fix**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/common/guards/__tests__/dashboard-auth.guard.spec.ts
+++ b/apps/api/src/common/guards/__tests__/dashboard-auth.guard.spec.ts
@@ -6,8 +6,8 @@
 function createMockExecutionContext(
   cookies: Record<string, string> = {},
   headers: Record<string, string> = {},
-): { ctx: ExecutionContext; request: Record<string, unknown> } {
-  const request: Record<string, unknown> = { headers, cookies };
+): { ctx: ExecutionContext; request: Record<string | symbol, unknown> } {
+  const request: Record<string | symbol, unknown> = { headers, cookies };
   const handler = vi.fn();
 
   const ctx = {
--- a/apps/api/src/modules/acp/__tests__/acp.service.spec.ts
+++ b/apps/api/src/modules/acp/__tests__/acp.service.spec.ts
@@ -86,8 +86,8 @@
   aegisAddon: false,
   currency: 'eur',
   amountCents: 4900,
-  buyerEmail: null,
-  buyerName: null,
+  buyerEmail: null as string | null,
+  buyerName: null as string | null,
   stripeSubscriptionId: null,
   stripePaymentMethodId: null,
   expiresAt: new Date(Date.now() + 86400000),
--- a/apps/api/src/modules/analytics/__tests__/analytics-latency.spec.ts
+++ b/apps/api/src/modules/analytics/__tests__/analytics-latency.spec.ts
@@ -19,7 +19,7 @@
       { tool: 'create-invoice', p50: 25, p95: 80, p99: 200, calls: 50 },
     ];
     const db = createMockDb(mockRows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getLatencies('tenant-1', '2026-03-01', '2026-03-15');
     expect(result).toEqual({ buckets: mockRows });
@@ -30,7 +30,7 @@
       { date: '2026-03-10', p50: 15, p95: 50, p99: 150, calls: 200 },
     ];
     const db = createMockDb(mockRows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getLatencies('tenant-1', '2026-03-10', '2026-03-10', 'day');
     expect(result).toEqual({ buckets: mockRows });
--- a/apps/api/src/modules/analytics/__tests__/analytics.service.spec.ts
+++ b/apps/api/src/modules/analytics/__tests__/analytics.service.spec.ts
@@ -32,7 +32,7 @@
       { date: '2026-03-11', calls: 23 },
     ];
     const db = createMockDb(mockRows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getUsage('tenant-1', '2026-03-10', '2026-03-11', 'day');
 
@@ -50,7 +50,7 @@
       { tool: 'create-invoice', tokensIn: 300, tokensOut: 800, calls: 5 },
     ];
     const db = createMockDb(mockRows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getTokens('tenant-1', '2026-03-01', '2026-03-15', 'tool');
 
@@ -64,7 +64,7 @@
 
   it('returns empty buckets when no data', async () => {
     const db = createMockDb([]);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const usage = await service.getUsage('tenant-1', '2026-03-01', '2026-03-01', 'day');
     const tokens = await service.getTokens('tenant-1', '2026-03-01', '2026-03-01', 'tool');
@@ -81,7 +81,7 @@
     const db = createMockDb(rows);
     // getTokenTrend uses db.execute() (raw SQL with generate_series)
     (db as any).execute = vi.fn().mockResolvedValue({ rows });
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getTokenTrend('tenant-1', '2026-03-25', '2026-03-31');
 
@@ -93,7 +93,7 @@
   it('getTokenTrend() returns empty buckets when no data', async () => {
     const db = createMockDb([]);
     (db as any).execute = vi.fn().mockResolvedValue({ rows: [] });
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getTokenTrend('tenant-1', '2026-03-25', '2026-03-31');
 
@@ -106,7 +106,7 @@
       { tool: 'gpt-4o', tokensIn: 3000, tokensOut: 1000, calls: 30 },
     ];
     const db = createMockDb(rows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getTokens('tenant-1', '2026-03-25', '2026-03-31', 'model');
 
@@ -121,7 +121,7 @@
       { id: 'get_orders', tokensIn: 3000, tokensOut: 1000, calls: 30, avgP50: 150 },
     ];
     const db = createMockDb(rows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getBreakdown('tenant-1', '2026-03-25', '2026-03-31', 'tool');
 
@@ -137,7 +137,7 @@
       { id: 'claude-sonnet-4-6', tokensIn: 8000, tokensOut: 3000, calls: 100, avgP50: 180 },
     ];
     const db = createMockDb(rows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getBreakdown('tenant-1', '2026-03-25', '2026-03-31', 'model');
 
@@ -150,7 +150,7 @@
       { id: 'agent-abc', tokensIn: 4000, tokensOut: 1500, calls: 40, avgP50: 220 },
     ];
     const db = createMockDb(rows);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getBreakdown('tenant-1', '2026-03-25', '2026-03-31', 'agent');
 
@@ -162,7 +162,7 @@
 
   it('getBreakdown() returns empty entities when no data', async () => {
     const db = createMockDb([]);
-    const service = new AnalyticsService(db as any);
+    const service = new AnalyticsService(db as any, {} as never);
 
     const result = await service.getBreakdown('tenant-1', '2026-03-25', '2026-03-31', 'tool');
 
--- a/apps/api/src/modules/apps/__tests__/environment-pipeline.store.spec.ts
+++ b/apps/api/src/modules/apps/__tests__/environment-pipeline.store.spec.ts
@@ -110,7 +110,7 @@
       healthStatus: 'healthy',
     }],
     audits: [],
-    ...cloneState(input as State),
+    ...structuredClone(input),
   };
   let transactionTail = Promise.resolve();
   let activeTransactions = 0;
--- a/apps/api/src/modules/apps/__tests__/runtime-environment-defaults.spec.ts
+++ b/apps/api/src/modules/apps/__tests__/runtime-environment-defaults.spec.ts
@@ -8,7 +8,7 @@
         id: 'app-1', name: 'Get It Done', environments: [],
       }),
     };
-    const service = new AppsService({} as never, entitlement as never);
+    const service = new AppsService({} as never, entitlement as never, {} as never);
 
     await expect(service.create('tenant-1', { name: 'Get It Done' }))
       .resolves.toEqual(expect.objectContaining({ environments: [] }));
--- a/apps/api/src/modules/auth/__tests__/agent-token.controller.spec.ts
+++ b/apps/api/src/modules/auth/__tests__/agent-token.controller.spec.ts
@@ -23,6 +23,7 @@
 function createMockTokenService() {
   return {
     issueToken: vi.fn().mockResolvedValue(MOCK_TOKEN_RESULT),
+    introspect: vi.fn(),
   };
 }
 
--- a/apps/api/src/modules/auth/__tests__/agent-token.service.spec.ts
+++ b/apps/api/src/modules/auth/__tests__/agent-token.service.spec.ts
@@ -13,6 +13,7 @@
 function createMockJwtService() {
   return {
     sign: vi.fn().mockResolvedValue('mock.jwt.token'),
+    verify: vi.fn(),
   };
 }
 
--- a/apps/api/src/modules/auth/__tests__/api-key.service.spec.ts
+++ b/apps/api/src/modules/auth/__tests__/api-key.service.spec.ts
@@ -78,7 +78,6 @@
       const result = await service.create('tenant-1', {
         label: 'My Key',
         scopes: ['management'],
-        env: 'live',
       });
 
       expect(result.id).toBe('key-uuid-1');
@@ -110,7 +109,6 @@
 
       const result = await service.create('tenant-1', {
         scopes: ['runtime:execute'],
-        env: 'test',
       });
 
       expect(result.plaintext).toMatch(/^gl_[a-zA-Z0-9]+/);
@@ -132,7 +130,6 @@
 
       const result = await service.create('tenant-1', {
         scopes: ['management'],
-        env: 'live',
       });
 
       // Verify the stored data does NOT contain the plaintext
--- a/apps/api/src/modules/registry/__tests__/generated-assets.service.spec.ts
+++ b/apps/api/src/modules/registry/__tests__/generated-assets.service.spec.ts
@@ -64,7 +64,7 @@
 
   beforeEach(() => {
     mockDb = createMockDb();
-    service = new GeneratedAssetsService(mockDb as any);
+    service = new GeneratedAssetsService(mockDb as any, {} as never, {} as never);
   });
 
   describe('syncAsset', () => {
@@ -179,9 +179,10 @@
         keyEnvVar: 'CRM_KEY',
       });
 
-      expect(result.config.appName).toBe('My CRM');
-      expect(result.config.baseUrl).toBe('http://localhost:3030');
-      expect(result.config.auth).toEqual({ headerName: 'X-API-Key', keyEnvVar: 'CRM_KEY' });
+      const config = result.config as { appName: string; baseUrl: string; auth: unknown };
+      expect(config.appName).toBe('My CRM');
+      expect(config.baseUrl).toBe('http://localhost:3030');
+      expect(config.auth).toEqual({ headerName: 'X-API-Key', keyEnvVar: 'CRM_KEY' });
     });
 
     it('should throw 404 when asset not found', async () => {
--- a/apps/api/scripts/verify-connected-free-rehearsal.ts
+++ b/apps/api/scripts/verify-connected-free-rehearsal.ts
@@ -219,7 +219,7 @@
         const pipeline = new EnvironmentPipelineService(new DrizzleEnvironmentPipelineStore(tx), publish);
         const entitlements = new PlatformEntitlementService(tx);
         const apps = new AppsService(tx, entitlements, pipeline);
-        const keys = new ApiKeyService(tx, redis);
+        const keys = new ApiKeyService(tx, redis, 'neon-websocket');
         const connect = new RuntimeConnectService(new DrizzleRuntimeConnectStore(tx, keys), apps, entitlements, { get: (_key: string, fallback: string) => fallback } as never, redis);
         const connections = new RuntimeConnectionService(new DrizzleRuntimeConnectionStore(tx, signing));
         await tx.insert(tenants).values({ id: IDS.tenant, name: 'Connected rehearsal', slug: 'connected-rehearsal-019fb4a0', plan: 'free' });
@@ -366,12 +366,14 @@
           && verifySignedEnvelope(signing, revocationBundle.revocations[0]),
         'signed revocation was not persisted and delivered');
         const rolledBack = await deployments.rollback(secondScope, promoted.deploymentId, actor);
+        const [rolledBackRow] = await tx.select().from(runtimeDeployments)
+          .where(eq(runtimeDeployments.id, rolledBack.id));
         invariant(
-          rolledBack.rolledBackFromId === disabledActive.deploymentId,
+          rolledBackRow?.rolledBackFromId === disabledActive.deploymentId,
           'rollback did not link the independently superseding deployment',
         );
         invariant(
-          rolledBack.configRevisionId === targetRow.configRevisionId,
+          rolledBackRow?.configRevisionId === targetRow.configRevisionId,
           'rollback did not restore the complete app binding',
         );
 
PATCH
```

- [ ] **Step 3: See the whole gate GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
time bun run typecheck; echo "exit=$?"
./node_modules/.bin/vitest run src/common/guards/__tests__/dashboard-auth.guard.spec.ts src/modules/acp/__tests__/acp.service.spec.ts src/modules/analytics/__tests__/analytics-latency.spec.ts src/modules/analytics/__tests__/analytics.service.spec.ts src/modules/apps/__tests__/environment-pipeline.store.spec.ts src/modules/apps/__tests__/runtime-environment-defaults.spec.ts src/modules/auth/__tests__/agent-token.controller.spec.ts src/modules/auth/__tests__/agent-token.service.spec.ts src/modules/auth/__tests__/api-key.service.spec.ts src/modules/registry/__tests__/generated-assets.service.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
L="$(mktemp -d)"; cd ../.. && bun run typecheck > "$L/turbo.log" 2>&1; echo "root-exit=$?"; grep "Tasks:" "$L/turbo.log"
```

Expected: only the `$ tsc -p tsconfig.typecheck.json && tsc -p tsconfig.spec.json` echo line, `exit=0`, well under the two-minute budget (11-30 s measured, depending on machine load); `Test Files  10 passed (10)`, `Tests  118 passed (118)`; full API suite unchanged at `Test Files  114 passed (114)`, `Tests  1130 passed | 10 skipped (1140)`; `root-exit=0`, `Tasks:    3 successful, 3 total` (DB build, API and Citadel typecheck).

- [ ] **Step 4: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/common/guards/__tests__/dashboard-auth.guard.spec.ts apps/api/src/modules/acp/__tests__/acp.service.spec.ts apps/api/src/modules/analytics/__tests__ apps/api/src/modules/apps/__tests__/environment-pipeline.store.spec.ts apps/api/src/modules/apps/__tests__/runtime-environment-defaults.spec.ts apps/api/src/modules/auth/__tests__ apps/api/src/modules/registry/__tests__/generated-assets.service.spec.ts apps/api/scripts/verify-connected-free-rehearsal.ts
git commit -m "test(api): fix remaining spec and script type errors"
```

From here on every task that touches the API runs `bun run typecheck` in its GREEN step.

---

### Task 14: Citadel – ESLint flat config with a recorded debt baseline

**Files:**
- Create: `apps/citadel/eslint.config.mjs`
- Create (generated by ESLint, never hand-edited): `apps/citadel/eslint-suppressions.json`
- Modify: `apps/citadel/package.json` (`bun add -d` sorts `devDependencies`; line 10 `"lint"`), `bun.lock`
- Test: `bun run lint` and the probes in Step 6

**Interfaces:** Consumes `FlatCompat({ baseDirectory, resolvePluginsRelativeTo })` from `@eslint/eslintrc` 3.3.5 (the copy ESLint 9.39.4 already depends on), `globalIgnores` from `eslint/config`, the legacy presets `next/core-web-vitals` and `next/typescript` of `eslint-config-next` 15.5.14 (Next 15.5.14). Produces the `lint` script.

There is no ESLint config, and `next lint` would start an interactive setup, so it is never run. `eslint-config-next` 15 only ships eslintrc presets; `FlatCompat` is the documented bridge. Bun's isolated install keeps the presets' plugins (`eslint-plugin-react-hooks`, `@next/eslint-plugin-next`, ...) next to `eslint-config-next` in `node_modules/.bun`, not in Citadel's `node_modules`, so without `resolvePluginsRelativeTo` ESLint fails with `couldn't find the plugin "eslint-plugin-react-hooks"`. `mcp-server/` is its own package (excluded from `tsconfig.json` too) and `src/generated/**` is codegen output. Like P01 Task 8 for Get It Done, the existing debt (10 `no-explicit-any` errors in 5 files) is recorded with bulk suppressions so new violations still fail; warnings do not fail the gate. ESLint does not apply bulk suppressions in `--stdin` mode, so the per-file count ratchet is probed by editing a tracked file and restoring it from a copy outside the repository.

- [ ] **Step 1: See RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel
L="$(mktemp -d)"; ./node_modules/.bin/eslint . > "$L/lint.log" 2>&1; echo "exit=$?"; grep "couldn't find" "$L/lint.log"
```

Expected: `exit=2` and `ESLint couldn't find an eslint.config.(js|mjs|cjs) file.`

- [ ] **Step 2: Add the eslintrc bridge**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel
bun add -d @eslint/eslintrc@3.3.5
cd ../.. && git diff --stat
node -e 'const d=require("./apps/citadel/package.json").devDependencies;console.log(JSON.stringify(d))'
```

Expected (measured in a copy): `apps/citadel/package.json | 13 +++++++------`, `bun.lock | 1 +`; the devDependencies are exactly `{"@eslint/eslintrc":"3.3.5","@tailwindcss/postcss":"^4.0.0","@types/node":"^22.0.0","@types/react":"^19.0.0","@types/react-dom":"^19.0.0","eslint":"^9.0.0","eslint-config-next":"^15.2.0","postcss":"^8.5.0","tailwindcss":"^4.0.0","typescript":"^5.7.0","vitest":"^3.0.0"}` (bun sorted the block; only the first entry is new).

- [ ] **Step 3: Create `apps/citadel/eslint.config.mjs`**

```js
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import { globalIgnores } from "eslint/config";

const require = createRequire(import.meta.url);

// eslint-config-next 15 ships legacy (eslintrc) presets. Bun's isolated
// install keeps their plugins next to eslint-config-next instead of in this
// app's node_modules, so plugins resolve relative to that package.
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
  resolvePluginsRelativeTo: dirname(require.resolve("eslint-config-next/package.json")),
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  globalIgnores([
    ".next/**", "out/**", "build/**", "next-env.d.ts",
    "mcp-server/**", "src/generated/**",
  ]),
];

export default eslintConfig;
```

- [ ] **Step 4: Set the lint script and see the debt**

The script is read-only lint: a lint run never rewrites the suppressions file. `bun add` in Step 2 re-sorted only the dependency blocks, so the scripts block still matches this patch.

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/citadel/package.json
+++ b/apps/citadel/package.json
@@ -7,7 +7,7 @@
     "build": "next build",
     "test": "vitest run",
     "start": "next start",
-    "lint": "next lint",
+    "lint": "eslint .",
     "typecheck": "tsc --noEmit",
     "ai:generate-tools": "agentic generate-tools",
     "ai:validate": "agentic validate-tools",
PATCH
cd apps/citadel
L="$(mktemp)"; bun run lint > "$L" 2>&1; echo "exit=$?"; grep "problems" "$L"
```

Expected: `exit=1`; `✖ 40 problems (10 errors, 30 warnings)`.

- [ ] **Step 5: Record the baseline and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel
./node_modules/.bin/eslint . --suppress-all > /dev/null 2>&1; echo "suppress-exit=$?"
node -e 'const j=require("./eslint-suppressions.json");let n=0;for(const f in j)for(const r in j[f])n+=j[f][r].count;console.log(Object.keys(j).length,"files",n,"suppressed")'
L="$(mktemp)"; bun run lint > "$L" 2>&1; echo "exit=$?"; grep "problems" "$L"
```

Expected: `suppress-exit=0`; `5 files 10 suppressed` (`src/app/(auth)/register/page.tsx` 1, `src/app/(dashboard)/audit-stream/page.tsx` 3, `src/app/(dashboard)/dashboard/page.tsx` 1, `src/app/(dashboard)/modules/[moduleId]/page.tsx` 4, `src/app/api/openrouter-models/route.ts` 1, all `@typescript-eslint/no-explicit-any`); `exit=0` and `✖ 30 problems (0 errors, 30 warnings)`.

- [ ] **Step 6: Prove a new violation still fails (no probe file is created)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel
# (a) a violation in a new file, linted from stdin
printf 'export const lintProbe = (value: any) => value;\n' | ./node_modules/.bin/eslint --stdin --stdin-filename src/lib/lint-probe.ts; echo "new-file-exit=$?"
test ! -e src/lib/lint-probe.ts && echo "no-probe-file"
# (b) one more occurrence of a suppressed rule in a suppressed file
F='src/app/(auth)/register/page.tsx'
B="$(mktemp -d)"
git diff --quiet -- "$F" && node -e 'console.log(require("./eslint-suppressions.json")[process.argv[1]]["@typescript-eslint/no-explicit-any"].count)' "$F"
cp "$F" "$B/page.tsx"
printf '\nexport const lintProbe = (value: any) => value;\n' >> "$F"
./node_modules/.bin/eslint "$F" > "$B/lint.log"; echo "suppressed-file-exit=$?"; grep problems "$B/lint.log"
cp "$B/page.tsx" "$F"
git diff --quiet -- "$F" && echo restored
git status --short
```

Expected: (a) `1:34  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any`, `new-file-exit=1`, `no-probe-file`; (b) `1`, then `suppressed-file-exit=1` and `✖ 3 problems (2 errors, 1 warning)` (the recorded `any` at line 98 is reported again because the file now exceeds its count, plus the new one at line 267), `restored`; status exactly ` M package.json`, ` M ../../bun.lock`, `?? eslint-suppressions.json`, `?? eslint.config.mjs` (git orders by repository path).

- [ ] **Step 7: Citadel still type-checks and tests green**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel
./node_modules/.bin/tsc --noEmit; echo "tsc=$?"
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
```

Expected: `tsc=0`; `Test Files  38 passed (38)`, `Tests  250 passed (250)`.

- [ ] **Step 8: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/citadel/eslint.config.mjs apps/citadel/eslint-suppressions.json apps/citadel/package.json bun.lock
git commit -m "build(lint): add an eslint flat config with a debt baseline for citadel"
```

To pay the debt down later: fix violations, run `./node_modules/.bin/eslint . --prune-suppressions` and commit the smaller file (never `--suppress-all` again without review).

---
### Task 15: API – gate app-bound API keys by route metadata

**Files:**
- Create: `apps/api/src/common/decorators/app-scope.decorator.ts`
- Modify: `apps/api/src/common/__tests__/api-key.guard.spec.ts:1-5` (imports) and a new `describe` at the end, `apps/api/src/common/guards/api-key.guard.ts:15,186-197,203`
- Test: `apps/api/src/common/__tests__/api-key.guard.spec.ts`

**Interfaces:**
- Consumes: `Reflector.getAllAndOverride(key, [handler, class])`; `TenantContext { apiKeyId?; scopes: string[]; targetAppId?; userId? }` (`common/types.ts`); `@RequireScopes(...)` keeps its all-of semantics.
- Produces: `TENANT_WIDE_ONLY = 'tenant_wide_only'`, `TenantWideOnly()`, `APP_SCOPED_RUNTIME_KEY = 'app_scoped_runtime_key'`, `AllowAppScopedRuntimeKey()`; `ApiKeyGuard` rules: (1) when a key lacks the required scopes, it still passes if the route carries `APP_SCOPED_RUNTIME_KEY` and the key has `runtime` and a `targetAppId`; (2) a key with `targetAppId` is refused (403) on any route carrying `TENANT_WIDE_ONLY`. Dashboard sessions are untouched (`CompositeAuthGuard` only delegates bearer and `x-api-key` requests to `ApiKeyGuard`).

- [ ] **Step 1: Write the failing tests (the metadata module carries no behaviour)**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/common/decorators/app-scope.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

/**
 * Tenant administration (API keys, members, app creation). An API key bound
 * to one app never reaches these routes, whatever scopes it carries.
 */
export const TENANT_WIDE_ONLY = 'tenant_wide_only';
export const TenantWideOnly = () => SetMetadata(TENANT_WIDE_ONLY, true);

/**
 * App-bound setup writes that a connected runtime key may make although the
 * route otherwise requires management. Only a key that carries `runtime` and
 * is bound to an app qualifies; the handler still has to compare that app
 * with the app in the path.
 */
export const APP_SCOPED_RUNTIME_KEY = 'app_scoped_runtime_key';
export const AllowAppScopedRuntimeKey = () =>
  SetMetadata(APP_SCOPED_RUNTIME_KEY, true);
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/common/__tests__/api-key.guard.spec.ts
+++ b/apps/api/src/common/__tests__/api-key.guard.spec.ts
@@ -2,6 +2,10 @@
 import { ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
 import { Reflector } from '@nestjs/core';
 import { ApiKeyGuard } from '../guards/api-key.guard';
+import {
+  APP_SCOPED_RUNTIME_KEY,
+  TENANT_WIDE_ONLY,
+} from '../decorators/app-scope.decorator';
 import { TENANT_CONTEXT } from '../types';
 
 function createMockExecutionContext(headers: Record<string, string> = {}, metadata?: Record<string, unknown>): ExecutionContext {
@@ -433,3 +437,83 @@
     expect(result).toBe(true);
   });
 });
+
+describe('ApiKeyGuard app-scoped keys', () => {
+  const key = 'gl_abcdefghijklmnopqrstuvwxyz0123456789AB';
+
+  function guardFor(
+    apiKey: { scopes: string[]; targetAppId: string | null },
+    metadata: Record<string, unknown>,
+  ) {
+    const row = [{
+      api_keys: {
+        id: 'key-1',
+        tenantId: 'tenant-1',
+        keyHash: 'hash',
+        scopes: apiKey.scopes,
+        targetAppId: apiKey.targetAppId,
+        revokedAt: null,
+        expiresAt: null,
+        lastUsedAt: null,
+      },
+      tenants: { id: 'tenant-1', slug: 'acme', plan: 'free', status: 'active' },
+    }];
+    const db = {
+      select: vi.fn(() => ({
+        from: () => ({ innerJoin: () => ({ where: vi.fn().mockResolvedValue(row) }) }),
+      })),
+    };
+    const redis = {
+      get: vi.fn().mockResolvedValue(null),
+      set: vi.fn().mockResolvedValue('OK'),
+      zadd: vi.fn().mockResolvedValue(1),
+    };
+    const reflector = {
+      getAllAndOverride: vi.fn((name: string) => metadata[name]),
+    } as unknown as Reflector;
+    return new ApiKeyGuard(db as never, redis as never, reflector);
+  }
+
+  const request = () => createMockExecutionContext({ authorization: `Bearer ${key}` });
+
+  it('lets an app-scoped runtime key reach a route that allows it in place of management', async () => {
+    const guard = guardFor(
+      { scopes: ['runtime'], targetAppId: 'app-1' },
+      { required_scopes: ['management'], [APP_SCOPED_RUNTIME_KEY]: true },
+    );
+
+    await expect(guard.canActivate(request())).resolves.toBe(true);
+  });
+
+  it('still demands the route scopes from a runtime key that is not bound to an app', async () => {
+    const guard = guardFor(
+      { scopes: ['runtime'], targetAppId: null },
+      { required_scopes: ['management'], [APP_SCOPED_RUNTIME_KEY]: true },
+    );
+
+    await expect(guard.canActivate(request())).rejects.toThrow(ForbiddenException);
+  });
+
+  it('keeps every other management route closed to an app-scoped runtime key', async () => {
+    const guard = guardFor(
+      { scopes: ['runtime'], targetAppId: 'app-1' },
+      { required_scopes: ['management'] },
+    );
+
+    await expect(guard.canActivate(request())).rejects.toThrow(ForbiddenException);
+  });
+
+  it('keeps app-scoped keys out of tenant administration even with management scope', async () => {
+    const appScoped = guardFor(
+      { scopes: ['management'], targetAppId: 'app-1' },
+      { required_scopes: ['management'], [TENANT_WIDE_ONLY]: true },
+    );
+    const tenantWide = guardFor(
+      { scopes: ['management'], targetAppId: null },
+      { required_scopes: ['management'], [TENANT_WIDE_ONLY]: true },
+    );
+
+    await expect(appScoped.canActivate(request())).rejects.toThrow(ForbiddenException);
+    await expect(tenantWide.canActivate(request())).resolves.toBe(true);
+  });
+});
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/common/__tests__/api-key.guard.spec.ts 2>&1 | grep -E "×|Tests "
```

Expected: `Tests  2 failed | 17 passed (19)`: "lets an app-scoped runtime key reach a route that allows it in place of management" (`ForbiddenException: Insufficient scopes`) and "keeps app-scoped keys out of tenant administration even with management scope" (resolves instead of rejecting). The two pins for unchanged behaviour already pass.

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/common/guards/api-key.guard.ts
+++ b/apps/api/src/common/guards/api-key.guard.ts
@@ -13,6 +13,10 @@
 import { type Database } from '@glirastes/db';
 import { apiKeys, tenants } from '@glirastes/db';
 import { TENANT_CONTEXT, type TenantContext } from '../types';
+import {
+  APP_SCOPED_RUNTIME_KEY,
+  TENANT_WIDE_ONLY,
+} from '../decorators/app-scope.decorator';
 
 // Accepts new format (gl_<random>) and legacy format (gl_live_<random>, cm_live_<random>)
 const API_KEY_PATTERN = /^(gl|cm)_([a-zA-Z0-9_]{32,})$/;
@@ -191,9 +195,17 @@
 
     if (requiredScopes && requiredScopes.length > 0) {
       const hasAll = requiredScopes.every((s) => tenantContext.scopes.includes(s));
-      if (!hasAll) {
+      if (!hasAll && !this.isAllowedAppScopedRuntimeKey(context, tenantContext)) {
         throw new ForbiddenException('Insufficient scopes');
       }
+    }
+
+    // Tenant administration is never reachable with a key bound to one app.
+    if (tenantContext.targetAppId && this.reflector.getAllAndOverride<boolean | undefined>(
+      TENANT_WIDE_ONLY,
+      [context.getHandler(), context.getClass()],
+    )) {
+      throw new ForbiddenException('App-scoped API keys cannot administer the tenant');
     }
 
     // Fire-and-forget: track lastUsedAt in Redis sorted set
@@ -201,4 +213,21 @@
 
     return true;
   }
+
+  /**
+   * A route may accept a connected runtime key in place of its required
+   * scopes. Only a key that carries `runtime` and is bound to an app
+   * qualifies; the handler compares that app with the requested one.
+   */
+  private isAllowedAppScopedRuntimeKey(
+    context: ExecutionContext,
+    tenant: TenantContext,
+  ): boolean {
+    return this.reflector.getAllAndOverride<boolean | undefined>(
+      APP_SCOPED_RUNTIME_KEY,
+      [context.getHandler(), context.getClass()],
+    ) === true
+      && tenant.scopes.includes('runtime')
+      && typeof tenant.targetAppId === 'string';
+  }
 }
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/common 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  9 passed (9)`, `Tests  64 passed (64)` (the guard file `19 passed`); `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/common/decorators/app-scope.decorator.ts apps/api/src/common/guards/api-key.guard.ts apps/api/src/common/__tests__/api-key.guard.spec.ts
git commit -m "feat(auth): gate app-scoped api keys by route metadata"
```

---

### Task 16: API – keep app-bound keys inside their own app

**Files:**
- Create: `apps/api/src/common/__tests__/app-scope-wiring.spec.ts`
- Modify: `apps/api/src/modules/apps/__tests__/apps.controller.spec.ts:1` and a new `describe` at the end; `apps/api/src/modules/apps/apps.controller.ts:7-10,16,53-56,70-84,100,370-382`; `apps/api/src/modules/auth/api-key.controller.ts:15,41-44`; `apps/api/src/modules/auth/tenant.controller.ts:15,38-41`; `apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts:16,72,82,94,213`
- Test: the wiring spec and the `/v1/apps` controller spec

**Interfaces:** Consumes Task 15's decorators. Produces: `GET /v1/apps` returns only `tenant.targetAppId`'s app for an app-bound key; `GET /v1/apps/:appId`, `GET /v1/apps/:appId/environments`, `PATCH /v1/apps/:appId` answer `404 App not found` for any other app; `POST /v1/apps`, every `ApiKeyController` route (`/v1/tenant/api-keys`) and every `TenantController` route (tenant, usage, team; the read-only `BillingController` usage routes that share the `/v1/tenant` prefix are not tenant administration and stay as they are) are `TenantWideOnly`; the four setup-credential routes carry `AllowAppScopedRuntimeKey`.

Gap before this task (proved by Step 1): every management key, including the one-day app-bound setup credential and today's pairing key, can list and read every app of the tenant, create and rename apps (`allowedRoles` on `@AiTool` is metadata for the AI tool catalogue, not enforcement), and mint a tenant-wide key through `/v1/tenant/api-keys`, which defeats any per-route app check.

Endpoint map for the connected CLI and runtime (SDK `foundation-runtime-v1`, read on 2026-10-04), with the key issued from Task 17 on (`['runtime']`, bound to the app):

| Caller | Route | Required today | After Tasks 15-17 |
| --- | --- | --- | --- |
| Managed runtime (`sync/control-plane-client.ts`, `managed-sync.ts`) | `POST/GET /v1/runtime/apps/:appId/environments/:environmentId/runners/{register,heartbeat,sync,stream}` | `runtime` | allowed, unchanged |
| Managed runtime (`sync/jwks-provider.ts`) | `GET /v1/runtime-revisions/jwks` | `runtime` | allowed, unchanged |
| `glirastes sync`, `setup sync` (`AppSetupClient.createRun`, `uploadArtifact`) | `POST /v2/apps/:appId/runtime-setup/runs`, `PUT .../runs/:runId/artifact` | `management` | allowed through `AllowAppScopedRuntimeKey`, controller still requires `targetAppId === :appId` |
| `glirastes setup status` (`AppSetupClient.getRun`) | `GET .../runs/:runId` | `management` | same |
| `AppSetupClient.updateStatus` (public SDK client) | `PATCH .../runs/:runId/status` | `management` | same |
| `glirastes connect` | `/v1/runtime-connect/pairings` and `/token` | public, rate-limited | unchanged |
| Overrides, publish, apply, overview, every other management route | various | `management` (+ dashboard user) | 403 for the pairing key |

- [ ] **Step 1: Write the failing tests (they prove the gap)**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/common/__tests__/app-scope-wiring.spec.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_SCOPED_RUNTIME_KEY,
  TENANT_WIDE_ONLY,
} from '../decorators/app-scope.decorator';
import { AppsController } from '../../modules/apps/apps.controller';
import { ApiKeyController } from '../../modules/auth/api-key.controller';
import { TenantController } from '../../modules/auth/tenant.controller';
import { RuntimeSetupV2Controller } from '../../modules/runtime-setup-v2/runtime-setup-v2.controller';

const metadata = (key: string, target: object) => Reflect.getMetadata(key, target);

describe('app-scoped key wiring', () => {
  it('keeps app-scoped keys out of tenant administration', () => {
    expect(metadata(TENANT_WIDE_ONLY, ApiKeyController)).toBe(true);
    expect(metadata(TENANT_WIDE_ONLY, TenantController)).toBe(true);
    expect(metadata(TENANT_WIDE_ONLY, AppsController.prototype.create)).toBe(true);
  });

  it('accepts a connected runtime key exactly on the app setup credential routes', () => {
    const accepting = Object.getOwnPropertyNames(RuntimeSetupV2Controller.prototype)
      .filter((name) => name !== 'constructor')
      .filter((name) => metadata(
        APP_SCOPED_RUNTIME_KEY,
        (RuntimeSetupV2Controller.prototype as unknown as Record<string, object>)[name],
      ) === true)
      .sort();

    expect(accepting).toEqual(['createRun', 'getRun', 'putArtifact', 'updateStatus']);
  });

  it('uses the runtime-key exception nowhere else in the API sources', () => {
    const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
    const uses = Object.fromEntries(
      readdirSync(sourceRoot, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith('.ts')
          && !file.includes('__tests__')
          && !file.endsWith('.spec.ts'))
        .map((file) => [
          file,
          readFileSync(join(sourceRoot, file), 'utf8')
            .split('@AllowAppScopedRuntimeKey()').length - 1,
        ] as const)
        .filter(([, count]) => count > 0),
    );

    expect(uses).toEqual({
      'modules/runtime-setup-v2/runtime-setup-v2.controller.ts': 4,
    });
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/apps/__tests__/apps.controller.spec.ts
+++ b/apps/api/src/modules/apps/__tests__/apps.controller.spec.ts
@@ -1,3 +1,4 @@
+import { NotFoundException } from '@nestjs/common';
 import { describe, expect, it, vi } from 'vitest';
 import { AppsController } from '../apps.controller';
 
@@ -553,3 +554,49 @@
     expect(appsService.delete).not.toHaveBeenCalled();
   });
 });
+
+describe('AppsController app-scoped keys', () => {
+  const ownApp = { id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903', name: 'Get It Done' };
+  const otherApp = { id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3999', name: 'Other App' };
+  const appKey = {
+    id: 'tenant-1',
+    apiKeyId: 'key-1',
+    targetAppId: ownApp.id,
+    scopes: ['management'],
+  } as never;
+  const dashboard = { id: 'tenant-1', userId: 'owner-1', memberRole: 'owner' } as never;
+
+  function controller() {
+    const appsService = {
+      list: vi.fn().mockResolvedValue([ownApp, otherApp]),
+      get: vi.fn(async (_tenantId: string, appId: string) => (
+        [ownApp, otherApp].find((app) => app.id === appId)
+      )),
+      listEnvironments: vi.fn().mockResolvedValue([]),
+      update: vi.fn().mockResolvedValue(ownApp),
+    };
+    return {
+      appsService,
+      controller: new AppsController(appsService as never, {} as never),
+    };
+  }
+
+  it('lists only its own app to an app-scoped key', async () => {
+    const { controller: apps } = controller();
+
+    await expect(apps.list(appKey)).resolves.toEqual({ apps: [ownApp] });
+    await expect(apps.list(dashboard)).resolves.toEqual({ apps: [ownApp, otherApp] });
+  });
+
+  it('answers another app like an unknown app for an app-scoped key', async () => {
+    const { controller: apps, appsService } = controller();
+
+    await expect(apps.get(appKey, otherApp.id)).rejects.toBeInstanceOf(NotFoundException);
+    await expect(apps.listEnvironments(appKey, otherApp.id))
+      .rejects.toBeInstanceOf(NotFoundException);
+    await expect(apps.update(appKey, otherApp.id, { name: 'Renamed' }))
+      .rejects.toBeInstanceOf(NotFoundException);
+    expect(appsService.update).not.toHaveBeenCalled();
+    await expect(apps.get(appKey, ownApp.id)).resolves.toEqual(ownApp);
+  });
+});
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/common/__tests__/app-scope-wiring.spec.ts 2>&1 | grep -E "^ +Tests |AssertionError"
./node_modules/.bin/vitest run src/modules/apps/__tests__/apps.controller.spec.ts 2>&1 | grep -E "^ +Tests |AssertionError"
```

Expected: wiring `Tests  3 failed (3)` (`expected undefined to be true`; `expected [] to deeply equal [ 'createRun', 'getRun', …(2) ]`; `expected {} to deeply equal { …(1) }`); apps `Tests  2 failed | 23 passed (25)` (the key lists both apps; `apps.get` for the other app resolves instead of rejecting).

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/apps/apps.controller.ts
+++ b/apps/api/src/modules/apps/apps.controller.ts
@@ -6,6 +6,7 @@
   Delete,
   ForbiddenException,
   Get,
+  NotFoundException,
   Param,
   Patch,
   Post,
@@ -14,6 +15,7 @@
 import { AiModule, AiTool } from '@chainmatics/agentic-adapter-nestjs';
 import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
+import { TenantWideOnly } from '../../common/decorators/app-scope.decorator';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
 import { type TenantContext } from '../../common/types';
 import { ApiKeyService } from '../auth/api-key.service';
@@ -52,7 +54,11 @@
   })
   async list(@CurrentTenant() tenant: TenantContext) {
     const apps = await this.appsService.list(tenant.id);
-    return { apps };
+    return {
+      apps: this.isAppScopedKey(tenant)
+        ? apps.filter((app) => app.id === tenant.targetAppId)
+        : apps,
+    };
   }
 
   @Get(':appId')
@@ -71,6 +77,7 @@
     @CurrentTenant() tenant: TenantContext,
     @Param('appId') appId: string,
   ) {
+    this.assertAppInScope(tenant, appId);
     return this.appsService.get(tenant.id, appId);
   }
 
@@ -79,6 +86,7 @@
     @CurrentTenant() tenant: TenantContext,
     @Param('appId') appId: string,
   ) {
+    this.assertAppInScope(tenant, appId);
     const environments = await this.appsService.listEnvironments(tenant.id, appId);
     return { environments };
   }
@@ -97,6 +105,7 @@
     method: 'POST',
     path: '/v1/apps',
   })
+  @TenantWideOnly()
   async create(
     @CurrentTenant() tenant: TenantContext,
     @Body() body: { name: string; description?: string; metadata?: unknown },
@@ -378,7 +387,22 @@
       metadata?: unknown;
     },
   ) {
+    this.assertAppInScope(tenant, appId);
     return this.appsService.update(tenant.id, appId, body);
+  }
+
+  private isAppScopedKey(tenant: TenantContext): boolean {
+    return Boolean(tenant.apiKeyId && tenant.targetAppId);
+  }
+
+  /**
+   * An API key bound to one app sees only that app. Any other app answers
+   * exactly like an unknown one, so the key cannot learn which apps exist.
+   */
+  private assertAppInScope(tenant: TenantContext, appId: string): void {
+    if (this.isAppScopedKey(tenant) && tenant.targetAppId !== appId) {
+      throw new NotFoundException('App not found');
+    }
   }
 
   private ownerOrAdmin(
--- a/apps/api/src/modules/auth/api-key.controller.ts
+++ b/apps/api/src/modules/auth/api-key.controller.ts
@@ -13,6 +13,7 @@
 import { AiModule, AiTool } from '@chainmatics/agentic-adapter-nestjs';
 import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
+import { TenantWideOnly } from '../../common/decorators/app-scope.decorator';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
 import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
 import { type TenantContext } from '../../common/types';
@@ -41,6 +42,7 @@
 @Controller('v1/tenant/api-keys')
 @UseGuards(CompositeAuthGuard)
 @RequireScopes('management')
+@TenantWideOnly()
 export class ApiKeyController {
   constructor(private readonly apiKeyService: ApiKeyService) {}
 
--- a/apps/api/src/modules/auth/tenant.controller.ts
+++ b/apps/api/src/modules/auth/tenant.controller.ts
@@ -13,6 +13,7 @@
 import { AiModule, AiTool } from '@chainmatics/agentic-adapter-nestjs';
 import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
+import { TenantWideOnly } from '../../common/decorators/app-scope.decorator';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
 import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
 import { type TenantContext } from '../../common/types';
@@ -38,6 +39,7 @@
 @Controller('v1/tenant')
 @UseGuards(CompositeAuthGuard)
 @RequireScopes('management')
+@TenantWideOnly()
 export class TenantController {
   constructor(
     private readonly tenantService: TenantService,
--- a/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts
+++ b/apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts
@@ -14,6 +14,7 @@
 import { z } from 'zod';
 import { CurrentTenant } from '../../common/decorators/tenant.decorator';
 import { RequireScopes } from '../../common/decorators/scopes.decorator';
+import { AllowAppScopedRuntimeKey } from '../../common/decorators/app-scope.decorator';
 import { CompositeAuthGuard } from '../../common/guards/composite-auth.guard';
 import { type TenantContext } from '../../common/types';
 import { findProhibitedAppSetupPath } from './app-setup-content-boundary';
@@ -70,6 +71,7 @@
   }
 
   @Get('runs/:runId')
+  @AllowAppScopedRuntimeKey()
   async getRun(
     @CurrentTenant() tenant: TenantContext,
     @Param('appId') appId: string,
@@ -80,6 +82,7 @@
   }
 
   @Post('runs')
+  @AllowAppScopedRuntimeKey()
   async createRun(
     @CurrentTenant() tenant: TenantContext,
     @Param('appId') appId: string,
@@ -92,6 +95,7 @@
   }
 
   @Patch('runs/:runId/status')
+  @AllowAppScopedRuntimeKey()
   async updateStatus(
     @CurrentTenant() tenant: TenantContext,
     @Param('appId') appId: string,
@@ -211,6 +215,7 @@
   }
 
   @Put('runs/:runId/artifact')
+  @AllowAppScopedRuntimeKey()
   async putArtifact(
     @CurrentTenant() tenant: TenantContext,
     @Param('appId') appId: string,
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/common/__tests__/app-scope-wiring.spec.ts src/modules/apps/__tests__/apps.controller.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/auth src/modules/runtime-setup-v2 src/common 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  2 passed (2)`, `Tests  28 passed (28)`; `Test Files  31 passed (31)`, `Tests  288 passed (288)`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/common/__tests__/app-scope-wiring.spec.ts apps/api/src/modules/apps/apps.controller.ts apps/api/src/modules/apps/__tests__/apps.controller.spec.ts apps/api/src/modules/auth/api-key.controller.ts apps/api/src/modules/auth/tenant.controller.ts apps/api/src/modules/runtime-setup-v2/runtime-setup-v2.controller.ts
git commit -m "fix(apps): keep app-scoped keys inside their own app"
```

---

### Task 17: API – issue runtime-only pairing keys that expire

**Files:**
- Modify: `apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts` (new `describe` at the end), `apps/api/src/modules/runtime-connect/runtime-connect.store.ts:1`, `apps/api/src/modules/runtime-connect/drizzle-runtime-connect.store.ts:8-11,104-105`
- Test: `apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts`

**Interfaces:**
- Consumes: `ApiKeyService.createWithExecutor(executor, tenantId, { label, targetAppId, scopes, expiresInDays })` (`expiresInDays` in days; `null` means never).
- Produces: `export const PAIRING_KEY_LIFETIME_DAYS = 90;` in `runtime-connect.store.ts`; the pairing key is `scopes: ['runtime']`, `targetAppId` = paired app, expiry = 90 days.

Lifecycle: renewal is a new `glirastes connect`; `POST /v1/tenant/api-keys/:id/rotate` replaces a leaked key while keeping scopes and the absolute expiry (`c860d10`, `784ac72`); revocation stops it at once because it deletes the cached context; the guard re-checks the absolute expiry on every cache hit, and a cached context lives at most 300 s or until the key expires, whichever comes first (`67cc575`), which bounds how long a scope change made directly in the database (Task 23) takes to apply. Keys issued before this task keep `management` and no expiry; Task 23 asks Philipp to approve their remediation. The token response shape stays `{ status, connection, apiKey }` because the SDK parses it strictly; the expiry is visible in the dashboard key list.

- [ ] **Step 1: Write the failing test**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts
+++ b/apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts
@@ -68,3 +68,55 @@
     expect(pairing.status).toBe('consumed');
   });
 });
+
+describe('DrizzleRuntimeConnectStore credentials', () => {
+  const now = new Date('2026-08-14T16:00:00.000Z');
+
+  it('issues a runtime-only key bound to the paired app that expires', async () => {
+    const pairing = {
+      id: 'pairing-1',
+      status: 'authorized',
+      localAppName: 'Get It Done',
+      tenantId: 'tenant-1',
+      targetAppId: 'app-1',
+      environmentId: 'env-1',
+      expiresAt: new Date('2026-08-14T16:10:00.000Z'),
+    };
+    const tx = {
+      select: vi.fn(() => {
+        const query = {
+          from: () => query,
+          where: () => query,
+          limit: () => query,
+          for: async () => [{ ...pairing }],
+        };
+        return query;
+      }),
+      update: vi.fn(() => ({
+        set: () => ({
+          where: () => ({ returning: async () => [{ id: pairing.id }] }),
+        }),
+      })),
+    };
+    const db = {
+      transaction: async <T>(callback: (executor: typeof tx) => Promise<T>) => callback(tx),
+    };
+    const apiKeys = {
+      createWithExecutor: vi.fn().mockResolvedValue({
+        id: 'key-1',
+        plaintext: `gl_${'x'.repeat(40)}`,
+      }),
+    };
+    const store = new DrizzleRuntimeConnectStore(db as never, apiKeys as never);
+
+    await expect(store.consume('hash', now)).resolves.toMatchObject({
+      status: 'connected',
+    });
+    expect(apiKeys.createWithExecutor).toHaveBeenCalledWith(tx, 'tenant-1', {
+      label: 'Get It Done connected runtime',
+      targetAppId: 'app-1',
+      scopes: ['runtime'],
+      expiresInDays: 90,
+    });
+  });
+});
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts 2>&1 | grep -E "^ +Tests |expiresInDays|\"management\""
```

Expected: `Tests  1 failed | 1 passed (2)`; the diff (printed twice, colour codes aside) marks `- "expiresInDays": 90` against `+ "expiresInDays": null` and an extra `+ "management",` in the received scopes.

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/runtime-connect/runtime-connect.store.ts
+++ b/apps/api/src/modules/runtime-connect/runtime-connect.store.ts
@@ -1,4 +1,12 @@
 export const RUNTIME_CONNECT_STORE = Symbol('RUNTIME_CONNECT_STORE');
+
+/**
+ * Lifetime of the API key a browser pairing hands to the local CLI. The key
+ * is runtime-only and bound to the paired app. It is renewed by pairing again
+ * (`glirastes connect`); the dashboard's rotation replaces a leaked key
+ * without extending this lifetime, and revocation stops it at once.
+ */
+export const PAIRING_KEY_LIFETIME_DAYS = 90;
 
 export type PairingStatus =
   | 'pending'
--- a/apps/api/src/modules/runtime-connect/drizzle-runtime-connect.store.ts
+++ b/apps/api/src/modules/runtime-connect/drizzle-runtime-connect.store.ts
@@ -6,6 +6,7 @@
 } from '@glirastes/db';
 import { ApiKeyService } from '../auth/api-key.service';
 import {
+  PAIRING_KEY_LIFETIME_DAYS,
   type PairingClaim,
   type RuntimeConnectStore,
 } from './runtime-connect.store';
@@ -101,8 +102,8 @@
         {
           label: `${pairing.localAppName} connected runtime`,
           targetAppId: pairing.targetAppId,
-          scopes: ['management', 'runtime'],
-          expiresInDays: null,
+          scopes: ['runtime'],
+          expiresInDays: PAIRING_KEY_LIFETIME_DAYS,
         },
       );
       const consumed = await tx.update(runtimeConnectionPairings)
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-connect 2>&1 | grep -E "Test Files|Tests "
grep -rn "'management', 'runtime'" src/modules/runtime-connect || echo "no management scope in pairing"
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  7 passed (7)`, `Tests  31 passed (31)` (the filter also matches `runtime-connections`; the store file has `2 passed`); `no management scope in pairing`; `typecheck=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-connect/runtime-connect.store.ts apps/api/src/modules/runtime-connect/drizzle-runtime-connect.store.ts apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts
git commit -m "fix(runtime-connect): issue runtime-only pairing keys that expire"
```

---

### Task 18: API – deny pairings, reject malformed device codes, prefill the code

**Files:**
- Modify: `apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts`, `__tests__/runtime-connect.service.spec.ts:13-24,75-77` (+ three tests at the end), `__tests__/runtime-connect.controller.spec.ts` (+ one test at the end)
- Modify: `apps/api/src/modules/runtime-connect/runtime-connect.store.ts` (interface), `drizzle-runtime-connect.store.ts:74` (+ `deny` after `authorize`), `runtime-connect.service.ts:32,78,99-107,150-151,185` (+ `deny`, `pairingApprover`), `runtime-pairing-claim.controller.ts:39` (+ `POST deny`)
- Test: the three spec files; SDK contract check in Step 5

**Interfaces:**
- Consumes: SDK contract `PairingStartResponseSchema.verificationUri` (`SafeControlPlaneUrlSchema`, any HTTPS or loopback URL incl. query) and `PairingTokenResultSchema` `{ status: 'denied' }` (`src/contracts/platform-connection.ts:47-80`); SDK `runConnect` maps `denied` to `E-CONNECT-DENIED` (`src/cli/commands/connect.ts:250-256`).
- Produces: `RuntimeConnectStore.deny(userCodeHash: string, now: Date): Promise<boolean>` (only `pending` and unexpired); `RuntimeConnectService.deny(tenant: TenantContext, rawInput: unknown): Promise<{ denied: true }>` (owner/admin dashboard user, body `{ userCode }` strict, 404 `pairing_unavailable` otherwise); `RuntimeConnectService.token(rawDeviceCode: unknown)` answers 400 `invalid_pairing_request` for anything but a 32-256 character string, before the poll limiter; `POST /v1/runtime-connect/pairings/deny`; `verificationUri` = `<CITADEL_URL>/connect/pair?user_code=<code>` (the page already reads `?user_code`).

`token()` used `z.string().min(32).max(256).parse(...)`, so a malformed device code threw a `ZodError` that the bounded exception filter turned into 500. Only a `pending` pairing can be denied. A pending pairing belongs to no tenant yet, so whoever holds the short code may deny it with exactly the authority that approving it needs; an `authorized` pairing already belongs to the approving tenant, so another tenant's owner who learned the code must not be able to cancel it (the page hides the deny button once the approval succeeded, and the CLI collects the key within one poll interval). A connection approved by mistake is ended by revoking its key in the dashboard. Deny and approve race safely: both updates require `status = 'pending'`, and PostgreSQL re-checks the `WHERE` after waiting for the other row lock, so exactly one of them wins.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts
+++ b/apps/api/src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts
@@ -119,4 +119,18 @@
       expiresInDays: 90,
     });
   });
+
+  it('denies only a pairing that is still pending', async () => {
+    const set = vi.fn(() => ({
+      where: () => ({ returning: async () => returned }),
+    }));
+    let returned: Array<{ id: string }> = [{ id: 'pairing-1' }];
+    const db = { update: vi.fn(() => ({ set })) };
+    const store = new DrizzleRuntimeConnectStore(db as never, {} as never);
+
+    await expect(store.deny('hash', now)).resolves.toBe(true);
+    expect(set).toHaveBeenCalledWith({ status: 'denied', updatedAt: now });
+    returned = [];
+    await expect(store.deny('hash', now)).resolves.toBe(false);
+  });
 });
--- a/apps/api/src/modules/runtime-connect/__tests__/runtime-connect.service.spec.ts
+++ b/apps/api/src/modules/runtime-connect/__tests__/runtime-connect.service.spec.ts
@@ -20,6 +20,7 @@
       expiresAt: new Date('2026-08-14T16:10:00.000Z'),
     }),
     authorize: vi.fn().mockResolvedValue(true),
+    deny: vi.fn().mockResolvedValue(true),
     consume: vi.fn().mockResolvedValue({ status: 'pending' }),
   };
   const apps = {
@@ -73,7 +74,7 @@
     expect(first.deviceCode).not.toBe(second.deviceCode);
     expect(first.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
     expect(first.verificationUri).toBe(
-      'https://platform.glirastes.io/connect/pair',
+      `https://platform.glirastes.io/connect/pair?user_code=${first.userCode}`,
     );
     expect(first.expiresInSeconds).toBe(600);
     expect(first.pollIntervalMs).toBe(2_000);
@@ -202,4 +203,61 @@
     await expect(service.token('device_abcdefghijklmnopqrstuvwxyz0123456789'))
       .resolves.toEqual({ status: 'expired' });
   });
+
+  it('rejects a malformed device code as a bad request before polling', async () => {
+    const deps = dependencies();
+    const service = new RuntimeConnectService(
+      deps.store as never, deps.apps as never, deps.entitlements as never,
+      deps.config as never, deps.redis as never,
+    );
+
+    for (const deviceCode of ['', 'too-short', 'x'.repeat(257), 42]) {
+      await expect(service.token(deviceCode)).rejects.toMatchObject({
+        status: 400,
+        response: { code: 'invalid_pairing_request' },
+      });
+    }
+    expect(deps.redis.set).not.toHaveBeenCalled();
+    expect(deps.store.consume).not.toHaveBeenCalled();
+  });
+
+  it('lets a verified owner or admin deny a pairing', async () => {
+    const deps = dependencies();
+    const service = new RuntimeConnectService(
+      deps.store as never, deps.apps as never, deps.entitlements as never,
+      deps.config as never, deps.redis as never,
+    );
+    const owner = { id: 'tenant-1', userId: 'owner-1', memberRole: 'owner' } as never;
+
+    await expect(service.deny(
+      { id: 'tenant-1', userId: 'member-1', memberRole: 'member' } as never,
+      { userCode: 'ABCD-EFGH' },
+    )).rejects.toBeInstanceOf(ForbiddenException);
+    await expect(service.deny(owner, { userCode: 'not a code' }))
+      .rejects.toBeInstanceOf(BadRequestException);
+    expect(deps.store.deny).not.toHaveBeenCalled();
+
+    await expect(service.deny(owner, { userCode: 'ABCD-EFGH' }))
+      .resolves.toEqual({ denied: true });
+    expect(deps.store.deny).toHaveBeenCalledWith(
+      expect.stringMatching(/^[a-f0-9]{64}$/),
+      new Date('2026-08-14T16:00:00.000Z'),
+    );
+
+    deps.store.deny.mockResolvedValueOnce(false);
+    await expect(service.deny(owner, { userCode: 'ABCD-EFGH' }))
+      .rejects.toMatchObject({ status: 404, response: { code: 'pairing_unavailable' } });
+  });
+
+  it('reports a denied pairing to the polling CLI', async () => {
+    const deps = dependencies();
+    deps.store.consume.mockResolvedValueOnce({ status: 'denied' });
+    const service = new RuntimeConnectService(
+      deps.store as never, deps.apps as never, deps.entitlements as never,
+      deps.config as never, deps.redis as never,
+    );
+
+    await expect(service.token('device_abcdefghijklmnopqrstuvwxyz0123456789'))
+      .resolves.toEqual({ status: 'denied' });
+  });
 });
--- a/apps/api/src/modules/runtime-connect/__tests__/runtime-connect.controller.spec.ts
+++ b/apps/api/src/modules/runtime-connect/__tests__/runtime-connect.controller.spec.ts
@@ -46,4 +46,14 @@
     await controller.authorize(tenant as never, body);
     expect(service.authorize).toHaveBeenCalledWith(tenant, body);
   });
+
+  it('passes only the server-authenticated tenant into a denial', async () => {
+    const service = { deny: vi.fn().mockResolvedValue({ denied: true }) };
+    const controller = new RuntimePairingClaimController(service as never);
+    const tenant = { id: 'tenant-1', userId: 'owner-1', memberRole: 'owner' };
+    const body = { userCode: 'ABCD-EFGH' };
+
+    await expect(controller.deny(tenant as never, body)).resolves.toEqual({ denied: true });
+    expect(service.deny).toHaveBeenCalledWith(tenant, body);
+  });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts 2>&1 | grep -E "Tests "
./node_modules/.bin/vitest run src/modules/runtime-connect/__tests__/runtime-connect.service.spec.ts 2>&1 | grep -E "×|Tests "
./node_modules/.bin/vitest run src/modules/runtime-connect/__tests__/runtime-connect.controller.spec.ts 2>&1 | grep -E "Tests "
```

Expected: store `Tests  1 failed | 2 passed (3)` (`store.deny is not a function`); service `Tests  3 failed | 6 passed (9)`: the URI test (no `?user_code=`), "rejects a malformed device code as a bad request before polling" (a `ZodError`, not a 400) and "lets a verified owner or admin deny a pairing" (`service.deny is not a function`); "reports a denied pairing to the polling CLI" already passes and pins the SDK branch; controller `Tests  1 failed | 4 passed (5)` (`controller.deny is not a function`).

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/runtime-connect/runtime-connect.store.ts
+++ b/apps/api/src/modules/runtime-connect/runtime-connect.store.ts
@@ -43,6 +43,7 @@
     },
     now: Date,
   ): Promise<boolean>;
+  deny(userCodeHash: string, now: Date): Promise<boolean>;
   consume(deviceCodeHash: string, now: Date): Promise<
     | { status: 'pending' | 'denied' | 'expired' }
     | {
--- a/apps/api/src/modules/runtime-connect/drizzle-runtime-connect.store.ts
+++ b/apps/api/src/modules/runtime-connect/drizzle-runtime-connect.store.ts
@@ -71,6 +71,24 @@
     return rows.length === 1;
   }
 
+  /**
+   * Refuse a pairing that is still pending. A pending pairing belongs to no
+   * tenant yet; an authorized one belongs to its approver's tenant and ends
+   * by revoking its key. Approval also requires `pending`, so one wins.
+   */
+  async deny(userCodeHash: string, now: Date): Promise<boolean> {
+    const rows = await this.db
+      .update(runtimeConnectionPairings)
+      .set({ status: 'denied', updatedAt: now })
+      .where(and(
+        eq(runtimeConnectionPairings.userCodeHash, userCodeHash),
+        eq(runtimeConnectionPairings.status, 'pending'),
+        gt(runtimeConnectionPairings.expiresAt, now),
+      ))
+      .returning({ id: runtimeConnectionPairings.id });
+    return rows.length === 1;
+  }
+
   async consume(deviceCodeHash: string, now: Date) {
     return this.db.transaction(async (tx) => {
       const [pairing] = await tx
--- a/apps/api/src/modules/runtime-connect/runtime-connect.service.ts
+++ b/apps/api/src/modules/runtime-connect/runtime-connect.service.ts
@@ -29,6 +29,8 @@
   localAppName: z.string().trim().min(1).max(100),
   artifactDigest: digest,
 }).strict();
+const denySchema = z.object({ userCode }).strict();
+const deviceCodeSchema = z.string().min(32).max(256);
 const authorizeSchema = z.discriminatedUnion('action', [
   z.object({
     userCode,
@@ -75,7 +77,10 @@
       schemaVersion: 1 as const,
       deviceCode,
       userCode: generatedUserCode,
-      verificationUri: `${this.origin('CITADEL_URL', 'http://localhost:3101')}/connect/pair`,
+      // The code rides along so the pairing page opens prefilled; it is the
+      // same short-lived code the CLI prints, never the device code.
+      verificationUri: `${this.origin('CITADEL_URL', 'http://localhost:3101')}`
+        + `/connect/pair?user_code=${encodeURIComponent(generatedUserCode)}`,
       expiresInSeconds,
       pollIntervalMs: 2_000,
     };
@@ -97,13 +102,7 @@
   }
 
   async authorize(tenant: TenantContext, rawInput: unknown) {
-    if (
-      !tenant.userId
-      || !tenant.memberRole
-      || !['owner', 'admin'].includes(tenant.memberRole)
-    ) {
-      throw new ForbiddenException({ code: 'pairing_owner_required' });
-    }
+    const approverId = this.pairingApprover(tenant);
     const input = this.parse(authorizeSchema, rawInput);
     const pairing = await this.store.claim(hash(input.userCode));
     if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= new Date()) {
@@ -139,7 +138,7 @@
         tenantId: tenant.id,
         targetAppId: pairing.localAppId,
         environmentId: input.environmentId,
-        authorizedBy: tenant.userId,
+        authorizedBy: approverId,
       },
       new Date(),
     );
@@ -147,8 +146,20 @@
     return { authorized: true };
   }
 
-  async token(rawDeviceCode: string) {
-    const deviceCode = z.string().min(32).max(256).parse(rawDeviceCode);
+  /**
+   * Refuse a pairing from the dashboard. The polling CLI then receives
+   * `denied` and stops with E-CONNECT-DENIED instead of waiting for expiry.
+   */
+  async deny(tenant: TenantContext, rawInput: unknown) {
+    this.pairingApprover(tenant);
+    const input = this.parse(denySchema, rawInput);
+    const denied = await this.store.deny(hash(input.userCode), new Date());
+    if (!denied) throw new NotFoundException({ code: 'pairing_unavailable' });
+    return { denied: true as const };
+  }
+
+  async token(rawDeviceCode: unknown) {
+    const deviceCode = this.parse(deviceCodeSchema, rawDeviceCode);
     const deviceCodeHash = hash(deviceCode);
     const allowed = await this.redis.set(
       `runtime-connect:poll:${deviceCodeHash}`,
@@ -182,6 +193,18 @@
     };
   }
 
+  /** A verified dashboard owner or admin decides a pairing; returns the user. */
+  private pairingApprover(tenant: TenantContext): string {
+    if (
+      !tenant.userId
+      || !tenant.memberRole
+      || !['owner', 'admin'].includes(tenant.memberRole)
+    ) {
+      throw new ForbiddenException({ code: 'pairing_owner_required' });
+    }
+    return tenant.userId;
+  }
+
   private parse<T>(schema: z.ZodType<T>, value: unknown): T {
     const parsed = schema.safeParse(value);
     if (!parsed.success) throw new BadRequestException({ code: 'invalid_pairing_request' });
--- a/apps/api/src/modules/runtime-connect/runtime-pairing-claim.controller.ts
+++ b/apps/api/src/modules/runtime-connect/runtime-pairing-claim.controller.ts
@@ -37,4 +37,12 @@
   ) {
     return this.connections.authorize(tenant, body);
   }
+
+  @Post('deny')
+  deny(
+    @CurrentTenant() tenant: TenantContext,
+    @Body() body: unknown,
+  ) {
+    return this.connections.deny(tenant, body);
+  }
 }
PATCH
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/runtime-connect/__tests__/drizzle-runtime-connect.store.spec.ts src/modules/runtime-connect/__tests__/runtime-connect.service.spec.ts src/modules/runtime-connect/__tests__/runtime-connect.controller.spec.ts src/modules/runtime-connect/__tests__/connected-free-rehearsal.spec.ts 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
```

Expected: `Test Files  4 passed (4)`, `Tests  20 passed (20)` (3 + 9 + 5 + 3); `typecheck=0` (the rehearsal script compiles against the extended store interface).

- [ ] **Step 5: Confirm the SDK still accepts both responses (read-only)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
S="$(mktemp -d)"
git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1 status --porcelain > "$S/before"
bun -e "
const { PairingStartResponseSchema, PairingTokenResultSchema } = await import('/Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1/src/contracts/platform-connection.ts');
const start = PairingStartResponseSchema.safeParse({ schemaVersion: 1, deviceCode: 'device_' + 'a'.repeat(43), userCode: 'ABCD-EFGH', verificationUri: 'https://platform.glirastes.io/connect/pair?user_code=ABCD-EFGH', expiresInSeconds: 600, pollIntervalMs: 2000 });
console.log(start.success, PairingTokenResultSchema.safeParse({ status: 'denied' }).success);
"
git -C /Users/philipprollmann/Dev/chainmatics/glirastes/.worktrees/foundation-runtime-v1 status --porcelain > "$S/after"
diff "$S/before" "$S/after" && echo "sdk-unchanged"
```

Expected: `true true`; `sdk-unchanged` (the import writes nothing into the SDK worktree).

- [ ] **Step 6: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/runtime-connect
git commit -m "feat(runtime-connect): deny pairings and reject malformed device codes"
```

---

### Task 19: Citadel – deny pairings and explain the Connected Free limit

**Files:**
- Modify: `apps/citadel/src/lib/runtime-connect-client.test.ts:2-6` (+ one test), `apps/citadel/src/app/(dashboard)/connect/pair/pair-page.test.tsx` (+ two tests)
- Create: `apps/citadel/src/lib/runtime-pairing-feedback.test.ts`, `apps/citadel/src/lib/runtime-pairing-feedback.ts`
- Modify: `apps/citadel/src/lib/runtime-connect-client.ts:31,61`, `apps/citadel/src/app/(dashboard)/connect/pair/page.tsx`
- Test: the three test files; Citadel `tsc`, Vitest, ESLint

**Interfaces:**
- Consumes: `POST /v1/runtime-connect/pairings/deny` → `{ denied: true }` (Task 18); `ApiError { status; body: string }` (`src/lib/api.ts:83`); the API answers the Free limit with `409 { code: 'connected_free_limit_reached', resource: 'app' | 'environment' }` (`platform-entitlement.service.ts:114-118`, one app and one environment on Free).
- Produces: `denyRuntimePairing(userCode: string, client?): Promise<{ denied: true }>`; `pairingFailureMessage(error: unknown, fallback: string): string` (reads only status and the error code; never echoes the body); the pair page shows "Deny connection" while a claim is open, a denied state ("Connection denied. The CLI stops without connecting."), and a plan-limit card with a link to `/settings/billing`.

- [ ] **Step 1: Write the failing tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/citadel/src/lib/runtime-connect-client.test.ts
+++ b/apps/citadel/src/lib/runtime-connect-client.test.ts
@@ -3,6 +3,7 @@
   authorizeRuntimePairing,
   claimRuntimePairing,
   createRuntimePairingEnvironment,
+  denyRuntimePairing,
 } from './runtime-connect-client';
 
 const localAppId = '019fa9a9-d5f7-7ec3-a3c7-8899de400001';
@@ -71,4 +72,18 @@
       { key: 'local', name: 'Local' },
     );
   });
+
+  it('denies a pairing by its short code only', async () => {
+    const api = { post: vi.fn().mockResolvedValue({ denied: true }) };
+
+    await expect(denyRuntimePairing('ABCD-EFGH', api as never))
+      .resolves.toEqual({ denied: true });
+    expect(api.post).toHaveBeenCalledWith(
+      '/v1/runtime-connect/pairings/deny',
+      { userCode: 'ABCD-EFGH' },
+    );
+
+    api.post.mockResolvedValueOnce({ denied: true, apiKey: 'gl_x' });
+    await expect(denyRuntimePairing('ABCD-EFGH', api as never)).rejects.toThrow();
+  });
 });
--- a/apps/citadel/src/app/(dashboard)/connect/pair/pair-page.test.tsx
+++ b/apps/citadel/src/app/(dashboard)/connect/pair/pair-page.test.tsx
@@ -29,4 +29,17 @@
     expect(page).toContain('Approve connection');
     expect(page).toContain('disabled={!selectedEnvironmentId');
   });
+
+  it('lets the approver deny the pairing so the CLI stops at once', async () => {
+    const page = await source();
+    expect(page).toContain('denyRuntimePairing(');
+    expect(page).toContain('Deny connection');
+    expect(page).toContain('Connection denied. The CLI stops without connecting.');
+  });
+
+  it('explains plan limits instead of a generic failure', async () => {
+    const page = await source();
+    expect(page).toContain('pairingFailureMessage(');
+    expect(page).toContain('/settings/billing');
+  });
 });
PATCH
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel/src/lib/runtime-pairing-feedback.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { pairingFailureMessage } from './runtime-pairing-feedback';

const limit = (resource: string) => new ApiError(
  'POST',
  '/v1/runtime-connect/pairings/authorize',
  409,
  JSON.stringify({ code: 'connected_free_limit_reached', resource }),
);

describe('runtime pairing feedback', () => {
  /**
   * Connected Free allows one app with one environment. Hitting that limit
   * used to look like any other failure, so the operator could not tell that
   * an upgrade, not a retry, was the way forward.
   */
  it('explains the Connected Free app limit with the way out', () => {
    const message = pairingFailureMessage(limit('app'), 'fallback');

    expect(message).toMatch(/Free plan connects one app/);
    expect(message).toMatch(/upgrade to Pro/i);
  });

  it('explains the Connected Free environment limit with the way out', () => {
    const message = pairingFailureMessage(limit('environment'), 'fallback');

    expect(message).toMatch(/Free plan connects one environment/);
    expect(message).toMatch(/upgrade to Pro/i);
  });

  it('falls back to the caller copy and never echoes a response body', () => {
    const secret = new ApiError('POST', '/x', 409, '{"code":"other","detail":"db password"}');

    expect(pairingFailureMessage(secret, 'The connection could not be approved'))
      .toBe('The connection could not be approved');
    expect(pairingFailureMessage(new ApiError('POST', '/x', 409, 'not json'), 'fallback'))
      .toBe('fallback');
    expect(pairingFailureMessage(new TypeError('Failed to fetch'), 'fallback'))
      .toBe('fallback');
  });
});
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel
./node_modules/.bin/vitest run src/lib/runtime-connect-client.test.ts 2>&1 | grep -E "Tests "
./node_modules/.bin/vitest run src/lib/runtime-pairing-feedback.test.ts 2>&1 | grep -E "Cannot find module" | head -1
./node_modules/.bin/vitest run "src/app/(dashboard)/connect/pair/pair-page.test.tsx" 2>&1 | grep -E "Tests "
```

Expected: client `Tests  1 failed | 4 passed (5)` (`denyRuntimePairing is not a function`); feedback `Error: Cannot find module './runtime-pairing-feedback'`; page `Tests  2 failed | 3 passed (5)`.

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/citadel/src/lib/runtime-connect-client.ts
+++ b/apps/citadel/src/lib/runtime-connect-client.ts
@@ -27,6 +27,8 @@
       appId: string;
       environmentId: string;
     };
+
+const denialResultSchema = z.object({ denied: z.literal(true) }).strict();
 
 const authorizationResultSchema = z.union([
   z.object({ adopted: z.literal(true), appId: z.string().uuid() }).strict(),
@@ -58,6 +60,18 @@
   return authorizationResultSchema.parse(result);
 }
 
+/** Refuse a pairing; the polling CLI stops with E-CONNECT-DENIED. */
+export async function denyRuntimePairing(
+  userCode: string,
+  client: RuntimeConnectApiClient = api,
+) {
+  const result = await client.post<unknown>(
+    '/v1/runtime-connect/pairings/deny',
+    { userCode },
+  );
+  return denialResultSchema.parse(result);
+}
+
 export function createRuntimePairingEnvironment(
   appId: string,
   input: { key: string; name: string },
--- a/apps/citadel/src/app/(dashboard)/connect/pair/page.tsx
+++ b/apps/citadel/src/app/(dashboard)/connect/pair/page.tsx
@@ -2,7 +2,8 @@
 
 import { useEffect, useMemo, useState } from 'react';
 import { useSearchParams } from 'next/navigation';
+import Link from 'next/link';
-import { CheckCircle2 } from 'lucide-react';
+import { CheckCircle2, XCircle } from 'lucide-react';
 import { toast } from 'sonner';
 import { Button } from '@/components/ui/button';
 import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
@@ -13,8 +14,10 @@
   authorizeRuntimePairing,
   claimRuntimePairing,
   createRuntimePairingEnvironment,
+  denyRuntimePairing,
   type RuntimePairingClaim,
 } from '@/lib/runtime-connect-client';
+import { pairingFailureMessage } from '@/lib/runtime-pairing-feedback';
 import { loadRuntimeEnvironments } from '@/lib/runtime-setup-client';
 import type { RuntimeEnvironment } from '@/lib/runtime-setup-view-model';
 
@@ -30,6 +33,8 @@
   const [environmentName, setEnvironmentName] = useState('');
   const [busy, setBusy] = useState(false);
   const [authorized, setAuthorized] = useState(false);
+  const [denied, setDenied] = useState(false);
+  const [planNotice, setPlanNotice] = useState<string | null>(null);
   const { apps, refetch, selectApp } = useAppContext();
 
   const matchingApp = useMemo(
@@ -52,10 +57,18 @@
     return () => { active = false; };
   }, [matchingApp]);
 
+  function reportFailure(error: unknown, fallback: string) {
+    const message = pairingFailureMessage(error, fallback);
+    setPlanNotice(message === fallback ? null : message);
+    toast.error(message);
+  }
+
   async function resolveCode() {
     if (!userCode.trim() || busy) return;
     setBusy(true);
     setAuthorized(false);
+    setDenied(false);
+    setPlanNotice(null);
     try {
       const result = await claimRuntimePairing(userCode.trim().toUpperCase());
       if (result.status !== 'pending') {
@@ -81,8 +94,8 @@
       await refetch();
       selectApp(claim.localAppId);
       toast.success('Local app identity adopted');
-    } catch {
-      toast.error('The local app identity could not be adopted');
+    } catch (error) {
+      reportFailure(error, 'The local app identity could not be adopted');
     } finally {
       setBusy(false);
     }
@@ -106,8 +119,8 @@
       setEnvironmentName('');
       setSelectedEnvironmentId('');
       toast.success('Environment created. Select it to continue.');
-    } catch {
-      toast.error('The environment could not be created');
+    } catch (error) {
+      reportFailure(error, 'The environment could not be created');
     } finally {
       setBusy(false);
     }
@@ -125,8 +138,23 @@
       });
       setAuthorized(true);
       toast.success('Connection approved');
-    } catch {
-      toast.error('The connection could not be approved');
+    } catch (error) {
+      reportFailure(error, 'The connection could not be approved');
+    } finally {
+      setBusy(false);
+    }
+  }
+
+  async function deny() {
+    if (!claim || busy) return;
+    setBusy(true);
+    try {
+      await denyRuntimePairing(userCode.trim().toUpperCase());
+      setClaim(null);
+      setDenied(true);
+      toast.success('Connection denied');
+    } catch (error) {
+      reportFailure(error, 'The pairing could not be denied');
     } finally {
       setBusy(false);
     }
@@ -168,11 +196,29 @@
             <div><span className="font-medium">Name:</span> {claim.localAppName}</div>
             <div className="break-all"><span className="font-medium">App ID:</span> {claim.localAppId}</div>
             <div className="break-all"><span className="font-medium">Artifact:</span> {claim.artifactDigest}</div>
-            {!matchingApp && (
-              <Button type="button" variant="outline" disabled={busy} onClick={() => void adoptIdentity()}>
-                Adopt this exact app identity
-              </Button>
-            )}
+            <div className="flex flex-wrap gap-2">
+              {!matchingApp && (
+                <Button type="button" variant="outline" disabled={busy} onClick={() => void adoptIdentity()}>
+                  Adopt this exact app identity
+                </Button>
+              )}
+              {!authorized && (
+                <Button type="button" variant="ghost" disabled={busy} onClick={() => void deny()}>
+                  Deny connection
+                </Button>
+              )}
+            </div>
+          </CardContent>
+        </Card>
+      )}
+
+      {planNotice && (
+        <Card className="shrink-0 border-amber-500/40">
+          <CardContent className="space-y-2 pt-6 text-sm">
+            <p>{planNotice}</p>
+            <Link className="font-medium underline" href="/settings/billing">
+              Open billing settings
+            </Link>
           </CardContent>
         </Card>
       )}
@@ -225,6 +271,15 @@
         </Card>
       )}
 
+      {denied && (
+        <Card className="shrink-0 border-destructive/40">
+          <CardContent className="flex items-center gap-2 pt-6 text-sm">
+            <XCircle className="h-5 w-5 text-destructive" />
+            Connection denied. The CLI stops without connecting.
+          </CardContent>
+        </Card>
+      )}
+
       {authorized && (
         <Card className="shrink-0 border-green-500/40">
           <CardContent className="flex items-center gap-2 pt-6 text-sm">
PATCH
```

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel/src/lib/runtime-pairing-feedback.ts`:

```ts
import { z } from 'zod';
import { ApiError } from './api';

const planLimitSchema = z.object({
  code: z.literal('connected_free_limit_reached'),
  resource: z.enum(['app', 'environment']),
}).passthrough();

const PLAN_LIMIT_COPY = {
  app: 'Your Free plan connects one app. Upgrade to Pro in the billing settings, or delete the app you no longer need, then approve again.',
  environment: 'Your Free plan connects one environment per app. Upgrade to Pro in the billing settings, or select the existing environment.',
} as const;

/**
 * Bounded copy for a failed pairing step. Only the status and the error
 * code are read; the server's body never reaches the page, so a provider or
 * database message cannot leak into the browser.
 */
export function pairingFailureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError) || error.status !== 409) return fallback;
  let body: unknown;
  try {
    body = JSON.parse(error.body);
  } catch {
    return fallback;
  }
  const limit = planLimitSchema.safeParse(body);
  return limit.success ? PLAN_LIMIT_COPY[limit.data.resource] : fallback;
}
```

- [ ] **Step 4: Run and see GREEN**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/citadel
./node_modules/.bin/vitest run src/lib/runtime-connect-client.test.ts src/lib/runtime-pairing-feedback.test.ts "src/app/(dashboard)/connect/pair/pair-page.test.tsx" 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/tsc --noEmit; echo "tsc=$?"
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
L="$(mktemp -d)"; bun run lint > "$L/lint.log" 2>&1; echo "lint=$?"; grep problems "$L/lint.log"
```

Expected: `Test Files  3 passed (3)`, `Tests  13 passed (13)`; `tsc=0`; `Test Files  39 passed (39)`, `Tests  256 passed (256)`; `lint=0`, `✖ 30 problems (0 errors, 30 warnings)` (no new finding; the suppression baseline is unchanged).

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/citadel/src/lib/runtime-connect-client.ts apps/citadel/src/lib/runtime-connect-client.test.ts apps/citadel/src/lib/runtime-pairing-feedback.ts apps/citadel/src/lib/runtime-pairing-feedback.test.ts "apps/citadel/src/app/(dashboard)/connect/pair/page.tsx" "apps/citadel/src/app/(dashboard)/connect/pair/pair-page.test.tsx"
git commit -m "feat(citadel): deny pairings and explain connected free limits"
```

---

### Task 20: Aegis – pin pseudonym collisions at every group-creation site

**Files:**
- Modify: `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts:537-546` (batched test), insert two tests before the final `});` of section 7 (line 568)
- Test: the same file; mutation proof in Step 3

**Interfaces:** Consumes `AegisService.shieldResult(sessionId, value): Promise<{ shielded; reverseMapPatch: Record<string, string> }>` and `shieldResults(sessionId, values[]): Promise<{ shielded: unknown[]; reverseMapPatch }>` (`aegis.service.ts:327,473`); the section-7 helpers `drawFor`, `MAX_NEUMANN`, `LUKAS_NEUMANN`, `SOPHIE_HOFFMANN`. Produces none.

The batched test at line 537 could pass without any collision (if `shieldResults` drew differently, "Herr Neumann" would still map to Maria). It now proves that Hans Weber really became "Lukas Neumann" and that the batch did not re-point the shared surname `Neumann` (the same pin the single-result test already has). P01 tested the fresh-identity draw only through `scan`; `shieldResult` and `shieldResults` create groups at their own call sites (`aegis.service.ts:401`, `:531`), so each gets its own pin. The pins pass on arrival (the code is already correct); Step 3 shows each one fails when its own call site regresses.

- [ ] **Step 1: Write the tests**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
+++ b/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
@@ -540,7 +540,12 @@
       const draws = [MAX_NEUMANN, LUKAS_NEUMANN].map(drawFor);
       vi.spyOn(Math, 'random').mockReturnValueOnce(draws[0]).mockReturnValueOnce(draws[1]);
       await service.scan(sessionId, 'Finde Maria Schmidt', ['de', 'en']);
-      await service.shieldResults(sessionId, [{ owner: 'Hans Weber' }]);
+      const batch = await service.shieldResults(sessionId, [{ owner: 'Hans Weber' }]);
+
+      // The collision really happened: the second person drew "Lukas Neumann".
+      expect(batch.shielded).toEqual([{ owner: 'Lukas Neumann' }]);
+      expect(batch.reverseMapPatch['Lukas Neumann']).toBe('Hans Weber');
+      expect(batch.reverseMapPatch).not.toHaveProperty('Neumann');
       await expect(service.rehydrate(sessionId, 'Herr Neumann'))
         .resolves.toEqual({ rehydrated: 'Maria Schmidt' });
     });
@@ -565,5 +570,39 @@
       expect(reverseMap['Max Neumann']).toBe(first);
       expect(reverseMap['Sophie Hoffmann']).toBe(second);
     });
+
+    it('draws a fresh identity when a tool result adds a person with a taken name', async () => {
+      const { sessionId } = await service.createSession('tenant-1', 'app-1', 'de');
+      injectPresidioMock(service, createPersonDetector(['Maria Schmidt', 'Hans Weber']));
+      vi.spyOn(Math, 'random')
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(SOPHIE_HOFFMANN));
+
+      await service.scan(sessionId, 'Finde Maria Schmidt', ['de', 'en']);
+      const shield = await service.shieldResult(sessionId, { owner: 'Hans Weber' });
+
+      expect(shield.shielded).toEqual({ owner: 'Sophie Hoffmann' });
+      expect(shield.reverseMapPatch['Sophie Hoffmann']).toBe('Hans Weber');
+      await expect(service.rehydrate(sessionId, 'Max Neumann'))
+        .resolves.toEqual({ rehydrated: 'Maria Schmidt' });
+    });
+
+    it('draws a fresh identity when a batched tool result adds a person with a taken name', async () => {
+      const { sessionId } = await service.createSession('tenant-1', 'app-1', 'de');
+      injectPresidioMock(service, createPersonDetector(['Maria Schmidt', 'Hans Weber']));
+      vi.spyOn(Math, 'random')
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(MAX_NEUMANN))
+        .mockReturnValueOnce(drawFor(SOPHIE_HOFFMANN));
+
+      await service.scan(sessionId, 'Finde Maria Schmidt', ['de', 'en']);
+      const batch = await service.shieldResults(sessionId, [{ owner: 'Hans Weber' }]);
+
+      expect(batch.shielded).toEqual([{ owner: 'Sophie Hoffmann' }]);
+      expect(batch.reverseMapPatch['Sophie Hoffmann']).toBe('Hans Weber');
+      await expect(service.rehydrate(sessionId, 'Max Neumann'))
+        .resolves.toEqual({ rehydrated: 'Maria Schmidt' });
+    });
   });
 });
PATCH
```

- [ ] **Step 2: Run (green on arrival)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts -t "Pseudonym collisions" 2>&1 | grep -E "Tests "
```

Expected: `Tests  6 passed | 6 skipped (12)`.

- [ ] **Step 3: Prove each pin catches its own regression (tracked file restored from a copy)**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
F=src/modules/aegis/aegis.service.ts
B="$(mktemp -d)"
git diff --quiet -- "$F" && cp "$F" "$B/aegis.service.ts"
for site in shieldResult shieldResults; do
  perl -0pi -e "s/(async ${site}\\(.*?)drawGroupSeed\\(session, locale\\)/\$1((Math.random() * 0x7fffffff) | 0 || 1)/s" "$F"
  ./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts -t "taken name" 2>&1 | grep -E "Tests |×"
  cp "$B/aegis.service.ts" "$F"
done
git diff --quiet -- "$F" && echo restored
```

Expected: for `shieldResult` the line `× ... draws a fresh identity when a tool result adds a person with a taken name` and `Tests  1 failed | 1 passed | 10 skipped (12)`; for `shieldResults` `× ... draws a fresh identity when a batched tool result adds a person with a taken name` and the same counts; then `restored`. (The loop variable is `site`, not `path`: in zsh `path` is tied to `PATH`.)

- [ ] **Step 4: Aegis suite**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/aegis 2>&1 | grep -E "Test Files|Tests "
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
git status --short
```

Expected: `Test Files  10 passed (10)`, `Tests  180 passed | 10 skipped (190)`; `typecheck=0`; status only ` M src/modules/aegis/__tests__/identity-group-e2e.spec.ts`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
git commit -m "test(aegis): pin pseudonym collisions at every group-creation site"
```

---

### Task 21: Aegis – never share a full pseudonym beyond the random draws

**Files:**
- Create: `apps/api/src/modules/aegis/__tests__/group-identity-space.spec.ts`
- Modify: `apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts:3` (type import) and one test at the end of section 7
- Modify: `apps/api/src/modules/aegis/group-pseudonym-generator.ts:94` (new section after `generateGroupIdentity`), `apps/api/src/modules/aegis/aegis.service.ts:15-18,94-112` and the six identity sites (`:197`, `:231-238`, `:367`, `:401-408`, `:503`, `:531-538`)
- Test: both spec files, Aegis suite, 20 repeated runs

**Interfaces:**
- Consumes: `generateGroupIdentity(seed: number, locale: string): GroupIdentity`; `IdentityGroup { seed; firstName; lastName }`; `IdentityRegistry.loadSession/saveSession` (test only).
- Produces: exported `MAX_IDENTITY_DRAWS = 32` (moved from `aegis.service.ts`) and `nextGroupIdentity(taken: ReadonlySet<string>, locale: string, drawSeed: () => number): GroupIdentity` in `group-pseudonym-generator.ts`; module-private `drawGroupIdentity(session: PiiSession, locale: string): GroupIdentity` and `identityOf(group: IdentityGroup): GroupIdentity` in `aegis.service.ts` (they replace `drawGroupSeed`).

Each locale has 20 first names and 20 surnames, so 400 full names. `drawGroupSeed` gave up after 32 random draws and then returned a seed whose name could be taken; with 390 groups a new group finds one of the 10 free names within 32 draws only about 55 % of the time (1 - 0.975^32), and from 400 groups on never. Now the 32 random draws are followed by a fixed-order search through the pool names and then double-barrelled surnames (20 x 380 more), 8,000 names per locale; a session that uses them all fails closed with `Aegis identity space exhausted for this session`. A fallback name is not what `generateGroupIdentity(seed)` would produce, so matched entities must derive their pseudonyms from the group's stored names; the three `generateGroupIdentity(group.seed, locale)` re-derivations become `identityOf(group)` (identical for every group created before this change).

- [ ] **Step 1: Write the failing tests**

Create `/Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api/src/modules/aegis/__tests__/group-identity-space.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTITY_DRAWS,
  generateGroupIdentity,
  nextGroupIdentity,
} from '../group-pseudonym-generator';

const DE_FIRST = [
  'Anna', 'Max', 'Sophie', 'Lukas', 'Emma', 'Leon', 'Mia', 'Paul',
  'Hannah', 'Felix', 'Lena', 'Tobias', 'Marie', 'Jonas', 'Katharina',
  'Maximilian', 'Laura', 'Tim', 'Sarah', 'Niklas',
];
const DE_LAST = [
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner',
  'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Richter', 'Wolf', 'Schröder',
  'Neumann', 'Braun', 'Krüger', 'Hartmann', 'Lange', 'Werner',
];
const MAX_NEUMANN = 1000;
const fullName = (identity: { firstName: string; lastName: string }) =>
  `${identity.firstName} ${identity.lastName}`;
const everyBaseName = () => new Set(
  DE_LAST.flatMap((last) => DE_FIRST.map((first) => `${first} ${last}`)),
);
let counter = 0;
const nextSeed = () => (counter = (counter * 1103515245 + 12345) & 0x7fffffff) || 1;

describe('Aegis identity space', () => {
  it('keeps the first free random identity', () => {
    const taken = new Set<string>();
    const identity = nextGroupIdentity(taken, 'de', () => MAX_NEUMANN);
    expect(identity).toEqual(generateGroupIdentity(MAX_NEUMANN, 'de'));
    expect(fullName(identity)).toBe('Max Neumann');
  });

  it('searches the base names in order once every random draw collides', () => {
    const taken = everyBaseName();
    taken.delete('Tim Werner');
    let draws = 0;
    const identity = nextGroupIdentity(taken, 'de', () => {
      draws += 1;
      return MAX_NEUMANN;
    });
    expect(draws).toBe(MAX_IDENTITY_DRAWS);
    expect(identity).toEqual({ firstName: 'Tim', lastName: 'Werner', seed: MAX_NEUMANN });
  });

  it('extends a used-up base space with double-barrelled surnames', () => {
    const identity = nextGroupIdentity(everyBaseName(), 'de', () => MAX_NEUMANN);
    expect(identity).toEqual({
      firstName: 'Anna',
      lastName: 'Müller-Schmidt',
      seed: MAX_NEUMANN,
    });
  });

  it('gives 450 people 450 distinct full names', () => {
    counter = 7;
    const taken = new Set<string>();
    for (let index = 0; index < 450; index++) {
      const name = fullName(nextGroupIdentity(taken, 'de', nextSeed));
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
    expect(taken.size).toBe(450);
  });

  it('fails closed instead of sharing a name when the whole space is used', () => {
    const taken = everyBaseName();
    for (const left of DE_LAST) {
      for (const right of DE_LAST) {
        if (left === right) continue;
        for (const first of DE_FIRST) taken.add(`${first} ${left}-${right}`);
      }
    }
    expect(taken.size).toBe(8_000);
    expect(() => nextGroupIdentity(taken, 'de', () => MAX_NEUMANN))
      .toThrow('Aegis identity space exhausted for this session');
  });
});
```

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
+++ b/apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
@@ -1,6 +1,7 @@
 import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
 import { AegisService } from '../aegis.service';
 import { generateGroupIdentity } from '../group-pseudonym-generator';
+import type { IdentityRegistry } from '../identity-registry';
 import { transliterate } from '../identity-group';
 import type { PiiEntity } from '../detectors/regex.detector';
 
@@ -604,5 +605,30 @@
       await expect(service.rehydrate(sessionId, 'Max Neumann'))
         .resolves.toEqual({ rehydrated: 'Maria Schmidt' });
     });
+
+    it('derives later pseudonyms of a group from the names it was created with', async () => {
+      const { sessionId } = await service.createSession('tenant-1', 'app-1', 'de');
+      injectPresidioMock(service, createPersonDetector(['Maria Schmidt']));
+      vi.spyOn(Math, 'random').mockReturnValueOnce(drawFor(MAX_NEUMANN));
+      await service.scan(sessionId, 'Maria Schmidt ist Kundin', ['de', 'en']);
+
+      // A group named from the extended identity space keeps its seed but not
+      // the seed's generated names. Simulate one by renaming the stored group.
+      const { registry } = service as unknown as { registry: IdentityRegistry };
+      const session = (await registry.loadSession(sessionId))!;
+      session.groups[0].firstName = 'Anna';
+      session.groups[0].lastName = 'Müller-Schmidt';
+      await registry.saveSession(sessionId, session);
+
+      const turn = await service.scan(
+        sessionId,
+        'Die Email von Maria Schmidt ist maria.schmidt@firma.de',
+        ['de', 'en'],
+      );
+
+      const email = Object.entries(turn.reverseMap)
+        .find(([, original]) => original === 'maria.schmidt@firma.de')?.[0];
+      expect(email?.split('@')[0]).toBe('anna.mueller-schmidt');
+    });
   });
 });
PATCH
```

- [ ] **Step 2: Run and see RED**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/aegis/__tests__/group-identity-space.spec.ts 2>&1 | grep -E "^ +Tests |TypeError" | uniq
./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts 2>&1 | grep -E "^ +Tests |AssertionError: expected 'max"
```

Expected: `TypeError: (0 , nextGroupIdentity) is not a function` and `Tests  5 failed (5)`; e2e `Tests  1 failed | 12 passed (13)` with `expected 'max.neumann' to be 'anna.mueller-schmidt'` (the e-mail is still derived from the seed's names).

- [ ] **Step 3: Minimal implementation**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/apps/api/src/modules/aegis/group-pseudonym-generator.ts
+++ b/apps/api/src/modules/aegis/group-pseudonym-generator.ts
@@ -91,6 +91,55 @@
   const lastName = lasts[Math.floor(rng() * lasts.length)];
 
   return { firstName, lastName, seed };
+}
+
+// ---------------------------------------------------------------------------
+// nextGroupIdentity
+// ---------------------------------------------------------------------------
+
+/** Random seeds drawn before the name space is searched in a fixed order. */
+export const MAX_IDENTITY_DRAWS = 32;
+
+/**
+ * Pick the identity for a new identity group so that no two groups of one
+ * session ever share a full name (the PERSON pseudonym). Random seeds keep
+ * pseudonyms unpredictable. Once MAX_IDENTITY_DRAWS draws all collide, the
+ * locale's names are searched in a fixed order: every pool name first, then
+ * double-barrelled surnames ("Müller-Schmidt"), 8,000 names per locale in
+ * all. The last drawn seed is kept, so the group's other pseudonyms stay
+ * random. A session that has used up even that space fails closed rather
+ * than give a second person someone else's name.
+ */
+export function nextGroupIdentity(
+  taken: ReadonlySet<string>,
+  locale: string,
+  drawSeed: () => number,
+): GroupIdentity {
+  let seed = drawSeed();
+  for (let draw = 1; ; draw++) {
+    const identity = generateGroupIdentity(seed, locale);
+    if (!taken.has(`${identity.firstName} ${identity.lastName}`)) return identity;
+    if (draw === MAX_IDENTITY_DRAWS) break;
+    seed = drawSeed();
+  }
+
+  const isDE = locale === 'de';
+  const firsts = isDE ? DE_FIRST : EN_FIRST;
+  const lasts = isDE ? DE_LAST : EN_LAST;
+  const surnames = [
+    ...lasts,
+    ...lasts.flatMap((left) => lasts
+      .filter((right) => right !== left)
+      .map((right) => `${left}-${right}`)),
+  ];
+  for (const lastName of surnames) {
+    for (const firstName of firsts) {
+      if (!taken.has(`${firstName} ${lastName}`)) {
+        return { firstName, lastName, seed };
+      }
+    }
+  }
+  throw new Error('Aegis identity space exhausted for this session');
 }
 
 // ---------------------------------------------------------------------------
--- a/apps/api/src/modules/aegis/aegis.service.ts
+++ b/apps/api/src/modules/aegis/aegis.service.ts
@@ -13,8 +13,9 @@
   type PiiSession,
 } from './identity-group';
 import {
-  generateGroupIdentity,
   deriveGroupPseudonym,
+  nextGroupIdentity,
+  type GroupIdentity,
 } from './group-pseudonym-generator';
 
 // ---------------------------------------------------------------------------
@@ -92,24 +93,33 @@
   }
 }
 
-const MAX_IDENTITY_DRAWS = 32;
-
 /**
- * Draw the seed for a new identity group. Re-draws (bounded) while the
- * generated full name already belongs to another group of this session, so
- * two people never share one PERSON pseudonym.
+ * Pick the identity for a new identity group of this session. No two groups
+ * ever share one PERSON pseudonym, however many people the session holds
+ * (see nextGroupIdentity).
  */
-function drawGroupSeed(session: PiiSession, locale: string): number {
+function drawGroupIdentity(session: PiiSession, locale: string): GroupIdentity {
   const taken = new Set(
     session.groups.map((group) => `${group.firstName} ${group.lastName}`),
   );
-  let seed = (Math.random() * 0x7fffffff) | 0 || 1;
-  for (let draw = 1; draw < MAX_IDENTITY_DRAWS; draw++) {
-    const { firstName, lastName } = generateGroupIdentity(seed, locale);
-    if (!taken.has(`${firstName} ${lastName}`)) break;
-    seed = (Math.random() * 0x7fffffff) | 0 || 1;
-  }
-  return seed;
+  return nextGroupIdentity(
+    taken,
+    locale,
+    () => (Math.random() * 0x7fffffff) | 0 || 1,
+  );
+}
+
+/**
+ * The identity a group was created with. Its names are stored rather than
+ * re-derived from the seed, because a group named from the extended identity
+ * space does not carry its seed's generated names.
+ */
+function identityOf(group: IdentityGroup): GroupIdentity {
+  return {
+    seed: group.seed,
+    firstName: group.firstName,
+    lastName: group.lastName,
+  };
 }
 
 // ---------------------------------------------------------------------------
@@ -194,7 +204,7 @@
       const groupEntry = group.entities[entity.value];
       if (!groupEntry) {
         // Entity not yet in this group — derive a new pseudonym within the existing group
-        const identity = generateGroupIdentity(group.seed, locale);
+        const identity = identityOf(group);
         const existingPseudonyms = Object.keys(session.reverseIndex);
         const pseudonym = deriveGroupPseudonym(
           identity,
@@ -227,14 +237,13 @@
       const clusters = clusterEntities(unmatched, text);
 
       for (const cluster of clusters) {
-        // Generate a new identity group with a random seed
-        const seed = drawGroupSeed(session, locale);
-        const identity = generateGroupIdentity(seed, locale);
+        // Generate a new identity group with an identity no group holds yet
+        const identity = drawGroupIdentity(session, locale);
         const groupId = `ig_${session.groups.length}`;
 
         const group: IdentityGroup = {
           id: groupId,
-          seed,
+          seed: identity.seed,
           firstName: identity.firstName,
           lastName: identity.lastName,
           entities: {},
@@ -364,7 +373,7 @@
         forwardMapping[entity.value] = groupEntry.pseudonym;
       } else {
         // Entity not yet in this group — derive a new pseudonym
-        const identity = generateGroupIdentity(group.seed, locale);
+        const identity = identityOf(group);
         const existingPseudonyms = Object.keys(session.reverseIndex);
         const pseudonym = deriveGroupPseudonym(
           identity,
@@ -398,13 +407,12 @@
       const clusters = clusterEntities(unmatched, textToScan);
 
       for (const cluster of clusters) {
-        const seed = drawGroupSeed(session, locale);
-        const identity = generateGroupIdentity(seed, locale);
+        const identity = drawGroupIdentity(session, locale);
         const groupId = `ig_${session.groups.length}`;
 
         const group: IdentityGroup = {
           id: groupId,
-          seed,
+          seed: identity.seed,
           firstName: identity.firstName,
           lastName: identity.lastName,
           entities: {},
@@ -500,7 +508,7 @@
         if (groupEntry) {
           forwardMapping[entity.value] = groupEntry.pseudonym;
         } else {
-          const identity = generateGroupIdentity(group.seed, locale);
+          const identity = identityOf(group);
           const existingPseudonyms = Object.keys(session.reverseIndex);
           const pseudonym = deriveGroupPseudonym(
             identity, entity.type, locale, entity.value, existingPseudonyms,
@@ -528,13 +536,12 @@
         const clusters = clusterEntities(unmatched, textToScan);
 
         for (const cluster of clusters) {
-          const seed = drawGroupSeed(session, locale);
-          const identity = generateGroupIdentity(seed, locale);
+          const identity = drawGroupIdentity(session, locale);
           const groupId = `ig_${session.groups.length}`;
 
           const group: IdentityGroup = {
             id: groupId,
-            seed,
+            seed: identity.seed,
             firstName: identity.firstName,
             lastName: identity.lastName,
             entities: {},
PATCH
```

- [ ] **Step 4: Run and see GREEN, then prove stability**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform/apps/api
./node_modules/.bin/vitest run src/modules/aegis/__tests__/group-identity-space.spec.ts src/modules/aegis/__tests__/identity-group-e2e.spec.ts 2>&1 | grep -E "Test Files|Tests "
./node_modules/.bin/vitest run src/modules/aegis 2>&1 | grep -E "Test Files|Tests "
grep -c "drawGroupSeed\|generateGroupIdentity" src/modules/aegis/aegis.service.ts
for i in $(seq 1 20); do ./node_modules/.bin/vitest run src/modules/aegis/__tests__/identity-group-e2e.spec.ts src/modules/aegis/__tests__/group-identity-space.spec.ts > /dev/null 2>&1 || echo "run $i failed"; done
bun run typecheck > /dev/null 2>&1; echo "typecheck=$?"
./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests "
```

Expected: `Test Files  2 passed (2)`, `Tests  18 passed (18)`; `Test Files  11 passed (11)`, `Tests  186 passed | 10 skipped (196)`; `0`; the loop prints nothing; `typecheck=0`; full API `Test Files  116 passed (116)`, `Tests  1153 passed | 10 skipped (1163)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add apps/api/src/modules/aegis/group-pseudonym-generator.ts apps/api/src/modules/aegis/aegis.service.ts apps/api/src/modules/aegis/__tests__/group-identity-space.spec.ts apps/api/src/modules/aegis/__tests__/identity-group-e2e.spec.ts
git commit -m "fix(aegis): never share a full pseudonym beyond the random draws"
```

---

### Task 22: Docs – record the resolved Aegis flake in the working document

**Files:**
- Modify: `docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md:129-130`, `:1548-1549`, `:2369-2371`, append section 20 after line 3064
- Test: grep checks in Step 2

**Interfaces:** none (docs only). The document is the canonical pilot working document; the three places still describe the flake as open.

- [ ] **Step 1: Apply the edit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git apply <<'PATCH'
--- a/docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md
+++ b/docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md
@@ -127,7 +127,8 @@
   One order-dependent flake was observed once in the deferred Aegis
   `identity-group-e2e` spec; it passes in isolation and on a full re-run, does
   not import anything changed here, and is recorded as a pre-existing
-  follow-up rather than a Task 6 regression.
+  follow-up rather than a Task 6 regression. Resolved on 2026-10-04 by
+  `18ff671` and `39f0eeb` (section 20).
 - Platform commit `acb5d90` completes Task 7. A reviewed setup artifact now
   derives immutable tool, planner, prompt-metadata, and app-configuration
   drafts in one flow; an artifact that is not reviewed, or that targets
@@ -1546,7 +1547,8 @@
   nondeterministic Aegis case also reproduced: overlapping pseudonym variants
   recursively rewrote newly rehydrated original text. Rehydration now performs
   one simultaneous longest-first replacement pass, with deterministic
-  regression coverage;
+  regression coverage. The separate collision flake that remained after this
+  fix is resolved in section 20;
 - at that rollback/STT checkpoint, repository-wide verification was green:
   SDK 65 files/459 tests plus
   typecheck, ESM/CJS build, and 16 public subpath shims; Platform DB 53 tests,
@@ -2368,7 +2370,8 @@
   suite passes 90 tests; Citadel passes 240 tests plus typecheck and production
   build. The full API suite has one pre-existing nondeterministic Aegis
   multi-person pseudonym test that failed only in the full run and passed all
-  six isolated retries; the runtime rehearsal targets remain green. Diff,
+  six isolated retries (resolved on 2026-10-04 by `18ff671` and `39f0eeb`,
+  section 20); the runtime rehearsal targets remain green. Diff,
   whitespace, and bounded secret-literal audits are clean.
 - No server or browser task was performed in this batch. No additional real
   rehearsal was run after the evidence boundary was corrected, and no new
@@ -3062,3 +3065,29 @@
 full upstream GID features/settings, keyboard/focus/live STT parity and remaining
 three-stack setup/change, fresh-agent timing, performance/token/bundle/rollback,
 Platform UX/metrics/tiers and landingpage gates. Full Goal remains active.
+
+## 20. Aegis pseudonym collisions resolved — 2026-10-04
+
+- Root cause of the 2-4 % `identity-group-e2e` flake recorded as open in
+  sections 1, 8 and 15: every new identity group drew a random seed from a
+  20 x 20 name pool per locale. Two people in one session could share a
+  generated surname (about 5 % of two-person sessions) or the full pseudonym
+  (1 in 400 per pair). The later group then took over "Herr Neumann" or the
+  full name, so rehydration could put the wrong person into tool arguments.
+- Platform `18ff671` (`fix(aegis): keep surname variants with their first
+  identity group`): a variant that already resolves to another original is
+  never re-pointed, in `scan`, `shieldResult` and `shieldResults`.
+- Platform `39f0eeb` (`fix(aegis): never give two identity groups one full
+  pseudonym`): a new group re-draws (bounded) while its generated full name
+  is taken.
+- Deterministic tests replace the flake: they force each collision by spying
+  on `Math.random`. MVP plan P01 measured the API suite at 1,130 passed plus
+  10 skipped and 20 consecutive green runs of the spec.
+- Follow-ups from MVP plan P08a (`test(aegis): pin pseudonym collisions at
+  every group-creation site`, `fix(aegis): never share a full pseudonym
+  beyond the random draws`): the batched tool-result test proves the
+  collision really happened, each group-creation path has its own regression
+  test, and a session whose random draws all collide continues through the
+  pool names and then double-barrelled surnames in a fixed order (8,000 names
+  per locale) before it fails closed. Later pseudonyms of a group derive from
+  its stored names.
PATCH
```

- [ ] **Step 2: Verify**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
F=docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md
grep -c "section 20" "$F"
grep -c "^## 20. Aegis pseudonym collisions resolved — 2026-10-04" "$F"
git diff --numstat -- "$F"
git status --short
```

Expected: `3`; `1`; `32	3	docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md`; status lists only that file.

- [ ] **Step 3: Commit**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
git add docs/plans/2026-07-29-glirastes-foundation-pilot-working-document.md
git commit -m "docs(plans): record the resolved aegis pseudonym flake"
```

---

### Task 23: P08a gate run and checkpoint (no commit)

**Files:** none modified. **Interfaces:** none.

- [ ] **Step 1: Platform gates**

```bash
cd /Users/philipprollmann/Dev/chainmatics/glirastes-platform/.worktrees/mvp-platform
pgrep -fl -- "nest start|next dev|vitest --watch" | grep mvp-platform || echo "no watcher"
(cd packages/db && ./node_modules/.bin/tsc -p tsconfig.json && echo "db-build=0")
(cd apps/api && bun run typecheck > /dev/null 2>&1; echo "api-typecheck=$?")
(cd apps/api && ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests ")
(cd apps/citadel && ./node_modules/.bin/tsc --noEmit; echo "citadel-tsc=$?")
(cd apps/citadel && ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests ")
(cd apps/citadel && L="$(mktemp -d)" && bun run lint > "$L/lint.log" 2>&1; echo "citadel-lint=$?"; grep problems "$L/lint.log")
(cd packages/db && bun test 2>&1 | tail -4)
(cd packages/db && bun test src/__tests__/migrations-from-scratch.test.ts src/__tests__/migration-baseline.test.ts 2>&1 | tail -3)
(cd packages/db && DATABASE_URL=postgres://offline.invalid/unused ./node_modules/.bin/drizzle-kit check 2>&1 | tail -1)
git status --short
git log --oneline 39f0eeb..HEAD | wc -l
```

Expected: `no watcher`; `db-build=0`; `api-typecheck=0`; API `Test Files  116 passed (116)`, `Tests  1153 passed | 10 skipped (1163)`; `citadel-tsc=0`; Citadel `Test Files  39 passed (39)`, `Tests  256 passed (256)`; `citadel-lint=0`, `✖ 30 problems (0 errors, 30 warnings)`; DB `101 pass`, `0 fail`, `Ran 101 tests across 19 files.`; the migration pair `6 pass`, `0 fail`; `Everything's fine 🐶🔥`; empty status; `22` commits. All numbers were measured on 2026-10-04 in a full copy of `39f0eeb` with every patch of this plan applied.

- [ ] **Step 2: Checkpoint report to Philipp**

Report the 22 commits with hashes, the gate numbers above, the decisions table from the top of this plan, and these approval requests (none of them is executed by an agent):

1. **Migration baseline on the shared database** before the next `bun run db:migrate`: the runbook in `packages/db/MIGRATIONS.md` (verification query, `bun scripts/print-migration-baseline.ts --through 0043_resumable_setup_publication`, review, run, then `db:migrate` must apply nothing).
2. **Pairing keys issued before Task 17** still carry `management` and never expire. Rotation copies label, scopes, app and the absolute expiry to a new key without linking it to the old one, so a rotated pairing key lives on as an unreferenced successor; the remediation therefore also matches successors (same tenant, app and label, created after a rotated pairing key). Proposed remediation, first the read-only preview, then the update with the same `WHERE` (checked on 2026-10-04 against a migrated PGlite with a rotated pairing key, its successor, a second pairing key and four keys that must stay untouched: the preview listed exactly the two open legacy keys and the update changed exactly those; cached contexts keep the old scopes for up to 300 s):

   ```sql
   WITH "pairing_keys" AS (
     SELECT "id", "tenant_id", "target_app_id", "label", "rotated_at", "created_at"
     FROM "api_keys"
     WHERE "id" IN (
       SELECT "api_key_id" FROM "runtime_connection_pairings" WHERE "api_key_id" IS NOT NULL
     )
   ), "rotated_successors" AS (
     SELECT "successor"."id"
     FROM "api_keys" AS "successor"
     JOIN "pairing_keys" AS "original"
       ON "successor"."tenant_id" = "original"."tenant_id"
      AND "successor"."target_app_id" = "original"."target_app_id"
      AND "successor"."label" = "original"."label"
      AND "original"."rotated_at" IS NOT NULL
      AND "successor"."created_at" > "original"."created_at"
   )
   SELECT "id", "label", "scopes", "created_at"
   FROM "api_keys"
   WHERE "revoked_at" IS NULL
     AND "expires_at" IS NULL
     AND "scopes" @> ARRAY['management']::text[]
     AND (
       "id" IN (SELECT "id" FROM "pairing_keys")
       OR "id" IN (SELECT "id" FROM "rotated_successors")
     )
   ORDER BY "created_at";
   ```

   After review, the same statement with the final `SELECT ... ORDER BY` replaced by:

   ```sql
   UPDATE "api_keys"
   SET "scopes" = ARRAY['runtime']::text[],
       "expires_at" = now() + interval '90 days'
   WHERE "revoked_at" IS NULL
     AND "expires_at" IS NULL
     AND "scopes" @> ARRAY['management']::text[]
     AND (
       "id" IN (SELECT "id" FROM "pairing_keys")
       OR "id" IN (SELECT "id" FROM "rotated_successors")
     );
   ```

   (`created_at` of a successor is compared with the original's `created_at`, not its `rotated_at`: the successor's `created_at` is the database's transaction start, which can precede the application-side `rotated_at` by milliseconds.)
3. **Ruling on `backfill-target-apps.sql`**: keep it in `drizzle/` as documented history, or move it to `packages/db/scripts/`.
4. **Broader authorization finding** (out of P08a scope, for P08b/P13): management routes check scopes but not the dashboard member role; `allowedRoles` on `@AiTool` is catalogue metadata only (for example `POST /v1/tenant/team/invite` accepts any dashboard member). Several management modules also never compare an API key's `targetAppId` (for example `/v1/webhooks`, billing and optimizer routes), so a one-day setup credential or an unremediated legacy pairing key still reaches them tenant-wide. P08a closed `/v1/apps`, API keys and team/tenant routes for app-bound keys only.
5. **Owner for the Pro activation command**: spec 7 lists "a secured admin command for the plan switch, no manual database edit" under Platform-Hygiene as a release prerequisite, but no roadmap row owns it and P08a does not build it. Proposed: P08b or P13.

Do not push.

---

## Self-Review

**Spec coverage**

| Spec item | Task |
| --- | --- |
| 7 Platform-Hygiene: register `0036`-`0043`, catch up snapshots, document and test the migration strategy against a disposable PostgreSQL (PGlite) | 1, 2, 3, 4, 5, 6 |
| 7: then `0044` (P08b) can be generated as `0044` against a current snapshot | 4 (journal ends at `idx` 43, snapshot `0043`) |
| 7: repair the API typecheck, isolate the Advisor instantiation explosion without deleting the module, fix the 103 type errors, typecheck as a gate | 7, 8, 9, 10, 11, 12, 13 (measured with the Advisor chain excluded: 20 source, 78 spec, 5 script errors = 103; the spec config removes the 7 TS1343 `import.meta` errors and Task 8 the MCP TS2589, leaving the 19 + 76 that Task 9 records; the gate is `bun run typecheck` in `apps/api` and `turbo run typecheck` at the root) |
| 7: pairing key limited to `runtime`, expiry/rotation | 17 (policy in Task 17 intro; rotation semantics from `784ac72`, `67cc575`, `c860d10`) |
| 7: `/v1/apps` checks app scope, test first that proves the gap | 15, 16 |
| 7 Verbinden: deny path in API and UI; code prefilled via `user_code`; clear message for `connected_free_limit_reached` | 18, 19 |
| 7: ESLint config for Citadel | 14 |
| 7 / roadmap: Aegis collision fixed (P01) plus open follow-ups: batched test proves the collision, `drawGroupSeed` regressions at `shieldResult`/`shieldResults`, exhaustion at ≥ 400 groups | 20, 21 |
| Roadmap: canonical working document records the Aegis fix (`18ff671`, `39f0eeb`) | 22 |
| 1 Erfolgskriterium 6 (all Platform suites, typechecks and lints green) for the P08a scope | 23 |

Deliberately not in P08a (roadmap P08b and later): `/connect` and `/manage` redesign along the five questions, bounded overrides and migration `0044`, policy revisions, capability report and view, the CI key scope `ci` (P10), a CI workflow file (the repository has only the deploy workflow; adding a test workflow needs the GitHub Packages token and belongs to P13), Pro activation command (spec 7 lists it under Platform-Hygiene as a release prerequisite, but no roadmap row owns it yet; Task 23 asks Philipp to assign it), and the `glirastes connect` framework detection from `tools.json` (SDK).

**Placeholder scan:** done. Every code step carries the exact patch or file content. All patches were generated against `39f0eeb` (`git archive` of the foundation worktree) and applied cumulatively with `git apply --check` and `git apply` in a scratch repository, task by task. Measured in scratch copies on 2026-10-04: each RED and GREEN count quoted above; the API type error counts after Tasks 9-13 (19/95 → 7/83 → 0/76 → 0/37 → 0/0); the single-file probes (Advisor `exit=142` before, 73,388 instantiations after; MCP TS2589 with 5,237,954 before, 45,995 after); PGlite 0.5.8 applying all 46 migrations in about 2-3 s; `drizzle-kit generate` re-emitting 245 statements before and "No schema changes" after the snapshot; the runbook query returning `true` for all ten objects; `bun add` diffs (`bun.lock` +3 and +1 lines); ESLint `40 problems (10 errors, 30 warnings)` → `5 files 10 suppressed` → `0 errors, 30 warnings`, both probes exit 1; the per-site Aegis mutations; and, in a full copy with a fresh `bun install --frozen-lockfile`, the final gate numbers of Task 23. Plan check (2026-10-05): after the review fixes (pending-only deny, source scan in the wiring spec, batched `Neumann` pin, `next/link`, package.json patch, remediation SQL for rotated keys, RED greps that keep the summary line), every bash block and file of Tasks 0-23 was executed in order in a fresh `git archive` copy of `39f0eeb` with its own install; every quoted count matched, only wall-clock times varied with machine load. Every bash block starts with an absolute `cd`; no step deletes a file with `rm`; no step reads `.env*`, `.secrets/` or `.npmrc`, and no `drizzle-kit` call can load a `.env` file.

**Type consistency:** done. `migrationBaselineSql(migrationsFolder: string, throughTag: string): string` is used identically by the test and the CLI. `TENANT_WIDE_ONLY`/`TenantWideOnly()` and `APP_SCOPED_RUNTIME_KEY`/`AllowAppScopedRuntimeKey()` are defined once (Task 15) and used by the guard, the wiring spec and four controllers (Task 16). `RuntimeConnectStore.deny(userCodeHash: string, now: Date): Promise<boolean>` matches `DrizzleRuntimeConnectStore.deny` and the service call; `PAIRING_KEY_LIFETIME_DAYS = 90` is the only lifetime literal (the store test asserts `90`). `denyRuntimePairing` and `pairingFailureMessage(error: unknown, fallback: string): string` match their tests and the page. `nextGroupIdentity(taken: ReadonlySet<string>, locale: string, drawSeed: () => number): GroupIdentity` and `MAX_IDENTITY_DRAWS` are imported by the new spec; `drawGroupIdentity`/`identityOf` replace every `drawGroupSeed`/`generateGroupIdentity` use in `aegis.service.ts` (grep count `0`). `DeployLatestPublishedResult.deployment: RuntimeDeploymentRecord` satisfies `publish-and-deploy.service.ts`'s `{ id; healthStatus }` use. P08a consumes the SDK's unpublished pairing contract read-only and changes no SDK file.
