import {
  useState,
  useCallback,
  useRef,
  useContext,
  useLayoutEffect,
  useMemo,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { VoiceInputAddon } from './voice-input-addon.js';
import { MentionInput } from './mention-input.js';
import { ComposerToolbarLayout } from './composer-toolbar.js';
import { ChatWindowVisibilityContext } from './chat-window-visibility.js';
import { createTextareaComposerHandle } from './textarea-composer-handle.js';
import { ComposerHint } from './composer-hint.js';
import { composerContextOf } from '../provider/composer-context.js';
import { useChatComposerTarget } from '../composer/chat-composer.js';
import { useComposerDraft } from '../composer/use-composer-draft.js';
import { isImeKeyDown } from '../utils/ime.js';
import type { ChatAttachment, ChatComposerInputControls, ChatInputProps, RichMentionInputHandle } from '../types.js';

const NO_ATTACHMENTS: ReadonlyArray<ChatAttachment> = [];

/**
 * The chat's input. With `@`/`/` search (`chatInteractions` or
 * `completionProviders`) it is the pill composer (`MentionInput`); otherwise
 * a plain text field that submits on Enter (without Shift) and renders the
 * provider's `InputExtra` (e.g. a voice button).
 */
export function ChatInput(props: ChatInputProps) {
  const { completionSearch } = useChatContext();
  return completionSearch ? <MentionInput {...props} /> : <PlainChatInput {...props} />;
}

function PlainChatInput({ className, onSubmit }: ChatInputProps) {
  const visible = useContext(ChatWindowVisibilityContext);
  const context = useChatContext();
  const { send, stop, isLoading, canCompose: composable, queue, classNames, locale, components, voice } = context;
  const hint = composerContextOf(context).composer?.hint === true;
  // A hand-built context without `canCompose` locks while loading, as before.
  const canCompose = composable ?? !isLoading;
  const [value, setValue] = useState('');
  const InputExtra = components.InputExtra;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // `useChatComposer` operations (insertText, setDraft, chatAbout, ...) reach the textarea through this handle.
  const handleRef = useRef<RichMentionInputHandle | null>(null);
  if (!handleRef.current) handleRef.current = createTextareaComposerHandle(textareaRef, setValue);
  useComposerDraft(handleRef, value, setValue);
  useChatComposerTarget(handleRef, { onChange: setValue });

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.overflowY = 'hidden';
    const borderY = el.offsetHeight - el.clientHeight;
    const next = el.scrollHeight + borderY;
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    if (next > max) {
      el.style.height = `${max}px`;
      el.style.overflowY = 'auto';
    } else {
      el.style.height = `${next}px`;
    }
  }, [value]);

  const submitValue = useCallback((): boolean => {
    const trimmed = value.trim();
    if (!trimmed || !canCompose) return false;
    if (onSubmit) {
      onSubmit(trimmed);
    } else if (!send(trimmed)) {
      return false;
    }
    setValue('');
    return true;
  }, [value, canCompose, onSubmit, send]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      submitValue();
    },
    [submitValue],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter that commits an IME composition does not send.
      if (isImeKeyDown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e as unknown as FormEvent);
      }
    },
    [handleSubmit],
  );

  const [liveText, setLiveText] = useState<string | null>(null);
  // A one-row field shows the start of a long placeholder; keep the newest words.
  const live = liveText === null ? null : liveText.trim().length > 120 ? `…${liveText.trim().slice(-119)}` : liveText.trim();

  const appendText = useCallback((text: string) => {
    setValue((prev) => (prev.length > 0 ? `${prev} ${text}` : text));
  }, []);

  // The plain field has no attachments and no completion; those controls do nothing.
  const controls = useMemo<ChatComposerInputControls>(() => ({
    value,
    isLoading,
    canCompose,
    canSend: canCompose && value.trim().length > 0,
    attachments: NO_ATTACHMENTS,
    attachmentError: null,
    attachmentsEnabled: false,
    addFiles: async () => {},
    removeAttachment: () => {},
    openFilePicker: () => {},
    submit: submitValue,
    stop,
    setText: setValue,
    appendText,
    focus: () => textareaRef.current?.focus(),
    openCompletion: () => {},
  }), [value, isLoading, canCompose, submitValue, stop, appendText]);

  return (
    <form
      onSubmit={handleSubmit}
      className={className ?? classNames.input}
      data-component="chat-input"
    >
      <ComposerToolbarLayout
        controls={controls}
        builtins={{
          attach: null,
          mic: voice.enabled && (
            <VoiceInputAddon
              disabled={!canCompose}
              language={voice.language ?? 'de'}
              baseUrl={voice.baseUrl}
              workletUrl={voice.workletUrl}
              getToken={voice.getToken}
              onTranscript={appendText}
              onError={voice.onError}
              showRecordingBar={voice.recordingBar?.enabled ?? true}
              recordingBarVariant={voice.recordingBar?.variant ?? 'inline'}
              onLiveTranscript={setLiveText}
              adapter={voice.adapter}
              pushToTalk={voice.pushToTalk}
              routeKey={voice.routeKey}
            />
          ),
          actions: null,
          extra: InputExtra && <InputExtra />,
          send: (
            <>
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
            </>
          ),
        }}
        editor={(
          <>
            <textarea
              ref={textareaRef}
              autoFocus={visible}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={live || locale.placeholder}
              aria-label={locale.placeholder}
              disabled={!canCompose}
              rows={1}
              data-state={isLoading ? 'loading' : 'idle'}
              data-live={live && !value ? 'true' : undefined}
            />
            {live && value && <div data-element="live-transcript" aria-hidden>{live}</div>}
          </>
        )}
      />
      {hint && <ComposerHint />}
    </form>
  );
}
