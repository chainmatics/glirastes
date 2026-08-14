import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  connectionDescriptorPath,
  renderConnectionDescriptor,
  validateConnectionTargetPath,
} from './connection-descriptor.js';

const connection = {
  schemaVersion: 1 as const,
  baseUrl: 'https://platform.glirastes.io',
  appId: '019fa9a9-d5f7-7ec3-a3c7-8899de400001',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de400002',
  runnerKey: 'local-019fa9a9',
};

describe('connection descriptor', () => {
  it('renders deterministic non-secret scope only', () => {
    const rendered = renderConnectionDescriptor(connection);
    expect(JSON.parse(rendered)).toEqual(connection);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered).not.toMatch(/apiKey|credential|secret/i);
  });

  it('uses the tracked descriptor path inside .glirastes', () => {
    expect(connectionDescriptorPath('/project'))
      .toBe('/project/.glirastes/platform-connection.json');
  });

  it('rejects outside-root paths and symlinked path components', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glirastes-connection-path-'));
    await mkdir(join(root, '.glirastes'));
    await expect(validateConnectionTargetPath(root, join(root, '..', 'outside')))
      .rejects.toThrow('inside the project');

    await symlink(tmpdir(), join(root, '.glirastes', 'linked'));
    await expect(validateConnectionTargetPath(
      root,
      join(root, '.glirastes', 'linked', 'descriptor.json'),
    )).rejects.toThrow('symlink');
  });
});
