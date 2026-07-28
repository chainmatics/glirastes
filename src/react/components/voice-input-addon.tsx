import { useCallback } from 'react';
import { useDeepgramTranscription } from '../hooks/use-deepgram-transcription.js';
import { RecordingBar } from './recording-bar.js';

interface VoiceInputAddonProps {
  disabled: boolean;
  language: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  showRecordingBar?: boolean;
  recordingBarVariant?: 'trigger' | 'inline';
}

export function VoiceInputAddon({
  disabled,
  language,
  baseUrl,
  getToken,
  onTranscript,
  onError,
  showRecordingBar = true,
  recordingBarVariant = 'inline',
}: VoiceInputAddonProps) {
  const {
    isRecording,
    isConnecting,
    displayTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useDeepgramTranscription({
    language,
    baseUrl,
    getToken,
    onError,
  });

  const stopAndSubmit = useCallback(async () => {
    const transcript = (await stopRecording()).trim();
    if (transcript.length > 0) {
      onTranscript(transcript);
    }
  }, [onTranscript, stopRecording]);

  const handleClick = useCallback(async () => {
    if (isRecording) {
      await stopAndSubmit();
      return;
    }
    await startRecording();
  }, [isRecording, startRecording, stopAndSubmit]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void handleClick();
        }}
        disabled={disabled || isConnecting}
        data-component="voice-input-addon"
        data-state={isConnecting ? 'connecting' : isRecording ? 'recording' : 'idle'}
      >
        {isRecording ? 'stop' : 'mic'}
      </button>

      {showRecordingBar && (isConnecting || isRecording) && (
        <RecordingBar
          isConnecting={isConnecting}
          transcript={displayTranscript}
          onCancel={() => { void cancelRecording(); }}
          onStop={() => { void stopAndSubmit(); }}
          variant={recordingBarVariant}
        />
      )}
    </>
  );
}
