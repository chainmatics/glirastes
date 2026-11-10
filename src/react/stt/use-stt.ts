import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  SttSessionController,
  type SttProviderAdapter,
  type SttSessionSnapshot,
} from './controller.js';

export interface UseSttOptions {
  adapter: SttProviderAdapter;
  language: string;
  onInterimTranscript?: (text: string) => void;
  onError?: (error: string) => void;
}

export interface UseSttReturn extends SttSessionSnapshot {
  isRecording: boolean;
  isConnecting: boolean;
  stream: MediaStream | null;
  startRecording: (previousDraft?: string) => Promise<void>;
  stopRecording: () => Promise<string>;
  cancelRecording: () => Promise<string>;
  retry: () => Promise<void>;
}

export function useStt(options: UseSttOptions): UseSttReturn {
  const controller = useMemo(() => new SttSessionController({
    adapter: options.adapter,
    language: options.language,
  }), [options.adapter, options.language]);

  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.snapshot,
    () => controller.snapshot,
  );

  useEffect(() => () => {
    void controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (snapshot.phase === 'failed' && snapshot.error) {
      options.onError?.(snapshot.error);
    }
  }, [options.onError, snapshot.error, snapshot.phase]);

  useEffect(() => {
    if (snapshot.interimTranscript) {
      options.onInterimTranscript?.(snapshot.displayTranscript);
    }
  }, [
    options.onInterimTranscript,
    snapshot.displayTranscript,
    snapshot.interimTranscript,
  ]);

  const startRecording = useCallback(
    (previousDraft = '') => controller.start(previousDraft),
    [controller],
  );

  return {
    ...snapshot,
    isRecording: snapshot.phase === 'recording' || snapshot.phase === 'finalizing',
    isConnecting:
      snapshot.phase === 'requesting_permission'
      || snapshot.phase === 'connecting',
    stream: controller.getStream(),
    startRecording,
    stopRecording: () => controller.stop(),
    cancelRecording: () => controller.cancel(),
    retry: () => controller.retry(),
  };
}
