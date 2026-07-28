export interface StreamAnalyser {
  readLevel(): number;
  close(): Promise<void>;
}

export function createStreamAnalyser(
  stream: MediaStream,
  createContext: () => AudioContext = () => new AudioContext(),
): StreamAnalyser {
  const context = createContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const values = new Uint8Array(analyser.frequencyBinCount);
  let closed = false;

  return {
    readLevel(): number {
      analyser.getByteTimeDomainData(values);
      let sumOfSquares = 0;
      for (const value of values) {
        const normalized = (value - 128) / 128;
        sumOfSquares += normalized * normalized;
      }
      return Math.min(1, Math.sqrt(sumOfSquares / Math.max(values.length, 1)) * 4);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      source.disconnect();
      analyser.disconnect();
      await context.close();
    },
  };
}
