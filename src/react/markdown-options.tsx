import { createContext, useContext } from 'react';
import type { ChatMarkdownOptions } from './types.js';

export const NO_MARKDOWN_OPTIONS: ChatMarkdownOptions = {};

export const ChatMarkdownOptionsContext = createContext<ChatMarkdownOptions>(NO_MARKDOWN_OPTIONS);

/** Markdown options the host set on `AiChatProvider` (`markdown`). */
export function useChatMarkdownOptions(): ChatMarkdownOptions {
  return useContext(ChatMarkdownOptionsContext);
}
