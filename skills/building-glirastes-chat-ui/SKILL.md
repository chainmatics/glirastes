---
name: building-glirastes-chat-ui
description: Use when integrating or customizing the Glirastes React chat, tool cards, approvals, sessions, mentions and slash commands (derived `@` entities and `/` commands, direct commands), suggestions, UI actions, themes, floating window behavior, or speech-to-text.
---

# Building the Glirastes Chat UI

Use `VercelAiChat` from `glirastes/react/vercel` plus
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

1. Mount one `VercelAiChat endpoint="/api/chat"` (the app's real chat route)
   and import `glirastes/react/styles.css`; theme it before forking anything.
2. Register client actions with `useAiClientAction` where their state lives,
   with a payload contract, and mount the navigation bridge
   (`useGlirastesNavigationBridge`) once. Run `glirastes tools refresh` and
   check with `glirastes tools status` that the UI tools are active.
3. Serve the derived `@` entities and `/` commands next to the chat route and
   pass them as `chatInteractions` (section below); add `completionProviders`
   only for sources they do not cover, plus the clarification card, result
   renderers and sessions as the product needs.
4. Wire speech-to-text through the SDK controller (gate below).
5. Prove it in a real browser: keyboard, mobile layout, approvals, STT
   cleanup.

The application may use an ephemeral session for basic interactive chat.
Server-backed conversation visibility and retention must be explicit when
durable sessions are enabled.

## Configuration

`VercelAiChat` requires `endpoint` and creates its transport internally.
It also accepts `AiChatProviderConfig` fields directly. Only when composing
`AiChatProvider` yourself do you supply `transport` from the transport hook.
Reach for configuration before forking a component.

| Field | What it decides |
|---|---|
| `endpoint` | required by `VercelAiChat`; the actual server chat route |
| `theme` | preset name or override object |
| `theme.colors.primary`, `theme.colors.primarySoft` | accent and gradient stop within a theme override |
| `classNames` | per-slot class hooks |
| `components` | replace a rendered component (see *Slots*) |
| `locale` | override any user-facing string; omitted keys fall back to English |
| `session` | `save` / `load` / `clear` for durable conversations |
| `mentions` | mention sources and search |
| `suggestions` | contextual suggestion chips |
| `voice` | speech-to-text |
| `toolResults`, `toolLabels` | how tool output is displayed and named |
| `onBeforeSend`, `onToolResult` | hooks around a turn |
| `approvalDescription` | human-readable text for an approval request |

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

`getThemeVars`, `CHAT_THEME_PRESETS`, and `DEFAULT_THEME_PRESET` are exported for
products that need to read the resolved variables. Prefer `theme` and
`classNames` over overriding the shipped CSS: styles are variable-driven, and
inline overrides are what break under a strict CSP.

## Slots

`components` replaces one rendered piece while the rest of the chat keeps
working: `MessageBubble`, `ChatInput`, `ToolResultBlock`, `Markdown`,
`InputExtra`, `ApprovalCard`, `BulkApprovalCard`, `PipelineTimeline`,
`SuggestionChip`, `MentionChip`.

Replace the narrowest slot that solves the problem. Swapping `MessageBubble`
to restyle one tool result costs the streaming, approval, and mention behavior
that bubble already carries.

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
disabled. A client action becomes the tool `ui.<actionId>`; pass its payload
contract as the third argument of `useAiClientAction` so the payload is typed
and checked before the handler runs.

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

Labels are English words built from identifiers. `docs/chat-interactions.md`
in the Glirastes repository (not shipped in the package) has the same table
with the override format.

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
- `VercelAiChat` has no slot for the suggestion item. Only a hand-composed
  `RichMentionInput` takes `components={{ DropdownItem }}`; that item must
  spread its `optionProps`, or the listbox loses its active option for screen
  readers.
- Keyboard model of the `/` and `@` list: the editor is a `textbox` that
  controls the suggestion `listbox`; ArrowUp and ArrowDown move between
  results, ArrowRight and ArrowLeft between an entity and its actions, Enter
  or Tab picks, Escape closes. The argument form starts at the first empty
  required field, entity fields are ARIA 1.2 comboboxes, and Escape closes an
  open list before it cancels the form.

## Commands, mentions and clarification

`completionProviders` turns the composer into provider search. Each provider
has a stable `id`, a `trigger` (`/` or `@`) and an async `search` that gets
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

## Mentions and suggestions

`mentions` supplies the sources; `MentionInput` and `RichMentionInput` render
them, `MentionChip` and `MentionChipList` display the result. Structured mention
ids must survive submission — assert that, because a mention degraded to plain
text still looks right on screen and no longer resolves.

`suggestions` drives `SuggestionBar` and `SuggestionChip`. Suggestions are
contextual, so they must handle their source failing: a search error may not
take the composer down with it.

## Sessions

`session.save`, `session.load`, and `session.clear` make conversations durable.
`load` accepts full SDK `ChatMessage`s or flat `WireChatMessage`s and coerces the
wire shape. `SessionSwitcher` renders list, create, switch, and rename.

Corrupted stored sessions fail closed rather than rendering garbage, and clearing
history requires an explicit confirmation. Both are tested behavior; keep them.

## Floating window

`FloatingChatUI`, `ChatWindow`, and `AiTriggerButton` provide the portal-mounted
widget; `useDragResizePanel` and `useDraggablePosition` carry drag, resize,
viewport constraint, and snapback. Panel dimensions persist and stay bounded.

Mount the window through the shipped portal rather than nesting it in product
layout: it is what keeps the panel clear of transformed or clipping ancestors.

## Approvals

Self-confirmation stays in the initiating chat. Organizational approval creates
a durable Platform request and remains fail-closed while unavailable. Never
derive approver authority from the browser payload. Test denial, expiry,
replay, cross-app, and cross-tenant cases.

`ApprovalCard` handles one request and `BulkApprovalCard` groups same-tool
requests while keeping each approval independent — bulk rendering must not become
bulk authorization. An approval failure is retryable without losing the request.

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

`voice.pushToTalk` adds hold-to-talk on the mic button and a hold hotkey
(default `mod+shift+space`) next to tap-to-toggle. Pass `voice.routeKey` (for
example the pathname) so navigation stops recording and keeps the speech as
draft; back/forward, session switches and unmount release the microphone as
well. `voice.adapter` plugs in another provider; keep its identity stable.

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
