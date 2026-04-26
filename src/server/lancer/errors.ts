import type { LancerServiceName } from './types.js';

/**
 * Thrown by the Lancer client when a service is unreachable and the configured
 * degradation action for that service is 'block'.
 *
 * Consumers (e.g. server-pro pipeline) should catch this error and treat the
 * request as blocked rather than falling back silently.
 */
export class ServiceBlockedError extends Error {
  public override readonly cause: Error | undefined;

  constructor(
    public readonly service: LancerServiceName,
    cause?: Error,
  ) {
    super(`Service '${service}' blocked the request due to degradation policy`);
    this.name = 'ServiceBlockedError';
    this.cause = cause;
  }
}
