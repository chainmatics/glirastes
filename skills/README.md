# Glirastes Agent Skills

For the guided integration path and searchable SDK reference, visit the
[developer documentation](https://glirastes.io/docs). Check each guide's release
status before using preview APIs with an installed SDK version.

The package ships ten skills for the app's existing coding agent. Glirastes
does not need a separate coding-agent service: the CLI generator derives
tools and prints work lists, and these skills guide the app's agent. Chat
model calls run in the customer's embedded or configured SDK runtime.

| Skill | Use when |
|---|---|
| [`setting-up-glirastes`](./setting-up-glirastes/SKILL.md) | Starting or resuming an integration after `glirastes init` |
| [`setting-up-glirastes-memory`](./setting-up-glirastes-memory/SKILL.md) | The chat should keep a summary of long chats, notes about a user across chats or notes shared in a tenant; browser or database storage |
| [`integrating-glirastes-nextjs`](./integrating-glirastes-nextjs/SKILL.md) | Wiring chat, tools, navigation, filters and metrics in a Next.js App Router app |
| [`integrating-glirastes-web`](./integrating-glirastes-web/SKILL.md) | A separate backend, Rust/PHP/Java runtime container, Angular/SvelteKit/Nuxt web component or a framework without a dedicated adapter |
| [`maintaining-glirastes-tools`](./maintaining-glirastes-tools/SKILL.md) | Resolving `glirastes tools resolve --print` findings and policy proposals |
| [`describing-glirastes-tools`](./describing-glirastes-tools/SKILL.md) | Writing descriptions, schemas, synonyms and examples from `glirastes tools describe --print` |
| [`building-glirastes-chat-ui`](./building-glirastes-chat-ui/SKILL.md) | React/web-component chat, identity-isolated browser sessions, the derived `@` entities and `/` commands (served by `createChatInteractionsHandler`, with direct commands), providers, result components, approvals and STT |
| [`curating-glirastes-chat-interactions`](./curating-glirastes-chat-interactions/SKILL.md) | Reviewing the derived `@` entities and `/` commands after a refresh: hide, rename or add entries, wire a custom composer, remove hand-built lists |
| [`upgrading-glirastes`](./upgrading-glirastes/SKILL.md) | After a Glirastes upgrade, when `glirastes tools refresh` prints an upgrade line, or before changing code that uses glirastes: review `glirastes upgrade report` with the developer |
| [`migrating-to-glirastes`](./migrating-to-glirastes/SKILL.md) | Moving off `@chainmatics/agentic-*` and `ai-tool.ts` |

Install project-local copies with:

```bash
npx --no-install glirastes init
```

Run it in the app's existing Codex/Claude session or select an installed CLI
from an interactive terminal with `--agent codex` or `--agent claude`. It
writes `.glirastes/tools.json`, `.glirastes/prompt-bundle.json`, the
`predev`/`prebuild` scripts and a short hint in `AGENTS.md`/`CLAUDE.md` where
they are missing, installs the skills and continues in the agent.
`--dry-run --json` previews without writing or launching anything.

For skill installation only, use the installed Foundation CLI:

```bash
npx --no-install glirastes install --host codex --with-setup-skills
```

Hosts install into `.agents/skills` (Codex), `.claude/skills` (Claude), or
`.gemini/skills` (Gemini). Unknown frameworks and projects without package.json
receive the generic web/runtime guidance by default; this is not a claim of
framework detection. An explicit parts selection still honors a declined
framework part. Owned, unchanged copies refresh; customized copies
are preserved and never force-replaced. After an SDK upgrade,
`glirastes tools refresh` (the app's `predev`/`prebuild` step) does the same
for every recorded install in `.glirastes/installed-skills.json`: unedited
copies are replaced, new skills of the installed parts added and dropped ones
removed, edited copies kept with a warning. `glirastes tools check` fails while
unedited copies are behind. Opt out with `GLIRASTES_SKILLS_AUTO_UPDATE=0` or
`glirastes tools refresh --no-skills`. The supported stacks and their test
status are recorded in the matching SDK repository's `docs/support-matrix.md`
(the repository docs are not shipped in installed skill copies);
`integrating-glirastes-web` explains generic paths and their per-layer gaps; manifest detection and skill
installation alone do not prove an integration. Use this Foundation package,
not an unrelated registry package sharing its version number.

## Runtime and frontend choices in 0.14

The released runtime image is public:
`ghcr.io/chainmatics/glirastes-runtime:0.28.0` (Linux amd64). No registry account
is required; pin its approved digest and match artifact/browser SDK versions.
Use these entry points when handing work to a coding agent:

| Task | Skill |
| --- | --- |
| Decide embedded Node versus configured service | `setting-up-glirastes` and its `references/runtime-hosts.md` |
| Integrate Rust/PHP/Java identity, OpenAPI and deployment | `integrating-glirastes-web` and its `references/runtime-container.md` |
| Mount Angular/SvelteKit/Nuxt/Vue UI with scoped sessions and cleanup | `building-glirastes-chat-ui` and its `references/non-react-hosts.md` |
| Update an API export and redeploy an immutable runtime artifact | `maintaining-glirastes-tools`, section OpenAPI and configured runtime updates |

Embed in a suitable existing Node/Next.js server, or deploy the configured
runtime service for Rust/PHP/Java without customer Node server code. V1 is one
active runtime per app/environment; a true sidecar needs its own lifecycle or
locality justification. A browser-only `<glirastes-chat>` can serve Angular,
SvelteKit, Nuxt, Vue or plain JS while the backend remains authoritative.

These references ship with the skills and remain usable after installation:

- [Runtime container inputs, configuration and deployment](integrating-glirastes-web/references/runtime-container.md)
- [Browser mounting, identity changes and framework lifecycles](building-glirastes-chat-ui/references/non-react-hosts.md)

The matching SDK repository also contains `examples/php-runtime` and
`examples/frontend-frameworks`. Those examples are optional source evidence;
a working generic integration is not proof that every framework capability or
router inventory is officially supported.
