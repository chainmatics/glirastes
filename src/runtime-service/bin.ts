#!/usr/bin/env node
import { resolve } from "node:path";
import { readRuntimeConfig } from "./config.js";

function option(args: string[], key: string): string {
  const index = args.indexOf(key);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error("Missing CLI option");
  return args[index + 1];
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") {
    const { buildRuntimeArtifact } = await import("./artifact.js");
    const result = await buildRuntimeArtifact({
      projectRoot: resolve(option(args, "--project")),
      outputDirectory: resolve(option(args, "--out")),
      mode: args.includes("--frozen") ? "frozen" : "write",
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "validate") {
    const { loadRuntimeArtifact } = await import("./artifact.js");
    await loadRuntimeArtifact(resolve(option(args, "--artifact")));
    process.stdout.write("Artifact valid\n");
    return;
  }
  if (command === "healthcheck") {
    const config = await readRuntimeConfig(option(args, "--config"));
    const response = await fetch(
      `http://127.0.0.1:${config.server.port}/readyz`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!response.ok) process.exitCode = 1;
    return;
  }
  if (command === "serve") {
    const config = await readRuntimeConfig(option(args, "--config"));
    const { startRuntimeService } = await import("./service.js");
    const service = await startRuntimeService(config);
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void service.stop().catch(() => {
          process.exitCode = 1;
        });
      });
    return;
  }
  process.stdout.write(
    "glirastes-runtime build --project DIR --out DIR [--frozen]\nglirastes-runtime validate --artifact DIR\nglirastes-runtime serve --config FILE\nglirastes-runtime healthcheck --config FILE\n",
  );
  if (command && command !== "--help") process.exitCode = 1;
}
void main().catch((error: unknown) => {
  const command = process.argv[2];
  if (command === "build" || command === "validate") {
    // Local operator diagnostics: no live request or credential is involved.
    process.stderr.write(
      `Artifact command failed: ${error instanceof Error ? error.message : "invalid artifact"}\n`,
    );
    process.exitCode = 1;
    return;
  }
  // SDK/provider/network errors may contain credentials or payloads. Never
  // print their raw messages from a production host.
  process.stderr.write(
    "Glirastes runtime command failed; check configuration, artifact and dependency availability.\n",
  );
  process.exitCode = 1;
});
