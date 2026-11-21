/**
 * Decodes a recording for local transcription: PCM16, mono, 16 kHz WAV only.
 *
 * Walks the RIFF chunks instead of assuming a 44-byte header, so files with
 * `LIST` or `FLLR` chunks (afconvert, ffmpeg) still decode. A `data` size that
 * lies (0xFFFFFFFF from streaming writers, or larger than the file) is read up
 * to the end of the buffer, and a trailing odd byte is dropped.
 *
 * @returns samples in [-1, 1), or `undefined` when the format is not supported.
 */
export function decodeRecordingWav(bytes: ArrayBuffer): Float32Array | undefined {
  const view = new DataView(bytes);
  const length = bytes.byteLength;
  const tag = (offset: number) => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
  if (length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;

  let formatOk: boolean | undefined;
  let offset = 12;
  while (offset + 8 <= length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > length) return undefined;
      formatOk = view.getUint16(body, true) === 1
        && view.getUint16(body + 2, true) === 1
        && view.getUint32(body + 4, true) === 16000
        && view.getUint16(body + 14, true) === 16;
      if (!formatOk) return undefined;
    } else if (id === 'data') {
      if (!formatOk) return undefined;
      const payload = Math.min(size, length - body) & ~1;
      const samples = new Float32Array(payload / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(body + i * 2, true) / 32768;
      return samples;
    }
    offset = body + size + (size & 1);
  }
  return undefined;
}
