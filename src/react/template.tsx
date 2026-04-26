import { AiChatPanel } from './components/ai-chat-panel.js';
import { ChatInput } from './components/chat-input.js';
import { MessageBubble } from './components/message-bubble.js';
import { MessageList } from './components/message-list.js';
import type {
  AiChatPanelProps,
  ChatInputProps,
  MessageBubbleProps,
  MessageListProps,
} from './types.js';

// ---------------------------------------------------------------------------
// cn — tiny class merge utility (keeps runtime deps minimal).
// ---------------------------------------------------------------------------

type ClassDictionary = Record<string, boolean | null | undefined>;
type ClassArray = ClassValue[];
type ClassPrimitive = string | number | null | undefined | false;
export type ClassValue = ClassPrimitive | ClassDictionary | ClassArray;

function appendClass(output: string[], value: ClassValue): void {
  if (!value) return;
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendClass(output, item);
    return;
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (enabled) output.push(key);
  }
}

export function cn(...values: ClassValue[]): string {
  const output: string[] = [];
  for (const value of values) appendClass(output, value);
  return output.join(' ');
}

// ---------------------------------------------------------------------------
// Theme tokens
// ---------------------------------------------------------------------------

export const defaultTheme = {
  colors: {
    primary: '#6366f1',
    background: '#ffffff',
    bubbleUser: '#e0e7ff',
    bubbleAssistant: '#f3f4f6',
    border: '#e5e7eb',
    text: '#111827',
    textMuted: '#6b7280',
  },
  radius: {
    panel: '0.75rem',
    bubble: '0.75rem',
    input: '0.5rem',
    chip: '9999px',
  },
  spacing: {
    panelPadding: '1rem',
    bubbleGap: '0.75rem',
    inputPadding: '0.75rem',
  },
} as const;

export type ChatTheme = typeof defaultTheme;

export const tailwindThemeExtension = {
  colors: {
    'chat-primary': 'rgb(var(--chat-primary) / <alpha-value>)',
    'chat-background': 'rgb(var(--chat-background) / <alpha-value>)',
    'chat-bubble-user': 'rgb(var(--chat-bubble-user) / <alpha-value>)',
    'chat-bubble-assistant': 'rgb(var(--chat-bubble-assistant) / <alpha-value>)',
    'chat-border': 'rgb(var(--chat-border) / <alpha-value>)',
    'chat-text': 'rgb(var(--chat-text) / <alpha-value>)',
    'chat-text-muted': 'rgb(var(--chat-text-muted) / <alpha-value>)',
  },
  borderRadius: {
    'chat-panel': '0.75rem',
    'chat-bubble': '0.75rem',
    'chat-input': '0.5rem',
    'chat-chip': '9999px',
  },
} as const;

// ---------------------------------------------------------------------------
// StyledMessageBubble
// ---------------------------------------------------------------------------

export interface StyledMessageBubbleProps extends MessageBubbleProps {
  classNames?: {
    base?: string;
    user?: string;
    assistant?: string;
    system?: string;
  };
}

