import { useMemo, useRef } from 'react';
import type {
  UseDeepgramTranscriptionOptions,
  UseDeepgramTranscriptionReturn,
} from '../types.js';
import { DeepgramSttAdapter } from '../stt/deepgram.js';
import { useStt } from '../stt/use-stt.js';

/**
 * Compatibility entry point backed by the provider-neutral STT controller.
 * New integrations may use `useStt` with their own provider adapter.
 */
export function useDeepgramTranscription(
  options: UseDeepgramTranscriptionOptions = {},
): UseDeepgramTranscriptionReturn {
  const getTokenRef = useRef(options.getToken);
  getTokenRef.current = options.getToken;
  const adapter = useMemo(() => new DeepgramSttAdapter({
    baseUrl: options.baseUrl,
    getToken: () => getTokenRef.current?.(),
  }), [options.baseUrl]);
  const stt = useStt({
    adapter,
    language: options.language ?? 'de',
    onInterimTranscript: options.onInterimTranscript,
    onError: options.onError,
  });

  return {
    phase: stt.phase,
    isRecording: stt.isRecording,
    isConnecting: stt.isConnecting,
    error: stt.error,
    transcript: stt.finalTranscript,
    interimTranscript: stt.interimTranscript,
    displayTranscript: stt.displayTranscript,
    stream: stt.stream,
    startRecording: stt.startRecording,
    stopRecording: stt.stopRecording,
    cancelRecording: stt.cancelRecording,
    retry: stt.retry,
  };
}
