import type { EffectiveEnvironmentControl, SecurityRevocation } from '../contracts/index.js';
import type { RolloutDeployments } from '../sync/deployment-selector.js';
import {
  materializeDeploymentRevisions,
  type MaterializedDeploymentRevisions,
} from '../sync/materialize-deployment.js';
import type {
  RuntimeControlState,
  RuntimeStateStore,
  RuntimeSyncState,
} from '../sync/state-store.js';

/** Keeps the sync state in memory and the accepted deployment materialized for the turns. */
export class AcceptedStateStore {
  private state: RuntimeSyncState | null = null;
  // bind and clear start a new generation; a view of an older one is inert.
  private generation = 0;
  private stable: MaterializedDeploymentRevisions | undefined;
  private canary: { deploymentId: string; revisions: MaterializedDeploymentRevisions } | undefined;
  private environmentId: string | undefined;
  // An unsigned connection error must never lift a signed halt.
  private retained: { environmentId: string; control: RuntimeControlState } | undefined;

  /** Called before the sync of an environment starts; the returned view is that sync's store. */
  bind(environmentId: string): RuntimeStateStore {
    this.generation += 1;
    const generation = this.generation;
    this.environmentId = environmentId;
    if (this.retained?.environmentId === environmentId && !this.state) {
      this.state = {
        cursor: null,
        stable: null,
        canary: null,
        pending: [],
        revocations: [],
        updatedAt: new Date(0).toISOString(),
        control: this.retained.control,
      };
      this.retained = undefined;
    }
    return {
      load: async () => (generation === this.generation ? this.load() : null),
      saveAtomic: async (state) => {
        if (generation === this.generation) this.save(state);
      },
    };
  }

  /** After the first successful sync of another environment, a retained control no longer applies. */
  synced(environmentId: string): void {
    if (this.retained && this.retained.environmentId !== environmentId) this.retained = undefined;
  }

  private load(): RuntimeSyncState | null {
    return this.state ? structuredClone(this.state) : null;
  }

  private save(state: RuntimeSyncState): void {
    this.state = structuredClone(state);
    this.stable = state.stable ? materializeDeploymentRevisions(state.stable) : undefined;
    this.canary = undefined;
    if (state.canary) {
      try {
        this.canary = { deploymentId: state.canary.deploymentId, revisions: materializeDeploymentRevisions(state.canary) };
      } catch {
        // A canary that does not materialize is never selected.
      }
    }
  }

  /** The accepted stable and canary deployments; a canary only when it materialized. */
  deployments(): RolloutDeployments {
    return {
      stable: this.state?.stable ?? null,
      canary: this.canary ? this.state?.canary ?? null : null,
      revocations: this.state?.revocations ?? [],
    };
  }

  /** The materialized canary of that deployment id, if it is the accepted one. */
  acceptedCanary(deploymentId: string): MaterializedDeploymentRevisions | undefined {
    return this.canary?.deploymentId === deploymentId ? this.canary.revisions : undefined;
  }

  accepted(): MaterializedDeploymentRevisions | undefined {
    return this.stable;
  }

  clear(): void {
    this.generation += 1;
    const control = this.state?.control;
    if (control && this.environmentId) {
      this.retained = { environmentId: this.environmentId, control };
    }
    this.state = null;
    this.stable = undefined;
    this.canary = undefined;
  }

  revocations(): SecurityRevocation[] {
    return this.state?.revocations ?? [];
  }

  control(): EffectiveEnvironmentControl | undefined {
    const control = this.state?.control ?? this.retained?.control;
    return control?.localHalt ?? control?.accepted ?? undefined;
  }
}