export function StyledMessageBubble({
  message,
  className,
  classNames,
}: StyledMessageBubbleProps) {
  return (
    <MessageBubble
      message={message}
      className={cn(
        'max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed shadow-sm',
        classNames?.base,
        message.role === 'user' && 'ml-auto bg-[rgb(var(--chat-bubble-user,224_231_255))] text-right',
        message.role === 'user' && classNames?.user,
        message.role === 'assistant' && 'mr-auto bg-[rgb(var(--chat-bubble-assistant,243_244_246))] text-left',
        message.role === 'assistant' && classNames?.assistant,
        message.role === 'system' && 'mx-auto bg-[rgb(var(--chat-bubble-assistant,243_244_246))] text-center',
        message.role === 'system' && classNames?.system,
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// StyledMessageList
// ---------------------------------------------------------------------------

export interface StyledMessageListProps extends MessageListProps {
  classNames?: {
    root?: string;
    loadMore?: string;
    bubble?: string;
  };
}

export function StyledMessageList({ className, classNames }: StyledMessageListProps) {
  return (
    <MessageList
      className={cn(
        'flex-1 min-h-0 overflow-y-auto px-4 py-3',
        '[&>[data-action=load-more]]:mx-auto [&>[data-action=load-more]]:mb-3',
        '[&>[data-action=load-more]]:rounded-md [&>[data-action=load-more]]:border',
        '[&>[data-action=load-more]]:border-[rgb(var(--chat-border,229_231_235))]',
        '[&>[data-action=load-more]]:px-3 [&>[data-action=load-more]]:py-1.5',
        '[&>[data-action=load-more]]:text-xs [&>[data-action=load-more]]:font-medium',
        '[&>[data-component=message-bubble]]:mb-3',
        classNames?.root,
        classNames?.loadMore,
        classNames?.bubble,
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// StyledChatInput
// ---------------------------------------------------------------------------

export interface StyledChatInputProps extends ChatInputProps {
  classNames?: {
    root?: string;
    textarea?: string;
    sendButton?: string;
    stopButton?: string;
  };
}

export function StyledChatInput({
  className,
  onSubmit,
  classNames,
}: StyledChatInputProps) {
  return (
    <ChatInput
      className={cn(
        'shrink-0 border-t border-[rgb(var(--chat-border,229_231_235))]',
        'bg-[rgb(var(--chat-background,255_255_255))] px-4 py-3',
        'flex items-end gap-2',
        '[&_textarea]:min-h-[44px] [&_textarea]:max-h-[160px] [&_textarea]:flex-1 [&_textarea]:resize-none',
        '[&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-[rgb(var(--chat-border,229_231_235))]',
        '[&_textarea]:bg-transparent [&_textarea]:px-3 [&_textarea]:py-2.5',
        '[&_textarea]:text-[rgb(var(--chat-text,17_24_39))]',
        '[&_textarea]:placeholder:text-[rgb(var(--chat-text-muted,107_114_128))]',
        '[&_textarea]:outline-none [&_textarea]:focus:ring-2 [&_textarea]:focus:ring-indigo-200',
        '[&_[data-action=send]]:rounded-lg [&_[data-action=send]]:bg-[rgb(var(--chat-primary,99_102_241))]',
        '[&_[data-action=send]]:px-3 [&_[data-action=send]]:py-2 [&_[data-action=send]]:text-sm',
        '[&_[data-action=send]]:font-medium [&_[data-action=send]]:text-white',
        '[&_[data-action=send]]:disabled:cursor-not-allowed [&_[data-action=send]]:disabled:opacity-50',
        '[&_[data-action=stop]]:rounded-lg [&_[data-action=stop]]:border',
        '[&_[data-action=stop]]:border-[rgb(var(--chat-border,229_231_235))]',
        '[&_[data-action=stop]]:px-3 [&_[data-action=stop]]:py-2 [&_[data-action=stop]]:text-sm',
        classNames?.root,
        classNames?.textarea,
        classNames?.sendButton,
        classNames?.stopButton,
        className,
      )}
      onSubmit={onSubmit}
    />
  );
}

// ---------------------------------------------------------------------------
// StyledChatPanel
// ---------------------------------------------------------------------------

export interface StyledChatPanelProps extends AiChatPanelProps {
  classNames?: {
    root?: string;
    errorBanner?: string;
    emptyState?: string;
    suggestionBar?: string;
    suggestionChip?: string;
    mentionChip?: string;
  };
}

export function StyledChatPanel({ className, classNames }: StyledChatPanelProps) {
  return (
    <AiChatPanel
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-xl border',
        'border-[rgb(var(--chat-border,229_231_235))]',
        'bg-[rgb(var(--chat-background,255_255_255))] text-[rgb(var(--chat-text,17_24_39))]',
        'shadow-sm',
        '[&_[data-component=error-banner]]:border-b [&_[data-component=error-banner]]:border-red-200',
        '[&_[data-component=error-banner]]:bg-red-50 [&_[data-component=error-banner]]:px-4',
        '[&_[data-component=error-banner]]:py-2.5 [&_[data-component=error-banner]]:text-sm',
        '[&_[data-component=empty-state]]:flex-1 [&_[data-component=empty-state]]:grid',
        '[&_[data-component=empty-state]]:place-items-center [&_[data-component=empty-state]]:px-6',
        '[&_[data-component=empty-state]]:text-sm [&_[data-component=empty-state]]:text-[rgb(var(--chat-text-muted,107_114_128))]',
        '[&_[data-component=suggestion-bar]]:px-4 [&_[data-component=suggestion-bar]]:pb-2',
        '[&_[data-component=suggestion-chip]]:rounded-full',
        '[&_[data-component=suggestion-chip]]:bg-[rgb(var(--chat-primary,99_102_241))]',
        '[&_[data-component=suggestion-chip]]:px-3 [&_[data-component=suggestion-chip]]:py-1.5',
        '[&_[data-component=suggestion-chip]]:text-xs [&_[data-component=suggestion-chip]]:font-medium',
        '[&_[data-component=suggestion-chip]]:text-white',
        '[&_[data-component=mention-chip]]:inline-flex [&_[data-component=mention-chip]]:items-center',
        '[&_[data-component=mention-chip]]:rounded-full [&_[data-component=mention-chip]]:bg-slate-100',
        '[&_[data-component=mention-chip]]:px-2.5 [&_[data-component=mention-chip]]:py-1',
        '[&_[data-component=mention-chip]]:text-xs',
        classNames?.root,
        classNames?.errorBanner,
        classNames?.emptyState,
        classNames?.suggestionBar,
        classNames?.suggestionChip,
        classNames?.mentionChip,
        className,
      )}
    />
  );
}
