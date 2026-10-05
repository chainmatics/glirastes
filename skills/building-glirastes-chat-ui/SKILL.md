---
name: building-glirastes-chat-ui
description: Use when integrating or customizing the Glirastes React chat, tool cards, approvals, sessions, mentions, suggestions, UI actions, themes, floating window behavior, or speech-to-text.
---

# Building the Glirastes Chat UI

## Start from the shipped UI

Use `VercelAiChat` from `glirastes/react/vercel` plus
`glirastes/react/styles.css`. Preserve existing product UX through supported
themes, slots, session adapters, tool renderers, and `useAiClientAction`
handlers rather than copying the chat implementation.

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

`glirastes/react` exports the action bus from `./ui.js`: `UiActionBus`,
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

## Verification

Test tool cards and UI actions, self-approval, sessions, keyboard/mobile
layouts, permission denial, start/stop/cancel/retry, duplicate final segments,
cleanup after unmount, and one-stream enforcement in real browsers. Record STT
quality plus p50/p95 finalization latency against the product baseline.

Assert that hidden and non-allowlisted tool output cannot escape through either
result blocks or an assistant fallback summary, and that a raw transport error
never reaches rendered state.
