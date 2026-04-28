// Runtime loader for the optional `ws` peer dependency.
//
// `ws` is only needed when the speech-to-text feature is enabled
// (AiChatModule.attachWebSockets()). A top-level `import { WebSocketServer }
// from 'ws'` would force every NestJS consumer to install `ws` even when
// they don't use speech — and crash with `ERR_MODULE_NOT_FOUND` at startup
// if they don't.
//
// We use a plain dynamic `import('ws')` inside a try/catch:
// - In ESM dist: native dynamic import — Node resolves `ws` only at the
//   moment `attachWebSockets` is called.
// - In CJS dist: TypeScript lowers `import('ws')` to a Promise wrapper around
//   `require('ws')` — same lazy semantics.
// - Bundlers that bundle the server (esbuild / webpack for serverless deploys)
//   will still see `ws` as a referenced module. If your deployment bundles,
//   either install `ws` unconditionally, or mark it as an external in your
//   bundler config (esbuild `--external:ws`, webpack `externals: { ws: 'commonjs ws' }`).
//   Standard NestJS deployments don't bundle and are unaffected.

export interface WsModule {
  WebSocketServer: any;
  WebSocket: any;
}

let cached: WsModule | undefined;

export async function loadWs(): Promise<WsModule> {
  if (cached) return cached;

  let mod: any;
  try {
    mod = await import('ws');
  } catch (err) {
    throw new Error(
      "[glirastes] The 'ws' package is required for the speech-to-text feature " +
        '(AiChatModule.attachWebSockets). Install it with: npm install ws',
      { cause: err as Error },
    );
  }

  cached = {
    WebSocketServer: mod.WebSocketServer ?? mod.default?.WebSocketServer,
    WebSocket: mod.default ?? mod.WebSocket,
  };
  return cached;
}
