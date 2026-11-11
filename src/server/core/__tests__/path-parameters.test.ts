import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { endpointToolToTool, toolToAiTool } from '../index.js';

function decisionsTool() {
  return endpointToolToTool({
    id: 'runtime-revisions.decide',
    toolName: 'runtimeRevisions_decide',
    description: 'Decide on a runtime revision.',
    method: 'POST',
    path: '/v1/apps/:appId/runtime-revisions/:type/:revisionId/decisions',
    inputSchema: z.object({ appId: z.string(), type: z.string(), revisionId: z.string(), decision: z.string() }).strict(),
  });
}

describe('path parameters of endpoint tools', () => {
  it('sends a plain value, encoded', async () => {
    const callEndpoint = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    await decisionsTool().execute(
      { appId: 'a b', type: 'prompt', revisionId: 'r1', decision: 'approve' },
      { callEndpoint } as never,
    );
    expect(callEndpoint).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/apps/a%20b/runtime-revisions/prompt/r1/decisions',
      body: { decision: 'approve' },
    });
  });

  it.each([
    ['..', '..'],
    ['.', '.'],
    ['an encoded ..', '%2e%2e'],
    ['an upper-case encoded ..', '%2E%2E'],
    ['a half-encoded ..', '.%2e'],
    ['a double-encoded ..', '%252e%252e'],
    ['an empty value', ''],
  ])('refuses %s as a path parameter and sends nothing', async (_label, value) => {
    const callEndpoint = vi.fn();
    await expect(decisionsTool().execute(
      { appId: 'X', type: value, revisionId: 'r1', decision: 'approve' },
      { callEndpoint } as never,
    )).rejects.toThrow(/path parameter:? "type"/);
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it('reports the refusal to the model as a tool error through the generated-tool shape', async () => {
    const callEndpoint = vi.fn();
    const aiTool = toolToAiTool(decisionsTool(), { callEndpoint } as never);
    const result = await aiTool.execute({ appId: '..', type: 'prompt', revisionId: 'r1', decision: 'approve' });
    expect(result).toMatchObject({ error: expect.stringMatching(/path parameter:? "appId"/) });
    expect(callEndpoint).not.toHaveBeenCalled();
  });
});
