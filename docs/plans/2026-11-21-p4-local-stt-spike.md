# P4 spike: local STT (sherpa-onnx + Parakeet TDT 0.6b v3 int8) in the glirastes Node server

Date: 2026-11-21. Host: Apple M3 Pro (5 performance + 6 efficiency cores), 36 GB, macOS 25.5, Node v25.8.1.

Linux checks ran in Docker Desktop 27.4:
- linux/arm64 runs natively.
- linux/amd64 runs under Rosetta emulation, so its timings do not represent real hardware.

Other processes loaded the host heavily during the first runs: the load average was about 110 and fell to about 11. The first numbers are worst-case values; the later runs are the representative ones.

**Verdict: GO WITH CHANGES** (see section 6).

**Raw evidence was not kept.** The spike ran in a temporary session scratch directory, which is not kept. Names below such as `scripts/…`, `evidence/…` and `downloads/…` refer to files of that directory; they are cited for traceability only and are not in this repository. The validated algorithms are restated in the P4 implementation plan (`docs/plans/2026-11-21-p4-local-stt.md`).

---

## 1. Package, delivery, platforms, Node, worker_threads, module shape, licence

### Package and licence
- **Package:** `sherpa-onnx-node`, a native N-API addon. Do not use `sherpa-onnx`: that is the WebAssembly build and it is single-threaded.
- **Versions:** `npm view sherpa-onnx-node` reports latest **2.0.2** (2026-11-19). 2.0.1 is from 2026-10-26 and 2.0.0 from 2026-10-23. Evidence: `evidence/npm-view-sherpa-onnx-node.json`.
- **Licence:** Apache-2.0 for the wrapper and for every platform package. The bundled `libonnxruntime` (ONNX Runtime 1.28.2) is MIT.

### How binaries are delivered
- Prebuilt binaries come as per-platform `optionalDependencies`, selected by npm's `os`/`cpu` fields.
- There is no install script and no build step.
- Each platform package contains `sherpa-onnx.node`, `libsherpa-onnx-c-api`, `libsherpa-onnx-cxx-api` and `libonnxruntime`.
- `npm install --ignore-scripts sherpa-onnx-node@2.0.2` installed only `sherpa-onnx-darwin-arm64` (35 MB unpacked).
- Platforms published: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64, win-arm64, win-ia32. Evidence: `evidence/npm-view-platforms.txt`.
- No `DYLD_LIBRARY_PATH` or `LD_LIBRARY_PATH` is needed, although the upstream README asks for it. The library search path is `@loader_path` on macOS and `$ORIGIN` on Linux (checked with `otool -l` and `objdump -p`).

### Linux C library limits
- **musl / Alpine is not supported.** The Linux packages declare no `libc` field, so npm installs them on Alpine anyway. Loading then fails on `node:22-alpine` with `Error loading shared library ld-linux-aarch64.so.1`.
- **glibc floor:** linux-arm64 needs glibc 2.17. The linux-x64 `sherpa-onnx.node` needs **glibc 2.32** (symbol `__libc_single_threaded`). That rules out Debian 11, Ubuntu 20.04, RHEL 8 and Amazon Linux 2. On `node:22-bullseye-slim` it fails with ``GLIBC_2.32' not found``.

