---
name: upgrading-glirastes
description: Use when working on code that uses glirastes or after upgrading the glirastes package, when the refresh hint reports pending upgrade items, or when the developer asks what a new Glirastes version changes for the app.
---

# Upgrading Glirastes

Each Glirastes release can ship upgrade notes: breaking changes, deprecations,
recommended changes and optional features. `glirastes upgrade report` compares
the notes since the app's last review with the app's code and lists what applies,
with file and line evidence. Glirastes never calls a model; the coding agent does the work.
The report never changes code: you propose, the developer decides.

Run it:

- when `glirastes tools refresh` or `glirastes tools check` prints a line like
  `Glirastes 0.16.0 → 0.17.0: 1 must, 2 should, 0 recommended, 3 optional`;
- after the `glirastes` version in `package.json` changed;
- before you change code that uses glirastes.

## Boundaries

- Change nothing before the developer agrees to that item. Presenting an item
  is not consent to apply it.
- Never apply optional items unasked. Offer them in one line each and stop.
- Never edit `.glirastes/sdk-baseline.json` by hand. Only `glirastes upgrade
  decide` and `glirastes upgrade ack` write it.
- Run `glirastes upgrade ack` only after the developer confirms the review is
  done. Never use its force option unasked: it skips open breaking items, and
  the developer decides that.
- Never claim an impact the report does not show. Evidence comes from the
  report, not from guesses about the code.
- Never force-replace an edited installed skill; merge by hand.

## Workflow

1. Run `glirastes upgrade report --json` and read it. `upToDate: true` means
   nothing to do. `baselineAhead` means the baseline is newer than the installed
   SDK (a downgrade); report that and stop. `baselineMissing` means the review
   starts from the installed skills version, or from `--from <version>` when
   you pass it. With no baseline and no installed skills record, the review
   starts at the installed version and reports nothing; if the developer knows
   the version the app used before, run `glirastes upgrade report --from <version>`.
2. The groups are Must (breaking), Should (deprecated, plus edited skills that
   are behind), Recommended and Optional, only if wanted. Should and
   Recommended items the code does not touch (`not-affected`) are not listed.
   Breaking items without evidence appear under "Checked, no evidence found"
   (`checkedNotAffected`): name them in one line each, since a barrel
   re-export can hide a use. They do not block `ack`.
   JSON keys: `must`, `should` (plus `keptSkills`), `recommended`, `offer`
   (= "Optional, only if wanted") and `checkedNotAffected`.
3. For every Must, Should and Recommended item show the developer the id,
   the summary, the evidence (`file:line`) and the referenced skill section
   (`skill`, read it before you propose a change). `status: "unclear"` means
   the code could not prove the note applies or not; say so and check the
   evidence yourself. Propose the change from `howTo`.
4. Offer optional items in one line each (id and summary). Do not read the
   skill section or prepare a change until the developer picks one.
5. Ask before changing anything. Apply only what the developer accepted, then
   run `glirastes tools refresh` and `glirastes tools check`.
6. Record each choice: `glirastes upgrade decide <id> adopted`, `declined` or
   `deferred`. `deferred` keeps the item in every later report, also after
   `glirastes upgrade ack`; adopted and declined items drop out (`--all` lists
   them again). A deferred Must item no longer counts as open: `--fail-on
   breaking` and the doctor warning skip it, and the refresh hint labels it
   (`1 must (1 deferred)`).
7. Edited skills under Should (`skill:<name>`): `glirastes tools refresh`
   keeps an edited copy and the report names it. Merge the shipped changes
   from `node_modules/glirastes/skills/<name>` into the copy yourself. A copy you
   did not edit is replaced by `glirastes tools refresh` or `glirastes install`
   (never with the force option); `GLIRASTES_SKILLS_AUTO_UPDATE=0` stops that
   during a refresh.
8. `unclassified` lists versions without upgrade notes. Read that version's
   section in `node_modules/glirastes/CHANGELOG.md`, summarize it for the
   developer and make no claim about its impact on the app.
9. When the developer confirms the review is done, run `glirastes upgrade ack`.
   It refuses while a Must item has no decision. Show that message to the
   developer instead of working around it. Then commit the app changes, the
   refreshed `.glirastes` outputs and `.glirastes/sdk-baseline.json`.

## Commands

```bash
glirastes upgrade report --json
glirastes upgrade report --all
glirastes upgrade report --brief
glirastes upgrade report --from <version>
glirastes upgrade report --fail-on breaking
glirastes upgrade decide <note-id> adopted
glirastes upgrade decide <note-id> declined
glirastes upgrade decide <note-id> deferred
glirastes upgrade ack
```

`--brief` lists Must, Should and Recommended items and only counts the
optional ones. `--fail-on breaking` exits 1 while
a Must item has no decision (deferred counts as a decision), for CI. `--root <dir>` points any subcommand at another
app. `GLIRASTES_UPGRADE_HINT=0` removes the summary line from refresh and check.

`glirastes install --with-upgrade-hook` adds a Claude Code `SessionStart` hook
to `.claude/settings.json` that runs `glirastes upgrade report --brief`; offer
it, never add it unasked.

## Verification

- `glirastes upgrade report` shows no Must or Should item without a recorded
  decision, and every adopted item changed only after the developer agreed.
- `glirastes tools check` reports `Tool outputs match the code.`
- `.glirastes/sdk-baseline.json` changed only through `decide` and `ack`.
- The developer saw every optional item as an offer, and none was applied
  unasked.
