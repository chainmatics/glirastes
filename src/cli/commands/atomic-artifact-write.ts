import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  open,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
  /**
   * Where the staged copy is written before the rename; the target's own
   * directory by default. Must be on the same filesystem as the target. A
   * secret stages in a private directory so a crash leaves no copy that Git
   * could pick up.
   */
  stagingDir?: string;
  /** Where the backup of the replaced file is kept; the target's directory by default. */
  backupDir?: string;
}

export interface AtomicArtifactWriteHooks {
  /** After every staged copy and backup exists, before the first rename. */
  afterStage?(): void | Promise<void>;
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
    staged: join(write.stagingDir ?? dirname(write.path), `${basename(write.path)}.glirastes-stage-${transactionId}`),
    backup: join(write.backupDir ?? dirname(write.path), `${basename(write.path)}.glirastes-backup-${transactionId}`),
    existed: false,
    mode: undefined as number | undefined,
  }));
  let replacementStarted = false;
  try {
    for (const entry of entries) {
      // Staged copies stay 0600 until they replace the target; a preserved
      // mode is applied after the rename, so a crash never leaves a copy
      // more readable than 0600.
      const handle = await open(entry.staged, 'wx', 0o600);
      try {
        await handle.writeFile(entry.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      entry.mode = entry.preserveMode ? await existingMode(entry.path) : undefined;
      entry.existed = await exists(entry.path);
      if (entry.existed) await copyFile(entry.path, entry.backup);
    }
    await hooks.afterStage?.();

    replacementStarted = true;
    for (const [index, entry] of entries.entries()) {
      await rename(entry.staged, entry.path);
      if (entry.mode !== undefined) await chmod(entry.path, entry.mode);
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
          // A rename, not a copy: a kill mid-rollback never leaves a
          // truncated file. The backup shares the target's filesystem.
          await rename(entry.backup, entry.path);
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
