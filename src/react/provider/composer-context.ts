import type { CompletionItem, CompletionSelectContext, ComposerConfig, MessageFooterConfig } from '../types.js';
import type { ResolvedChatTrigger } from '../completions/triggers.js';
import type { ComposerDraftController } from '../composer/composer-drafts.js';
import { useChatContext, type ChatContextValue } from './chat-context.js';

/**
 * Internal: what the provider hands its own composer and message rendering
 * on the same context object. Not part of `ChatContextValue`, so apps never
 * depend on it; read it with `useComposerContext` or `composerContextOf`.
 * Its own module, so tests that mock `chat-context.js` keep working.
 */
export interface ComposerContextValue {
  /** The composer's trigger chars with prefix and pick behavior (`triggers` of the provider). */
  triggers?: ReadonlyArray<ResolvedChatTrigger>;
  /** Toolbar layout and app items of the composer (`composer` of the provider). */
  composer?: ComposerConfig;
  /** The provider's `onCompletionSelect`; the composer adds its controls. */
  onCompletionSelect?: (item: CompletionItem, context: CompletionSelectContext) => boolean | void;
  /** Visible prefix of a sent mention by type: a trigger's `types`, else `inferMentionPrefix`. */
  mentionPrefix?: (type: string) => string;
  /** The unsent composer text per chat, owned by this provider instance. */
  drafts?: ComposerDraftController;
  /**
   * While a request runs: the working time of its turn so far in ms (earlier
   * runs of the same turn included, approval waits not); `null` when nothing
   * runs. A getter, so the provider does not re-render while time passes.
   */
  turnWorkedMs?: () => number | null;
  /**
   * A request runs or a UI action outcome it waits for is open: `isLoading`
   * without the session load and session changes it also covers.
   */
  isTurnRunning?: boolean;
  /** The resolved `messageFooter` (every part a boolean), null when it is off. */
  messageFooter?: Required<MessageFooterConfig> | null;
}

/** The internal composer fields of a chat context value (absent outside the provider). */
export function composerContextOf(context: ChatContextValue | null | undefined): ComposerContextValue {
  return (context ?? {}) as ComposerContextValue;
}

/** Internal: `useChatContext()` plus the composer fields of the provider. */
export function useComposerContext(): ChatContextValue & ComposerContextValue {
  return useChatContext() as ChatContextValue & ComposerContextValue;
}

