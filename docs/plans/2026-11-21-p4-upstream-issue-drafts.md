# P4 upstream issue drafts for k2-fsa/sherpa-onnx

**Status: drafts, not posted.** These come from the P4 spike ([spike report](2026-11-21-p4-local-stt-spike.md)). Posting them is a public action under the org's name; the owner decides when, and the person who posts them re-checks each repro against the latest release first.

---

## Draft 1: sherpa-onnx-linux-x64 2.0.2 requires CXXABI_1.3.15 and no longer loads on Debian 12 (bookworm)

**Title:** `sherpa-onnx-node 2.0.2: linux-x64 addon needs CXXABI_1.3.15 (GCC 13 libstdc++), fails on node:22-bookworm-slim`

**Body:**

`sherpa-onnx-linux-x64@2.0.2` fails to load on Debian 12 (bookworm), which is the base of the official `node:22-bookworm-slim` image. 2.0.1 loads fine on the same image.

Versions:
- `sherpa-onnx-node` 2.0.2 with `sherpa-onnx-linux-x64` 2.0.2 (fails); 2.0.1, 2.0.0, 1.13.8 and 1.12.40 (load)
- Image `node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`, linux/amd64
- Node 22.x; libstdc++ from Debian 12 (GCC 12)
- `sherpa-onnx-linux-arm64` 2.0.2 is not affected

Repro:

```sh
docker run --rm --platform linux/amd64 node:22-bookworm-slim sh -c '
  mkdir /t && cd /t && npm init -y >/dev/null &&
  npm install --ignore-scripts sherpa-onnx-node@2.0.2 >/dev/null &&
  node -e "require(\"sherpa-onnx-node\"); console.log(\"loaded\")"'
```

Actual:

```
Error: /lib/x86_64-linux-gnu/libstdc++.so.6: version `CXXABI_1.3.15' not found (required by …/sherpa-onnx-linux-x64/sherpa-onnx.node)
```

Expected: `loaded`, as with `sherpa-onnx-node@2.0.1`.

Analysis: `strings sherpa-onnx.node | grep -oE 'CXXABI_1\.3\.[0-9]+' | sort -V -u | tail -1` gives `CXXABI_1.3.15` for 2.0.2 and `CXXABI_1.3.9` for 2.0.1 (with `GLIBCXX_3.4.29`). The 2.0.2 x64 build seems to use a newer toolchain (GCC 13+) than earlier releases. That rules out Debian 12, Ubuntu 22.04 and RHEL 9 without an upgraded libstdc++.

Ask: could the linux-x64 npm binaries keep the earlier toolchain baseline (or link libstdc++ statically), and could the README state the minimum glibc and libstdc++ per platform? Related: the x64 addon already needs glibc 2.32 (`__libc_single_threaded`), while arm64 needs 2.17.

Workaround: pin `sherpa-onnx-node@2.0.1`, or use a base image with GCC 13+ libstdc++ (Debian 13, Ubuntu 24.04).

---

## Draft 2: linux-arm64: "Module did not self-register" when a worker_thread loads the addon after an earlier worker was terminated

**Title:** `sherpa-onnx-node (linux-arm64): addon fails in a new worker_thread with "Module did not self-register" after the first worker is terminated`

**Body:**

On linux-arm64, once the first `worker_threads` Worker that loaded `sherpa-onnx-node` has been terminated, every later Worker in the same process fails to load the addon. macOS arm64 and linux-x64 (2.0.1) work.

Versions:
- `sherpa-onnx-node` 2.0.1 and 2.0.2 with `sherpa-onnx-linux-arm64` of the same version
- Image `node:22-bookworm-slim` (linux/arm64, native), Node 22.x

Repro (`probe.mjs`):

```js
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const load = () => { try { require('sherpa-onnx-node'); return 'ok'; } catch (e) { return String(e.message); } };
if (isMainThread) {
  if (process.argv[2] === 'preload') console.log('main', load());
  for (let i = 0; i < 3; i++) {
    const w = new Worker(new URL(import.meta.url));
    console.log('worker', i, await new Promise((r) => w.once('message', r)));
    await w.terminate();
  }
} else parentPort.postMessage(load());
```

```sh
docker run --rm --platform linux/arm64 -v "$PWD:/t" -w /t node:22-bookworm-slim sh -c '
  npm init -y >/dev/null && npm install --ignore-scripts sherpa-onnx-node@2.0.1 >/dev/null && node probe.mjs'
```

Actual:

```
worker 0 ok
worker 1 Module did not self-register: '…/sherpa-onnx-linux-arm64/sherpa-onnx.node'.
worker 2 Module did not self-register: '…/sherpa-onnx-linux-arm64/sherpa-onnx.node'.
```

Expected: `ok` for every worker.

With `node probe.mjs preload`, where the main thread requires the addon once first (about 40 ms, no model), all workers load. Five terminate-and-respawn cycles stayed stable and memory stayed flat.

This matches the known Node behaviour for addons that are not context-aware or that the dynamic loader unloads together with the first worker's environment. Declaring the module with `NAPI_MODULE_INIT` / `NODE_MODULE_INIT` (context-aware) or keeping the shared library resident would likely fix it.

Workaround: require `sherpa-onnx-node` once on the main thread before starting any worker that uses it.
