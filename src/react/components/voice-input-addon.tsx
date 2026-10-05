import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { DeepgramSttAdapter } from '../stt/deepgram.js';
import type { SttProviderAdapter } from '../stt/controller.js';
import { useStt } from '../stt/use-stt.js';
import { ChatContext } from '../provider/chat-context.js';
import {
  DEFAULT_PUSH_TO_TALK_HOTKEY,
  parseHoldCombo,
  usePushToTalkHotkey,
} from '../hooks/use-push-to-talk-hotkey.js';
import type { VoicePushToTalkConfig } from '../types.js';
import { RecordingBar } from './recording-bar.js';
import { ChatWindowVisibilityContext } from './chat-window-visibility.js';

const DEFAULT_HOLD_THRESHOLD_MS = 350;

// One owner per hotkey for the whole page. A second composer (another
// provider, an embedded chat next to the host's own) listens on the same
// window, so without a claim one key press would open two microphone streams.
// The first claimant owns the key until it unmounts or stops wanting it; the
// next one in line takes over. Later claimants are ignored while it holds.
const hotkeyClaims = new Map<string, symbol[]>();
const hotkeyClaimListeners = new Set<() => void>();

function notifyHotkeyClaims(): void {
  for (const listener of [...hotkeyClaimListeners]) listener();
}

function subscribeToHotkeyClaims(listener: () => void): () => void {
  hotkeyClaimListeners.add(listener);
  return () => { hotkeyClaimListeners.delete(listener); };
}

function claimHotkey(combo: string, owner: symbol): () => void {
  hotkeyClaims.set(combo, [...(hotkeyClaims.get(combo) ?? []), owner]);
  notifyHotkeyClaims();
  return () => {
    const rest = (hotkeyClaims.get(combo) ?? []).filter((claimant) => claimant !== owner);
    if (rest.length > 0) hotkeyClaims.set(combo, rest);
    else hotkeyClaims.delete(combo);
    notifyHotkeyClaims();
  };
}

/** Spelling-independent identity of a combo, e.g. `Shift+Mod+Space`. */
function hotkeyIdentity(hotkey: string | false): string | null {
  if (!hotkey) return null;
  const combo = parseHoldCombo(hotkey);
  return combo ? `${combo.mod}:${combo.shift}:${combo.alt}:${combo.key}` : null;
}

function useHotkeyOwnership(hotkey: string | false, wanted: boolean): boolean {
  const [owner] = useState(() => Symbol('push-to-talk'));
  const combo = hotkeyIdentity(hotkey);
  useEffect(() => {
    if (!wanted || combo === null) return;
    return claimHotkey(combo, owner);
  }, [wanted, combo, owner]);
  return useSyncExternalStore(
    subscribeToHotkeyClaims,
    () => combo !== null && hotkeyClaims.get(combo)?.[0] === owner,
    () => false,
  );
}

interface VoiceInputAddonProps {
  disabled: boolean;
  language: string;
  baseUrl?: string;
  /** Returns the current auth token for WebSocket authentication */
  getToken?: () => string | null | undefined;
  /** Speech provider; defaults to the Deepgram speech-stream adapter. */
  adapter?: SttProviderAdapter;
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  showRecordingBar?: boolean;
  recordingBarVariant?: 'trigger' | 'inline';
  /** Hold the button or hotkey to talk; false keeps tap-to-toggle only. */
  pushToTalk?: VoicePushToTalkConfig | false;
  /** A changed value (e.g. the pathname) stops and keeps speech as draft. */
  routeKey?: string;
  /** Clock for hold detection; tests inject a fake one. */
  now?: () => number;
}

/**
 * The composer's single STT controller and microphone stream. Stop inserts
 * the transcript into the draft for editing; nothing is sent automatically.
 * Hide, route change, session switch and unmount release the microphone.
 */
