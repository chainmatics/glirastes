import { createHash } from 'node:crypto';
import type { RuntimeDeploymentBundle } from '../contracts/revisions.js';

export function stableCohortBucket(subjectId: string): number {
  const digest = createHash('sha256').update(subjectId).digest();
  return digest.readUInt32BE(0) % 100;
}

export function selectRuntimeDeployment(
  deployments: {
    stable: RuntimeDeploymentBundle | null;
    canary: RuntimeDeploymentBundle | null;
  },
  input: {
    subjectId: string;
    pinnedDeploymentId?: string;
  },
): RuntimeDeploymentBundle {
  if (input.pinnedDeploymentId) {
    const available = [deployments.stable, deployments.canary].filter(
      (deployment): deployment is RuntimeDeploymentBundle => deployment !== null,
    );
    const pinned = available.find(
      (deployment) => (
        deployment.deploymentId === input.pinnedDeploymentId
        && deployment.pinned
      ),
    );
    if (!pinned) {
      throw new Error('Pinned runtime deployment is unavailable or not pinnable');
    }
    return pinned;
  }
  if (!deployments.stable) {
    throw new Error('No verified stable deployment is available');
  }
  if (
    deployments.canary
    && stableCohortBucket(input.subjectId)
      < deployments.canary.targetPercentage
  ) {
    return deployments.canary;
  }
  return deployments.stable;
}
