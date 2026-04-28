import { useContext, useEffect, useState, useRef, type ReactElement, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { AiTriggerButtonProps } from '../types.js';
import { CancelButton, StopButton } from './recording-controls.js';
import { useDraggablePosition } from '../hooks/use-draggable-position.js';
import { ChatContext } from '../provider/chat-context.js';
import { loadWaveSurfer } from './wavesurfer-loader.js';

// ---------------------------------------------------------------------------
// Inline SVG icons (no lucide-react dependency)
// ---------------------------------------------------------------------------

function SparklesIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Inline styles — SDK must not depend on consumer's Tailwind config
// ---------------------------------------------------------------------------

const WRAPPER_STYLE: CSSProperties = {
  position: 'fixed',
  bottom: '1rem',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 9999,
  pointerEvents: 'none',
};

const WRAPPER_POSITIONED_STYLE: CSSProperties = {
  position: 'fixed',
  zIndex: 9999,
  pointerEvents: 'none',
};

const PILL_BASE_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: '9999px',
  paddingLeft: '0.75rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
};

const RECORDING_PILL_STYLE: CSSProperties = {
  ...PILL_BASE_STYLE,
  paddingLeft: '0.5rem',
  minWidth: '12rem',
};

const SPARKLE_STYLE: CSSProperties = {
  position: 'relative',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  flexShrink: 0,
  padding: '0.25rem',
};

const MIC_BUTTON_STYLE: CSSProperties = {
  position: 'relative',
  zIndex: 10,
  height: '1.75rem',
  width: '1.75rem',
  borderRadius: '9999px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  backgroundColor: 'rgba(255,255,255,0.2)',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: 0,
};

const WAVEFORM_CONTAINER_STYLE: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 0,
};

const DOT_STYLE: CSSProperties = {
  height: '0.375rem',
  width: '0.375rem',
  borderRadius: '9999px',
  backgroundColor: 'currentColor',
  opacity: 0.6,
};

