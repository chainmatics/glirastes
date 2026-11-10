import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  RuntimeDeploymentBundleSchema,
  SecurityRevocationSchema,
  type RuntimeDeploymentBundle,
  type SecurityRevocation,
} from '../contracts/revisions.js';

export interface RuntimeSyncState {
  cursor: string | null;
  stable: RuntimeDeploymentBundle | null;
  canary: RuntimeDeploymentBundle | null;
  pending: RuntimeDeploymentBundle[];
  revocations: SecurityRevocation[];
  updatedAt: string;
}

const RuntimeSyncStateSchema: z.ZodType<RuntimeSyncState> = z.object({
  cursor: z.iso.datetime({ offset: true }).nullable(),
  stable: RuntimeDeploymentBundleSchema.nullable(),
  canary: RuntimeDeploymentBundleSchema.nullable(),
  pending: z.array(RuntimeDeploymentBundleSchema),
  revocations: z.array(SecurityRevocationSchema),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export interface RuntimeStateStore {
  load(): Promise<RuntimeSyncState | null>;
  saveAtomic(state: RuntimeSyncState): Promise<void>;
}

export class MemoryRuntimeStateStore implements RuntimeStateStore {
  private state: RuntimeSyncState | null = null;

  async load(): Promise<RuntimeSyncState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async saveAtomic(state: RuntimeSyncState): Promise<void> {
    this.state = structuredClone(RuntimeSyncStateSchema.parse(state));
  }
}

export class FileRuntimeStateStore implements RuntimeStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<RuntimeSyncState | null> {
    let serialized: string;
    try {
      serialized = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return RuntimeSyncStateSchema.parse(JSON.parse(serialized));
  }

  async saveAtomic(state: RuntimeSyncState): Promise<void> {
    const validated = RuntimeSyncStateSchema.parse(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(validated)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, this.path);
  }
}
