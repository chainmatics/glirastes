import { useCallback, useEffect } from 'react';
import { useDeepgramTranscription } from '../hooks/use-deepgram-transcription.js';
import type { VoiceInputButtonProps } from '../types.js';

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

function StopIcon() {
  return (
    <span
      aria-hidden="true"
      data-part="stop"
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        borderRadius: 2,
        background: 'currentColor',
        animation: 'glirastes-voice-pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}

export function VoiceInputButton({
  onTranscript,
  disabled = false,
  className,
  language = 'de',
  baseUrl,
  getToken,
  onError,
}: VoiceInputButtonProps) {
  useInjectPulseStyle();

  const { isRecording, isConnecting, startRecording, stopRecording } = useDeepgramTranscription({
    language,
    baseUrl,
    getToken,
    onError,
  });

  const handleClick = useCallback(async () => {
    if (isRecording) {
      const finalText = stopRecording();
      if (finalText.trim()) {
        onTranscript(finalText);
      }
      return;
    }

    await startRecording();
  }, [isRecording, onTranscript, startRecording, stopRecording]);

  return (
    <button
      type="button"
      onClick={() => {
        void handleClick();
      }}
      disabled={disabled || isConnecting}
      className={joinClassNames('glirastes-voice-input-button', className)}
      data-component="voice-input-button"
      data-state={isConnecting ? 'connecting' : isRecording ? 'recording' : 'idle'}
      title={isRecording ? 'Aufnahme stoppen' : 'Spracheingabe starten'}
      aria-label={isRecording ? 'Aufnahme stoppen' : 'Spracheingabe starten'}
    >
      {isConnecting ? (
        <span aria-hidden="true" data-part="spinner">...</span>
      ) : isRecording ? (
        <StopIcon />
      ) : (
        <span aria-hidden="true" data-part="icon">mic</span>
      )}
    </button>
  );
}
