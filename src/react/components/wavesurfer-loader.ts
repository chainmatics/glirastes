// Runtime loader for the optional `wavesurfer.js` peer dependency.
//
// `wavesurfer.js` is only needed for the live waveform during voice input.
// A plain dynamic `import('wavesurfer.js')` would be statically analysed by
// browser-side bundlers (Webpack, Turbopack, Vite, esbuild) — even though
// the import only executes when the user clicks the mic, the bundler tries
// to resolve the specifier at *build* time and fails when the peer isn't
// installed.
//
// To make the optional peer truly optional, we hide the specifier behind a
// runtime-constructed function. Bundlers can't follow a string passed to
// `Function('s', 'return import(s)')`, so they don't try to resolve it.
//
// Trade-offs:
// - **CSP:** Pages with a strict Content-Security-Policy that disallows
//   `unsafe-eval` will block the `Function` constructor. If you ship under
//   such a CSP, install `wavesurfer.js` unconditionally — the bundler will
//   then resolve the static path and the runtime trick is bypassed for free.
// - **Tree-shaking:** Bundlers can't tree-shake calls behind this function,
//   but the loader itself is tiny and only the components that opt into
//   voice (`AiTriggerButton`, `RecordingBar`) reach this path.
//
// If your deployment forbids `Function`/`eval` AND you don't want
// `wavesurfer.js` installed, build a Glirastes app without the `<showMic>`
// option — the voice components are then never mounted and `loadWaveSurfer`
// is never called.

const runtimeImport = new Function('s', 'return import(s)') as (
  specifier: string,
) => Promise<{ default: unknown }>;

export interface WaveSurferModule {
  WaveSurfer: any;
  RecordPlugin: any;
}

export function loadWaveSurfer(): Promise<WaveSurferModule> {
  return Promise.all([
    runtimeImport('wavesurfer.js').then((m) => m.default),
    runtimeImport('wavesurfer.js/dist/plugins/record.esm.js').then((m) => m.default),
  ]).then(([WaveSurfer, RecordPlugin]) => ({ WaveSurfer, RecordPlugin }));
}
