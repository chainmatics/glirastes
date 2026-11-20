// Run by tests/pg-import.test.ts under plain `node` (not vitest's loader):
// links the built runtime service, which imports pg, then builds a pool with the
// options the service uses and ends it (no connection is opened). Prints the pg
// version the import resolved to. Lives outside the pg floor fixture so that,
// without the floor hook, `pg` resolves from the repository like the service's.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [serviceUrl] = process.argv.slice(2);
const service = await import(serviceUrl);
if (typeof service.startRuntimeService !== 'function') throw new Error('startRuntimeService missing');

const { default: pg } = await import('pg');
const pool = new pg.Pool({
  connectionString: 'postgres://127.0.0.1:1/none',
  max: 8,
  connectionTimeoutMillis: 5000,
  query_timeout: 6000,
  keepAlive: true,
});
pool.on('error', () => {});
await pool.end();

let directory = dirname(fileURLToPath(import.meta.resolve('pg')));
for (;;) {
  try {
    const { name, version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (name === 'pg') {
      process.stdout.write(JSON.stringify({ pg: version }) + '\n');
      break;
    }
  } catch {
    // no manifest here, go up
  }
  const parent = dirname(directory);
  if (parent === directory) throw new Error('pg package.json not found');
  directory = parent;
}
