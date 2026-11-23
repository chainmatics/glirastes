---
name: building-glirastes-chat-ui
description: Use when integrating or customizing the Glirastes React chat or browser-only web component in Angular/SvelteKit/Nuxt/Vue, tool cards, approvals, sessions, mentions and slash commands (derived `@` entities and `/` commands, direct commands), suggestions, UI actions, themes, floating window behavior, or speech-to-text.
---

# Building the Glirastes Chat UI

For React, use `VercelAiChat` from `glirastes/react/vercel` plus
`glirastes/react/styles.css`. Preserve existing product UX through supported
themes, slots, session adapters, tool renderers, and `useAiClientAction`
handlers rather than copying the chat implementation. You, the app's coding
agent, wire it; Glirastes never calls a model from the UI or the CLI: the
chat route uses the app's own model access.

## Boundaries

- The browser never decides rights: role filtering in the UI only hides
  entries, the server and the app still authorize every tool call.
- Never derive approver authority from the browser payload; organizational
  approval stays fail-closed while unavailable.
- Speech traffic goes directly between the app's provider adapter and its
  provider, never through the Glirastes Control Plane.
- Never edit `.glirastes/tool-policy.json` or generated files to change what
  the UI shows; UI tools, `@` entities and `/` commands come from
  `glirastes tools refresh`.

## Workflow

