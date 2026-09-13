import { useCallback, useContext, useEffect, useRef } from 'react';
import { useDeepgramTranscription } from '../hooks/use-deepgram-transcription.js';
import { RecordingBar } from './recording-bar.js';
import { ChatWindowVisibilityContext } from './chat-window-visibility.js';

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
  const visible = useContext(ChatWindowVisibilityContext);
  const transcriptCallback = useRef(onTranscript);
  transcriptCallback.current = onTranscript;
  const pendingStop = useRef<Promise<void> | null>(null);
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

  // Multiple controls and a visibility change may stop the same recording.
  // The controller coalesces cleanup; this boundary also inserts text once.
  const stopAndSubmit = useCallback(() => {
    if (pendingStop.current) return pendingStop.current;
    const pending = Promise.resolve().then(async () => {
      const transcript = (await stopRecording()).trim();
      if (transcript.length > 0) transcriptCallback.current(transcript);
    }).catch(() => {
      // The shared controller has already reported the provider error through
      // onError and released its resources. No unhandled event promise.
    }).finally(() => { if (pendingStop.current === pending) pendingStop.current = null; });
    pendingStop.current = pending;
    return pending;
  }, [stopRecording]);

  useEffect(() => {
    if (!visible && (isRecording || isConnecting)) void stopAndSubmit();
  }, [visible, isRecording, isConnecting, stopAndSubmit]);

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
