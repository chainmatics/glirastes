import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { CommandArgumentsForm as DefaultCommandArgumentsForm } from './command-arguments-form.js';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
import { VoiceInputAddon } from './voice-input-addon.js';
import { useChatContext } from '../provider/chat-context.js';
import { inferMentionPrefix, normalizeMentionSlug } from '../utils/mention-markup.js';
import type {
  MentionData,
  MentionInputProps,
  RichMentionInputHandle,
} from '../types.js';

/**
 * Chat input with `@` mention and `/` command autocomplete.
 *
 * With `completionProviders` the editor searches the providers directly
 * (debounced, arrow keys, Tab/Enter, Escape) and submits structured ids.
 * Without them the legacy `mentions` flow is unchanged.
 */
export function MentionInput(props: MentionInputProps) {
  const { completionSearch } = useChatContext();
  return completionSearch
    ? <ProviderMentionInput {...props} />
    : <LegacyMentionInput {...props} />;
}

function ProviderMentionInput({ className, onSubmit }: MentionInputProps) {
  const {
    send,
    stop,
    isLoading,
    classNames,
    locale,
    components,
    completionSearch,
    voice,
    runEntityAction,
    composerMentions,
    consumeComposerMentions,
    pendingCommand,
    submitPendingCommand,
    cancelPendingCommand,
  } = useChatContext();
  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const InputExtra = components.InputExtra;
  const ArgumentsForm = components.CommandArgumentsForm ?? DefaultCommandArgumentsForm;

  // References added from outside the composer (`mentionEntity`).
  useEffect(() => {
    const handle = inputRef.current;
    if (!handle || composerMentions.length === 0) return;
    for (const mention of composerMentions) handle.addMention(mention);
    consumeComposerMentions();
    setValue(handle.getValue());
  }, [composerMentions, consumeComposerMentions]);

  const submit = useCallback((text: string, mentions: MentionData[]) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return false;
    if (onSubmit) {
      onSubmit(trimmed);
    } else {
      send(trimmed, { mentions });
    }
    setValue('');
    return true;
  }, [isLoading, onSubmit, send]);

  return (
    <div data-component="mention-input" data-mode="providers">
      {pendingCommand && (
        <ArgumentsForm
          key={`${pendingCommand.commandId}:${JSON.stringify(pendingCommand.values)}:${pendingCommand.error ?? ''}`}
          pending={pendingCommand}
          onSubmit={(values, valueLabels) => {
            // Back to the editor only once the form is gone; while it keeps asking, focus stays in it.
            if (submitPendingCommand(values, valueLabels)) inputRef.current?.focus();
          }}
          onCancel={() => {
            cancelPendingCommand();
            inputRef.current?.focus();
          }}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const handle = inputRef.current;
          if (handle && submit(handle.getValue(), handle.getMentions())) handle.clear();
        }}
        className={className ?? classNames.input}
      >
        <RichMentionInput
          ref={inputRef}
          onChange={setValue}
          onSubmit={(text, mentions) => { submit(text, mentions); }}
          onSearch={completionSearch}
          placeholder={locale.placeholder}
          disabled={isLoading}
          onEntityAction={(result, actionId) => runEntityAction(
            { type: result.type, id: result.id, label: result.label },
            actionId,
          )}
          listLabel={locale.completionListLabel}
          resultsLabel={locale.completionResultsLabel}
        />
        {voice.enabled && (
          <VoiceInputAddon
            disabled={isLoading}
            language={voice.language ?? 'de'}
            baseUrl={voice.baseUrl}
            getToken={voice.getToken}
            onTranscript={(text) => {
              const handle = inputRef.current;
              if (!handle) return;
              const current = handle.getValue();
              handle.setValue(current ? `${current} ${text}` : text, handle.getMentions());
            }}
            onError={voice.onError}
            showRecordingBar={voice.recordingBar?.enabled ?? true}
            recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
            adapter={voice.adapter}
            pushToTalk={voice.pushToTalk}
            routeKey={voice.routeKey}
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
    </div>
  );
}

function LegacyMentionInput({ className, onSubmit }: MentionInputProps) {
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
            adapter={voice.adapter}
            pushToTalk={voice.pushToTalk}
            routeKey={voice.routeKey}
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
