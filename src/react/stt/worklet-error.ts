/** `SttSessionSnapshot.errorCode` of a session whose audio worklet did not load. */
export const AUDIO_WORKLET_UNAVAILABLE = 'audio-worklet-unavailable';

/**
 * The PCM audio worklet could not be loaded (`audioWorklet.addModule`
 * rejected), usually because the file is not served at `url` (404). Voice
 * input cannot record without it.
 */
export class AudioWorkletLoadError extends Error {
  readonly code = AUDIO_WORKLET_UNAVAILABLE;

  constructor(readonly url: string, options: { cause?: unknown } = {}) {
    super('Audio worklet could not be loaded', options);
    this.name = 'AudioWorkletLoadError';
  }
}

export function isAudioWorkletLoadError(error: unknown): error is AudioWorkletLoadError {
  return error instanceof AudioWorkletLoadError
    || (error instanceof Error && (error as { code?: unknown }).code === AUDIO_WORKLET_UNAVAILABLE);
}
