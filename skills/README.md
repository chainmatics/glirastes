# Glirastes Agent Skills

Pre-built [agent skills](https://docs.claude.com/en/docs/claude-code/skills) that teach a coding agent (Claude Code, Codex, Cursor, …) how to integrate, maintain, and customize the Glirastes SDK in a real codebase. Drop them into your repo's `.claude/skills/` (or your agent's equivalent), and the agent picks the right one automatically based on the task.

Skills are a separate concept from `glirastes generate-skills`:

- **`generate-skills` (CLI command)** — turns *your tools* into skill files so external agents can call your tools.
- **These skills (this directory)** — instruct an agent on how to *integrate Glirastes itself* into a project.

## Available skills

| Skill | Use when |
|---|---|
| [`integrating-glirastes-nextjs`](./integrating-glirastes-nextjs/SKILL.md) | Adding chat to a Next.js App Router app where Next.js is the only backend. |
| [`integrating-glirastes-nestjs`](./integrating-glirastes-nestjs/SKILL.md) | Adding chat to a NestJS backend (with or without a separate frontend). |
| [`integrating-glirastes-nextjs-with-nestjs-backend`](./integrating-glirastes-nextjs-with-nestjs-backend/SKILL.md) | Full-stack setup: Next.js frontend in one workspace, separate NestJS backend in another. |
| [`maintaining-glirastes-tools`](./maintaining-glirastes-tools/SKILL.md) | Authoring `ai-tool.ts` / `ai-ui-tool.ts`, intent modules, codegen pipeline, all CLI commands. |
| [`building-glirastes-chat-ui`](./building-glirastes-chat-ui/SKILL.md) | Customizing the chat UI — theming, mentions, voice input, approval cards, action bus. |

The three `integrating-*` skills are mutually exclusive: pick the one that matches your stack. The other two are stack-agnostic.

## Installing into your project

These skills ship with the npm package, so they're always in sync with the SDK version you've installed. Use the bundled CLI installer:

```bash
# Project-local: all skills into ./.claude/skills (default)
npx glirastes install-skills

# Global: into ~/.claude/skills — picked up by every Claude Code session on this machine
npx glirastes install-skills --global         # short: -g

# Stack-filtered — only the skills relevant to your setup
npx glirastes install-skills --stack nextjs               # Next.js standalone
npx glirastes install-skills --stack nestjs               # NestJS standalone
npx glirastes install-skills --stack nextjs+nestjs        # Next.js + NestJS monorepo
npx glirastes install-skills --stack all                  # explicit "all" (default)

# Combine: global + stack filter
npx glirastes install-skills -g --stack nextjs+nestjs

# Different agent? Pass --target (mutually exclusive with --global)
npx glirastes install-skills --target .codex/skills

# Symlink mode — skills auto-update when you bump glirastes
npx glirastes install-skills --symlink

# Preview without writing
npx glirastes install-skills --dry-run

# Overwrite previously installed skills
npx glirastes install-skills --force
```

| Flag | Effect |
|---|---|
| *(default)* | Install into `./.claude/skills` relative to the current project. |
| `-g`, `--global` | Install into `~/.claude/skills` so every project on this machine sees the skills. Mutually exclusive with `--target`. |
| `--target <dir>` | Override the destination. Accepts relative or absolute paths and `~/`-prefixed paths. |
| `--stack <name>` | `nextjs` \| `nestjs` \| `nextjs+nestjs` \| `all` (default). Filters which skills are installed. |
| `--symlink` | Symlink instead of copy — skills track the installed `glirastes` version automatically on `npm install`. |
| `--force` | Overwrite skills that already exist at the target. |
| `--dry-run` | Print what would happen without writing anything. |

### Project-local vs global — which to pick?

- **Project-local** (default): each project sees skills tied to its own installed `glirastes` version. Best when teams collaborate via git — the project's `.claude/skills` is checked in (or symlinked, then `.gitignore`d).
- **Global** (`-g`): one install per developer machine, shared across every project. Best for a solo dev who works on multiple Glirastes projects and wants consistency without re-running the installer per project.

Both modes can coexist. Project-local skills override global skills when the same name is present in both.

### Manual install (no CLI)

If you prefer not to use the installer:

```bash
mkdir -p .claude/skills
cp -r node_modules/glirastes/skills/*/ .claude/skills/
```

Or symlink:

```bash
mkdir -p .claude/skills
for skill in node_modules/glirastes/skills/*/; do
  ln -sf "$(pwd)/$skill" ".claude/skills/$(basename "$skill")"
done
```

## Skill authoring

If you fork or extend a skill, follow the [Anthropic skill creator best practices](https://github.com/anthropics/anthropic-cookbook/tree/main/agents/agent-skills):

- Use the verb-ing-noun naming pattern (`integrating-glirastes-nextjs`, not `glirastes-nextjs-helper`)
- Keep `SKILL.md` under ~500 lines — split deep references into sibling files, one level deep
- Frontmatter `description` must be third-person and include the trigger condition
- Include code snippets you can adapt, not just abstract guidance

## Reporting issues / suggesting improvements

These skills evolve with the SDK. If a skill steers an agent toward an outdated API, [open an issue](https://github.com/chainmatics/glirastes/issues) with:

1. The skill name
2. The agent's incorrect output
3. The correct API for the current SDK version

Pull requests welcome.