### Blocking regression: linux-x64 2.0.2
- `sherpa-onnx-linux-x64@2.0.2` needs **`CXXABI_1.3.15`**, which only the C++ runtime from GCC 13 or newer provides.
- It **fails to load on `node:22-bookworm-slim`**, the base image of our `containers/runtime/Dockerfile`, with ``libstdc++.so.6: version `CXXABI_1.3.15' not found``.
- 2.0.1, 2.0.0, 1.13.8 and 1.12.40 need only `CXXABI_1.3.9` / `GLIBCXX_3.4.29`, which bookworm provides. linux-arm64 2.0.2 is not affected.
- Found by comparing the x64 tarballs with `strings` and `objdump` (`downloads/npm-linux-old/`), then confirmed with an amd64 bookworm container.
- **2.0.1 on bookworm amd64 works:** it loads, transcribes German correctly, runs in a worker and survives a worker restart. Evidence: `evidence/docker-linux-x64-bookworm-2.0.1.txt`.

### Node versions and module shape
- **Node versions:** the package README requires Node 16 or newer. Verified on Node 25.8.1 (macOS) and Node 22.23 (Linux). This is compatible with glirastes `engines` `>=20.6`.
- **Module shape:** CommonJS only (`main: sherpa-onnx.js`). There is no `exports` field, no `type: module` and no `.d.ts`.
  - In ESM, `import s from '…'` and `(await import(...)).default` work.
  - Named imports fail: `SyntaxError: Named export 'OfflineRecognizer' not found`.

### worker_threads
- Works on darwin-arm64, linux-arm64 and linux-x64.
- **Caveat on linux-arm64 (2.0.1 and 2.0.2):** once the first worker that loaded the addon is terminated, every later worker fails to load it with `Module did not self-register`.
- **Proven fix:** the main thread `require`s the addon once before starting the worker. This takes about 39 ms and about 10 MB of memory, and loads no model. With it, 5 restart cycles stayed stable.
- macOS and linux-x64 2.0.1 do not have this problem.
- Evidence: `scripts/respawn-probe.mjs`, `evidence/docker-linux-arm64-worker.json`.

### Async API
- `OfflineRecognizer.createAsync(config)` and `recognizer.decodeAsync(stream)` exist and run on Node's libuv threadpool.
- They do not block the event loop: lag stayed at 11–14 ms. A synchronous decode of a 20 s chunk on the main thread blocked it for 771–1027 ms.

## 2. API (from the package's own examples)

Sources, both at k2-fsa/sherpa-onnx commit `8a667ab1`, with copies in `downloads/upstream-examples/`:
- `nodejs-addon-examples/test_asr_non_streaming_nemo_parakeet_tdt_v2.js`
- `nodejs-addon-examples/test_vad_with_non_streaming_asr_whisper.js`

The config typedefs are in `node_modules/sherpa-onnx-node/types.js`.

```js
const sherpa = (await import('sherpa-onnx-node')).default;   // CJS default export
const rec = new sherpa.OfflineRecognizer({                    // or: await sherpa.OfflineRecognizer.createAsync(cfg)
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.int8.onnx`, joiner: `${d}/joiner.int8.onnx` },
    tokens: `${d}/tokens.txt`, numThreads: 2, provider: 'cpu', debug: 0, modelType: 'nemo_transducer',
  },
});
const stream = rec.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples /* Float32Array in [-1,1] */ });
rec.decode(stream);                       // or: const r = await rec.decodeAsync(stream)
const { text } = rec.getResult(stream);

const vad = new sherpa.Vad({ sileroVad: { model: vadPath, threshold: 0.5, minSpeechDuration: 0.25,
  minSilenceDuration: 0.5, maxSpeechDuration: 20, windowSize: 512 }, sampleRate: 16000, numThreads: 1 }, bufferSeconds);
for (let i = 0; i < samples.length; i += 512) {
  vad.acceptWaveform(samples.subarray(i, i + 512));
  while (!vad.isEmpty()) { const seg = vad.front(false); vad.pop(); /* seg.start, seg.samples */ }
}
vad.flush(); /* then drain again */
```

Parakeet takes **no language parameter** because it detects the language itself. The engine ignores the `language` argument of `transcribe()`. The handler should still validate it.

## 3. Model source, files, pinning, licences

### Parakeet TDT 0.6b v3 int8 (sherpa-onnx export)
**Primary source: HuggingFace.**
- Repo: `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`.
- Pinned commit: **`ed5d745623472f97cfc2e6c2916ee248798fc5a8`** (2026-11-07). The commit before it is `2bda32ec…` (2025-08-16).
- URL form: `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8/<file>`.
- Commit-pinned `resolve` URLs are immutable. The HF API (`/api/models/<repo>?blobs=true`) lists sha256 values for the large files, and all downloaded files matched them.

**Alternative source: GitHub release.** Repo `k2-fsa/sherpa-onnx`, tag `asr-models`, asset `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`.
- It was **re-uploaded on 2026-11-07**, so assets under this tag can change.
- It also needs bzip2 extraction in Node.
- Not suitable as the primary source; acceptable only as a mirror with a sha256 pin.

### Silero VAD
- Available only as a GitHub release asset; k2-fsa and csukuangfj publish no HuggingFace copy.
- URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`.
- The digest GitHub reports matches the download.
- This asset was also replaced once (updated 2025-07-11). The sha256 pin is therefore what makes the download trustworthy, and a mismatch must fail closed.

### Pinned files

| File | Bytes | sha256 | Source |
|---|---:|---|---|
| encoder.int8.onnx | 652,282,294 | `1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479` | HF @ ed5d7456 |
| decoder.int8.onnx | 11,845,274 | `0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5` | HF @ ed5d7456 |
| joiner.int8.onnx | 6,355,277 | `cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98` | HF @ ed5d7456 |
| tokens.txt | 93,939 | `d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d` (computed by me; HF lists no hash for small files) | HF @ ed5d7456 |
| silero_vad.onnx | 643,854 | `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6` | GH release asr-models |
| (alternative) …-v3-int8.tar.bz2 | 487,211,443 | `1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9` | GH release asr-models |

The total download is 670.6 MB; it took 57 s here.

Other ready-made sherpa-onnx packages exist (Silero `silero_vad.int8.onnx` at 212,860 bytes, sha256 `c36d490a…3a20`; and an fp32 Parakeet package). They were not tested.

### Licences (model card text read)
- **sherpa export card:** "The weights are NVIDIA's parakeet-tdt-0.6b-v3 … licensed under CC BY 4.0. This ONNX export was produced by the sherpa-onnx project, whose code is licensed under Apache-2.0. NVIDIA does not endorse this package."
- **Upstream `nvidia/parakeet-tdt-0.6b-v3` card** (commit `541d1f99`, not gated):
  - "This model is ready for commercial/non-commercial use."
  - "GOVERNING TERMS: Use of this model is governed by the CC-BY-4.0 license."
  - It adds no NVIDIA Open Model License or other terms, apart from a generic Trustworthy-AI paragraph.
- **Silero VAD** (snakers4/silero-vad): MIT, so its copyright notice must be kept.
- **sherpa-onnx:** Apache-2.0.

**Verdict: commercial use is OK.**
- Obligations: the CC-BY attribution and the Silero MIT notice.
- The attribution must name NVIDIA, link the licence, say the weights were converted and quantised, and say NVIDIA does not endorse the package.
- glirastes does not redistribute the weights, because users download them with `stt pull`. The CLI and docs should still print the attribution.

## 4. Measurements (int8, CPU)

### Test audio
Generated with `say -v Anna` (German) and `say -v Samantha` (English), then `afconvert -f WAVE -d LEI16@16000 -c 1`. afconvert writes an extra `FLLR` chunk, so the header is not 44 bytes; the spike's WAV parser walks the RIFF chunks and handles it.
- `de.wav`: 6.95 s.
- `en.wav`: 5.61 s.
- `long.wav`: 80.26 s, four paragraphs separated by 0.7 s pauses.
- `cont.wav`: 56.89 s of continuous speech with no pause of 0.5 s or more. This represents the ~53 s failure case.

### Short-clip transcripts (same at every thread count)
- German: "Guten Morgen, bitte lege eine neue Aufgabe für Donnerstag an und erinnere mich um 9 Uhr an das Kundengespräch." It matches the source except "neun" became "9".
- English: "Good morning, please create a new task for Thursday and remind me about the customer call at 9 o'clock." It matches the source except "nine" became "9".

### Main thread, darwin-arm64, warm file cache
Evidence: `evidence/threads-sweep.txt`. Real-time factor (RTF) is processing time divided by audio length; lower is faster.

| numThreads | Model load | RTF, 7 s German | RTF, 57 s chunked |
|---|---:|---:|---:|
| 1 | 0.79 s | 0.063 | 0.065 |
| 2 | 0.85 s | 0.037 | 0.041 |
| 4 | 0.94 s | 0.029 | 0.026 |

- **Cold first load:** 8.9 s, with RTF 0.33. The file cache was empty and the load average was about 110.
- **Warmup:** decoding 1 s of silence takes 50–250 ms.

### Worker thread, darwin-arm64, numThreads 2
Evidence: `evidence/worker-t2-run2.json`.
- **Load:** 0.8 s inside the worker.
- **Main event-loop lag:** at most 11–14 ms during load and during every job.
- **Jobs:**
  - German: 306 ms (RTF 0.044).
  - English: 263 ms (0.047).
  - 57 s continuous clip: 2.32 s (0.041), split into 4 chunks.
- **Queueing:** 3 jobs submitted at once were run one after another, 255 ms each, 768 ms in total.
- **Terminate mid-decode** of the 80 s clip: returned after 442 ms, the time to finish the native chunk already running. No crash.
- **Restart:** a new worker plus model load plus one job took 1.07 s.
- **Restart loop:** across 5 cycles memory went from 919 to 930 MB, about 2 MB per cycle, and stayed flat.

### Linux
- **linux-arm64, bookworm, native, 2.0.2, worker with the main-thread preload:**
  - Load: 1.3 s.
  - German: RTF 0.049. 57 s clip: RTF 0.045.
  - Terminate: 524 ms.
  - Memory across restarts: 713–715 MB, flat.
- **linux-x64 2.0.1, emulated (not representative):** German RTF 0.18; 57 s clip RTF 0.11 with 4 threads.

### Memory on darwin, one phase per process, peaks from `/usr/bin/time -l`

| Phase | Peak RSS | Peak footprint |
|---|---:|---:|
| Model load only | 1159 MB | 1147 MB |
| 3 short German decodes | 1079–1228 MB | 1226 MB |
| 80 s, chunked to 20 s or less | 1459–1461 MB | 1506–1531 MB |
| 57 s, chunked | 1239–1356 MB | 1325–1413 MB |
| **80 s, decoded as one clip** | **1718 MB** | **1905 MB** |
| 57 s, decoded as one clip | 1333 MB | 1753 MB |

On linux-arm64 memory is 0.98 GB after the model loads and 1.25 GB after a 57 s job. Plan for **about 1.2 GB steady and up to about 1.6 GB per process** with chunks of 20 s or less.

### Long audio and the 53 s case
**Decoding the whole clip:**
- The 57 s and 80 s clips did not crash with this stack.
- It cost 400–800 MB more peak memory.
- It made more errors: in the 80 s clip, "Der Kunde wünschen" twice and one dropped "sollten".
- The sherpa model card warns that long audio "degrades badly and grows memory" and recommends splitting "at silences into 15–20 s chunks".

**Transcribing the VAD's own speech segments:**
- Dropped first words twice ("Projekt läuft…" instead of "Das Projekt läuft…") and one "sollten".
- Repeated a word at a chunk boundary ("Termin. Termin").
- The VAD's `maxSpeechDuration: 20` is not a hard limit: it produced segments of 21.9 s and 21.2 s.

**Cutting the original audio at silences** (validated in `scripts/split.mjs`):
- How it works:
  - The VAD is used only to find silences.
  - The original audio is cut at the midpoint of each silence.
  - Chunks are filled greedily up to 20 s.
  - When no silence fits, the cut falls on the quietest 30 ms frame in the last 8 s.
  - Results are joined with single spaces.
- **80 s clip:** word-perfect transcript, 6 chunks, RTF 0.04.
- **57 s continuous clip:** correct except one dropped "die Kunden" inside a chunk.

## 5. Where the findings contradict the approved design

1. **The linux-x64 binary of the latest release (2.0.2) does not load on Debian bookworm**, which is our own container base (`CXXABI_1.3.15`). The claimed linux-x64 support holds only with 2.0.1 (verified) or with a base image that ships the C++ runtime from GCC 13 or newer (Debian trixie, Ubuntu 24.04).
2. **On linux-arm64, restarting the worker breaks** with `Module did not self-register` unless the main thread keeps the addon loaded. A timeout that terminates the worker would disable STT until the process restarts.
3. **Chunks of up to 30 s are too long.** The model card says 15–20 s. The VAD's maximum is not enforced, and decoding its trimmed segments drops first words.
4. **Memory** is about 1.2 GB steady and 1.5 GB at peak, not about 1 GB.
5. **Platform floor:** x64 needs glibc 2.32 or newer, and musl/Alpine is not supported even though npm installs the package there.
6. **CommonJS only, no types:** named ESM imports fail, so the dynamic import must use `.default`.
7. Parakeet ignores `language`.

None of these is a NO-GO:
- The licence allows commercial use.
- The API fits the planned `transcribe()` contract.
- worker_threads work.
- Speed is far inside the 120 s timeout.

## 6. Required design changes

1. **Pin the optional peer exactly to `2.0.1`**, not a range.
   - Bump it only after a CI smoke test on `node:22-bookworm-slim` amd64 and arm64, plus macOS arm64.
   - The smoke test loads the addon, decodes one German clip in a worker and restarts the worker once.
   - At startup, report the installed version and refuse or warn on untested ones.
   - File an upstream issue about the `CXXABI_1.3.15` regression in linux-x64 2.0.2.
2. **Load the addon in the main thread first.** `stt-local` should `require` it once before starting the worker (about 40 ms, no model), so worker restarts work on linux-arm64.
3. **Cancellation:**
   - Inside the worker, check `signal` and the deadline between chunks. This keeps the warm worker.
   - Use `worker.terminate()` only as a hard stop when a single chunk overruns. It waits for the running native chunk, about 0.5 s here.
   - Then start a new worker lazily and expect 1–9 s to reload the model.
4. **Chunking:**
   - Cut the original audio at VAD silence midpoints into chunks of at most 20 s, enforced in our own code.
   - Fall back to the quietest frame when no silence fits.
   - Do not decode the VAD's trimmed segments.
   - Pad 0.3 s at the edges and join with single spaces.
   - Audio of 20 s or less skips the VAD.
   - If the VAD finds no speech, return `''`.
5. **Memory:** document "about 1.2 GB steady, plan a 2 GB container limit". One worker per process stays as designed.
6. **Supported platforms:**
   - **Supported:** darwin-arm64; linux-x64 (glibc 2.32 or newer and the C++ runtime from GCC 11 or newer, with 2.0.1); linux-arm64 (glibc 2.17 or newer).
   - **Explicitly unsupported:** musl/Alpine. Detect it (`process.report.getReport().header.glibcVersionRuntime` is missing) and fail with a clear message.
   - **Not claimed:** Windows and darwin-x64 binaries exist but are untested.
7. **ESM interop and types:** use `(await import('sherpa-onnx-node')).default` and ship our own minimal `.d.ts` for the parts we use. If the import fails, throw an error that names the install command.
8. **`stt pull`:**
   - Download the 4 Parakeet files from HuggingFace URLs pinned to the commit, not the tarball. This needs no bzip2 and gives a sha256 per file.
   - Download Silero from the GitHub release URL with its sha256 pin.
   - Keep the atomic temp → hash → rename and fail closed on a mismatch.
   - `--mirror` keeps the same relative paths and sha256 values.
   - Print the CC-BY-4.0 attribution to NVIDIA, the line "converted to ONNX int8 by sherpa-onnx; NVIDIA does not endorse", and the Silero MIT notice.
9. **WAV input:**
   - Walk the RIFF chunks instead of assuming a 44-byte header.
   - Require PCM16, mono, 16 kHz.
   - Normalise gain on very quiet input (model card; upstream issue sherpa-onnx#4024).
10. **Defaults:**
    - `numThreads` 2 by default and configurable; 4 threads was another ~30% faster.
    - A 120 s timeout is ample: the browser caps recordings at 120 s, which takes about 5 s to transcribe on arm64.
    - The existing 45 s default for the URL path can stay separate.
11. **Still to verify in the implementation PR: Next.js bundling.**
    - The native module and the worker file inside `glirastes/server/stt-local` must not be bundled.
    - Document and test `serverExternalPackages: ['sherpa-onnx-node', 'glirastes']` or an equivalent.
    - Fallback if a worker file URL is impractical under a bundler: `decodeAsync` without a worker. It does not block the event loop (verified) but occupies libuv threadpool threads.

## Appendix: key commands

```bash
npm view sherpa-onnx-node@2.0.2 name version license main optionalDependencies dist.integrity --json
npm view sherpa-onnx-<platform>@2.0.2 license os cpu dist.unpackedSize dist.integrity --json
npm install --ignore-scripts sherpa-onnx-node@2.0.2            # in the scratch npm/ directory
objdump -T .../sherpa-onnx-linux-x64-2.0.2/package/sherpa-onnx.node | grep GLIBC_2.32
strings .../sherpa-onnx.node | grep -oE 'CXXABI_1\.3\.[0-9]+' | sort -V -u | tail -1
gh release view asr-models -R k2-fsa/sherpa-onnx --json assets   # names, sizes, digests, updatedAt
curl -s "https://huggingface.co/api/models/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8?blobs=true"
curl -s "https://huggingface.co/api/models/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/commits/main"
curl -sSfL -o <file> "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8/<file>"
shasum -a 256 downloads/models/*/*
say -v Anna -o de.aiff "…" && afconvert -f WAVE -d LEI16@16000 -c 1 de.aiff de.wav
/usr/bin/time -l node scripts/phase.mjs audio/<clip>.wav <threads> <load|whole|vad20|split20> <loops>
bash scripts/phases.sh <spikeDir> 2
node scripts/worker-host.mjs audio 2                           # PRELOAD_MAIN=1 on Linux
docker run --rm --platform linux/arm64|linux/amd64 -v …:ro node:22-bookworm-slim@sha256:e9f565d3… node /spike/scripts/…
docker run … node:22-bullseye-slim / node:22-alpine node /spike/scripts/addon-probe.mjs <addon.node> main
node scripts/respawn-probe.mjs <addon.node> <n> [keepMain]
```

npm integrity values for the pinned 2.0.1 packages:
- `sherpa-onnx-node@2.0.1`: `sha512-1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg==`
- `darwin-arm64@2.0.1`: `sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ==`
- `linux-x64@2.0.1`: `sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw==`
- `linux-arm64@2.0.1`: `sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA==`

Spike scripts, all in `scripts/`: `lib.mjs`, `split.mjs`, `main.mjs`, `phase.mjs`, `phases.sh`, `stt-worker.mjs`, `worker-host.mjs`, `addon-probe.mjs`, `respawn-probe.mjs`. Raw outputs are in `evidence/`.