---
name: building-glirastes-chat-ui
description: Customizing the Glirastes chat UI — VercelAiChat / LangGraphAiChat, AiChatProvider + AiChatPanel composition, theming, mentions, voice input, approval cards, ChatWindow portal, useAiClientAction. Use when going beyond the zero-config chat widget.
version: 1.0.0
tags:
  - glirastes
  - react
  - chat-ui
  - components
triggers:
  - chat panel
  - chat window
  - VercelAiChat
  - LangGraphAiChat
  - AiChatProvider
  - AiChatPanel
  - useAiChat
  - useAiClientAction
  - chat theming
  - chat mentions
  - voice input
  - approval card
  - suggestion chips
  - pipeline timeline
---

# Building the Glirastes Chat UI

> **Scope:** customizing the chat UI beyond `<VercelAiChat endpoint="/api/chat" />`. For the initial integration (install, wire the route, drop the widget), see [integrating-glirastes-nextjs](../integrating-glirastes-nextjs/SKILL.md) or [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md).

## Component map

```
AiChatProvider (state + transport + config)
 └─ AiChatPanel (the panel layout — header, body, input)
     ├─ MessageList → MessageBubble (text, mentions, tool results, approvals, pipeline timeline)
     ├─ SuggestionBar (Pro: contextual followup chips)
     └─ ChatInput / RichMentionInput (input box)
         └─ VoiceInputAddon (optional: live waveform + STT)

VercelAiChat = AiChatProvider + ChatWindow (floating, draggable, resizable) + AiTriggerButton (the floating launcher)
LangGraphAiChat = same shape but talks LangGraph instead of Vercel AI SDK
```

`<VercelAiChat />` is the zero-config wrapper. For full control, drop down to `AiChatProvider` + `AiChatPanel`.

## Three integration levels

### Level 1 — VercelAiChat (zero config)

```tsx
'use client';
import { VercelAiChat } from 'glirastes/react/vercel';
import 'glirastes/react/styles.css';

export function ChatWidget() {
  return <VercelAiChat endpoint="/api/chat" />;
}
```

This gives you the floating trigger button (bottom-right), draggable+resizable chat window, message rendering, mentions, voice input, approval cards. Everything wired up. ~80% of apps stop here.

### Level 2 — VercelAiChat with props

`VercelAiChat` (and `LangGraphAiChat`) accept layout + behaviour props:

```tsx
<VercelAiChat
  endpoint="/api/chat"
  headers={() => ({ Authorization: `Bearer ${getToken()}` })}
  bodyExtras={() => ({ tenantId: getTenantId() })}
  title="Assistant"
  defaultOpen={false}
  draggable
  resizable
  size={{ width: 400, height: 640 }}
  hideTriggerWhenOpen
  shortcut={{ key: 'k', meta: true }}
  showMic={true}
  showClearButton
  confirmClear
  showSessionSwitcher
  welcomeMessage="Hi! Ask me about your tasks."
  triggerIcon={<MyCustomIcon />}
  headerActions={<MySettingsButton />}
  sessions={{ storage: 'localStorage', maxHistory: 30 }}
  autoResumeOnApproval
/>
```

Highlights:

| Prop | What it does |
|---|---|
| `headers` | Function returning request headers — refreshed on every request, ideal for JWT |
| `bodyExtras` | Extra fields merged into the chat request body — tenant ID, locale, etc. |
| `shortcut` | Keyboard shortcut to toggle the chat (e.g. `⌘K`) |
| `showMic` | Voice input toggle. Set `false` to drop `wavesurfer.js` from the bundle entirely |
| `sessions` | Multi-session history — switches between conversations, persists across reloads |
| `autoResumeOnApproval` | After an approval card is approved, the LLM continues without manual nudge |

### Level 3 — AiChatProvider + AiChatPanel (full control)

When you need a non-floating layout (sidebar, full-page, embedded), compose manually:

```tsx
'use client';
import { AiChatProvider, AiChatPanel, useAiChat } from 'glirastes/react';
import { useVercelAiChatTransport } from 'glirastes/react/vercel';

export function FullPageChat() {
  const transport = useVercelAiChatTransport({
    endpoint: '/api/chat',
    headers: () => ({ Authorization: `Bearer ${getToken()}` }),
  });

  return (
    <AiChatProvider transport={transport}>
      <div className="h-full flex">
        <Sidebar />
        <AiChatPanel className="flex-1" />
      </div>
    </AiChatProvider>
  );
}
```

