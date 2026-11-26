# Chat views

Chat views let the model answer with a small composed view inside the chat (a
table of invoices, a few key figures, a status overview) built from components
the app declares. The composition is generated; the data is not: every
business value in a view is a reference to a real tool result, which the
server resolves.

The feature is optional and off by default. Without `chatViews` on the chat
handler there is no `render_view` tool, no extra prompt text and no request
field; the stream is byte-identical to a handler without the feature. Without
`chatViews` on the React provider nothing is sent and a stored view renders as
plain text.

The step-by-step setup for a coding agent (server, React, an own component,
codegen, a test without a model, troubleshooting) is the packaged skill
reference `skills/building-glirastes-chat-ui/references/chat-views.md`.

## Contents

- How it works
- Setup in short
- The catalog
- References and the model
- Rendering and fallbacks
- Security and privacy
- Limits of this release
- Support level

## How it works

1. **Contract** (`glirastes/contracts`, Zod, no React): the spec the model
   writes (`chatViewSpecSchema`), the component manifest
   (`chatComponentManifestSchema`), the resolved view the browser gets
   (`resolvedChatViewSchema`, `v: 1`), what a client can render
   (`chatViewCapabilitiesSchema`) and `CHAT_VIEW_LIMITS`.
2. **Server**: with `chatViews` set, `createAiChatHandler` registers the
   built-in tool `render_view`. Its description lists the usage rules and one
   signature line per component. `execute` validates the spec against the
   catalog (narrowed to what the browser said it can render), resolves every
   reference against the tool results of the conversation, and returns
   `{ shown: true, elements, view }`. The model only ever sees
   `{ shown, elements }`: in the current turn through the AI SDK's
   `toModelOutput`, in later turns because the handler strips `view` from the
   history before model input.
3. **Bindings**: the browser renders the `view` of the persisted tool part
   through a registry of React components; a deterministic text renderer
   (`chatViewToText`) is the second binding and the fallback for every element
   that cannot render.

## Setup in short

```ts
// server
createAiChatHandler({ ...config, chatViews: {} });                       // starter catalog
createAiChatHandler({ ...config, chatViews: { catalog: appManifest } }); // + the app's components
```

```tsx
// browser
<VercelAiChat endpoint="/api/chat" chatViews={{}} />
<VercelAiChat endpoint="/api/chat" chatViews={{ components: appBindings, surface: 'narrow' }} />
```

An app component is defined once with `defineChatComponent` (Zod props,
`bindable()` / `refOnly()` for data props, a `text` rule for the fallback),
bound in the browser with `bindChatComponent(definition, Component)`, and
collected by `glirastes tools refresh` into `.glirastes/chat-components.json`,
which the server receives as `chatViews.catalog`
(`chatComponentManifestSchema.parse(json)`; a Node server may pass the
definitions directly).

## The catalog

The runtime source of truth is a JSON manifest (a JSON Schema subset per
component, no refinements or transforms), so a host without TypeScript can
validate it. The SDK's starter catalog (`starterChatComponents`) is semantic,
not visual: `Group`, `Card`, `Text`, `KeyValue`, `Table`, `StatusBadge`,
`EntityLink`, `Money`, `DateTime`, `Stat`, `Action`. The app's entries are
merged over it (`mergeChatManifests`); an entry with the same `id` and
`schemaVersion` replaces the starter's. No spec may carry `className`, styles,
colors, sizes, URLs or HTML; formatting of money and dates happens in the
binding with the page language.

A table-like app component declares `itemScope: { rowsProp, cellsProp }`;
each entry of the cells prop names its cell element in a `chatElementId()`
field (`defineChatComponent` throws without one). The text fallback follows
the entry's `itemScope` and `text` rule, so an app table prints as a table.

## References and the model

- `{ "$ref": "<toolCallId>", "path": "data[].customer" }`: same path grammar
  as `read_result`.
- `{ "$item": "<field>" }`: the current row inside a table cell element.
- `$count`, `$sum` and `$said` (a value the model states, with a basis
  reference) only on the starter `Stat.value`; a stated value is marked
  "computed by the assistant" by the SDK wrapper, not by app CSS.
- A reference reaches the results of the current turn (the full stored result
  when the model saw an overview, read under the same guard as `read_result`)
  and the tool parts the browser sends back for earlier turns. The model gets
  a content-free memo of up to ten earlier results (call id, tool, row count,
  field names) next to the seen-objects memo. Field names pass the same
  filter as `read_result` echoes (identifiers without a run of three digits);
  a result without a list is listed as `value`, as its keys may be data.
- The resolved `view` never reaches the model: the handler strips it from
  the history on every request, also after `chatViews` was switched off,
  unless the app registers its own tool named `render_view`.
- An invalid spec or a path that does not resolve returns `success: false`
  with a precise message, so the model corrects itself; loop detection applies
  as for any tool.

## Rendering and fallbacks

- The browser checks each element's props again. The binding is the highest
  bound `schemaVersion` of the type up to the element's own whose schema
  accepts the props; an element newer than every binding may therefore render
  through an older one when its props fit. Otherwise the element renders as
  its text and its siblings still render. A failing root, or a binding that
  throws at the root, renders the whole view as text. An element whose type
  the client's manifest does not know renders its children's text, else
  nothing.
- Every text fallback is plain text in React text nodes, never Markdown or
  HTML. `chatViewToText` used elsewhere escapes every value in its default
  Markdown form; its `plain` form must not be fed to a Markdown renderer.
- Styling hooks: `[data-component="chat-view"]`, `[data-element="…"]`,
  `text-fallback`, `said-marker`, `table-note`; `unstyled` is honoured.

## Security and privacy

- Values come only from tool results the user's own turn produced, after the
  existing output field filters and the PII shield. With `piiShield` a view
  shows the shielded (pseudonymized) form, exactly like tool cards and
  approval cards; views are never rehydrated, and the `render_view` arguments
  are excluded from argument rehydration like `read_result`.
- In a managed turn a reference to a stored result passes the `read_result`
  guard (principal, budget, revocation) and counts as a call of the origin
  tool.
- The browser's capability list only narrows the catalog; it is trusted for
  nothing else.
- A view button sends a prompt or runs a registered client action. It runs no
  tool, asks for no approval and grants nothing the typed request would not.
- Nothing goes to the Platform; the catalog is not governed by it.

## Limits of this release

- One view per answer (`maxViewsPerTurn: 1`); a second `render_view` fails
  with `one view per answer`.
- A view is a snapshot of the results at that moment; there is no live data
  and no refetch.
- Action buttons only `prompt` and `uiAction`. A `uiAction` outcome goes only
  to `onUiActionOutcome` (`reported: false`); the model does not learn it.
- A field that only exists in the full form of a result the model saw cut can
  be referenced in the same turn (the server reads the stored result);
  otherwise the model must call `read_result` first, and for an earlier turn,
  whose handles have expired, run the tool again.
- No forms, charts, partial streaming render, tool runs from a view, or
  Platform governance of the catalog.
- Sizes (`CHAT_VIEW_LIMITS`): 60 elements, depth 6, 8 KB spec, 200-character literals, 50
  table rows, 8 table columns (3 on a `narrow` surface), 64 KB resolved view.
- The configured runtime container has no `chat.chatViews` option yet; chat
  views are off there.

## Support level

See the [support matrix](support-matrix.md#chat-views). The React binding
(`glirastes/react`) and the text renderer (`glirastes`) are shipped and tested
in CI; no browser or pilot acceptance is recorded yet. `<glirastes-chat>` (Web Components) and native
clients have no binding of their own and are not claimed.
