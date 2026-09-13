import { fileURLToPath } from 'node:url';
export default {
  transpilePackages: ['glirastes'],
  outputFileTracingRoot: fileURLToPath(new URL('./', import.meta.url)),
  experimental: { cpus: 2 },
};