1. Choose React or the browser-only custom element (see Non-React hosts).
   For React, mount one `VercelAiChat endpoint="/api/chat"` (the app's real chat route)
   and import `glirastes/react/styles.css`; theme it before forking anything.
   Place the assistant as in "Placing the assistant" below: a toggle where the
   app wants it, the chat docked on the right or detached as a window. The
   bare floating bubble is only for apps without a layout of their own.
2. Register client actions with `useAiClientAction` where their state lives,
   with a payload contract (and `{ route }` when that is one page), and mount the navigation bridge
   (`useGlirastesNavigationBridge`) once. Run `glirastes tools refresh` and
   check with `glirastes tools status` that the UI tools are active.
3. Serve the derived `@` entities and `/` commands next to the chat route and
   pass them as `chatInteractions` (section below); add `completionProviders`
   only for sources they do not cover, plus the clarification card, result
   renderers and sessions as the product needs.
4. Wire speech-to-text through the SDK controller (gate below).
5. Prove it in a real browser: keyboard, mobile layout, approvals, STT
   cleanup.

The app may use an ephemeral session for basic chat; with durable sessions,
make server-side visibility and retention explicit.

## Configuration

`VercelAiChat` requires `endpoint`, creates its transport internally and takes
the `AiChatProviderConfig` fields; an own `AiChatProvider` needs `transport`
from `useVercelAiChatTransport`. Reach for configuration before forking a
component; headless hooks and building blocks for an own chat:
[references/hooks-and-building-blocks.md](references/hooks-and-building-blocks.md).

| Field | What it decides |
|---|---|
| `endpoint` | required by `VercelAiChat`; the actual server chat route |
| `theme` | preset name or override object |
| `theme.colors.primary`, `theme.colors.primarySoft` | accent and gradient stop within a theme override |
| `classNames` | per-slot class hooks |
| `components` | replace a rendered component (see *Slots*) |
| `locale`, `locales` | `locale` overrides any string for every language; `locales` per BCP-47 tag (`{ pl: { sendButton: 'Wyślij' } }`, partial tables fall back per key; language = `language`, else the page `lang` (`<glirastes-chat>`: nearest `lang`), else the turn's tool labels, followed when the page changes it later; `languageSource: 'server'` = old order; sent per request as `Content-Language` unless `sendLanguage: false`, server side: `requestLocale` > `locale` > that > manifest, `clientLanguage: false`) |
| `session` | `save` / `load` / `clear` for durable conversations |
| `mentions` | mention sources and search |
| `suggestions`, `messageFooter` | suggestion chips (`placement: 'message'` puts follow-ups under the answer); `messageFooter`: copy, sources, duration and stop per answer (references/hooks-and-building-blocks.md) |
| `voice` | speech-to-text |
| `attachments`, `queue` | image and PDF attachments (section below); opt-in message queue, messages sent while busy or during an approval go once idle (`references/composer-chips-attachments.md`, "Message queue") |
| `chatInteractions` | derived `@` entities and `/` commands (section below) |
| `entityLinks` | entity references in answers as chips (`knownEntities`, `ambiguousNames` (default `'text'`: a shared name stays text; `'first'` = before 0.18.0; markers with an id link by id), `resolveAmbiguous`, `scope`, `mentionMarkers: 'markdown'` + `verifyMentions`); `entityDeclarations` sets declared identity by tool name (`docs/entity-identity.md`) |
| `toolResults`, `toolLabels` | how tool output is displayed and named |
| `onBeforeSend`, `onToolResult`, `onUiActionOutcome` | hooks around a turn; UI action outcomes in `references/hooks-and-building-blocks.md` |
| `approvalDescription`, `approvalDisplay` | human-readable text for an approval request; `approvalDisplay` (`decided: 'entry'`, `open: 'inline'`) places approvals at their tool part (`MessageParts.parts`); do not set `decided: 'entry'` if the app draws its own entry from `parts[].approval` (both would show) |

`locale` exists so the SDK never fights the product's i18n stack. Bind it to
whatever the app already uses:

```tsx
const t = useTranslations('chat');
<VercelAiChat endpoint="/api/chat" locale={{ sendButton: t('send'), placeholder: t('placeholder') }} />
```

## Theming before forking

`theme` takes a preset name or an object that overrides one. Presets:
`professional-lightblue` (the default), `professional-dark`, `minimal-white`,
`vibrant-indigo`, `terminal-green`, `liquid-glass`, `purple-haze`, `blue-dream`,
`sunset-orange`, `ocean-teal`, `midnight-mono`.

```tsx
<VercelAiChat endpoint="/api/chat" theme="professional-dark" />
<VercelAiChat endpoint="/api/chat" theme={{ preset: 'minimal-white', colors: { primary: '#10b981' } }} />
```

`getThemeVars`, `CHAT_THEME_PRESETS` and `DEFAULT_THEME_PRESET` expose the
resolved variables. Prefer `theme` and `classNames` over overriding the CSS:
styles are variable-driven, inline overrides break under a strict CSP.

## Slots

`components` replaces one rendered piece while the rest of the chat keeps
working: `MessageBubble`, `MessageParts`, `TurnNotice` (message layout), `ChatInput`,
`ToolResultBlock`, `Markdown`, `InputExtra`, `ApprovalCard`, `BulkApprovalCard`, `ApprovalEntry`,
`PipelineTimeline`, `SuggestionChip`, `MentionChip`, `AttachmentTray`, `AttachmentButton`.

Replace the narrowest slot: swapping `MessageBubble` to restyle one tool result
costs the streaming, approval and mention behavior it carries.

## UI actions

`glirastes/react` re-exports the framework-neutral action bus of
`glirastes/browser`: `UiActionBus`,
`useAiClientAction`, `useAiClientActionById`, `useAiClientActionByType`,
`dispatchAiClientAction`, `dispatchAiClientActions`, plus
`getRegisteredHandlers`, `getMissingHandlers`, `getActionIdInfo`,
`setActionIdRegistry`, and `useAiMissingHandlerWarning`.

A UI tool produces an action; a handler in the app performs it. Register with
`useAiClientAction` where the state lives, not at the root — a handler far from
its state is how stale closures get shipped.

`useAiMissingHandlerWarning` and `getMissingHandlers` surface actions the model
can emit but nothing handles. Wire the warning during development: a silently
dropped action looks exactly like a model that ignored the request.

Generated navigation (`ui.navigate`) and filter (`ui.filter.<view>`) tools run
through `useGlirastesNavigationBridge({ push })`; without the bridge they stay
disabled. A client action becomes the tool `ui.<actionId>` (`task-details.open` is `ui.taskDetails.open`); a
single-segment id or one starting with `navigate.`, `filter.` or `action.` moves under `ui.action.`
(`navigate` is `ui.action.navigate`); the browser still dispatches the registered id. Pass its payload
contract as the third argument of `useAiClientAction` so the payload is typed and checked before the
handler runs. An action that lives on one page takes that page's path as fourth argument,
`{ route: '/templates' }`, in the page component: from another page the chat navigates there first and
runs the action once it is registered. A handler returns `false` if it could not work
(the dispatch fails; the model is only told "handed to the app"). Never register a global handler that
only fires a window event for a listener on one page. A chat UI that does not use the SDK provider must
pass each tool result to `runToolResultUiActions` (`glirastes/browser`), or no UI tool runs.

## `@` entities and `/` commands

`glirastes tools refresh` derives them from the enabled tools and writes
`chatInteractions` into the generated module. A disabled, `needs_attention` or
excluded tool derives nothing, and only string arguments are derived (an
optional key of another type is left out of the form; a required one hides
the command or action).

| Derived from | Becomes |
| --- | --- |
| A page without parameters (`ui.navigate`) | `/` command `open.<path>`, segments joined by dots (`/settings/profile` is `open.settings.profile`, `/` is `open.home`) |
| A URL filter (`ui.filter.<view>`) | `/` command `filter.<view>`; enums become choices |
| A client action (`ui.<actionId>`) | `/` command `<actionId>` |
| A read endpoint with `search`, `q`, `query` or `term` that lists objects with an `id` and a `title`, `name`, `displayName`, `label`, `subject` or `email` (`GET /api/tasks?search=`) | `@` entity `task` |
| An endpoint with one path parameter below that collection, or a page with one parameter of that entity | Context action of the entity ("Complete", id `task.tasks.complete`; "Open") |

A search below `/search` (`GET /api/users/search?name=`) is an entity too.
Labels come from each tool's reviewed `title`, entities from the presentation
noun; without them, verb plus object from identifiers. Chat-internal client
actions are left out, destructive ones come last. Review the list with
`curating-glirastes-chat-interactions`; `docs/chat-interactions.md` (Glirastes
repository, not shipped in the package) has the table and override format.

- Serve them with a GET next to the chat POST:
  `export const GET = createChatInteractionsHandler({ interactions: generated.chatInteractions, overrides, managedRuntime })`
  from `glirastes/server/nextjs`, with `overrides` the parsed
  `.glirastes/chat-interactions.json` when the app has one. With
  `managedRuntime` the list is per user and leaves out what this user may
  not run; without it every caller gets the same list. Define
  `managedRuntime` once as a `const` at module scope and pass that same
  object to the POST and the GET; two hand-written copies drift apart, and
  the list then shows commands the POST refuses or hides ones it would run.
- In React, load them with `useChatInteractionsData('/api/chat')` and pass a
  memoized `chatInteractions={{ data, entities, commands, locale }}` to
  `VercelAiChat`. `defineChatEntity` and `defineChatCommand` add what the
  code does not show (people from another service, a prepared prompt) and
  replace a derived entry with the same type or id. Key the chat by user
  when the identity can change without a reload, so the list follows.
- `chatInteractions` already offers the generated UI tools as `/` commands;
  drop an earlier `createUiToolCommandProvider`, or the list shows them twice.
- `<glirastes-chat endpoint="/api/chat" interactions>` loads the same list
  and offers `defineEntity`, `defineCommand` and `mentionEntity`. Its GET
  sends no app headers: a host that authenticates by header sets the
  `interactions` property instead.
- A `/` command sent alone runs its tool on the server without a model
  call, under the same guard, confirmation, audit and PII shield as a model
  call; missing arguments open a form first. `directCommands: false` on
  `createAiChatHandler` turns this off.
- Better labels, synonyms (`keywords`) and icons go into
  `.glirastes/chat-interactions.json` (`describing-glirastes-tools`).
  `hidden` there only shapes the list; the server still authorizes.
- Own suggestion item: `components.MentionDropdownItem` on the chat, or
  `components={{ DropdownItem }}` on `MentionInput`; it must spread its
  `optionProps`, or the listbox loses its active option for screen readers.
  `renderActions`, `renderSubmit`, other `MentionInput` props and
  `useChatComposerInput` (custom composers): the curating skill.
  Never an own `onSearch` next to `chatInteractions`.
- Keyboard model of the `/` and `@` list: the editor is a `textbox` that
  controls the suggestion `listbox`; ArrowUp and ArrowDown move between
  results, ArrowRight and ArrowLeft between an entity and its actions, Enter
  or Tab picks, Escape closes. Headings group a mixed list, and a search
  without hits says so. The argument form starts at the first empty
  required field, entity fields are ARIA 1.2 comboboxes, and Escape closes an
  open list before it cancels the form.

## Pills, "Chat about this" and chips in answers

`chatInteractions` makes the default `ChatInput` show `/` and `@` pills (`theme.colors.pill*`, `--cm-pill-*`, `glirastes/react/pills.css` when unstyled); keep it.
`useChatComposer().chatAbout({ type, id, label })` opens the chat with the pills in it (composers on `useChatComposerInput` get them; other own composers: `useChatComposerTarget`); `useOptionalChatComposer()` is `null` outside the provider, and `onOpenRequest` on the provider shows a chat the app opens itself.
`entityLinks={{ matchers, open }}` makes references in answers clickable chips; a replaced `Markdown` slot keeps them only through `useChatEntityLinks()`. Markdown: lists are styled by default; tables need `bun add remark-gfm` and `markdown={{ remarkPlugins: [remarkGfm] }}` (`ChatMarkdownOptions`, memoized). Until react-markdown has loaded, a message shows skeleton lines (`[data-element="markdown-skeleton"][data-state="loading"]`); the provider loads it on mount, `preloadMarkdown()` starts earlier.
Methods, chip options and gotchas: [references/composer-chips-attachments.md](references/composer-chips-attachments.md).

## Commands, mentions and clarification

`completionProviders` turns the composer into provider search. Each provider
has a stable `id`, a `trigger` (`@`, `/` or another char, see [triggers](references/composer-triggers-toolbar.md#triggers)) and an async `search` that gets
the query, an abort `signal`, a `limit` and the `completionContext` (roles and
attributes the UI knows). Arrow keys, Tab/Enter and Escape work in the list,
and the selected item's own id reaches the model in the mention marker.
`createUiToolCommandProvider` offers the catalog's UI tools as `/` commands.
Role filtering only hides entries: the server and the app still authorize.
Memoize the providers array; a new identity rebuilds the search.

Enable `clarification` on `createAiChatHandler`. The model asks one targeted
question through the built-in clarification tool inside its normal step, no
extra planner call. `ClarificationCard` renders the options and a free-text
answer; the answer resumes the original request, and typing into the composer
while a question is open answers it too.

## Result components

`toolRenderers` maps a tool's `definitionId` and `schemaVersion` to a compact
local component built with `defineToolResultRenderer`. Each version's
`outputSchema` guards stored messages: when no version accepts the output or
the component throws, the default `ToolResultBlock` renders instead.

## Non-React hosts

`glirastes/embed` registers `<glirastes-chat endpoint="/api/chat">` through
`defineGlirastesChatElement()`. The React UI runs in a Shadow DOM, page CSS
themes it with `--glirastes-chat-primary` and the other `--glirastes-chat-*`
variables, `glirastes-chat:ready`, `:status`, `:tool-result` and `:error`
events bubble out, and removing the element unmounts it and frees the
microphone. The host needs `react`, `react-dom`, `@ai-sdk/react` and `ai`.

Import `glirastes/embed`, `glirastes/browser` and the session helper only in
browser lifecycle code; an SSR guard around rendering does not protect a
server-side static import. Create the element detached, set attributes and
its JS `config` (session, headers, callbacks), then append it. Initial session
loading must see the verified user's store on the first mount.

Use an identity key containing app, environment, business tenant and user.
On logout or any change of that key, remove the old element and create a
new store and element; changing `config` on the existing provider is not a
safe identity reset. Cancel/ignore stale async initialization, dispose browser
action/navigation registrations and clear retained local conversations as the
app's privacy policy requires. Verify the new user cannot see or resume the
old user's messages or pending approvals.

Follow [references/non-react-hosts.md](references/non-react-hosts.md) for a
complete mounting pattern and Angular/SvelteKit/Nuxt lifecycle guidance. The
configured runtime defaults to `/glirastes/chat`; do not assume it exposes
chat-interactions, speech or attachment routes unless that host implements
those capabilities.

## Mentions and suggestions

`mentions` supplies the sources; `MentionInput` and `RichMentionInput` render
them, `MentionChip` and `MentionChipList` show them. Assert that structured
mention ids survive submission: a mention degraded to plain text looks right
and no longer resolves. `suggestions` drives `SuggestionBar` and `SuggestionChip`; a failing source may not take the composer down.
Opt-in `composer.starters`, `composer.hint`, `composer.clarificationChips`; per-chat drafts are on by default: [references/composer-starters-drafts.md](references/composer-starters-drafts.md).

## Attachments

Off by default; enable both sides: `attachments` on `VercelAiChat` (`true` or
`{ mediaTypes, maxFiles, maxFileBytes, prepare }`) and `attachments: {
enabled: true }` on `createAiChatHandler`. The SDK never compresses: downscale
in `prepare`. With `piiShield` the handler also needs `allowWithPiiShield:
true` (files bypass the shield); decide that with the developer. A custom
composer adds `AttachmentTray`, `<input {...composer.attachmentInputProps} />`
and `AttachmentButton` (`onClick={composer.openFilePicker}`). Raise body limits
in front of the route: Next.js middleware (10 MB), Express/NestJS JSON parser.
Only the two most recent user messages keep file data, and the LangGraph
transport refuses files. Limits, error codes and the composer API:
[references/composer-chips-attachments.md](references/composer-chips-attachments.md).

## Sessions

`session.save`, `.load` and `.clear` make conversations durable; `load` takes
SDK `ChatMessage`s or flat `WireChatMessage`s. `SessionSwitcher` renders list,
create, switch and rename (`variant="list"` for a side column).

Corrupted stored sessions fail closed; clearing history needs a confirmation.

For several chats per user without a backend, pass
`session={createLocalSessionStore({ storageKey: JSON.stringify([appId, environment, businessTenantId, userId]) })}`
(from `glirastes/react`; memoize by that complete identity key): the chats
stay in the browser's `localStorage`, are named after their first question,
and the assistant header lists them in place of its title, with new, rename
and delete; it also keeps each chat's unsent draft (`drafts: false` turns it off). Include app, environment, business tenant and verified user in
`storageKey`; remount `AiChatProvider` with that key when identity changes (drafts live in it). This keeps chat
content on the device, so decide it with the developer; an app that needs
chats on every device supplies `list`, `create`, `remove`, `rename`, `save`
and `load` from its own server instead.

## Floating window

`FloatingChatUI`, `ChatWindow` and `AiTriggerButton` provide the portal-mounted
widget; `useDragResizePanel` and `useDraggablePosition` carry drag, resize,
viewport constraint and snapback (bounded, persisted). Mount it through the
shipped portal, which keeps it clear of transformed or clipping ancestors.

## Placing the assistant

The default for an app with its own layout: an "Ask AI" button where the app
wants it (usually the top bar), and the chat docked on the right or detached
as a window. `AssistantWorkspace` inside `VercelAiChat` is that whole
integration; `AssistantToggle` and `useAssistantLayout()` control it from any
depth, the parent needs a height, `modes` adds full screen with a chat column.
Example, width, shortcuts, look, own layout: [references/placing-the-assistant.md](references/placing-the-assistant.md).

## Approvals

Self-confirmation stays in the initiating chat. Organizational approval creates
a durable Platform request and stays fail-closed while unavailable. Test
denial, expiry, replay, cross-app and cross-tenant cases.

`ApprovalCard` handles one request; `BulkApprovalCard` groups same-tool requests
but keeps each approval independent (no bulk authorization). A failed approval
is retryable without losing the request. Both name the call's ids and warn about unknown ones ([hooks and building blocks](references/hooks-and-building-blocks.md)).

## Speech-to-text gate

Use the SDK STT controller as the only recording state machine:

- exactly one microphone stream supplies capture and visualization;
- push-to-talk exposes an unambiguous recording state;
- show a visible interim transcript while recording;
- merge interim and final segments without loss or duplication;
- stop finalizes into the draft; cancel restores the previous draft;
- let the user edit before sending;
- no automatic send on finalization: only the user sends;
- retry permission, provider, and reconnect failures explicitly;
- close MediaStream tracks, sockets, timers, and audio resources on every exit.

`voice.getToken` and chat `headers` may be async. `voice.pushToTalk` adds
hold-to-talk on the mic button and a hotkey (default `mod+shift+space`) next to
tap-to-toggle. Pass `voice.routeKey` (for example the pathname) so navigation
stops recording and keeps the speech as draft; back/forward, session switches and
unmount release the microphone as well. `voice.adapter` plugs in another provider
(an `SttProviderAdapter`; `DeepgramSttAdapter` and `RecordedSttAdapter` ship in
`glirastes/stt`); keep its identity stable. Every voice input (`RecordedSttAdapter` too) needs the audio worklet served: chain `glirastes stt worklet` into `predev`/`prebuild`, see [speech worklet](references/hooks-and-building-blocks.md#speech-worklet).

A finished recording (`RecordedSttAdapter`, `audio/wav` to
`/api/ai/speech-recognize`) needs one route to the app's transcription service,
or to [local speech recognition](references/local-speech.md) in its own server:

```ts
// src/app/api/ai/speech-recognize/route.ts
import { createRecordingTranscriptionHandler } from 'glirastes/server/nextjs';
import { resolvePrincipal } from '@/lib/glirastes-principal';

export const runtime = 'nodejs';
export const POST = createRecordingTranscriptionHandler({
  authorize: async (request) => Boolean(await resolvePrincipal(request)),
  url: process.env.STT_RECORDING_URL,
  apiKey: process.env.STT_RECORDING_API_KEY,
  model: process.env.STT_RECORDING_MODEL,
});
```

`useStt` is the hook, `VoiceInputButton` and `RecordingBar` the surface. Speech
traffic goes directly between the target app's local provider adapter and its
configured provider. Do not proxy transcripts through the Glirastes Control
Plane.

## Commands

```bash
glirastes tools refresh
glirastes tools status
glirastes doctor
```

## Verification

Test tool cards and UI actions, self-approval, sessions, keyboard/mobile
layouts, permission denial, start/stop/cancel/retry, duplicate final segments,
cleanup after unmount, and one-stream enforcement in real browsers. Record STT
quality plus p50/p95 finalization latency against the product baseline.

Assert that hidden and non-allowlisted tool output cannot escape through either
result blocks or an assistant fallback summary, and that a raw transport error
never reaches rendered state. `glirastes tools status` lists the UI tools the
chat can run, and a navigation or filter request changes the page. A derived
`/` command runs without a model call (also through `<glirastes-chat>`), a
command whose tool asks first still shows the approval card, and an `@`
search returns only what the user's own session may read.
