import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  PlatformConnectionDescriptorSchema,
  type PlatformConnectionDescriptor,
} from '../../contracts/index.js';
import { FoundationDiagnosticError } from '../../diagnostics/foundation-diagnostic.js';

export function connectionDescriptorPath(projectRoot: string): string {
  return join(resolve(projectRoot), '.glirastes', 'platform-connection.json');
}

export function renderConnectionDescriptor(
  value: PlatformConnectionDescriptor,
): string {
  const descriptor = PlatformConnectionDescriptorSchema.parse(value);
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

export async function validateConnectionTargetPath(
  projectRoot: string,
  targetPath: string,
): Promise<string> {
  const root = resolve(projectRoot);
  const target = resolve(targetPath);
  const targetRelative = relative(root, target);
  if (
    targetRelative === '..'
    || targetRelative.startsWith(`..${sep}`)
    || isAbsolute(targetRelative)
  ) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-PATH-OUTSIDE',
      operation: 'connect',
      message: 'Connection files must remain inside the project.',
      remediation: 'use-project-local-connection-paths',
    });
  }

  let current = root;
  for (const part of targetRelative.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new FoundationDiagnosticError({
          code: 'E-CONNECT-PATH-SYMLINK',
          operation: 'connect',
          message: 'Connection file paths must not contain a symlink.',
          remediation: 'replace-connection-path-symlink',
          path: targetRelative,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
