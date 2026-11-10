// Bundles tests/browser/chat-harness.tsx with Bun and serves it on a
// loopback port. A loopback origin is a secure context, so getUserMedia works
// with Chrome's fake media device. Nothing is downloaded.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ENTRY = join(ROOT, 'tests/browser/chat-harness.tsx');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export async function startChatHarness() {
  const outdir = await mkdtemp(join(tmpdir(), 'glirastes-chat-harness-'));
  const build = spawn('bun', [
    'build', ENTRY,
    '--outdir', outdir,
    '--target', 'browser',
    '--format', 'esm',
    '--production',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let output = '';
  build.stdout.on('data', (chunk) => { output += chunk; });
  build.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(build, 'exit');
  if (code !== 0) {
    await rm(outdir, { recursive: true, force: true });
    throw new Error(`Harness build failed:\n${output}`);
  }
  await writeFile(join(outdir, 'index.html'), [
    '<!doctype html>',
    '<html lang="de"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="stylesheet" href="/chat-harness.css">',
    '<style>body{margin:0;font:16px/1.5 system-ui,sans-serif}</style>',
    '</head><body><div id="root"></div>',
    '<script type="module" src="/chat-harness.js"></script>',
    '</body></html>',
  ].join(''));

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = path.endsWith('.js') || path.endsWith('.css') ? path.slice(1) : 'index.html';
    try {
      const body = await readFile(join(outdir, file));
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(outdir, { recursive: true, force: true });
    },
  };
}