// ---------------------------------------------------------------------------
// CSS keyframes injected once for bounce animation
// ---------------------------------------------------------------------------

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes ai-trigger-bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-25%); }
    }
    [data-component="ai-trigger-button"] [data-dot] {
      animation: ai-trigger-bounce 1.4s ease-in-out infinite;
    }
    [data-component="ai-trigger-button"] [data-dot="2"] {
      animation-delay: 0.15s;
    }
    [data-component="ai-trigger-button"] [data-dot="3"] {
      animation-delay: 0.3s;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// ConnectingDots — shown while connecting or as wavesurfer fallback
// ---------------------------------------------------------------------------

function ConnectingDots() {
  return (
    <div style={WAVEFORM_CONTAINER_STYLE} data-element="connecting-indicator">
      <span data-dot="1" style={DOT_STYLE} />
      <span data-dot="2" style={{ ...DOT_STYLE, marginLeft: '0.375rem' }} />
      <span data-dot="3" style={{ ...DOT_STYLE, marginLeft: '0.375rem' }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TriggerLiveWave — real-time mic waveform via WaveSurfer.js
// ---------------------------------------------------------------------------

function TriggerLiveWave() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    const cleanupRef = { current: () => {} };

    // Lazy-load the optional wavesurfer.js peer dep at runtime — see wavesurfer-loader.ts.
    loadWaveSurfer()
      .then(({ WaveSurfer, RecordPlugin }) => {
        if (disposed) return;

        const ws = WaveSurfer.create({
          container: el,
          waveColor: '#000000',
          height: 24,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          cursorWidth: 0,
          interact: false,
          normalize: true,
        });

        const record = ws.registerPlugin(
          RecordPlugin.create({
            scrollingWaveform: true,
            scrollingWaveformWindow: 5,
            renderRecordedAudio: false,
          }),
        );

        record.startMic().catch((err: unknown) => {
          console.warn('[AiTriggerButton] Failed to start waveform mic:', err);
        });

        cleanupRef.current = () => {
          record.stopMic();
          record.destroy();
          ws.destroy();
        };
      })
      .catch((err) => {
        console.warn(
          '[AiTriggerButton] wavesurfer.js is not installed — waveform visualization disabled. Install it with: npm install wavesurfer.js',
          err,
        );
        if (!disposed) setLoadFailed(true);
      });

    return () => {
      disposed = true;
      cleanupRef.current();
    };
  }, []);

  if (loadFailed) {
    return <ConnectingDots />;
  }

  return <div ref={containerRef} data-element="waveform" style={{ flex: 1, minWidth: 0 }} />;
}

// ---------------------------------------------------------------------------
// AiTriggerButton
// ---------------------------------------------------------------------------

export function AiTriggerButton({
  onClickChat,
  onClickMic,
  isRecording,
  isConnecting,
  onStopRecording,
  onCancelRecording,
  portal = true,
  className,
  buttonClassName,
  renderWrapper,
  draggable = true,
  persistPosition = 'ai-trigger-btn',
  ariaLabel = 'AI Assistant',
  micAriaLabel = 'Start recording',
  stopAriaLabel = 'Stop recording',
  cancelAriaLabel = 'Cancel recording',
  showMic = true,
  icon,
}: AiTriggerButtonProps) {
  const [isMounted, setIsMounted] = useState(false);

  // Theme vars from the provider (standalone use is allowed — fall back).
  const themeVars = useContext(ChatContext)?.themeVars ?? {};

  const { position, isDragging, onMouseDown, wasDragged, resetPosition } =
    useDraggablePosition({
      enabled: draggable,
      persistKey: persistPosition || false,
    });

  useEffect(() => {
    injectStyles();
    setIsMounted(true);
  }, []);

  if (!isMounted) return null;

  const state = isRecording ? 'recording' : isConnecting ? 'connecting' : 'idle';

  // Wrapper: use className if provided (consumer controls styling), otherwise inline styles.
  // Theme CSS variables are always spread so the pill inherits the active palette.
  const wrapperStyle: CSSProperties = className
    ? { ...themeVars }
    : {
        ...themeVars,
        ...(position
          ? { ...WRAPPER_POSITIONED_STYLE, left: position.x, top: position.y }
          : WRAPPER_STYLE),
      };

  const wrapperClassName = className ?? undefined;

  // ---- Recording / connecting state ----
  if (isRecording || isConnecting) {
    const content = (
      <div
        className={wrapperClassName}
        style={wrapperStyle}
        data-component="ai-trigger-button"
        data-state={state}
      >
        <div
          className={buttonClassName ?? undefined}
          style={RECORDING_PILL_STYLE}
          aria-label={stopAriaLabel}
        >
          <CancelButton onClick={onCancelRecording!} ariaLabel={cancelAriaLabel} />

          <div style={WAVEFORM_CONTAINER_STYLE} data-element="waveform-container">
            {isConnecting ? <ConnectingDots /> : <TriggerLiveWave />}
          </div>

          <StopButton onClick={onStopRecording!} ariaLabel={stopAriaLabel} />
        </div>
      </div>
    );

    return portal ? createPortal(content, document.body) : content;
  }

  // ---- Default (idle) state ----
  const button = (
    <div
      role="button"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onClick={() => {
        if (!wasDragged) onClickChat();
      }}
      onDoubleClick={() => {
        if (position) resetPosition();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClickChat();
        }
      }}
      className={buttonClassName ?? undefined}
      style={{
        ...PILL_BASE_STYLE,
        cursor: isDragging ? 'grabbing' : 'pointer',
        // When the mic is hidden, balance the padding so the single
        // icon sits centered instead of off-to-the-left.
        ...(showMic ? {} : { paddingRight: '0.75rem' }),
      }}
      data-element="button-pill"
      aria-label={ariaLabel}
    >
      {/* Left zone: Sparkles / custom icon (opens chat) */}
      <span style={SPARKLE_STYLE} data-element="chat-trigger" aria-hidden="true">
        {icon ?? <SparklesIcon />}
      </span>

      {/* Right zone: Mic (starts recording). Hidden when `showMic` is false —
          in that case the pill collapses to a single-icon trigger. */}
      {showMic && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!wasDragged) onClickMic();
          }}
          style={MIC_BUTTON_STYLE}
          data-element="mic-trigger"
          aria-label={micAriaLabel}
        >
          <MicIcon />
        </button>
      )}
    </div>
  ) as ReactElement;

  const wrapped = renderWrapper ? renderWrapper(button) : button;

  const content = (
    <div
      className={wrapperClassName}
      style={wrapperStyle}
      data-component="ai-trigger-button"
      data-state="idle"
      data-dragging={isDragging || undefined}
    >
      {wrapped}
    </div>
  );

  return portal ? createPortal(content, document.body) : content;
}
