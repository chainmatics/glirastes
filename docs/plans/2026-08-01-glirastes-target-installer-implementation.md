# Glirastes Target Installer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task. Strict TDD: verify RED, minimal GREEN, then full suite,
> typecheck, and build. One logically separate Conventional Commit per task.

**Goal:** Ship the guided installer described in
`2026-08-01-glirastes-target-installer-design.md`, so a fresh target app reaches a
synced setup run through one command and no external account.

**Repository:** Glirastes SDK, branch `codex/glirastes-foundation-runtime`.

**Tech stack:** TypeScript strict (NodeNext ESM + CJS), Bun, Vitest, Zod 4.

**Verification per task:** `bunx vitest run <focused>` → `bun run typecheck` →
`bun run test` → `bun run build`. Consumers load from `dist/`, so the build is not
optional.

---

## Execution order

Tasks 1–3 are independent and may overlap. Task 4 needs 1 and 2. Task 5 needs 4.
Task 6 is independent. Task 7 needs all of them.

```
1 packaging gate ─┐
2 manifest ───────┼─→ 4 part resolution ─→ 5 wizard ─→ 7 end-to-end acceptance
3 remove NestJS ──┘                                   ↗
6 chat UI skill depth ────────────────────────────────┘
```

---

## Task 1: Refuse to ship an empty skill

**Files**
- Modify: `src/cli/commands/install-skills.test.ts`

**RED**
1. Add a packaging test that reads every directory under `skills/` and asserts
   each contains a readable `SKILL.md` with non-empty frontmatter `name` and
   `description`.
2. Run `bunx vitest run src/cli/commands/install-skills.test.ts`. It must fail on
   `integrating-glirastes-nestjs` and
   `integrating-glirastes-nextjs-with-nestjs-backend`, which contain zero files.

**GREEN**
3. Leave the directories in place for now — Task 3 removes them. Confirm the test
   names both, then mark it skipped with a comment pointing at Task 3, so the RED
   is recorded without blocking the suite.
4. Commit `test(cli): assert every shipped skill has a SKILL.md`.

## Task 2: Record installed skills in a manifest

**Files**
- Create: `src/cli/commands/installed-skills-manifest.ts`
- Create: `src/cli/commands/__tests__/installed-skills-manifest.test.ts`
- Modify: `src/cli/commands/install-skills.ts`

**RED**
1. Test that writing a manifest records schema version, host, target, mode, SDK
   version, and one entry per skill with its file list and content hash.
2. Test that reading a manifest classifies each skill as `unchanged` (hash
   matches), `modified` (hash differs), or `missing` (files gone).
3. Test that a skill absent from the manifest is classified `unmanaged` and is
   never a candidate for overwrite or removal.
4. Test that the hash is stable across line-ending differences and independent of
   file order.
5. Run the focused test; verify it fails for the missing module.

**GREEN**
6. Implement the manifest module with a Zod schema; write to
   `.glirastes/installed-skills.json`.
7. Have `installSkills` write the manifest after a successful install, and skip
   writing on `dryRun`.
8. Commit `feat(cli): record installed skills in a manifest`.

## Task 3: Remove the empty NestJS skill directories

**Files**
- Delete: `skills/integrating-glirastes-nestjs/`
- Delete: `skills/integrating-glirastes-nextjs-with-nestjs-backend/`
- Modify: `src/cli/commands/install-skills.test.ts`

**RED**
1. Un-skip the Task 1 packaging test. It fails on the two empty directories.

**GREEN**
2. Remove both directories.
3. Confirm nothing references them: grep `skills/`, `STACK_SKILL_MAP`,
   `package.json#files`, and the docs.
4. Re-run the packaging test; it passes.
5. Commit `chore(skills): drop the empty NestJS skill directories`, recording in
   the body that NestJS is a deferred surface and both return with it.

## Task 4: Resolve parts instead of a fixed stack list

**Files**
- Create: `src/cli/commands/installer-parts.ts`
- Create: `src/cli/commands/__tests__/installer-parts.test.ts`
- Modify: `src/cli/commands/install-skills.ts`
- Modify: `src/cli/commands/install-skills.test.ts`

