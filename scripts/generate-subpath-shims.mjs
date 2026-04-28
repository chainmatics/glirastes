// Generates legacy subpath shim directories at the package root.
//
// Why? `moduleResolution: node` (TS) and Webpack 4 / older bundlers do NOT read
// the `exports` field in package.json. They locate subpaths by walking the
// filesystem: `glirastes/server/nestjs` → looks for `node_modules/glirastes/server/nestjs/package.json`.
//
// These shims satisfy that expectation for legacy consumers. Modern Node and
// modern bundlers use `exports` and resolve to the same files via `import`/
// `require` conditions — both paths converge on identical artifacts.
//
// Each shim contains a tiny package.json pointing at the appropriate
// dist/-output (CJS for `main`, ESM for `module`, the ESM types as `types`).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Each entry: [subpath as the consumer imports it, dist directory name].
 * Subpath segments determine how many `../` we need to climb back to root.
 */
const SHIMS = [
  ['server', 'server'],
  ['server/nextjs', 'server/adapters/nextjs'],
  ['server/nestjs', 'server/adapters/nestjs'],
  ['server/testing', 'server/testing'],
  ['react', 'react'],
  ['react/vercel', 'react/transports/vercel'],
  ['react/langgraph', 'react/transports/langgraph'],
  ['codegen', 'codegen'],
  ['openapi', 'openapi'],
];

for (const [subpath, distRel] of SHIMS) {
  const depth = subpath.split('/').length;
  const up = '../'.repeat(depth);
  const dirPath = `${ROOT}/${subpath}`;

  const pkg = {
    main: `${up}dist/cjs/${distRel}/index.js`,
    module: `${up}dist/${distRel}/index.js`,
    types: `${up}dist/${distRel}/index.d.ts`,
  };

  mkdirSync(dirPath, { recursive: true });
  writeFileSync(`${dirPath}/package.json`, JSON.stringify(pkg, null, 2) + '\n');
}

console.log(`Generated ${SHIMS.length} subpath shims.`);
