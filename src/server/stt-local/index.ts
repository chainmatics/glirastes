/**
 * `glirastes/server/stt-local` (experimental, ESM only): transcribe browser
 * recordings in the app's own Node server with Parakeet TDT 0.6b v3 int8
 * through the optional peer `sherpa-onnx-node` 2.0.1. Models come from
 * `glirastes stt pull`; nothing is downloaded at runtime.
 */
export {
  checkLocalStt,
  createLocalTranscriber,
  type LocalSttCheck,
  type LocalTranscriber,
  type LocalTranscriberOptions,
} from './transcriber.js';
export { resolveSttModelDir } from './models.js';
export { SttLocalError, type SttLocalErrorCode } from './errors.js';