**RED**
1. Test stack detection: a project with `next` in dependencies detects `nextjs`;
   one without detects nothing and proposes no framework part.
2. Test that each part resolves independently to its skill set — framework
   integration, chat UI, tool maintenance, setup skill — and that declining a
   part yields no files from it.
3. Test that the setup part requires exactly one host and rejects zero or two.
4. Test that an unknown part name is a precise error naming the valid parts.
5. Test backward compatibility: `--stack nextjs` and `--stack all` keep working
   and map onto the new part set.

**GREEN**
6. Implement part resolution and replace `STACK_SKILL_MAP` with it.
7. Keep `--stack` as a documented alias over the part set.
8. Commit `feat(cli): resolve installable parts from the detected stack`.

## Task 5: The guided `glirastes setup` wizard

**Files**
- Create: `src/cli/commands/setup-wizard.ts`
- Create: `src/cli/commands/__tests__/setup-wizard.test.ts`
- Modify: `src/cli/index.ts`

**RED**
1. Test that bare `setup` runs the wizard and that `setup scan|sync|status` still
   dispatch to the existing subcommands unchanged.
2. Test the step sequence: parts → host → scan → assessment mode → validate →
   sync, with each step's output feeding the next.
3. Test that without a TTY and without complete flags the command fails with a
   message naming the missing flags — and never prompts.
4. Test resumability: a wizard interrupted after `scan` continues from the
   assessment step on re-run and does not create a second setup run.
5. Test that choosing autonomous assessment with no provider credential prints
   the egress explanation and the `https://openrouter.ai/keys` link, then stops
   with a non-zero exit — it must not proceed on an assumed key.
6. Test that the default path — interview mode — completes with no credential and
   no network call other than the control-plane sync.

**GREEN**
7. Implement the wizard as a sequence of small, individually testable steps that
   delegate to the existing `installSkills`, discovery, validation, and
   `AppSetupClient` code. Add no second implementation of any of them.
8. Commit `feat(cli): add the guided setup wizard`.

## Task 6: Bring the chat UI skill to usable depth

**Files**
- Modify: `skills/building-glirastes-chat-ui/SKILL.md`
- Possibly create: `skills/building-glirastes-chat-ui/references/*.md`

**Steps**
1. Read the actual exported React surface — `src/react/index.ts`, the provider,
   components, hooks, the UI action bus, and `styles.css`. Document what exists,
   not what the old family had.
2. Cover the topics the current 48 lines omit: provider configuration, the styling
   levels, mentions, voice input, approval card composition, the UI action bus,
   and window portals.
3. Every code sample must typecheck against the current exports. Add a test that
   extracts fenced `ts` blocks and typechecks them, or keep samples minimal enough
   that the export names are asserted directly.
4. Commit `docs(skills): give the chat UI skill the depth its topics need`.

## Task 7: End-to-end acceptance against a fresh fixture

**Files**
- Create: `src/cli/__tests__/installer-e2e.test.ts`
- Create: fixture under `src/cli/__tests__/fixtures/fresh-nextjs-app/`

**RED**
1. Drive the whole wizard against the fixture with a stubbed control plane and a
   stubbed host agent, asserting a synced setup run at the end.
2. Assert the five-minute property as a wall-clock budget on the automated run,
   in the spirit of the existing timed rehearsal.
3. Assert the acceptance list from the design: parts install independently,
   unrelated skills are preserved, refresh upgrades unmodified skills and reports
   modified ones, `--force` says what it replaced, and the zero-configuration path
   completes.

**GREEN**
4. Fix whatever the acceptance run exposes.
5. Commit `test(cli): accept the guided installer end to end`.

---

## Out of scope

- Reintroducing the NestJS or LangGraph surfaces (Task 3 only removes empty
  directories; the surfaces return with their own acceptance gates).
- Any scaffolding of application source — the retired `init` behaviour stays
  retired.
- Platform-side changes. This plan touches the SDK only.
- Migrating `get-it-done`'s local `scripts/glirastes-*.ts` into the SDK. That is
  real and wanted, but it is its own piece of work with its own consumer-facing
  risk.
