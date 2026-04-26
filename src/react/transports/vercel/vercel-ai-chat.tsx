'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { FloatingChatUI, type FloatingChatUIProps } from '../../components/floating-chat-ui.js';
import { useVercelAiChatTransport } from '../vercel.js';
import type { AiChatProviderConfig, SessionConfig } from '../../types.js';

export interface VercelAiChatProps extends AiChatProviderConfig, FloatingChatUIProps {
  /** Chat API endpoint URL (e.g. `/api/chat`). */
  endpoint: string;
  /** Static headers or a function that returns headers per request. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Auto-resume generation after all pending approvals are provided. Default: true. */
  autoResumeOnApproval?: boolean;
  /** Extra fields merged into every outgoing request body. */
  bodyExtras?: Record<string, unknown> | (() => Record<string, unknown>);
  /**
   * Multi-session hooks. When provided, the drop-in renders a session
   * switcher in the header and sends the active session id as `sessionId`
   * in the request body (merged with `bodyExtras`). Your backend owns
   * how to interpret it — the Vercel AI SDK itself has no thread concept.
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
 * Drop-in Vercel AI SDK chat widget. Bundles transport, provider, and a
 * floating (trigger button + draggable window) chat UI into one component.
 *
 * ```tsx
 * 'use client';
 * import { VercelAiChat } from 'glirastes/react/vercel';
 *
 * export default function Layout({ children }) {
 *   return (
 *     <>
 *       {children}
 *       <VercelAiChat endpoint="/api/chat" sessions={mySessionBridge} />
 *     </>
 *   );
 * }
 * ```
 *
 * All `AiChatProviderConfig` fields (session, mentions, classNames, etc.)
 * and `FloatingChatUIProps` (title, defaultOpen, width, height, draggable,
 * resizable, shortcut, showClearButton) are accepted as top-level props.
 */
export function VercelAiChat({
  endpoint,
  headers,
  autoResumeOnApproval,
  bodyExtras,
  sessions,
  title,
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
  children,
  ...providerConfig
}: VercelAiChatProps) {
  const [activeId, setActiveId] = useState<string>(() => {
    if (sessions?.activeId) return sessions.activeId;
    if (sessions?.defaultActiveId) return sessions.defaultActiveId;
    return 'default';
  });

  useEffect(() => {
    if (sessions?.activeId && sessions.activeId !== activeId) {
      setActiveId(sessions.activeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions?.activeId]);

  // When sessions are enabled, merge `sessionId` into the outgoing body
  // on every request — the backend is responsible for routing.
  const mergedBodyExtras = useMemo(() => {
    if (!sessions) return bodyExtras;
    return () => {
      const base =
        typeof bodyExtras === 'function'
          ? bodyExtras()
          : bodyExtras ?? {};
      return { ...base, sessionId: activeId };
    };
  }, [sessions, bodyExtras, activeId]);

  const transport = useVercelAiChatTransport({
    endpoint,
    headers,
    autoResumeOnApproval,
    bodyExtras: mergedBodyExtras,
  });

  const effectiveSession: SessionConfig | undefined = useMemo(() => {
    if (!sessions) return providerConfig.session;
    // Strip any consumer-supplied `activeId` and use `defaultActiveId`
    // (seed-only) so the provider stays uncontrolled. Auto-select +
    // switchSession both flow back through `onActiveIdChange`.
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
        />
      )}
    </AiChatProvider>
  );
}
