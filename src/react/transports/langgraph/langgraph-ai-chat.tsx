'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { FloatingChatUI, type FloatingChatUIProps } from '../../components/floating-chat-ui.js';
import {
  useLangGraphChatTransport,
  type LangGraphCustomEvent,
} from '../langgraph.js';
import type {
  AiChatProviderConfig,
  ChatTransportDataPart,
  SessionConfig,
} from '../../types.js';

export interface LangGraphAiChatProps extends AiChatProviderConfig, FloatingChatUIProps {
  /** Chat API endpoint URL (e.g. `/api/chat`). */
  endpoint: string;
  /** Static headers or a function that returns headers per request. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /**
   * Fixed LangGraph thread id. Ignored when `sessions` is provided —
   * in that mode the active session id is used as the thread id.
   */
  threadId?: string;
  /** Extra fields to merge into every request body. */
  bodyExtras?: Record<string, unknown> | (() => Record<string, unknown>);
  /** fetch credentials mode. Default: `same-origin`. */
  credentials?: RequestCredentials;
  /** Hook for translating backend `event: custom` events into data parts. */
  onCustomEvent?: (evt: LangGraphCustomEvent) => ChatTransportDataPart | null;
  /** Hook for rendering LangGraph `event: updates` as status labels. */
  renderUpdate?: (node: string, update: Record<string, unknown>) => string | null;
  /**
   * Multi-session hooks. When provided, the drop-in renders a session
   * switcher in the header and wires the active session id into the
   * LangGraph transport as `threadId`. Pass your own `SessionConfig`
   * (typically a bridge to `chatService.getSessions/createSession/...`).
   *
   * See `SessionConfig` in `glirastes/react`.
   */
  sessions?: SessionConfig;
  /**
   * Replace the default floating UI with custom children. Useful when you
   * want to compose `<MessageList />`, `<ChatInput />`, etc. yourself or
   * render an inline `<AiChatPanel />` instead of a floating window.
   */
  children?: ReactNode;
}

/**
 * Drop-in LangGraph chat widget. Bundles transport, provider, and a
 * floating (trigger button + draggable window) chat UI into one component.
 * Zero dependency on `@ai-sdk/react` or `ai`.
 *
 * ```tsx
 * 'use client';
 * import { LangGraphAiChat } from 'glirastes/react/langgraph';
 *
 * export default function Layout({ children }) {
 *   return (
 *     <>
 *       {children}
 *       <LangGraphAiChat endpoint="/api/chat" />
 *     </>
 *   );
 * }
 * ```
 *
 * All `AiChatProviderConfig` fields (session, mentions, classNames, etc.)
 * and `FloatingChatUIProps` (title, defaultOpen, width, height, draggable,
 * resizable) are accepted as top-level props.
 */
export function LangGraphAiChat({
  endpoint,
  headers,
  threadId,
  bodyExtras,
  credentials,
  onCustomEvent,
  renderUpdate,
  sessions,
  title,
  open,
  onOpenChange,
  defaultOpen,
  draggable,
  resizable,
  size,
  hideTriggerWhenOpen,
  shortcut,
  showClearButton,
  confirmClear,
  showSessionSwitcher,
  headerActions,
  triggerIcon,
  showMic,
  welcomeMessage,
  children,
  ...providerConfig
}: LangGraphAiChatProps) {
  // The widget owns its own copy of the active id so it can feed it to
  // the LangGraph transport as `threadId`. The provider is left in
  // *uncontrolled* mode — we only pass `defaultActiveId` (initial seed)
  // and `onActiveIdChange` (so the provider's auto-select / switchSession
  // calls update our local state). This lets the provider's bootstrap
  // skip ('default' sentinel) work correctly.
  const [activeId, setActiveId] = useState<string>(() => {
    if (sessions?.activeId) return sessions.activeId;
    if (sessions?.defaultActiveId) return sessions.defaultActiveId;
    return threadId ?? 'default';
  });

  // If the caller controls `activeId` externally, mirror it.
  useEffect(() => {
    if (sessions?.activeId && sessions.activeId !== activeId) {
      setActiveId(sessions.activeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions?.activeId]);

  const effectiveThreadId = sessions ? activeId : threadId;

  // When multi-session mode is active, also surface the active id as
  // `sessionId` in the request body. LangGraph projects vary on the
  // canonical name (`threadId` vs `sessionId`); shipping both is harmless
  // and lets backends like chaingrow's `/chat/stream` handler — which
  // reads `body.sessionId` — pick up the active session without the
  // consumer having to wire `bodyExtras` themselves.
  const effectiveBodyExtras = useMemo(() => {
    if (!sessions) return bodyExtras;
    return () => {
      const base =
        typeof bodyExtras === 'function' ? bodyExtras() : bodyExtras ?? {};
      return { ...base, sessionId: activeId };
    };
  }, [sessions, bodyExtras, activeId]);

  const transport = useLangGraphChatTransport({
    endpoint,
    headers,
    threadId: effectiveThreadId,
    bodyExtras: effectiveBodyExtras,
    credentials,
    onCustomEvent,
    renderUpdate,
  });

  const effectiveSession: SessionConfig | undefined = useMemo(() => {
    if (!sessions) return providerConfig.session;
    // Strip any consumer-supplied `activeId` and replace with a seed
    // (`defaultActiveId`) so the provider stays uncontrolled.
    const { activeId: _consumerActiveId, ...rest } = sessions;
    return {
      ...rest,
      defaultActiveId: activeId,
      onActiveIdChange: (id) => {
        setActiveId(id);
        sessions.onActiveIdChange?.(id);
      },
    };
  }, [sessions, activeId, providerConfig.session]);

  return (
    <AiChatProvider
      transport={transport}
      {...providerConfig}
      session={effectiveSession}
    >
      {children ?? (
        <FloatingChatUI
          title={title}
          open={open}
          onOpenChange={onOpenChange}
          defaultOpen={defaultOpen}
          draggable={draggable}
          resizable={resizable}
          size={size}
          hideTriggerWhenOpen={hideTriggerWhenOpen}
          shortcut={shortcut}
          showClearButton={showClearButton}
          confirmClear={confirmClear}
          showSessionSwitcher={showSessionSwitcher}
          headerActions={headerActions}
          triggerIcon={triggerIcon}
          showMic={showMic}
          welcomeMessage={welcomeMessage}
        />
      )}
    </AiChatProvider>
  );
}
