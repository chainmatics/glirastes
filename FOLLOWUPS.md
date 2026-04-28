# Deferred follow-ups

These were identified during the 0.3.0 quality pass but deferred because
each one is large enough to deserve its own PR / version bump.

## Dual ESM + CJS bundle (1–2 days)

Glirastes ships ESM-only with `"type": "module"`. CommonJS NestJS apps
(the default `tsconfig` from `nest new`) cannot import it without
migrating their entire backend to ESM:

```
TS1479: The current file is a CommonJS module whose imports will produce
'require' calls; however, the referenced file is an ECMAScript module and
cannot be imported with 'require'.
```

**Plan:** switch the build from raw `tsc` to `tsup` (or `tshy`) emitting
both ESM and CJS, set `package.json` `exports` to dual-conditional
`import`/`require` paths.

**Verification target:** integration test in a `module: commonjs` NestJS
10 app that imports `glirastes/server/nestjs` and runs.

## Split into `glirastes` (server) + `glirastes-react` (UI)

Right now every consumer pulls `@ai-sdk/react`, `react-markdown`, the
chat-panel CSS, and so on into `node_modules`, even backend-only services.
Bundlers tree-shake what isn't imported, but `node_modules` size and
install time still take the hit.

**Plan:** publish two packages from the same repo:

- `glirastes` — types, server core, Next.js + NestJS adapters. No React.
- `glirastes-react` — chat widget, transports, hooks. Depends on `glirastes`.

Backend consumers install `glirastes`, frontend consumers install both.
Newbie ergonomics stay intact via a single `npm install glirastes glirastes-react`
command in the React quickstart.

## Optional `baseUrl` for `defineEndpointTool`

When frontend (port 3000) and backend (port 3001) are split, the `path`
field has to encode the absolute backend URL — leaks deployment config
into tool definitions and breaks if you copy a tool between environments.

**Plan:** add a top-level option to the registry/handler config so the
base URL lives in one place:

```ts
endpointToolsToRegistry(tools, { baseUrl: process.env.BACKEND_URL });
// or
createAiChatHandler({ tools, baseUrl: process.env.BACKEND_URL });
```

## Single-package install for shared workspaces

Mono-repos with a `shared/` workspace currently need glirastes installed
in *three* places (frontend, backend, shared) just because `@AiParam` is
used in DTOs that live in shared. Either:

- Ship `@AiParam` as a side-effect-free type-only decorator from a tiny
  satellite package, or
- Document the workspace-hoist pattern explicitly in the README.

## Auto-derive registry from endpoint-tool array

`createAiChatHandler({ tools: endpointToolsToRegistry([...]) })` is
mechanical. Accept arrays directly:

```ts
createAiChatHandler({ tools: [listTasks, createTask] });
```

Keep `endpointToolsToRegistry` for cases where consumers need to merge UI
+ endpoint registries by hand.

## CLI surface

`package.json` declares `bin: { glirastes: 'dist/cli/bin.js' }` and the
README's TOC links to a `#cli` section, but the prominent quickstart
flow doesn't mention it. Either document `glirastes init | generate |
validate | coverage | scaffold` near the top of the README, or remove the
unreachable TOC link.
