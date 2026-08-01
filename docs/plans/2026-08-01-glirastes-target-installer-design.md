# Glirastes Target Installer — Design

**Date:** 2026-08-01
**Status:** Proposed
**Extends:** `2026-07-28-glirastes-foundation-design.md` and the Platform's
`2026-07-30-glirastes-app-setup-assessment-and-prompt-rollouts-design.md`
(§ *Setup skills are optional and host-selectable*). Nothing here overrides
either; this document fills in the installer those two assume.

## Outcome

After `npm install glirastes`, one guided command carries a fresh target app from
nothing to a synced setup run. The operator is never required to know which
sub-commands exist, never has to hand-assemble an execution inventory, and never
needs an external account to complete the default path.

The five-minute goal from the Foundation design applies here: a newly scanned
application reaches its first successful tool action in under five minutes,
without decorators or manually maintained annotations.

## The problem this solves

Every step of the Foundation onboarding already exists as a separate command:

| Step | Today |
|---|---|
| Install agent skills | `glirastes install [--host] [--with-setup-skills]` |
| Discover local executions | `glirastes setup scan` |
| Assess, describe, propose roles, draft prompts | the `setting-up-glirastes` skill, run by hand in the host agent |
| Validate the artifact | `glirastes validate` |
| Upload to the control plane | `glirastes setup sync` |

Nothing composes them. The operator must know the order, the flags, and that an
assessment step happens outside the CLI entirely. The pilot proved the chain
works; it did not make it discoverable.

## Decisions

### D1 — The guided flow is `glirastes setup` with no subcommand

`setup` is already the Foundation namespace (`scan`, `sync`, `status`). Invoking
it bare runs the wizard; the subcommands remain the individual, scriptable steps.

The name `init` is deliberately **not** reused. It carries the meaning of the
retired scaffolding command that wrote nine files into the consumer's project,
and this installer scaffolds nothing.

Non-interactive use stays fully supported: every prompt has a corresponding flag,
and the wizard refuses to run without a TTY unless every required flag is given.

### D2 — The default path needs no external account

The wizard's default assessment mode is **interview**, and the interview runs
inside the coding agent the operator already has — that is what the host choice
(Codex, Claude, Gemini) is for. No API key, no egress, no account.

**Autonomous** mode is the only path that needs a model of its own. It is a
distinct, explicitly confirmed choice, and when the operator picks it without a
configured provider the wizard explains what will leave the machine, links
`https://openrouter.ai/keys`, and stores the key locally in the ignored
`.glirastes/` directory. It never proceeds on an assumed credential, and the
Platform is never a proxy.

This keeps the design's "installer-confirmed setup-only egress" property intact
while making the zero-configuration case the default rather than the exception.

### D2a — Three assessment modes, and the setup skill follows from the mode

The 2026-07-30 design asks whether setup skills should be installed. That
question has no answer worth asking: **interview and autonomous are both carried
out by the setup skill**, so both require it. Offering it as a choice invites an
operator to decline the thing that performs the step they just picked.

The mode is therefore the only question, and it has three answers:

| Mode | Setup skill | Needs a provider |
|---|---|---|
| `interview` | installed — it conducts the interview | no |
| `autonomous` | installed — it performs the assessment | yes |
| `manual` | not installed | no |

`manual` is the way out for an operator who writes the setup artifact
themselves. It is the only mode where the skill is genuinely optional, and it is
the case the earlier yes/no question was really reaching for. In manual mode the
wizard does not ask for a host at all, and points at the artifact contract in the
skill, which can still be installed on its own at any time.

### D2b — Several agent hosts at once

The 2026-07-30 design requires that "the user selects exactly one supported local
agent host", and its acceptance asserts it. **That constraint is lifted.** A
developer who uses more than one agent gets the skills in each; nothing about the
skills is host-specific beyond the directory they land in, so the restriction
bought nothing.

Each host keeps its own directory and its own manifest record. Installing for one
host never disturbs what another has, and a skill is classified per host — a
skill installed for Claude is `unmanaged` from Codex's point of view rather than
silently shared.

`--target` remains single-host: several hosts each need their own directory, so
pointing them all at one is an error rather than a race.

### D3 — Parts are selectable, and the selection is derived, not asked blindly

