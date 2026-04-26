import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the CLI package version from package.json (dist/utils/ → ../../package.json). */
export function getCliVersion(): string {
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
}
