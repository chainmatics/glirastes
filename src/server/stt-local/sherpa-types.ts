/**
 * The few members of `sherpa-onnx-node` (CommonJS, untyped) that glirastes uses.
 * Kept as plain interfaces so they are emitted with the build.
 */
export interface SherpaOfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

export interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  decodeAsync(stream: SherpaOfflineStream): Promise<{ text: string }>;
  getResult(stream: SherpaOfflineStream): { text: string };
}

export interface SherpaSpeechSegment {
  start: number;
  samples: Float32Array;
}

export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(enableExternalBuffer: boolean): SherpaSpeechSegment;
  pop(): void;
  flush(): void;
}

export interface SherpaModule {
  OfflineRecognizer: {
    new (config: object): SherpaOfflineRecognizer;
    createAsync(config: object): Promise<SherpaOfflineRecognizer>;
  };
  Vad: new (config: object, bufferSizeInSeconds: number) => SherpaVad;
}
