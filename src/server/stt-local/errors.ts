export type SttLocalErrorCode =
  | 'peer_missing'
  | 'platform_unsupported'
  | 'models_missing'
  | 'load_failed'
  | 'worker_failed';

/** A local speech recognition failure. Messages never carry audio or transcript content. */
export class SttLocalError extends Error {
  readonly code: SttLocalErrorCode;

  constructor(code: SttLocalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SttLocalError';
    this.code = code;
  }
}
