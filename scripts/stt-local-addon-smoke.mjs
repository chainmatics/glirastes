// Stage 1 of the local STT smoke test: the native addon, without a model.
//
//   node stt-local-addon-smoke.mjs [--expect-unsupported]
//
// Runs from a scratch consumer (scripts/stt-local-consumer.sh), so the import
// goes through the packed tarball's `exports`. checkLocalStt() checks the
// platform, loads the addon on the main thread, probes it in a worker,
// restarts that worker and probes again. With --expect-unsupported it passes
// only when the platform is refused (musl / Alpine).
import { createRequire } from 'node:module';
import { checkLocalStt } from 'glirastes/server/stt-local';

const expectUnsupported = process.argv.includes('--expect-unsupported');

function fail(message) {
  console.error(`stt-local addon smoke: ${message}`);
  process.exit(1);
}

let result;
try {
  result = await checkLocalStt();
} catch (error) {
  if (expectUnsupported && error?.code === 'platform_unsupported') {
    console.log(JSON.stringify({ refused: error.code, message: error.message }));
    process.exit(0);
  }
  fail(`${error?.code ?? 'error'}: ${error?.message ?? String(error)}`);
}

if (expectUnsupported) fail(`expected platform_unsupported, got ${JSON.stringify(result)}`);
const installed = createRequire(import.meta.url)('sherpa-onnx-node/package.json').version;
if (result.workerRestarts !== 1) fail(`expected one worker restart, got ${result.workerRestarts}`);
if (result.sherpaVersion !== installed) fail(`worker loaded sherpa-onnx-node ${result.sherpaVersion}, installed is ${installed}`);
console.log(JSON.stringify(result));
