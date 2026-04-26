import { useState, useRef, useCallback, useMemo } from 'react';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
import { VoiceInputAddon } from './voice-input-addon.js';
import { useChatContext } from '../provider/chat-context.js';
import { inferMentionPrefix, normalizeMentionSlug } from '../utils/mention-markup.js';
import type { MentionInputProps, RichMentionInputHandle } from '../types.js';

/**
 * Chat input with mention autocomplete support.
 *
 * Uses `RichMentionInput` for editing, provides autocomplete for `@` and `/`,
 * and keeps selected mentions in provider state for serialization on send.
 */
export function MentionInput({ className, onSubmit }: MentionInputProps) {
  const {
    send,
    stop,
    isLoading,
    classNames,
    locale,
    components,
    mentionResults,
    setMentionSearch,
    clearMentionSearch,
    isMentionSearching,
    hasMentions,
    mentionConfig,
    addActiveMention,
    removeActiveMention,
    clearActiveMentions,
    activeMentions,
    voice,
  } = useChatContext();

  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const InputExtra = components.InputExtra;

  const detectMentionQuery = useCallback((text: string) => {
    const match = text.match(/(?:^|\s)([@/])([a-zA-Z0-9._-]{1,80})$/);
    if (!match) return null;
    return {
      trigger: match[1] as '@' | '/',
      query: match[2] ?? '',
    };
  }, []);

  const updateValue = useCallback((nextValue: string) => {
    setValue(nextValue);
    if (!hasMentions) return;
    const mentionState = detectMentionQuery(nextValue);
    if (mentionState && mentionState.query.length > 0) {
      setMentionSearch(mentionState.query, mentionState.trigger);
      return;
    }
    clearMentionSearch();
  }, [clearMentionSearch, detectMentionQuery, hasMentions, setMentionSearch]);

  const handleSubmit = useCallback((message: string) => {
    const trimmed = message.trim();
    if (!trimmed || isLoading) return;
    if (onSubmit) {
      onSubmit(trimmed);
    } else {
      send(trimmed);
    }
    setValue('');
    clearMentionSearch();
    clearActiveMentions();
  }, [clearActiveMentions, clearMentionSearch, isLoading, onSubmit, send]);

  const selectedMentionIds = useMemo(
    () => new Set(activeMentions.map((mention) => String(mention.id))),
    [activeMentions],
  );

  const applyMention = useCallback(async (result: { id: string; type: string; label: string }) => {
    const mentionState = detectMentionQuery(value);
    const prefix = mentionState?.trigger ?? inferMentionPrefix(result.type);
    const explicitSlug = (result as unknown as { slug?: string }).slug;
    const slug = typeof explicitSlug === 'string' && explicitSlug.trim().length > 0
      ? explicitSlug.trim()
      : normalizeMentionSlug(result.label);
    const token = `${prefix}${slug}`;

    const replaced = value.replace(/(^|\s)([@/])[a-zA-Z0-9._-]*$/, `$1${token} `);
    const nextValue = replaced === value
      ? `${value.trimEnd()} ${token} `.trimStart()
      : replaced;

    let resolved: Record<string, unknown> = {};
    if (mentionConfig?.resolve) {
      try {
        resolved = await mentionConfig.resolve(result.id, result.type);
      } catch {
        resolved = {};
      }
    }

    addActiveMention({
      ...resolved,
      id: result.id,
      type: result.type,
      label: result.label,
      displayName: typeof resolved.displayName === 'string' ? resolved.displayName : result.label,
      slug,
      prefix,
    });

    updateValue(nextValue);
    clearMentionSearch();
    inputRef.current?.focus();
  }, [
    addActiveMention,
    clearMentionSearch,
    detectMentionQuery,
    mentionConfig,
    updateValue,
    value,
  ]);

  return (
    <div data-component="mention-input">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit(value);
        }}
        className={className ?? classNames.input}
      >
        <MentionChipList
          mentions={activeMentions.map((mention) => ({
            id: String(mention.id),
            type: String(mention.type),
            displayName: typeof mention.displayName === 'string'
              ? mention.displayName
              : typeof mention.label === 'string'
              ? mention.label
              : String(mention.id),
            slug: typeof mention.slug === 'string' ? mention.slug : undefined,
            prefix: typeof mention.prefix === 'string' ? mention.prefix : undefined,
          }))}
          onRemove={removeActiveMention}
        />

        <RichMentionInput
          ref={inputRef}
          value={value}
          onChange={updateValue}
          onSubmit={handleSubmit}
          placeholder={locale.placeholder}
          disabled={isLoading}
        />

        {voice.enabled && (
          <VoiceInputAddon
            disabled={isLoading}
            language={voice.language ?? 'de'}
            baseUrl={voice.baseUrl}
            getToken={voice.getToken}
            onTranscript={(text) => {
              const nextValue = value.length > 0 ? `${value} ${text}` : text;
              updateValue(nextValue);
            }}
            onError={voice.onError}
            showRecordingBar={voice.recordingBar?.enabled ?? true}
            recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
          />
        )}
        {InputExtra && <InputExtra />}
        {isLoading ? (
          <button type="button" onClick={stop} data-action="stop">
            {locale.stopButton}
          </button>
        ) : (
          <button type="submit" disabled={!value.trim()} data-action="send">
            {locale.sendButton}
          </button>
        )}
      </form>

      {hasMentions && mentionResults.length > 0 && (
        <div data-component="mention-dropdown" data-state={isMentionSearching ? 'searching' : 'idle'}>
          {mentionResults.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => {
                void applyMention(result);
              }}
              data-mention-type={result.type}
              data-selected={selectedMentionIds.has(result.id) ? 'true' : 'false'}
            >
              {result.label}
              {result.description && (
                <span data-element="description">{result.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
