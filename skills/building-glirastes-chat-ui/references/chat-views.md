# Chat views

Optional. With chat views the model can answer with a small composed view (a
table of invoices, a few key figures, a status overview) built from
components the app declares, instead of text only. The layout is generated;
the data is not: every value in a view is a reference to a real tool result,
resolved on the server. An app that does not set `chatViews` gets no new tool,
no new prompt text and no new request field.

## Contents

- Decide first
- Enable on the server
- Enable in React
- Add an app component
- How the model writes a view
- Action buttons
- Rendering, fallbacks and versions
- Deliberate limits of this release
- Test without a model
- Troubleshooting
- API reference

## Decide first

Ask the developer before enabling it; nothing needs it. It fits answers with
four or more like records, comparisons and status overviews. Both sides must
be on: the server option offers the tool to the model, the React option renders
the views. A server without the React option still works (views show as plain
text); the React option without the server option sends a field the server
ignores.

## Enable on the server

```ts
// src/app/api/chat/route.ts
export const POST = createAiChatHandler({
  ...turn,               // or your own config
  chatViews: {},         // starter catalog only
});
```

`chatViews` (`ChatViewsConfig`) has two keys:

| Key | What it does |
| --- | --- |
| `catalog` | the app's components, as a `ChatComponentManifest` or as `defineChatComponent` definitions; merged over the starter catalog (same `id` and `schemaVersion` replaces the starter's). Without it, the starter catalog alone |
| `maxViewsPerTurn` | only `1` in this release |

Any other key, another `maxViewsPerTurn` or an invalid manifest throws
`createAiChatHandler: chatViews…` when the handler is created. With the
option the handler adds the built-in tool `render_view`
(`RENDER_VIEW_TOOL_NAME`) to every request; an app tool of that name wins and
the feature stays off for that request. The configured runtime container has
no `chat.chatViews` option yet, so chat views are off there.

## Enable in React

```tsx
<VercelAiChat endpoint="/api/chat" chatViews={{}} />   // starter bindings
```

