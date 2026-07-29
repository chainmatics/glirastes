# Glirastes Agent Skills

The package ships three focused skills for the managed-local foundation:

| Skill | Use when |
|---|---|
| [`integrating-glirastes-nextjs`](./integrating-glirastes-nextjs/SKILL.md) | Taking a Next.js app from scan to its first local tool action |
| [`maintaining-glirastes-tools`](./maintaining-glirastes-tools/SKILL.md) | Reviewing fingerprints, bindings, revisions, revocations, or tombstones |
| [`building-glirastes-chat-ui`](./building-glirastes-chat-ui/SKILL.md) | Integrating chat UI, sessions, approvals, actions, themes, or STT |

Install project-local copies with:

```bash
npx glirastes install-skills
```

Use `--target .codex/skills` for another agent directory, `--global` for a
user-wide installation, `--symlink` to track the installed SDK, `--force` to
replace an older copy, and `--dry-run` to preview.

The first foundation bundles the verified Next.js pilot workflow only.
Framework-neutral runtime contracts remain public, but unsupported integration
skills are not installed until their scan-to-first-tool path meets the same
acceptance gates.
