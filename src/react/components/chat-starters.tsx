import { useOptionalChatComposer } from '../composer/chat-composer.js';
import { useChatContext } from '../provider/chat-context.js';
import { composerContextOf } from '../provider/composer-context.js';
import type { ChatStarter } from '../types.js';

export interface ChatStartersProps {
  className?: string;
}

function toStarter(entry: string | ChatStarter): ChatStarter {
  return typeof entry === 'string' ? { label: entry } : entry;
}

/**
 * Starter chips on an empty chat (`composer.starters`). A click puts the
 * starter's prompt into the composer (after text already there) and focuses
 * it; a starter with `send: true` sends the prompt instead. Disabled while
 * the composer is locked. Renders nothing without starters or once the chat
 * has messages. `AiChatPanel` renders it; use it in an own panel above the
 * composer.
 */
export function ChatStarters({ className }: ChatStartersProps) {
  const context = useChatContext();
  const composer = useOptionalChatComposer();
  const { messages, locale, send, isLoading, canCompose: composable, pendingApprovals, pendingCommand } = context;
  const config = composerContextOf(context).composer;
  const starters = config?.starters;
  if (!starters?.length || messages.length > 0) return null;
  // A hand-built context without `canCompose` locks while loading, as the inputs do.
  const locked = !(composable ?? !isLoading) || (pendingApprovals?.length ?? 0) > 0 || !!pendingCommand;
  const renderIcon = config?.renderIcon;

  return (
    <div
      className={className}
      data-component="chat-starters"
      role="group"
      aria-label={locale.startersLabel ?? 'Suggestions'}
    >
      {starters.map((entry, index) => {
        const starter = toStarter(entry);
        const prompt = starter.prompt ?? starter.label;
        const icon = typeof starter.icon === 'string'
          ? renderIcon?.(starter.icon, { type: 'starter' })
          : starter.icon;
        return (
          <button
            // Starters are a static app list; label plus position keeps duplicates apart.
            key={`${index}:${starter.label}`}
            type="button"
            data-element="starter"
            disabled={locked}
            {...(starter.description ? { title: starter.description } : {})}
            onClick={() => {
              if (locked) return;
              if (starter.send) {
                send(prompt);
                return;
              }
              composer?.insertText(prompt);
              composer?.focus();
            }}
          >
            {icon !== undefined && icon !== null && icon !== false && (
              <span data-element="starter-icon" aria-hidden="true">{icon}</span>
            )}
            <span data-element="starter-label">{starter.label}</span>
          </button>
        );
      })}
    </div>
  );
}