`chatViews` (`ChatViewsOptions`, on `AiChatProviderConfig`, so also on
`AiChatProvider` and `VercelAiChat`) takes `components` (the app's
`ChatComponentBinding`s, merged over `starterChatBindings` by
`id@schemaVersion`, the app's win; memoize the array) and `surface`
(`'narrow'` asks the server for at most 3 table columns, for a small chat
window; `'workspace'` is the default width). With the option the transport
sends what the page can render as `chatViews: { components: [{ id,
schemaVersion }], surface? }` next to `messages`; the server offers the model
only the intersection of its catalog and that list. Without the option nothing
is sent and a stored view renders as plain text.

## Add an app component

1. **Define** it in a module with no React and no side effects at import
   (codegen imports it in Node), exported, `defineChatComponent` imported
   from `glirastes`:

   ```ts
   // src/chat-components/invoice-summary.ts
   import { z } from 'zod';
   import { bindable, defineChatComponent } from 'glirastes';

   export const invoiceSummary = defineChatComponent({
     id: 'InvoiceSummary',            // PascalCase, ≤ 40 chars
     schemaVersion: 1,
     description: 'Invoice with customer, total and status',
     whenToUse: 'one invoice at a glance',
     props: z.object({
       customer: bindable(z.string()),
       total: bindable(z.number()),
       currency: z.string().regex(/^[A-Z]{3}$/),
       status: bindable(z.enum(['open', 'paid', 'overdue'])),
     }),
     text: { label: 'customer', value: 'total' },   // the text fallback
   });
   ```

   - Mark every prop that carries data with `bindable()` (a literal or a
     reference); ids and lists with `refOnly()` (only a reference). An
     unmarked prop takes only a literal the model writes (≤ 200 chars), so a
     data prop left unmarked makes the model type values in.
   - Props must be plain JSON Schema: no `.refine`, `.transform`, `className`,
     colors, sizes or URLs. Formatting (currency, dates) happens in the
     component.
   - `children`: `'none'` (default), `'any'` or a list of allowed component
     ids. `itemScope: { rowsProp, cellsProp }` makes it a table-like
     component whose cell elements read rows with `$item`. Each entry of the
     cells prop names its cell element in a `chatElementId()` field, e.g.
     `fields: z.array(z.object({ title: z.string(), element: chatElementId() }))`;
     without one `defineChatComponent` throws.
   - `text` (`ChatComponentTextRule`: `label`, `value`, `rows`, `columns`)
     names the props the text fallback prints: an item-scope component prints
     a table (header = the column's `header`, else its first other text
     field), `rows` alone one line per entry, a container with only `label`
     a title, otherwise `label: value`. An element whose type the client's
     manifest does not know prints its children's text, else nothing.
   - A breaking prop change gets a new `schemaVersion`; keep the old
     definition bound as long as stored chats may hold it.

2. **Bind** it in the browser:

   ```tsx
   import { bindChatComponent, type ChatComponentProps } from 'glirastes/react';
   import { invoiceSummary } from '@/chat-components/invoice-summary';

   function InvoiceSummaryCard({ props, locale }: ChatComponentProps<typeof invoiceSummary.props>) {
     const total = new Intl.NumberFormat(locale, { style: 'currency', currency: props.currency }).format(props.total);
     return <section data-element="invoice-summary">{props.customer}: {total} ({props.status})</section>;
   }

   const chatComponents = [bindChatComponent(invoiceSummary, InvoiceSummaryCard)]; // module scope = stable
   <VercelAiChat endpoint="/api/chat" chatViews={{ components: chatComponents }} />
   ```

   `ChatComponentProps` gives `props` (checked against the schema version),
   `children` (rendered child elements), `said`, `rows` and `renderCell(rowIndex,
   cellId)` for an item-scope component, `locale` and `dispatch` (`prompt`,
   `uiAction`). Type it with the props schema (`typeof def.props`); the shape
   (`typeof def.props.shape`) still works on zod 4.

3. **Collect** with `glirastes tools refresh`: it writes
   `.glirastes/chat-components.json` (only the app's entries; only when the
   app exports at least one definition, a stale file is removed). `glirastes
   tools check` reports it as drift (`tool-outputs-drift`) when it is out of
   date. A definition that is
   not exported is a warning; one that cannot be imported or converted is a
   `chat-component-invalid` finding with the SDK's message.

4. **Pass** the manifest to the server. A JSON import types `v` as `number`,
   so parse it:

   ```ts
   import { chatComponentManifestSchema } from 'glirastes/contracts';
   import manifest from '../../../../.glirastes/chat-components.json' with { type: 'json' };

   chatViews: { catalog: chatComponentManifestSchema.parse(manifest) },
   ```

   A Node server may pass the definitions instead
   (`chatViews: { catalog: [invoiceSummary] }`); the manifest is what a
   non-TypeScript host or a check in CI can read.

### Apps on zod 3

Component props must be zod 4 schemas. On zod 3.25 or later (check
`node_modules/zod/package.json`), import `z` from the zod 4 build that zod
ships in every file that calls `defineChatComponent`, `bindable` or `refOnly`:

```ts
import { z } from 'zod/v4';
```

This works at runtime (the same manifest as with zod 4, `.describe()` and
`.meta()` included) and in `tsc`: the SDK's signatures are structural
(`ChatPropSchema`), so the app's zod types are never compared with the SDK's.
The app's other code keeps `zod`. The classic `import { z } from 'zod'` of
zod 3 is refused: `bindable()`, `refOnly()` and `defineChatComponent` throw
"this is a zod 3 schema … import { z } from 'zod/v4'", `glirastes tools
refresh` reports it as `chat-component-invalid` ("uses a schema that is not
zod 4"), and `glirastes doctor` warns (check `chat-views-zod`, `E-SETUP-110`).
Below zod 3.25 there is no `zod/v4`: update zod first. An alias such as
`"zod-v4": "npm:zod@4"` is not needed (glirastes 0.31.0 ran `tsc` out of
memory on `zod/v4` schemas; update glirastes instead).

## How the model writes a view

The tool description lists the rules and one signature line per component
(`describeChatCatalog`). The model sends `{ root, elements: { <id>: { type,
props, children? } }, caption? }` (`ChatViewSpec`):

- `{ "$ref": "<toolCallId>", "path": "data[].name" }` (`ChatValueRef`): a
  value of a tool result, same path grammar as `read_result`.
- `{ "$item": "total" }` (`ChatItemRef`): the current row, inside a table cell
  element.
- `{ "$count": <ref> }` / `{ "$sum": <ref> }` (`ChatOperator`), and
  `{ "$said": "12.400 €", "basis": <ref> }` (`ChatSaid`), only on the starter
  `Stat.value`; a `$said` value is marked "computed by the assistant".
- References reach results of the current turn and the tool parts the
  browser sent back. The model also gets a content-free memo of up to 10
  earlier results (call id, tool, row count, field names). It lists only
  field names `read_result` would echo (identifiers without three digits in
  a row); a result without a list is just `value`, since its keys may be
  data.

The server validates (`validateChatViewSpec`), resolves
(`resolveChatView`) and returns `{ shown: true, elements, view }`; the model
sees only `{ shown, elements }`, never `view`, now or in later turns (the
handler strips `view` from history on every request, also after `chatViews`
is switched off, unless the app registers its own `render_view` tool). A bad
spec returns `success: false` with a precise message, so the model corrects
itself. Limits (`CHAT_VIEW_LIMITS`): 60 elements, depth 6, 8 KB spec, 200-char
literals, 50 table rows ("+n more" below), 8 table columns (3 when narrow),
64 KB resolved view.

Starter catalog (`starterChatComponents`, manifest
`starterChatComponentManifest`): `Group`, `Card`, `Text` (literal `text` only),
`KeyValue`, `Table`, `StatusBadge`, `EntityLink`, `Money`, `DateTime`, `Stat`,
`Action`.

## Action buttons

`Action` has a label and exactly one target:

- `prompt`: sends the text as the user's next message;
- `uiAction: { id, args? }`: runs a registered client action
  (`useAiClientAction('<id>', …)`, the registered id, not the tool name
  `ui.…`) through the UI action bus. The server does not check the id; name
  the ids a view may use in the system prompt or a component's `whenToUse`.

The outcome of a view button goes only to `onUiActionOutcome` (`toolName:
'render_view'`, `reported: false`); the model does not learn it. No button
runs a tool, asks for approval or grants anything the typed request would not.

## Rendering, fallbacks and versions

- Each element is checked again in the browser. Its binding is the highest
  bound `schemaVersion` of its type up to the element's own whose schema
  accepts the props: an element newer than every binding may render through
  an older one when its props fit, an element whose version is no longer
  bound (or whose props fit nothing) renders as its text. Siblings still
  render; a failing root or a throwing binding turns the whole view into text.
- Every text fallback is plain text, never Markdown or HTML (built with
  `chatViewToText` / `chatElementToText`, `format: 'plain'`).
- Hooks for CSS: `[data-component="chat-view"]` (`data-fallback="text"` for a
  whole-view text), `[data-element="<kebab id>"]` on starter elements,
  `text-fallback`, `said-marker`, `caption`, `table-note` (`data-note="more"
  | "partial"`). `unstyled` is honoured.
- Texts: locale keys `chatViewSaidMarker`, `chatViewPartialNote`,
  `chatViewMoreRows` (`{count}`); English and German ship.
- `ChatView` renders a `ResolvedChatView` outside the chat (`view`,
  `registry` from `createChatViewRegistry`, `locale`, `texts`
  (`ChatViewTexts`), `dispatch`); without `registry` it renders text.

## Deliberate limits of this release

- With `piiShield` a view shows the shielded (pseudonymized) values, like
  every tool card; the browser does not rehydrate them.
- A view is a snapshot of the results at that moment; it never refreshes.
- One view per answer: a second `render_view` in the same answer fails with
  `one view per answer` (a failed call does not use it up).
- A field the model saw only in cut form (`_truncated`, or an overview with
  `_result`) cannot be referenced: in the current turn the server reads the
  full stored result itself; otherwise the error tells the model to call
  `read_result` first and reference that call. Handles live only in their
  request, so for an earlier turn the model runs the tool again. A table whose
  rows come from a cut result shows the "partial" note.
- Only the React binding and the text renderer exist; `<glirastes-chat>` and
  native clients are not claimed. A custom `streamHandler` gets the tool but
  not the source memo.
- Copying a view-only answer copies no view text.

## Test without a model

Script the model with `MockLanguageModelV3` from `ai/test`: step 1 calls the
app tool, step 2 calls `render_view` on that call id, step 3 answers.

```ts
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { createAiChatHandler } from 'glirastes/server/nextjs';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
function scriptedModel(steps: Array<Array<{ toolCallId: string; toolName: string; input: unknown }> | string>) {
  let step = 0;
  return new MockLanguageModelV3({ doStream: async () => {
    const current = steps[Math.min(step++, steps.length - 1)]!;
    const chunks = typeof current === 'string'
      ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: current }, { type: 'text-end', id: 't' }]
      : current.map((c) => ({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.stringify(c.input) }));
    return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...chunks,
      { type: 'finish', finishReason: { unified: typeof current === 'string' ? 'stop' : 'tool-calls', raw: undefined }, usage }] as never) };
  } });
}

it('shows invoices as a table', async () => {
  const model = scriptedModel([
    [{ toolCallId: 'call-list', toolName: 'invoices_list', input: {} }],
    [{ toolCallId: 'call-view', toolName: 'render_view', input: { root: 'table', elements: {
      table: { type: 'Table', props: { rows: { $ref: 'call-list', path: 'data[]' },
        columns: [{ header: 'Customer', cell: 'name' }, { header: 'Total', cell: 'total' }] } },
      name: { type: 'StatusBadge', props: { label: { $item: 'customer' }, tone: 'neutral' } },
      total: { type: 'Money', props: { amount: { $item: 'total' }, currency: 'EUR' } },
    } } }],
    'Here are your invoices.',
  ]);
  const handler = createAiChatHandler({ model, systemPrompt: 'Assistant', tools, chatViews: {} });
  const response = await handler(new Request('https://app.example/api/chat', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Show invoices' }] }] }) }));
  const chunks = (await response.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  const output = chunks.find((c) => c.type === 'tool-output-available' && c.toolCallId === 'call-view').output;
  expect(output).toMatchObject({ shown: true, elements: 3, view: { root: 'table' } });
  expect(JSON.stringify(model.doStreamCalls[2]!.prompt))   // the model never sees the view
    .toContain('"toolName":"render_view","output":{"type":"json","value":{"shown":true,"elements":3}}');
});
```

`tools` is the app's registry with `invoices_list`. For the browser, render
`<ChatView view={view} registry={createChatViewRegistry([...starterChatBindings, binding])} locale="de" />`
with Testing Library (jsdom) and assert the component and a text fallback for
props that do not fit. `validateChatViewSpec(spec, manifest)` and
`resolveChatView(spec, manifest, lookup)` test a spec without a handler.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The model never shows a view | `chatViews` set on `createAiChatHandler`? The rules allow a view only for ≥ 4 like records, a comparison or a status overview, never for single values, confirmations or questions; ask for one explicitly to test. No app tool named `render_view`? The browser's `chatViews.components` does not exclude the component? |
| `render_view` fails with a reference error | the path is not in the result (typo, or only in the cut form: see limits); `Text` takes no reference, use `StatusBadge`, `KeyValue` or an own bindable prop |
| An element shows text instead of the component | not bound in the browser, bound in another `schemaVersion` than the element's, or its props do not fit the bound schema (a server catalog newer than the browser bundle) |
| The whole view shows text | the React `chatViews` option is missing, or the root element failed |
| `defineChatComponent` throws "must be a list of objects with a chatElementId() field" | the cells prop of an `itemScope` component needs a `chatElementId()` field naming each column's cell element |
| "this is a zod 3 schema", or `chat-component-invalid` "uses a schema that is not zod 4" | the app is on zod 3: `import { z } from 'zod/v4'` in the component files (see Apps on zod 3) |
| `tsc` runs out of memory on component files importing `zod/v4` | glirastes older than this fix: update it (workaround there: alias `"zod-v4": "npm:zod@4.4.3"` and import from `zod-v4`) |
| Pseudonyms instead of names | by design with `piiShield`: views show the shielded form |
| A button does nothing | the `uiAction` id is not registered on this page (`onUiActionOutcome` gets the code, the console warns) |
| `.glirastes/chat-components.json` missing | no exported `defineChatComponent` imported from `glirastes`, or a `chat-component-invalid` finding in `glirastes tools refresh` |
| Type error on `catalog: manifest` | parse the JSON with `chatComponentManifestSchema.parse` |

## API reference

- `glirastes`: `defineChatComponent` (`ChatComponentDefinitionInput` →
  `ChatComponentDefinition`, generic over the props schema `ChatPropSchema`;
  `ChatPropsOf<typeof def.props>` is its props type; `ChatComponentChildren`,
  `ChatComponentItemScope`, `ChatComponentTextRule`), `bindable`, `refOnly`,
  `toChatComponentManifest`, `mergeChatManifests` (second wins per
  `id@schemaVersion`), `starterChatComponents`,
  `starterChatComponentManifest`, `describeChatCatalog`,
  `effectiveChatManifest(manifest, capabilities)` (the intersection),
  `validateChatViewSpec` (`ValidateChatViewSpecOptions`,
  `ChatViewSpecValidation`), `resolveChatView` (`ChatViewSourceLookup`
  returns a `ChatViewSource` `{ toolName, value, truncated }`;
  `ChatViewResolution`), `chatViewToText`, `chatElementToText`
  (`ChatViewTextOptions`: `locale`, `format: 'markdown' | 'plain'`; escaped
  Markdown by default, never feed `plain` to a Markdown renderer).
- `glirastes/contracts`: `chatViewSpecSchema`, `chatComponentManifestSchema`,
  `chatComponentManifestEntrySchema` (`ChatComponentManifestEntry`),
  `resolvedChatViewSchema`, `chatViewCapabilitiesSchema`
  (`ChatViewCapabilities`), `chatValueRefSchema`, `chatItemRefSchema`,
  `chatOperatorSchema`, `chatSaidSchema`, `CHAT_VIEW_LIMITS`,
  `RENDER_VIEW_TOOL_NAME`, `chatComponentManifestDigest` (SHA-256 of the
  canonical JSON, to compare catalogs).
- `glirastes/server/nextjs` (also `/server/http`, `/adapter/nextjs`):
  `ChatViewsConfig`.
- `glirastes/react`: `bindChatComponent`, `createChatViewRegistry`
  (`ChatViewRegistry`: `manifest`, `resolve`, `capabilities`;
  `ResolvedChatComponent`), `starterChatBindings`, `ChatView`
  (`ChatViewProps`, `ChatViewTexts`), `ChatComponentBinding`,
  `ChatComponentProps`, `ChatViewDispatch`, `ChatViewsOptions`; an own
  transport implements `ChatTransport.setChatViewCapabilities`.
