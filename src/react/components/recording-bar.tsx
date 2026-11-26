import { useCallback, useContext } from 'react';
import { createPortal } from 'react-dom';
import { ChatContext } from '../provider/chat-context.js';
import type { RecordingBarProps } from '../types.js';
import { CancelButton, StopButton } from './recording-controls.js';
import { StreamWaveform } from './stream-waveform.js';
import { voiceText } from './voice-ui.js';

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function LoadingDots() {
  return (
    <div data-part="loading-dots" style={{ display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'center' }}>
      <span data-dot="1" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', animation: 'dot-pulse 1.4s ease-in-out infinite' }} />
      <span data-dot="2" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', animation: 'dot-pulse 1.4s ease-in-out 0.2s infinite' }} />
      <span data-dot="3" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', animation: 'dot-pulse 1.4s ease-in-out 0.4s infinite' }} />
    </div>
  );
}

const MAX_VISIBLE_TRANSCRIPT = 80;

/** First strong letter decides the script direction, like `dir="auto"`. */
const STARTS_RIGHT_TO_LEFT =
  /^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;

/**
 * Shows the newest words; the full text stays available as a tooltip.
 *
 * The slot can be narrower than the 80-character window, and `overflow:
 * hidden` keeps the start of a line. The box therefore runs opposite to the
 * script and the text sits in an isolated child of its own direction: the
 * clipped side and the ellipsis land on the oldest words, the newest stay
 * visible, and punctuation keeps its place.
 */
function InterimTranscript({ text }: { text?: string }) {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return null;
  const visible = trimmed.length > MAX_VISIBLE_TRANSCRIPT
    ? `…${trimmed.slice(-(MAX_VISIBLE_TRANSCRIPT - 1))}`
    : trimmed;
  const rtlScript = STARTS_RIGHT_TO_LEFT.test(visible);
  return (
    <span
      data-part="interim-transcript"
      aria-live="polite"
      title={trimmed}
      style={{
        // Most of the bar goes to the words, not to the waveform.
        flex: '4 1 0',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: rtlScript ? 'ltr' : 'rtl',
        textAlign: 'left',
        fontSize: '0.8125rem',
        opacity: 0.85,
      }}
    >
      <bdi dir={rtlScript ? 'rtl' : 'ltr'}>{visible}</bdi>
    </span>
  );
}

const VISUALLY_HIDDEN = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
} as const;

/** Waveform only; the editor shows the words, the mic button stops. */
function ComposerRecordingBar({ isConnecting, stream, transcript, className }: RecordingBarProps) {
  return (
    <div
      className={joinClassNames('glirastes-recording-bar', 'glirastes-recording-bar-composer', className)}
      data-component="recording-bar"
      data-variant="composer"
      style={{ display: 'flex', alignItems: 'center', width: '4.5rem', height: '24px', flex: '0 1 4.5rem', minWidth: 0 }}
    >
      <div data-part="wave-container" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
        {isConnecting ? <LoadingDots /> : <StreamWaveform stream={stream} />}
      </div>
      <span data-part="interim-transcript" aria-live="polite" style={VISUALLY_HIDDEN}>{transcript?.trim() ?? ''}</span>
    </div>
  );
}

function RecordingBarInner({
  isConnecting,
  stream,
  transcript,
  onCancel,
  onStop,
  variant,
  className,
}: RecordingBarProps) {
  const locale = useContext(ChatContext)?.locale;
  const cancelLabel = voiceText(locale, 'voiceCancelAriaLabel');
  const stopLabel = voiceText(locale, 'voiceStopAndInsertAriaLabel');
  const handleCancel = useCallback(() => onCancel(), [onCancel]);
  const handleStop = useCallback(() => onStop(), [onStop]);

  return (
    <div
      className={joinClassNames('glirastes-recording-bar', variant === 'trigger' ? 'glirastes-recording-bar-trigger' : 'glirastes-recording-bar-inline', className)}
      data-component="recording-bar"
      data-variant={variant}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        ...(variant === 'inline' ? { width: '100%', height: '36px' } : {}),
      }}
    >
      <CancelButton onClick={handleCancel} ariaLabel={cancelLabel} title={cancelLabel} />

      <div data-part="wave-container" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
        {isConnecting ? <LoadingDots /> : <StreamWaveform stream={stream} />}
      </div>

      <InterimTranscript text={transcript} />

      <StopButton onClick={handleStop} ariaLabel={stopLabel} title={stopLabel} />
    </div>
  );
}

export function RecordingBar(props: RecordingBarProps) {
  const unstyled = useContext(ChatContext)?.unstyled ?? false;
  if (props.variant === 'composer') return <ComposerRecordingBar {...props} />;
  if (props.variant === 'trigger') {
    if (typeof document === 'undefined') return null;

    return createPortal(
      <div data-component="recording-bar-portal" data-unstyled={unstyled || undefined}>
        <RecordingBarInner {...props} />
      </div>,
      document.body,
    );
  }

  return <RecordingBarInner {...props} />;
}
