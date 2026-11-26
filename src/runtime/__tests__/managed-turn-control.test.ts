import { describe, expect, it } from 'vitest';
import {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
} from './turn-snapshot.test.js';
import { createTurnSnapshot } from '../turn-snapshot.js';
import { createManagedTurnGuard } from '../managed-turn.js';
import { ToolExecutionDeniedError } from '../tool-denial.js';
import { AssistantHaltedError, type ManagedTurnControl } from '../turn-control.js';

function guardWith(control: () => ManagedTurnControl) {
  return createManagedTurnGuard({
    snapshot: createTurnSnapshot({
      turnId: 'turn-1', agentRevision, manifestRevision, policyRevision, principal, localLimits,
    }),
    resolvePrincipal: async () => principal,
    loadControl: control,
  });
}

const call = { toolName: 'list_tasks', input: { status: 'open' } };
const enabled: ManagedTurnControl = { assistant: 'enabled' };
const halted: ManagedTurnControl = { assistant: 'halted', code: 'assistant_halted' };

describe('createManagedTurnGuard with an environment control', () => {
  it('refuses the next tool call, approval check and subject lookup once halted, as a terminal denial', async () => {
    let current: ManagedTurnControl = enabled;
    const guard = guardWith(() => current);
    await expect(guard.beforeToolCall(call)).resolves.toBeUndefined();

    current = halted;
    for (const attempt of [
      () => guard.beforeToolCall(call),
      () => guard.resolveApproval(call),
      () => guard.beforeSubjectLookup(call),
    ]) {
      const error = await attempt().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ToolExecutionDeniedError);
      expect(error).toMatchObject({ reason: 'assistant_halted', recoverable: false });
    }
    // A refused call does not count against the budget.
    expect(guard.tracker.usage.toolCalls).toBe(1);
  });

  it('does not cut off a tool call that was already running when the halt arrived', async () => {
    let current: ManagedTurnControl = enabled;
    const guard = guardWith(() => current);
    await guard.beforeToolCall(call);
    current = halted;
    await expect(guard.afterToolCall({ ...call, result: { tasks: [] }, durationMs: 5 })).resolves.toBeUndefined();
  });

  it('refuses the next model step once halted', async () => {
    let current: ManagedTurnControl = enabled;
    const guard = guardWith(() => current);
    await expect(guard.beforeModelStep()).resolves.toBeUndefined();
    current = { assistant: 'halted', code: 'control_unknown' };
    await expect(guard.beforeModelStep()).rejects.toEqual(new AssistantHaltedError('control_unknown'));
  });

  it('checks nothing without a control loader', async () => {
    const guard = createManagedTurnGuard({
      snapshot: createTurnSnapshot({
        turnId: 'turn-1', agentRevision, manifestRevision, policyRevision, principal, localLimits,
      }),
      resolvePrincipal: async () => principal,
    });
    await expect(guard.beforeModelStep()).resolves.toBeUndefined();
    await expect(guard.beforeToolCall(call)).resolves.toBeUndefined();
  });
});
