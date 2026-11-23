import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SttLocalError } from '../errors.js';
import { checkModelFiles, resolveSttModelDir, STT_ATTRIBUTION_TEXT, STT_MODEL_FILES } from '../models.js';

const HF = '/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8/';

describe('STT_MODEL_FILES', () => {
  it('pins exactly the five spike files', () => {
    expect(STT_MODEL_FILES.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))).toEqual([
      { path: 'parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx', bytes: 652282294, sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479' },
      { path: 'parakeet-tdt-0.6b-v3-int8/decoder.int8.onnx', bytes: 11845274, sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5' },
      { path: 'parakeet-tdt-0.6b-v3-int8/joiner.int8.onnx', bytes: 6355277, sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98' },
      { path: 'parakeet-tdt-0.6b-v3-int8/tokens.txt', bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
      { path: 'silero-vad/silero_vad.onnx', bytes: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
    ]);
    for (const file of STT_MODEL_FILES.slice(0, 4)) {
      expect(file.url).toBe(`https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8${HF}${file.path.split('/')[1]}`);
    }
    expect(STT_MODEL_FILES[4]!.url).toBe('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx');
  });

  it('carries the exact attribution text', () => {
    expect(STT_ATTRIBUTION_TEXT).toBe([
      'Parakeet TDT 0.6B v3 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) by NVIDIA,',
      'licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).',
      'Converted to ONNX int8 by sherpa-onnx (Apache-2.0); NVIDIA does not endorse this package.',
      'Silero VAD (https://github.com/snakers4/silero-vad), Copyright (c) 2020-present Silero Team, MIT License.',
    ].join('\n'));
  });
});

describe('resolveSttModelDir', () => {
  it('resolves GLIRASTES_MODEL_DIR, then XDG_CACHE_HOME/glirastes/models, then ~/.cache/glirastes/models', () => {
    expect(resolveSttModelDir({ GLIRASTES_MODEL_DIR: '/srv/models', XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(resolve('/srv/models'));
    expect(resolveSttModelDir({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(resolve('/xdg/glirastes/models'));
    expect(resolveSttModelDir({ GLIRASTES_MODEL_DIR: '', XDG_CACHE_HOME: '' }, '/home/u')).toBe(resolve('/home/u/.cache/glirastes/models'));
  });
});

describe('checkModelFiles', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const files = [
    { path: 'a/one.bin', bytes: 3, sha256: 'x', url: 'https://x/one' },
    { path: 'a/two.bin', bytes: 4, sha256: 'x', url: 'https://x/two' },
    { path: 'b/three.bin', bytes: 2, sha256: 'x', url: 'https://x/three' },
  ];

  it('passes when every file has its pinned size', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-models-'));
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'a/one.bin'), 'abc');
    await writeFile(join(dir, 'a/two.bin'), 'abcd');
    await writeFile(join(dir, 'b/three.bin'), 'ab');
    await expect(checkModelFiles(dir, files)).resolves.toBeUndefined();
  });

  it('names each missing or wrong-size file and the pull command', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-models-'));
    await mkdir(join(dir, 'a'));
    await writeFile(join(dir, 'a/one.bin'), 'abc');
    await writeFile(join(dir, 'a/two.bin'), 'ab');
    const error = await checkModelFiles(dir, files).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SttLocalError);
    expect((error as SttLocalError).code).toBe('models_missing');
    const message = (error as Error).message;
    expect(message).not.toContain('a/one.bin');
    expect(message).toContain('a/two.bin');
    expect(message).toContain('b/three.bin');
    expect(message).toContain(dir);
    expect(message.endsWith('Run: glirastes stt pull')).toBe(true);
  });
});
