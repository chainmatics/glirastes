import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  RuntimeDeploymentBundleSchema,
  SecurityRevocationSchema,
  type RuntimeDeploymentBundle,
  type SecurityRevocation,
} from '../contracts/revisions.js';
import {
  EnvironmentControlSchema,
  LocalEnvironmentControlHaltSchema,
  type EnvironmentControl,
  type LocalEnvironmentControlHalt,
} from '../contracts/environment-control.js';

export interface RuntimeControlState {
  /** The last control whose signature and scope verified. */
  accepted: EnvironmentControl | null;
  /** Set while a delivered control could not be verified (fail closed). */
  localHalt: LocalEnvironmentControlHalt | null;
}

export interface RuntimeSyncState {
  cursor: string | null;
  stable: RuntimeDeploymentBundle | null;
  canary: RuntimeDeploymentBundle | null;
  pending: RuntimeDeploymentBundle[];
  revocations: SecurityRevocation[];
  updatedAt: string;
  /** Absent until a Platform with environment control answered; old state files lack it. */
  control?: RuntimeControlState;
  /** The newest accepted rollout binding per deployment, so an older one is never applied again. */
  rolloutBindings?: RuntimeRolloutBindingRecord[];
}

export interface RuntimeRolloutBindingRecord {
  deploymentId: string;
  issuedAt: string;
  /** sha256 (base64url) of the canonical signed binding. */
  digest: string;
}

const RuntimeSyncStateSchema: z.ZodType<RuntimeSyncState> = z.object({
  cursor: z.iso.datetime({ offset: true }).nullable(),
  stable: RuntimeDeploymentBundleSchema.nullable(),
  canary: RuntimeDeploymentBundleSchema.nullable(),
  pending: z.array(RuntimeDeploymentBundleSchema),
  revocations: z.array(SecurityRevocationSchema),
  updatedAt: z.iso.datetime({ offset: true }),
  control: z.object({
    accepted: EnvironmentControlSchema.nullable(),
    localHalt: LocalEnvironmentControlHaltSchema.nullable(),
  }).strict().optional(),
  rolloutBindings: z.array(z.object({
    deploymentId: z.uuid(),
    issuedAt: z.iso.datetime({ offset: true }),
    digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).strict()).max(64).optional(),
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
