import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SttLocalError } from './errors.js';

/** One pinned model file; `path` is relative to the model directory and to a `--mirror`. */
export interface SttModelFile {
  path: string;
  bytes: number;
  sha256: string;
  url: string;
}

const PARAKEET = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8';

export const PARAKEET_DIR = 'parakeet-tdt-0.6b-v3-int8';
export const SILERO_VAD_PATH = 'silero-vad/silero_vad.onnx';

/** The five sha256-pinned files `glirastes stt pull` downloads. */
export const STT_MODEL_FILES: readonly SttModelFile[] = Object.freeze([
  { path: `${PARAKEET_DIR}/encoder.int8.onnx`, bytes: 652282294, sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479', url: `${PARAKEET}/encoder.int8.onnx` },
  { path: `${PARAKEET_DIR}/decoder.int8.onnx`, bytes: 11845274, sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5', url: `${PARAKEET}/decoder.int8.onnx` },
  { path: `${PARAKEET_DIR}/joiner.int8.onnx`, bytes: 6355277, sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98', url: `${PARAKEET}/joiner.int8.onnx` },
  { path: `${PARAKEET_DIR}/tokens.txt`, bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d', url: `${PARAKEET}/tokens.txt` },
  { path: SILERO_VAD_PATH, bytes: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx' },
].map((file) => Object.freeze(file)));

/** Printed by `glirastes stt pull` and written to `<modelDir>/ATTRIBUTION.txt`. */
export const STT_ATTRIBUTION_TEXT = [
  'Parakeet TDT 0.6B v3 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) by NVIDIA,',
  'licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).',
  'Converted to ONNX int8 by sherpa-onnx (Apache-2.0); NVIDIA does not endorse this package.',
  'Silero VAD (https://github.com/snakers4/silero-vad), Copyright (c) 2020-present Silero Team, MIT License.',
].join('\n');

/**
 * The model directory: `GLIRASTES_MODEL_DIR`, else `$XDG_CACHE_HOME/glirastes/models`,
 * else `~/.cache/glirastes/models`.
 */
export function resolveSttModelDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.GLIRASTES_MODEL_DIR) return resolve(env.GLIRASTES_MODEL_DIR);
  if (env.XDG_CACHE_HOME) return resolve(env.XDG_CACHE_HOME, 'glirastes', 'models');
  return resolve(home, '.cache', 'glirastes', 'models');
}

/**
 * Checks that every model file is present with its pinned size. Hashing is
 * `glirastes stt pull`'s job; this runs at every start and stays cheap.
 */
export async function checkModelFiles(modelDir: string, files: readonly SttModelFile[] = STT_MODEL_FILES): Promise<void> {
  const problems: string[] = [];
  for (const file of files) {
    const size = await stat(join(modelDir, file.path)).then((s) => (s.isFile() ? s.size : undefined), () => undefined);
    if (size === undefined) problems.push(`${file.path} (missing)`);
    else if (size !== file.bytes) problems.push(`${file.path} (${size} bytes, expected ${file.bytes})`);
  }
  if (problems.length > 0) {
    throw new SttLocalError(
      'models_missing',
      `Local speech models are missing or incomplete in ${modelDir}: ${problems.join(', ')}. Run: glirastes stt pull`,
    );
  }
}
