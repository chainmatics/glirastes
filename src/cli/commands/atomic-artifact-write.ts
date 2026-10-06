import { randomUUID } from 'node:crypto';
import {
  copyFile,
  open,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ArtifactWrite {
  path: string;
  content: string | Uint8Array;
  /**
   * Gives the replacement the permission bits of the file it replaces. Staged
   * files are created 0600, which suits secrets and generated artifacts but
   * would silently narrow a developer's own source file. Off by default so a
   * credential file is never loosened to its previous mode.
   */
  preserveMode?: boolean;
}

export interface AtomicArtifactWriteHooks {
  afterReplace?(index: number): void | Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Stages and fsyncs the complete set before replacement. Recoverable copies
 * remain until every authoritative path has been replaced successfully.
 */
export async function writeArtifactSetAtomically(
  writes: ReadonlyArray<ArtifactWrite>,
  hooks: AtomicArtifactWriteHooks = {},
): Promise<void> {
  const seen = new Set<string>();
  for (const write of writes) {
    if (!write.path || seen.has(write.path)) {
      throw new Error('Artifact transaction paths must be unique and explicit.');
    }
    seen.add(write.path);
  }
  const transactionId = randomUUID();
  const entries = writes.map((write) => ({
    ...write,
    staged: `${write.path}.glirastes-stage-${transactionId}`,
    backup: `${write.path}.glirastes-backup-${transactionId}`,
    existed: false,
  }));
  let replacementStarted = false;
  try {
    for (const entry of entries) {
      const handle = await open(entry.staged, 'wx', 0o600);
      try {
        await handle.writeFile(entry.content);
        const mode = entry.preserveMode ? await existingMode(entry.path) : undefined;
        if (mode !== undefined) await handle.chmod(mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      entry.existed = await exists(entry.path);
      if (entry.existed) await copyFile(entry.path, entry.backup);
    }

    replacementStarted = true;
    for (const [index, entry] of entries.entries()) {
      await rename(entry.staged, entry.path);
      await hooks.afterReplace?.(index);
    }
    for (const directory of new Set(entries.map((entry) => dirname(entry.path)))) {
      const handle = await open(directory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (replacementStarted) {
      for (const entry of entries) {
        if (entry.existed && await exists(entry.backup)) {
          await copyFile(entry.backup, entry.path);
        } else if (!entry.existed) {
          await removeIfPresent(entry.path);
        }
      }
    }
    throw error;
  } finally {
    for (const entry of entries) {
      await removeIfPresent(entry.staged);
      await removeIfPresent(entry.backup);
    }
  }
}
