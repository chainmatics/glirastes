# Task 8 report: codegen chat-component manifest

## Implemented
- `src/codegen/tools/sources/chat-components.ts`: TS-program scan (imports of `defineChatComponent` from `glirastes`, exported const or default export) -> schema probe -> manifest (`scanChatComponents`, `renderChatComponentManifest`). Starter entries are not included; sorted by id@version; duplicates and unprobeable definitions are `chat-component-invalid` findings (non-blocking error), unexported definitions a warning.
- Probe: new item kind `chat-component` in `schema-probe.ts` / `probe-child.mjs`. The child imports the app module and calls the SDK's own `toChatComponentManifest([def])` (no second converter); the parent validates with `chatComponentManifestSchema` and content-boundary check. `ProbeFailure.detail` carries the SDK message.
- `TOOLS_PATHS.chatComponents = '.glirastes/chat-components.json'`; `pipeline.ts` adds it to `outputs` only when components exist (atomic write via the existing write step, drift detection included). Uses react-actions `srcDir`/`tsconfig` if configured.
- `mergeChatManifests` already existed (Task 2); server merges (Task 6), so nothing added.
- Upgrade note `chat-views-contract.json` howTo extended.

## Tests
- `src/codegen/tools/sources/chat-components.test.ts` (6): manifest equals SDK output, none without definitions, local same-named function ignored + not-exported warning, transform props error with SDK message, duplicates, pipeline writes file / writes none / idempotent.
- `bunx vitest run src/codegen src/upgrade-notes.test.ts src/public-subpaths.test.ts`: 65 files, 992 passed, 1 skipped. typecheck and typecheck:tests clean.
- TDD note: tests were written after the implementation (no RED run recorded).

## Concerns
- Fixture apps need `node_modules/glirastes` symlinked to the SDK root (done in test); `dist` must be built.
- A stale `.glirastes/chat-components.json` is not deleted when an app removes all definitions.
- `bun.lock` modification is pre-existing and not committed.

## Handoff notes for Task 9
- Command: `glirastes tools refresh` (also `glirastes tools` check mode reports drift as `tool-outputs-drift`). Output: `.glirastes/chat-components.json` (only written when the app exports `defineChatComponent(...)` definitions, which must be `export const x = defineChatComponent(...)` or default export, imported from `glirastes`, importable without side effects).
- The file holds only the app's own entries; the server merges them over the starter catalog.
```ts
import manifest from '../.glirastes/chat-components.json' with { type: 'json' };
createAiChatHandler({ /* ... */ chatViews: { catalog: manifest } });
```
(Alternative: pass the `defineChatComponent` definitions array directly.) The browser still needs `bindChatComponent(definition, Component)` per component.

## Fix round 1: stale manifest
- `pipeline.ts`: when the scan yields no manifest and has no error finding, an existing `.glirastes/chat-components.json` counts as stale. Frozen (check) mode reports it as `tool-outputs-drift` and in `driftPaths`; write mode removes it with the existing stale-setup-artifact removal (symlink-escape check included) and sets `wrote`. A failed scan (error finding) leaves the file.
- Test added (`chat-components.test.ts`): write, delete the component, frozen run fails with drift on the file, write removes it, frozen run clean.
- Command: `bunx vitest run src/codegen` -> 63 files passed, 957 passed, 1 skipped. typecheck and typecheck:tests clean.
