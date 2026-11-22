import { useCallback, useContext, useEffect } from 'react';
import { useDeepgramTranscription } from '../hooks/use-deepgram-transcription.js';
import { ChatContext } from '../provider/chat-context.js';
import type { VoiceInputButtonProps } from '../types.js';
import { VoiceError, VoiceStateIcon, voiceButtonLabel, type VoiceButtonState } from './voice-ui.js';

const PULSE_STYLE_ID = 'glirastes-voice-pulse-style';
const PULSE_CSS = `@keyframes glirastes-voice-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`;

function useInjectPulseStyle() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(PULSE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PULSE_STYLE_ID;
    style.textContent = PULSE_CSS;
    document.head.appendChild(style);
  }, []);
}

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function VoiceInputButton({
  onTranscript,
  disabled = false,
  className,
  language = 'de',
  baseUrl,
  workletUrl,
  getToken,
  adapter,
  onError,
}: VoiceInputButtonProps) {
  useInjectPulseStyle();
  const locale = useContext(ChatContext)?.locale;

  const {
    phase, errorCode, isRecording, isConnecting, startRecording, stopRecording,
  } = useDeepgramTranscription({
    language,
    baseUrl,
    workletUrl,
    getToken,
    adapter,
    onError,
  });

  const handleClick = useCallback(async () => {
    if (isRecording) {
      const finalText = await stopRecording();
      if (finalText.trim()) {
        onTranscript(finalText);
      }
      return;
    }

    // Failures show as the failed state and its alert.
    await startRecording().catch(() => {});
  }, [isRecording, onTranscript, startRecording, stopRecording]);

  const state: VoiceButtonState = phase === 'failed'
    ? 'failed'
    : isConnecting
      ? 'connecting'
      : phase === 'finalizing'
        ? 'transcribing'
        : isRecording
          ? 'recording'
          : 'idle';
  const label = voiceButtonLabel(locale, state);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void handleClick();
        }}
        disabled={disabled || isConnecting}
        className={joinClassNames('glirastes-voice-input-button', className)}
        data-component="voice-input-button"
        data-state={state === 'transcribing' ? 'recording' : state}
        aria-busy={state === 'connecting' || state === 'transcribing'}
        title={label}
        aria-label={label}
      >
        <VoiceStateIcon state={state} pulse />
      </button>
      {state === 'failed' && <VoiceError locale={locale} errorCode={errorCode} />}
    </>
  );
}