The installer detects the stack and proposes a selection the operator confirms or
edits, rather than presenting an unexplained menu.

| Part | Default | Depends on |
|---|---|---|
| Framework integration skill | selected when the stack is detected | Next.js detected |
| Chat UI skill | selected when a React chat surface is wanted | operator confirms |
| Tool maintenance skill | selected | — |
| Setup skill | **implied by the assessment mode** (D2a), never asked | one or more hosts |
| Autonomous assessment | asked as a mode, default interview | provider credential |

`STACK_SKILL_MAP`'s current shape — `nextjs` and `all` resolving to an identical
three-skill list — is replaced by per-part resolution.

### D4 — Installed skills are recorded in a manifest

The 0.18.8 installer wrote `.managed.json`; the Foundation installer writes
nothing, so an installed skill is indistinguishable from an authored one. That
regression is reversed, with the content hash added:

```jsonc
// .glirastes/installed-skills.json
{
  "schemaVersion": 1,
  "sdkVersion": "0.4.0",
  "installs": [                  // one record per host (D2b)
    {
      "host": "claude",
      "target": ".claude/skills",
      "mode": "copy",            // or "symlink"
      "skills": {
        "integrating-glirastes-nextjs": {
          "files": [".claude/skills/integrating-glirastes-nextjs/SKILL.md"],
          "contentHash": "sha256:…"
        }
      }
    }
  ]
}
```

The hash makes refresh safe: a skill whose on-disk content still matches its hash
is upgraded silently; one the operator has edited is reported and left alone
unless `--force` is passed. An entry absent from the manifest is never touched.

The manifest lives under `.glirastes/`, not beside the skills, so it is
host-independent and does not pollute the host's skill directory.

### D5 — Empty skill directories are removed, not shipped

`integrating-glirastes-nestjs` and `integrating-glirastes-nextjs-with-nestjs-backend`
ship as directories with zero files. NestJS is a deferred surface under the
confirmed pilot cut, so the correct state is absence: remove both directories and
reintroduce them together with the NestJS surface and its own acceptance gate.

A packaging test asserts that every directory under `skills/` contains a
`SKILL.md`, so an empty skill cannot ship again.

### D6 — The chat UI skill is brought to usable depth

`building-glirastes-chat-ui` is 48 lines against the 572 of the family it
replaces. It covers the shipped UI, approvals, the speech-to-text gate, and
verification, and omits provider configuration, the styling levels, mentions,
voice input, approval card composition, the UI action bus, and window portals.
It is selectable as its own part (D3), which only pays off if it carries the
material the omitted topics need.

## Boundary

Unchanged and non-negotiable: prompts, model calls, tool arguments, tool results,
secrets, business data, and final authorization stay local. The installer adds no
egress of its own. The single exception is the autonomous assessment of D2, which
is explicit, confirmed, and goes directly from the local skill to the provider
under the customer's own agreement — never through the Platform.

The installer writes only into `.glirastes/`, the chosen host's skill directory,
and — with confirmation — the operator's local environment file. It scaffolds no
application source.

## Acceptance

**Guided flow**
- A fresh Next.js target reaches a synced setup run through the wizard alone,
  with no prior Glirastes knowledge and no external account.
- The same outcome is reachable non-interactively with flags only, and the wizard
  fails with a precise message rather than prompting when a TTY is absent.
- Every step is resumable: re-running after an interruption continues rather than
  restarting, and never duplicates a setup run.

**Parts**
- Each part installs independently; declining a part leaves no files from it.
- Codex, Claude, and Gemini targets each install correctly, singly or together.
- Installing for one host leaves every other host's record and files intact.
- Interview and autonomous both install the setup skill without asking; manual
  installs neither it nor anything host-specific, and asks for no host.
- Existing project files and unrelated skills are preserved.

**Manifest**
- A refresh upgrades unmodified skills and reports modified ones without
  overwriting them.
- `--force` overwrites, and says which files it replaced.
- Skills absent from the manifest are never modified or removed.

**Zero configuration**
- With no provider credential present, the default path completes end to end.
- Choosing autonomous assessment without a credential explains the egress, links
  the provider, and stops — it never proceeds on an assumed key.

**Packaging**
- Every shipped skill directory contains a `SKILL.md`.
- The published package contains the skills and no fixture secrets.
