import type { ChatLocale } from '../types.js';
import { AUDIO_WORKLET_UNAVAILABLE } from '../stt/worklet-error.js';

type VoiceTextKey =
  | 'voiceStartAriaLabel'
  | 'voiceStopAriaLabel'
  | 'voiceConnectingAriaLabel'
  | 'voiceTranscribingAriaLabel'
  | 'voiceCancelAriaLabel'
  | 'retryRecordingAriaLabel'
  | 'voiceFailedText'
  | 'voiceUnavailableText';

/** English texts of the voice controls; also the fallback outside a chat provider. */
export const VOICE_TEXTS_EN: Readonly<Record<VoiceTextKey, string>> = {
  voiceStartAriaLabel: 'Start voice input',
  voiceStopAriaLabel: 'Stop recording',
  voiceConnectingAriaLabel: 'Starting voice input…',
  voiceTranscribingAriaLabel: 'Transcribing…',
  voiceCancelAriaLabel: 'Cancel recording',
  retryRecordingAriaLabel: 'Retry recording',
  voiceFailedText: 'Voice input failed. Try again.',
  voiceUnavailableText: 'Voice input is unavailable: the audio module could not be loaded.',
};

export function voiceText(locale: Partial<ChatLocale> | undefined, key: VoiceTextKey): string {
  return locale?.[key] ?? VOICE_TEXTS_EN[key];
}

export type VoiceButtonState = 'idle' | 'connecting' | 'recording' | 'transcribing' | 'failed';

export function voiceButtonLabel(locale: Partial<ChatLocale> | undefined, state: VoiceButtonState): string {
  if (state === 'connecting') return voiceText(locale, 'voiceConnectingAriaLabel');
  if (state === 'recording') return voiceText(locale, 'voiceStopAriaLabel');
  if (state === 'transcribing') return voiceText(locale, 'voiceTranscribingAriaLabel');
  return voiceText(locale, 'voiceStartAriaLabel');
}

const SVG_PROPS = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

export function MicIcon() {
  return (
    <svg {...SVG_PROPS} data-part="icon" data-icon="mic">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

export function StopIcon({ pulse = false }: { pulse?: boolean }) {
  return (
    <svg
      {...SVG_PROPS}
      data-part="stop"
      data-icon="stop"
      style={pulse ? { animation: 'glirastes-voice-pulse 1.5s ease-in-out infinite' } : undefined}
    >
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

export function BusyIcon() {
  return (
    <svg {...SVG_PROPS} data-part="spinner" data-icon="busy">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

export function RetryIcon() {
  return (
    <svg {...SVG_PROPS} data-icon="retry">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

export function VoiceStateIcon({ state, pulse }: { state: VoiceButtonState; pulse?: boolean }) {
  if (state === 'recording') return <StopIcon pulse={pulse} />;
  if (state === 'connecting' || state === 'transcribing') return <BusyIcon />;
  return <MicIcon />;
}

/** The visible, announced text of a failed recording. */
export function VoiceError({
  locale,
  errorCode,
}: {
  locale: Partial<ChatLocale> | undefined;
  errorCode: string | null | undefined;
}) {
  return (
    <span role="alert" data-element="voice-error">
      {errorCode === AUDIO_WORKLET_UNAVAILABLE
        ? voiceText(locale, 'voiceUnavailableText')
        : voiceText(locale, 'voiceFailedText')}
    </span>
  );
}
