import { useEffect, useState } from 'react';
import { createStreamAnalyser } from '../stt/waveform.js';

/** Visualizes an existing authoritative recorder stream without opening a mic. */
export function StreamWaveform({
  stream,
}: {
  stream: MediaStream | null | undefined;
}) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream) return;
    let disposed = false;
    let frame = 0;
    let analyser: ReturnType<typeof createStreamAnalyser> | null = null;
    try {
      analyser = createStreamAnalyser(stream);
      const draw = () => {
        if (disposed || !analyser) return;
        setLevel(analyser.readLevel());
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    } catch {
      setLevel(0);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      void analyser?.close();
    };
  }, [stream]);

  const heights = [0.45, 0.75, 1, 0.65, 0.85, 0.5].map(
    (weight) => Math.max(4, Math.round(4 + level * weight * 20)),
  );
  return (
    <div
      data-element="waveform"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        gap: 3,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {heights.map((height, index) => (
        <span
          key={index}
          style={{
            width: 3,
            height,
            borderRadius: 2,
            background: 'currentColor',
          }}
        />
      ))}
    </div>
  );
}
