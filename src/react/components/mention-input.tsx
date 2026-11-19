import { useState, useRef, useCallback, useMemo } from 'react';
import { MentionChipList } from './mention-chip.js';
import { RichMentionInput } from './rich-mention-input.js';
import { VoiceInputAddon } from './voice-input-addon.js';
import { AttachmentButton as DefaultAttachmentButton, AttachmentTray as DefaultAttachmentTray } from './attachments.js';
import { useChatComposerInput } from '../hooks/use-chat-composer-input.js';
import { useChatContext } from '../provider/chat-context.js';
import { inferMentionPrefix, normalizeMentionSlug } from '../utils/mention-markup.js';
import type {
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
  const { completionSearch, hasMentions, attachments } = useChatContext();
  // The legacy `mentions` flow has no attachment support; attachments alone use the composer.
  return completionSearch || (attachments && !hasMentions)
    ? <ProviderMentionInput {...props} />
    : <LegacyMentionInput {...props} />;
}

function ProviderMentionInput({
  className,
  onSubmit,
  initialValue,
  initialMentions,
  inputClassName,
  editorClassName,
  components: inputComponents,
  renderActions,
  renderSubmit,
}: MentionInputProps) {
  const { classNames, locale, components, voice, canCompose: composable, queue } = useChatContext();
  const composer = useChatComposerInput({
    onSubmit: onSubmit ? (message) => onSubmit(message) : undefined,
    initialValue,
  });
  const { isLoading } = composer;
  const canCompose = composable ?? !isLoading;
  const InputExtra = components.InputExtra;
  const DropdownItem = inputComponents?.DropdownItem ?? components.MentionDropdownItem;
  const Tray = components.AttachmentTray ?? DefaultAttachmentTray;
  const AttachButton = components.AttachmentButton ?? DefaultAttachmentButton;

  return (
    <div data-component="mention-input" data-mode="providers">
      {composer.argumentsForm}
      {composer.attachmentsEnabled && (
        <Tray attachments={composer.attachments} onRemove={composer.removeAttachment} error={composer.attachmentError} />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          composer.submit();
        }}
        className={className ?? classNames.input}
      >
        {composer.attachmentsEnabled && (
          <>
            <input {...composer.attachmentInputProps} />
            <AttachButton onClick={composer.openFilePicker} disabled={!canCompose} />
          </>
        )}
        <RichMentionInput
          ref={composer.inputRef}
          {...composer.inputProps}
          initialMentions={initialMentions}
          wrapperClassName={inputClassName}
          className={editorClassName}
          {...(DropdownItem ? { components: { DropdownItem } } : {})}
        />
        {voice.enabled && (
          <VoiceInputAddon
            disabled={!canCompose}
            language={voice.language ?? 'de'}
            baseUrl={voice.baseUrl}
            workletUrl={voice.workletUrl}
            getToken={voice.getToken}
            onTranscript={composer.appendText}
            onError={voice.onError}
            showRecordingBar={voice.recordingBar?.enabled ?? true}
            recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
            adapter={voice.adapter}
            pushToTalk={voice.pushToTalk}
            routeKey={voice.routeKey}
          />
        )}
        {renderActions?.(composer)}
        {InputExtra && <InputExtra />}
        {renderSubmit ? renderSubmit(composer) : (
          <>
            {isLoading && (
              <button type="button" onClick={composer.stop} data-action="stop">
                {locale.stopButton}
              </button>
            )}
            {(!isLoading || queue?.enabled) && (
              <button type="submit" disabled={!composer.canSend} data-action="send">
                {locale.sendButton}
              </button>
            )}
          </>
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
    canCompose: composable,
    queue,
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
  const canCompose = composable ?? !isLoading;

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
    if (!trimmed || !canCompose) return;
    if (onSubmit) {
      onSubmit(trimmed);
    } else if (!send(trimmed)) {
      return;
    }
    setValue('');
    clearMentionSearch();
    clearActiveMentions();
  }, [clearActiveMentions, clearMentionSearch, canCompose, onSubmit, send]);

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
          disabled={!canCompose}
        />

        {voice.enabled && (
          <VoiceInputAddon
            disabled={!canCompose}
            language={voice.language ?? 'de'}
            baseUrl={voice.baseUrl}
            workletUrl={voice.workletUrl}
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
        {isLoading && (
          <button type="button" onClick={stop} data-action="stop">
            {locale.stopButton}
          </button>
        )}
        {(!isLoading || queue?.enabled) && (
          <button type="submit" disabled={!value.trim() || !canCompose} data-action="send">
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