Inside any descendant of `AiChatProvider`, `useAiChat()` exposes the full state — messages, sending, current pipeline state, etc. Useful when you want to render messages elsewhere or add custom controls.

## UI Action Bus — frontend reactions to tool results

Tool results that carry a `uiAction` payload (from `uiPattern` or `uiActionOnSuccess`) are dispatched through `UiActionBus`. Register handlers anywhere in the component tree:

```tsx
'use client';
import { useAiClientAction } from 'glirastes/react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function TaskList() {
  const router = useRouter();

  // Open the detail view when the LLM picks a task
  useAiClientAction('task-details.open', (payload) => {
    router.push(`/tasks/${payload?.taskId}`);
  });

  // Refresh the list after a mutation
  useAiClientAction('tasks.refresh', () => {
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
  });

  // Open a custom dialog
  useAiClientAction('task-create-dialog.open', () => {
    setCreateDialogOpen(true);
  });

  return /* ... */;
}
```

Action IDs follow conventions derived from `uiPattern`:

| `uiPattern.type` | Derived action ID |
|---|---|
| `open-detail`, `entity: 'task'` | `task-details.open` |
| `open-dialog`, `dialog: 'create-task'` | `task-create-dialog.open` |
| `refresh`, `target: 'tasks'` | `tasks.refresh` |
| `toast` | dispatched directly to your toast lib via the SDK's toast handler config |

For raw `uiActionOnSuccess: { type: 'run-client-action', actionId: 'X' }` you choose any string for `actionId`.

`glirastes coverage` reports any action ID declared in tools but not handled (or vice versa).

## Approval cards

Mutations with `needsApproval: true` (default for POST/PATCH/PUT/DELETE) render an approval card before executing. The default card shows:

- Tool name and description
- Input parameters
- Approve / Cancel buttons

Customize per-tool with optional `approvalCard` config:

```ts
defineEndpointTool({
  // ...
  approvalCard: {
    title: 'Create task',
    description: (input) => `Create task "${input.title}"?`,
    severity: 'info', // or 'warning' | 'danger' for destructive ops
  },
})
```

For full UI control, pass a custom component to `AiChatProvider`:

```tsx
<AiChatProvider
  components={{ ApprovalCard: MyCustomApprovalCard }}
>
  ...
</AiChatProvider>
```

## Mentions (`@user`, `#tag`)

Mentions let users reference entities the LLM can resolve to IDs. Configure on the provider or on `VercelAiChat`:

```tsx
<VercelAiChat
  endpoint="/api/chat"
  mentions={{
    triggers: {
      '@': {
        label: 'User',
        search: async (query) => {
          const users = await fetch(`/api/users/search?q=${query}`).then(r => r.json());
          return users.map(u => ({ id: u.id, label: u.name, hint: u.email }));
        },
      },
      '#': {
        label: 'Tag',
        search: async (query) => fetch(`/api/tags?q=${query}`).then(r => r.json()),
      },
    },
  }}
/>
```

Mentions in the input get serialized into the user message — your tools see structured references the LLM can pass back as IDs:

```
Input:  "assign @Alice the task #urgent"
Wire:   "assign user_123 the task with tag tag_456"
```

## Theming

The chat UI is styled with a small token system. Override at the provider level:

```tsx
<VercelAiChat
  endpoint="/api/chat"
  theme={{
    colors: {
      primary: '#6366f1',
      background: '#0a0a0a',
      foreground: '#ffffff',
      muted: '#262626',
      border: '#404040',
    },
    radius: '12px',
    fontFamily: 'Inter, sans-serif',
  }}
/>
```

For deeper customization, swap the default `glirastes/react/styles.css` for your own:

1. Don't import `glirastes/react/styles.css`
2. Inspect the DOM (every component has stable `data-*` attributes) — e.g. `[data-glirastes='chat-panel']`, `[data-part='message-bubble']`
3. Write your own CSS targeting those selectors

## Voice input (Deepgram speech-to-text)

The trigger button has a built-in mic mode. When the user holds the mic:

1. Browser captures audio
2. `wavesurfer.js` renders a live waveform
3. Audio frames stream to your backend's `/api/ai/speech-stream` WebSocket
4. Backend proxies to Deepgram, streams transcriptions back
5. On release, the final transcript becomes the chat input

**Frontend setup:**

```bash
npm install wavesurfer.js
```

```tsx
<VercelAiChat
  endpoint="/api/chat"
  showMic={true}
  voiceInput={{
    websocketUrl: '/api/ai/speech-stream',
    language: 'en', // or 'de', etc.
  }}
/>
```