export function VoiceInputAddon({
  disabled,
  language,
  baseUrl,
  getToken,
  adapter,
  onTranscript,
  onError,
  showRecordingBar = true,
  recordingBarVariant = 'inline',
  pushToTalk,
  routeKey,
  now = Date.now,
}: VoiceInputAddonProps) {
  const visible = useContext(ChatWindowVisibilityContext);
  const chat = useContext(ChatContext);
  const transcriptCallback = useRef(onTranscript);
  transcriptCallback.current = onTranscript;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const pendingStop = useRef<Promise<void> | null>(null);

  const resolvedAdapter = useMemo<SttProviderAdapter>(
    () => adapter ?? new DeepgramSttAdapter({
      baseUrl,
      getToken: () => getTokenRef.current?.(),
    }),
    [adapter, baseUrl],
  );
  const {
    phase,
    isRecording,
    isConnecting,
    displayTranscript,
    stream,
    startRecording,
    stopRecording,
    cancelRecording,
    retry,
  } = useStt({ adapter: resolvedAdapter, language, onError });
  const active = isRecording || isConnecting;
  const activeRef = useRef(active);
  activeRef.current = active;

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
  const stopAndSubmitRef = useRef(stopAndSubmit);
  stopAndSubmitRef.current = stopAndSubmit;

  const start = useCallback(() => {
    // Failures surface through onError and the failed phase (retry button).
    void startRecording().catch(() => {});
  }, [startRecording]);

  useEffect(() => {
    if (!visible && active) void stopAndSubmit();
  }, [visible, active, stopAndSubmit]);

  // Route and session changes end the recording; the speech stays as draft.
  const routeRef = useRef(routeKey);
  useEffect(() => {
    if (routeRef.current === routeKey) return;
    routeRef.current = routeKey;
    if (activeRef.current) void stopAndSubmitRef.current();
  }, [routeKey]);
  const sessionId = chat?.activeSessionId;
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    if (activeRef.current) void stopAndSubmitRef.current();
  }, [sessionId]);
  useEffect(() => {
    const onHistory = () => {
      if (activeRef.current) void stopAndSubmitRef.current();
    };
    window.addEventListener('popstate', onHistory);
    window.addEventListener('hashchange', onHistory);
    return () => {
      window.removeEventListener('popstate', onHistory);
      window.removeEventListener('hashchange', onHistory);
    };
  }, []);

  // Push-to-talk: a hold of at least the threshold stops on release; a
  // shorter tap keeps recording (toggle). Keyboard activation toggles.
  const pushToTalkEnabled = pushToTalk !== false;
  const configuredThreshold = pushToTalk === false ? undefined : pushToTalk?.holdThresholdMs;
  const holdThresholdMs = typeof configuredThreshold === 'number'
    && Number.isFinite(configuredThreshold) && configuredThreshold >= 0
    ? configuredThreshold
    : DEFAULT_HOLD_THRESHOLD_MS;
  const nowRef = useRef(now);
  nowRef.current = now;
  const holdThresholdRef = useRef(holdThresholdMs);
  holdThresholdRef.current = holdThresholdMs;
  const suppressClick = useRef(false);
  const releasedOverButton = useRef(false);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartedRecording = useRef(false);
  const stopWatchingPress = useRef<(() => void) | null>(null);
  const hotkeyHeld = useRef(false);

  const cancelSuppressTimer = () => {
    if (suppressTimer.current === null) return;
    clearTimeout(suppressTimer.current);
    suppressTimer.current = null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    touchStartedRecording.current = false;
    if (!pushToTalkEnabled || disabled || activeRef.current) return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    stopWatchingPress.current?.();
    cancelSuppressTimer();
    const startedAt = nowRef.current();
    suppressClick.current = true;
    releasedOverButton.current = false;
    touchStartedRecording.current = event.pointerType === 'touch';
    const stopWatching = () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      if (stopWatchingPress.current === stopWatching) stopWatchingPress.current = null;
    };
    const release = () => {
      stopWatching();
      // A release over the button is followed by a click that handleClick
      // swallows. A release elsewhere or a cancelled pointer is followed by
      // none, and the flag would swallow the next, unrelated click instead.
      if (!releasedOverButton.current) {
        suppressClick.current = false;
      } else {
        // Touch capture reports every release as "over the button", even one
        // that ends away from it with no click at all. The click of a press
        // is dispatched in the task of its pointerup, before any timer, so
        // the flag outlives it by no more than a timer turn.
        suppressTimer.current = setTimeout(() => {
          suppressTimer.current = null;
          suppressClick.current = false;
        }, 0);
      }
      releasedOverButton.current = false;
      if (nowRef.current() - startedAt >= holdThresholdRef.current) {
        void stopAndSubmitRef.current();
      }
    };
    stopWatchingPress.current = stopWatching;
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    start();
  };

  // React handles the event before the window listener above sees it.
  const handlePointerUp = () => {
    releasedOverButton.current = true;
  };

  // The end of a finger's tap is followed by a click, which the browser
  // hit-tests against the layout of that moment. Recording began on
  // pointerdown and the inline recording bar has since moved its controls
  // under the finger, so that click would press Stop and end the recording
  // the tap just started. The press has done its work; no click is wanted.
  const handleTouchEnd = (event: ReactTouchEvent<HTMLButtonElement>) => {
    if (!touchStartedRecording.current) return;
    touchStartedRecording.current = false;
    if (event.cancelable) event.preventDefault();
  };
  const handleTouchCancel = () => {
    touchStartedRecording.current = false;
  };

  useEffect(() => () => {
    stopWatchingPress.current?.();
    cancelSuppressTimer();
  }, []);

  const handleClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (isRecording) {
      void stopAndSubmit();
      return;
    }
    if (!isConnecting) start();
  };

  const hotkey = pushToTalk === false
    ? false
    : pushToTalk?.hotkey ?? DEFAULT_PUSH_TO_TALK_HOTKEY;
  const ownsHotkey = useHotkeyOwnership(hotkey, pushToTalkEnabled && visible && !disabled);
  usePushToTalkHotkey({
    hotkey,
    enabled: ownsHotkey,
    onPress: () => {
      if (activeRef.current) return;
      hotkeyHeld.current = true;
      start();
    },
    onRelease: () => {
      if (!hotkeyHeld.current) return;
      hotkeyHeld.current = false;
      void stopAndSubmitRef.current();
    },
  });

  const state = phase === 'failed'
    ? 'failed'
    : isConnecting
      ? 'connecting'
      : isRecording
        ? 'recording'
        : 'idle';

  return (
    <>
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onClick={handleClick}
        disabled={disabled}
        aria-busy={isConnecting}
        data-component="voice-input-addon"
        data-state={state}
      >
        {isRecording ? 'stop' : 'mic'}
      </button>

      {phase === 'failed' && (
        <button
          type="button"
          onClick={() => { void retry().catch(() => {}); }}
          disabled={disabled}
          aria-label={chat?.locale.retryRecordingAriaLabel ?? 'Retry recording'}
          data-action="retry-recording"
        >
          retry
        </button>
      )}

      {showRecordingBar && active && (
        <RecordingBar
          isConnecting={isConnecting}
          stream={stream}
          transcript={displayTranscript}
          onCancel={() => { void cancelRecording().catch(() => {}); }}
          onStop={() => { void stopAndSubmit(); }}
          variant={recordingBarVariant}
        />
      )}
    </>
  );
}
