import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecordingBarProps } from '../types.js';
import { CancelButton, StopButton } from './recording-controls.js';
import { loadWaveSurfer } from './wavesurfer-loader.js';

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function LiveWave({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const cleanupRef = { current: () => {} };

    // Lazy-load the optional wavesurfer.js peer dep at runtime — see wavesurfer-loader.ts.
    loadWaveSurfer()
      .then(({ WaveSurfer, RecordPlugin }) => {
        if (disposed) return;

        const ws = WaveSurfer.create({
          container,
          waveColor: '#000000',
          height: 28,
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
        ) as { startMic: () => Promise<MediaStream>; stopMic: () => void; destroy: () => void };

        void record.startMic().catch(() => {
          // Ignore: mic permissions may be handled by the transcription hook.
        });

        cleanupRef.current = () => {
          record.stopMic();
          record.destroy();
          ws.destroy();
        };
      })
      .catch((err) => {
        console.warn(
          '[RecordingBar] wavesurfer.js is not installed — waveform visualization disabled. Install it with: npm install wavesurfer.js',
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
    return <LoadingDots />;
  }

  return <div ref={containerRef} className={joinClassNames('glirastes-recording-wave', className)} />;
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
      style={{ display: 'flex', alignItems: 'center', gap: '8px', ...(variant === 'inline' ? { height: '36px' } : {}) }}
    >
      <CancelButton onClick={handleCancel} ariaLabel="Aufnahme abbrechen" title="Aufnahme abbrechen" />

      <div data-part="wave-container" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
        {isConnecting ? <LoadingDots /> : <LiveWave />}
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