**Backend setup:** see [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md) → "Speech-to-text WebSocket". For Next.js standalone, you need a separate WebSocket server — Next.js Route Handlers don't support WS natively.

If you don't want voice input at all, set `showMic={false}` and skip installing `wavesurfer.js`. The components are tree-shaken.

### Content Security Policy and `wavesurfer.js`

The optional-peer loader for `wavesurfer.js` uses `new Function('s', 'return import(s)')` to hide the specifier from bundlers (so apps that don't install the peer don't fail to build). This requires `script-src 'unsafe-eval'` in your CSP.

If your deployment forbids `unsafe-eval` **and** you want voice input, install `wavesurfer.js` unconditionally:

```bash
npm install wavesurfer.js
```

With the peer present at install time, the bundler resolves the static path successfully and the runtime trick is bypassed entirely. Strict-CSP environments without voice can stay on `showMic={false}` and never need `wavesurfer.js`.

## ChatWindow — portal, draggable, resizable

`VercelAiChat` already wraps the panel in a `ChatWindow`. If you compose manually, you can use the window separately:

```tsx
import { ChatWindow, AiChatPanel } from 'glirastes/react';

<ChatWindow
  open={open}
  onOpenChange={setOpen}
  draggable
  resizable
  size={{ width: 400, height: 640 }}
  defaultPosition={{ x: 'right', y: 'bottom', offset: 24 }}
>
  <AiChatPanel />
</ChatWindow>
```

The window portals to `document.body` by default — no z-index fights with your app shell.

## Sessions (multi-conversation)

Enable conversation history with the `sessions` prop:

```tsx
<VercelAiChat
  endpoint="/api/chat"
  sessions={{
    storage: 'localStorage', // or a custom adapter implementing { load, save, clear }
    maxHistory: 30,
    onCreate: (session) => trackEvent('chat:new-session'),
  }}
  showSessionSwitcher
/>
```

A session switcher renders in the header (with `showSessionSwitcher`); users can name, switch, or delete sessions. Custom adapters let you persist server-side instead of localStorage.

## Pipeline timeline (Pro)

When `GLIRASTES_API_KEY` is set, the chat shows per-request pipeline steps inline (intent classification, guardrails, tool calls, model selection):

```
↳ Intent: task_query (0.94)
↳ Tools available: 3
↳ Model: gpt-4o-mini
↳ Tool call: list_tasks (124ms)
```

No setup beyond having the key — the timeline auto-renders inside the message bubble of the corresponding assistant turn.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Widget unstyled | `styles.css` not imported | Add `import 'glirastes/react/styles.css'` near the root |
| Floating button overlaps a sticky footer | Default position bottom-right | Pass `defaultPosition={{ x: 'right', y: 'bottom', offset: 80 }}` |
| `useAiClientAction` doesn't fire | Component not mounted when the action arrives | Mount the handler in a layout that's always rendered |
| Mentions search runs on every keystroke | No debounce | Wrap your `search` fn with `lodash.debounce` (300ms typical) |
| Voice input fails silently | WebSocket URL wrong / `DEEPGRAM_API_KEY` missing | Check browser DevTools → WS frame; check backend logs |
| Approval card not shown for a mutation | Tool sets `needsApproval: false` explicitly | Either remove the override or set `autoApproveTools` per-user |
| Approval card shown for a benign GET | Tool overrides `needsApproval: true` | GETs default to `false` — drop the override |
| Multiple chat instances on the page | Mounted `<VercelAiChat />` more than once | Render exactly one in your root layout |
| Bundle includes `wavesurfer.js` despite `showMic={false}` | Direct import of voice components elsewhere | Remove any `import` from `glirastes/react/components/recording-bar` etc. |

## What this skill does NOT cover

- **Initial integration** (install, route handler, widget mount) — see [integrating-glirastes-nextjs](../integrating-glirastes-nextjs/SKILL.md) or [integrating-glirastes-nestjs](../integrating-glirastes-nestjs/SKILL.md)
- **Tool authoring** (`uiPattern` / `uiActionOnSuccess` semantics, `actionId` derivation, approval flag) — see [maintaining-glirastes-tools](../maintaining-glirastes-tools/SKILL.md)
- **LangGraph transport differences** — replace `useVercelAiChatTransport` / `VercelAiChat` with `useLangGraphAiChatTransport` / `LangGraphAiChat`; everything else in this skill applies unchanged
