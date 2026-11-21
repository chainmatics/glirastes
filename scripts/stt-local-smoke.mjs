// Stage 2 of the local STT smoke test: real transcription with the pinned model.
//
//   node stt-local-smoke.mjs <clip.wav> <modelDir>
//
// Runs from a scratch consumer (scripts/stt-local-consumer.sh) after
// `glirastes stt pull --dir <modelDir>`. Transcribes the German fixture, a
// version longer than 20 s (VAD and chunking against the real addon), and the
// fixture again after a worker restart. Any failure exits 1.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createLocalTranscriber } from 'glirastes/server/stt-local';

const [wavPath, modelDir] = process.argv.slice(2);
if (!wavPath || !modelDir) {
  console.error('Usage: node stt-local-smoke.mjs <clip.wav> <modelDir>');
  process.exit(2);
}

function fail(message) {
  console.error(`stt-local smoke: ${message}`);
  process.exit(1);
}

/** Standalone RIFF walker: PCM16 mono 16 kHz only. */
function decodeWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tag = (at) => String.fromCharCode(...buffer.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') fail('fixture is not a RIFF/WAVE file');
  let formatOk = false;
  for (let at = 12; at + 8 <= buffer.length;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      formatOk = view.getUint16(body, true) === 1 && view.getUint16(body + 2, true) === 1
        && view.getUint32(body + 4, true) === 16000 && view.getUint16(body + 14, true) === 16;
      if (!formatOk) fail('fixture is not PCM16 mono 16 kHz');
    } else if (id === 'data') {
      if (!formatOk) fail('fixture has data before fmt');
      const count = Math.floor(Math.min(size, buffer.length - body) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(body + i * 2, true) / 32768;
      return samples;
    }
    at = body + size + (size & 1);
  }
  return fail('fixture has no data chunk');
}

const clip = decodeWav(readFileSync(wavPath));
const gap = 24000; // 1.5 s of silence between the copies
const long = new Float32Array(clip.length * 3 + gap * 2);
for (let i = 0; i < 3; i += 1) long.set(clip, i * (clip.length + gap));
if (long.length <= 320000) fail(`the long clip must be longer than 20 s, got ${long.length} samples`);

const texts = {};
// The transcriber transfers the samples to its worker, so each call gets a copy.
async function transcribe(stt, samples, label) {
  const { text } = await stt.transcribe(
    { samples: samples.slice(), sampleRate: 16000 },
    { language: 'de', signal: new AbortController().signal },
  );
  texts[label] = text;
  return text.toLowerCase();
}

function expectClip(text, label) {
  for (const word of ['aufgabe', 'donnerstag']) {
    if (!text.includes(word)) fail(`${label}: "${word}" missing in "${text}"`);
  }
}

let stt = createLocalTranscriber({ modelDir });
const started = performance.now();
await stt.warmup();
const loadMs = Math.round(performance.now() - started);

let at = performance.now();
expectClip(await transcribe(stt, clip, 'clip'), 'clip');
const clipMs = Math.round(performance.now() - at);

at = performance.now();
const longText = await transcribe(stt, long, 'long');
const longMs = Math.round(performance.now() - at);
const count = longText.split('donnerstag').length - 1;
if (count !== 3) fail(`long clip: expected "donnerstag" 3 times, got ${count} in "${longText}"`);

await stt.close();
stt = createLocalTranscriber({ modelDir });
expectClip(await transcribe(stt, clip, 'afterRestart'), 'after restart');
await stt.close();

const header = process.report.getReport().header;
console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  glibc: header.glibcVersionRuntime,
  sherpaVersion: createRequire(import.meta.url)('sherpa-onnx-node/package.json').version,
  loadMs,
  clipMs,
  longMs,
  longSeconds: Math.round(long.length / 1600) / 10,
  texts,
}, null, 2));
