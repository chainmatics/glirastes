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
  /**
   * URL of the audio worklet file, passed to `adapter.connect()`. An adapter
   * that does not declare `acceptsWorkletUrl` ignores it (warned once).
   */
  workletUrl?: string;
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

let warnedIgnoredWorkletUrl = false;

/** One console warning per page when an adapter cannot take the chat's worklet URL. */
function warnIgnoredWorkletUrl(adapter: SttProviderAdapter, workletUrl: string | undefined): void {
  if (warnedIgnoredWorkletUrl || !workletUrl || adapter.acceptsWorkletUrl === true) return;
  warnedIgnoredWorkletUrl = true;
  const workletPath = workletUrl.split(/[?#]/)[0];
  console.warn(
    `[glirastes] voice.workletUrl ("${workletPath}") is ignored: the speech adapter passed as voice.adapter does not declare acceptsWorkletUrl. Pass the URL to the adapter's constructor instead, e.g. new RecordedSttAdapter({ workletUrl }) or new DeepgramSttAdapter({ workletUrl }).`,
  );
}

export function useStt(options: UseSttOptions): UseSttReturn {
  const controller = useMemo(() => new SttSessionController({
    adapter: options.adapter,
    language: options.language,
    ...(options.workletUrl !== undefined ? { workletUrl: options.workletUrl } : {}),
  }), [options.adapter, options.language, options.workletUrl]);

  useEffect(() => {
    warnIgnoredWorkletUrl(options.adapter, options.workletUrl);
  }, [options.adapter, options.workletUrl]);

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
