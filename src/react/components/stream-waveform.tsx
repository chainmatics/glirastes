import { useEffect, useRef } from 'react';
import { createStreamAnalyser } from '../stt/waveform.js';

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const STEP = BAR_WIDTH + BAR_GAP;
const SAMPLE_MS = 45;
const MIN_BAR = 2;
/** Share of the width on the oldest side that fades out. */
const FADE_SHARE = 0.18;

/**
 * Visualizes an existing authoritative recorder stream without opening a mic:
 * the recent loudness as bars that fill the width and scroll from right to left,
 * newest on the right, silence as a dotted baseline. Drawn on a canvas in the
 * text color (`currentColor`), so a theme colors it with `color`.
 */
export function StreamWaveform({
  stream,
}: {
  stream: MediaStream | null | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext?.('2d');
    if (!container || !canvas || !context) return;

    let width = 0;
    let height = 0;
    let color = 'currentColor';
    let levels: number[] = [];
    let lastSampleAt = 0;
    let smoothed = 0;
    let frame = 0;
    let disposed = false;
    let analyser: ReturnType<typeof createStreamAnalyser> | null = null;
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      width = Math.max(0, Math.floor(rect.width));
      height = Math.max(0, Math.floor(rect.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      color = getComputedStyle(container).color || color;
      const count = Math.ceil(width / STEP) + 1;
      levels = levels.length >= count ? levels.slice(-count) : [...new Array<number>(count - levels.length).fill(0), ...levels];
    };

    const draw = (offset: number) => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      const middle = height / 2;
      const fadeWidth = Math.max(1, width * FADE_SHARE);
      for (let index = levels.length - 1; index >= 0; index -= 1) {
        const x = width - (levels.length - index) * STEP + BAR_WIDTH - offset;
        if (x + BAR_WIDTH < 0) break;
        const level = levels[index] ?? 0;
        const barHeight = Math.max(MIN_BAR, Math.min(height, Math.pow(level, 0.7) * height));
        context.globalAlpha = Math.min(1, Math.max(0.15, x / fadeWidth)) * (level > 0.02 ? 1 : 0.45);
        const top = middle - barHeight / 2;
        const radius = Math.min(BAR_WIDTH / 2, barHeight / 2);
        context.beginPath();
        if (typeof context.roundRect === 'function') context.roundRect(x, top, BAR_WIDTH, barHeight, radius);
        else context.rect(x, top, BAR_WIDTH, barHeight);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const tick = (now: number) => {
      if (disposed) return;
      if (analyser) {
        // Fast attack, slower release: speech reads as shapes, not flicker.
        const raw = analyser.readLevel();
        smoothed = raw > smoothed ? raw : smoothed * 0.8 + raw * 0.2;
      }
      if (now - lastSampleAt >= SAMPLE_MS) {
        lastSampleAt = now;
        levels.push(smoothed);
        if (levels.length > Math.ceil(width / STEP) + 1) levels.shift();
      }
      const progress = reducedMotion ? 0 : Math.min(1, (now - lastSampleAt) / SAMPLE_MS);
      draw(progress * STEP);
      frame = requestAnimationFrame(tick);
    };

    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); draw(0); }) : null;
    observer?.observe(container);

    if (stream) {
      try {
        analyser = createStreamAnalyser(stream);
      } catch {
        analyser = null;
      }
    }
    if (analyser) frame = requestAnimationFrame(tick);
    else draw(0);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      void analyser?.close();
    };
  }, [stream]);

  return (
    <div
      ref={containerRef}
      data-element="waveform"
      aria-hidden="true"
      style={{
        position: 'relative',
        flex: 1,
        minWidth: 0,
        height: 24,
        alignSelf: 'center',
      }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: 'block' }} />
    </div>
  );
}
