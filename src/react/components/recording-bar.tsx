import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { RecordingBarProps } from '../types.js';
import { CancelButton, StopButton } from './recording-controls.js';
import { StreamWaveform } from './stream-waveform.js';

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

function RecordingBarInner({
  isConnecting,
  stream,
  onCancel,
  onStop,
  variant,
  className,
}: RecordingBarProps) {
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
      <CancelButton onClick={handleCancel} ariaLabel="Aufnahme abbrechen" title="Aufnahme abbrechen" />

      <div data-part="wave-container" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
        {isConnecting ? <LoadingDots /> : <StreamWaveform stream={stream} />}
      </div>

      <StopButton onClick={handleStop} ariaLabel="Aufnahme stoppen" title="Aufnahme stoppen" />
    </div>
  );
}

export function RecordingBar(props: RecordingBarProps) {
  if (props.variant === 'trigger') {
    if (typeof document === 'undefined') return null;

    return createPortal(
      <div data-component="recording-bar-portal">
        <RecordingBarInner {...props} />
      </div>,
      document.body,
    );
  }

  return <RecordingBarInner {...props} />;
}
