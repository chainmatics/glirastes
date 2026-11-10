'use client';

import type { CSSProperties, ReactNode } from 'react';
import { AssistantLayoutProvider, useOptionalAssistantLayout, type AssistantLayoutProviderProps } from './assistant-layout.js';
import { AssistantShell, type AssistantShellProps } from './assistant-shell.js';

export interface AssistantWorkspaceProps
  extends Omit<AssistantShellProps, 'children' | 'mainSelector'>,
    Omit<AssistantLayoutProviderProps, 'children'> {
  /** The page. Put an `AssistantToggle` wherever it belongs, e.g. in the top bar. */
  children: ReactNode;
  /** The conversation, usually `<AiChatPanel />`. */
  chat: ReactNode;
  /** Class of the row that holds page and docked assistant. It fills its parent by default. */
  className?: string;
  /** Class of the page area next to the assistant. */
  mainClassName?: string;
}

const ROW: CSSProperties = { display: 'flex', width: '100%', height: '100%', minHeight: 0 };
const MAIN: CSSProperties = { flex: '1 1 0%', minWidth: 0, minHeight: 0, overflow: 'auto' };

/**
 * The assistant in one component: the page, and next to it the chat docked
 * on the right or detached as a window, with layout, width and position
 * remembered. Wrap the app's content in it inside the chat provider:
 *
 *   <AiChatProvider ...>
 *     <AssistantWorkspace chat={<AiChatPanel />}>
 *       <header>… <AssistantToggle /></header>
 *       <main>…</main>
 *     </AssistantWorkspace>
 *   </AiChatProvider>
 *
 * Every option of `AssistantShell` (icons, labels, classNames, renderButton,
 * header slots, shortcuts, window) and of `AssistantLayoutProvider`
 * (storageKey, defaultMode, widths) can be given here. An app that already
 * has an `AssistantLayoutProvider` higher up keeps using that one.
 */
export function AssistantWorkspace({
  children, chat, className, mainClassName,
  storageKey, minWidth, maxWidth, defaultWidth, defaultMode,
  ...shell
}: AssistantWorkspaceProps) {
  const existing = useOptionalAssistantLayout();
  const row = <div data-component="assistant-workspace" className={className} style={className ? undefined : ROW}>
    <div data-assistant-main className={mainClassName} style={mainClassName ? undefined : MAIN}>{children}</div>
    <AssistantShell {...shell}>{chat}</AssistantShell>
  </div>;
  if (existing) return row;
  return <AssistantLayoutProvider storageKey={storageKey} minWidth={minWidth} maxWidth={maxWidth}
    defaultWidth={defaultWidth} defaultMode={defaultMode}>{row}</AssistantLayoutProvider>;
}
