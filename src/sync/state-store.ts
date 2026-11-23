import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  RuntimeDeploymentBundleSchema,
  SecurityRevocationSchema,
  type RuntimeDeploymentBundle,
  type SecurityRevocation,
} from '../contracts/revisions.js';

/**
 * The privacy floor of the accepted state. Once a protected policy was
 * accepted, a later revision without a privacy block is refused, and only
 * an explicitly signed `off` with a higher policy revision lowers it. It is
 * stored with the accepted state in the same write.
 */
export interface RuntimePrivacyFloor {
  profile: 'protected-text/v1' | 'off';
  /** The policy revision number (monotonic per environment) that set the floor. */
  policyRevision: number;
  deploymentId: string;
  revisionId: string;
}

export interface RuntimeSyncState {
  scope?: { targetAppId: string; environmentId: string; tenantId?: string };
  cursor: string | null;
  stable: RuntimeDeploymentBundle | null;
  canary: RuntimeDeploymentBundle | null;
  pending: RuntimeDeploymentBundle[];
  revocations: SecurityRevocation[];
  /** Absent in state written before privacy policies existed: no floor. */
  privacyFloor?: RuntimePrivacyFloor | null;
  /**
   * Verified deployments whose protected privacy block this runner cannot
   * enforce. While one is listed, AI traffic is blocked
   * (`privacy_not_configured`) instead of running unprotected on the
   * accepted revision. Absent in older state: none.
   */
  privacyRefusedDeploymentIds?: string[];
  updatedAt: string;
}

const RuntimePrivacyFloorSchema = z.object({
  profile: z.enum(['protected-text/v1', 'off']),
  policyRevision: z.number().int().positive(),
  deploymentId: z.uuid(),
  revisionId: z.uuid(),
}).strict();

const RuntimeSyncStateSchema: z.ZodType<RuntimeSyncState> = z.object({
  scope: z.object({ targetAppId: z.uuid(), environmentId: z.uuid(), tenantId: z.uuid().optional() }).strict().optional(),
  cursor: z.iso.datetime({ offset: true }).nullable(),
  stable: RuntimeDeploymentBundleSchema.nullable(),
  canary: RuntimeDeploymentBundleSchema.nullable(),
  pending: z.array(RuntimeDeploymentBundleSchema),
  revocations: z.array(SecurityRevocationSchema),
  privacyFloor: RuntimePrivacyFloorSchema.nullable().optional(),
  privacyRefusedDeploymentIds: z.array(z.uuid()).max(64).optional(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

/** Validates a state read from any store; throws for an invalid one. */
export function parseRuntimeSyncState(value: unknown): RuntimeSyncState {
  return RuntimeSyncStateSchema.parse(value);
}

export interface RuntimeStateStore {
  /**
   * `true` only when a saved state survives a process restart (a file on a
   * persistent volume, a database row). Managed privacy accepts and confirms
   * a protected policy only with a durable store; a store without this flag
   * counts as volatile.
   */
  readonly durable?: boolean;
  /** `null` when nothing was saved yet; throws when the state cannot be read or is invalid. */
  load(): Promise<RuntimeSyncState | null>;
  saveAtomic(state: RuntimeSyncState): Promise<void>;
}

/**
 * Keeps the state in the process. Volatile: it never satisfies managed
 * privacy, which needs a store that survives a restart.
 */
export class MemoryRuntimeStateStore implements RuntimeStateStore {
  readonly durable = false;
  private state: RuntimeSyncState | null = null;

  async load(): Promise<RuntimeSyncState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async saveAtomic(state: RuntimeSyncState): Promise<void> {
    this.state = structuredClone(RuntimeSyncStateSchema.parse(state));
  }
}

/**
 * Keeps the state in a JSON file, replaced atomically. Durable only when the
 * path lies on a volume that survives a restart and a redeploy of the
 * process (not a container's writable layer or a tmpfs); the SDK cannot
 * check that, the deployment must guarantee it.
 */
export class FileRuntimeStateStore implements RuntimeStateStore {
  readonly durable = true;
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
