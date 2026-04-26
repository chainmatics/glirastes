import {
  useState,
  useCallback,
  useRef,
  useLayoutEffect,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { VoiceInputAddon } from './voice-input-addon.js';
import type { ChatInputProps } from '../types.js';

/**
 * Plain chat input field with submit handling.
 *
 * Submits on Enter (without Shift). Renders the InputExtra component
 * from provider config if available (e.g., voice input button).
 *
 * Toggles between send and stop button based on loading state.
 */
export function ChatInput({ className, onSubmit }: ChatInputProps) {
  const { send, stop, isLoading, classNames, locale, components, voice } = useChatContext();
  const [value, setValue] = useState('');
  const InputExtra = components.InputExtra;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed || isLoading) return;
      if (onSubmit) {
        onSubmit(trimmed);
      } else {
        send(trimmed);
      }
      setValue('');
    },
    [value, isLoading, onSubmit, send],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e as unknown as FormEvent);
      }
    },
    [handleSubmit],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className={className ?? classNames.input}
      data-component="chat-input"
    >
      <textarea
        ref={textareaRef}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={locale.placeholder}
        disabled={isLoading}
        rows={1}
        data-state={isLoading ? 'loading' : 'idle'}
      />
      {voice.enabled && (
        <VoiceInputAddon
          disabled={isLoading}
          language={voice.language ?? 'de'}
          baseUrl={voice.baseUrl}
          getToken={voice.getToken}
          onTranscript={(text) => {
            setValue((prev) => (prev.length > 0 ? `${prev} ${text}` : text));
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
  );
}
