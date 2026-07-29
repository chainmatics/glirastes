import {
  ExecutionLeaseSchema,
  type ExecutionBudget,
  type ExecutionLease,
  type ToolRiskClass,
} from '../contracts/index.js';
import {
  RuntimeRevisionVerifier,
  type RuntimePublicKeyProvider,
} from '../sync/signature-verifier.js';

export interface OfflineExecutionLeaseScope {
  tenantId: string;
  targetAppId: string;
  environmentId: string;
  runnerId: string;
  deploymentId: string;
  agentRevisionId: string;
  triggerId: string;
}

export interface OfflineExecutionLeaseAuthorization {
  leaseId: string;
  budget: ExecutionBudget;
}

export class OfflineExecutionLeaseAuthorizer {
  private readonly verifier: RuntimeRevisionVerifier;

  constructor(keys: RuntimePublicKeyProvider) {
    this.verifier = new RuntimeRevisionVerifier(keys);
  }

  async authorize(input: {
    lease: ExecutionLease;
    scope: OfflineExecutionLeaseScope;
    riskClass: ToolRiskClass;
    requiresApproval: boolean;
    at?: Date;
  }): Promise<OfflineExecutionLeaseAuthorization> {
    const lease = ExecutionLeaseSchema.parse(input.lease);
    await this.verifier.verifyExecutionLease(lease);
    this.assertScope(lease, input.scope);

    const now = (input.at ?? new Date()).getTime();
    if (now < Date.parse(lease.issuedAt)) {
      throw new Error('Offline execution lease is not active yet');
    }
    if (now >= Date.parse(lease.expiresAt)) {
      throw new Error('Offline execution lease has expired');
    }
    if (input.requiresApproval) {
      throw new Error('Approval-required tools cannot execute offline');
    }
    if (input.riskClass !== 'safe-read') {
      throw new Error('Offline execution is restricted to safe-read tools');
    }
    if (!lease.allowedRiskClasses.includes(input.riskClass)) {
      throw new Error('Tool risk class is outside the offline execution lease');
    }

    return {
      leaseId: lease.leaseId,
      budget: structuredClone(lease.budget),
    };
  }

  private assertScope(
    lease: ExecutionLease,
    scope: OfflineExecutionLeaseScope,
  ): void {
    const matches = (
      lease.tenantId === scope.tenantId
      && lease.targetAppId === scope.targetAppId
      && lease.environmentId === scope.environmentId
      && lease.runnerId === scope.runnerId
      && lease.deploymentId === scope.deploymentId
      && lease.agentRevisionId === scope.agentRevisionId
      && lease.triggerId === scope.triggerId
    );
    if (!matches) {
      throw new Error('Offline execution lease scope does not match the run');
    }
  }
}
