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
    ['a value with a slash and dot segments (p8)', 'x/../../admin'],
    ['.. before an encoded slash (p8)', '..%2fadmin'],
    ['.. before a double-encoded slash', '..%252fadmin'],
    ['backslash dot segments (p8)', '..\\..\\admin'],
    ['encoded backslash dot segments', '..%5cadmin'],
    ['a trailing dot segment', 'admin/..'],
    ['a single dot segment', 'a/./b'],
    ['a deeply encoded dot segment', '%25252525252e%25252525252e%25252525252fadmin'],
    ['a malformed escape next to an encoded slash', '..%2fadmin%'],
    ['more encoding rounds than the bound', `%${'25'.repeat(20)}2e%2e`],
  ])('refuses %s as a path parameter and sends nothing', async (_label, value) => {
    const callEndpoint = vi.fn();
    await expect(decisionsTool().execute(
      { appId: 'X', type: value, revisionId: 'r1', decision: 'approve' },
      { callEndpoint } as never,
    )).rejects.toThrow(/path parameter:? "type"/);
    expect(callEndpoint).not.toHaveBeenCalled();
  });

  it.each(['a.b', '...', 'v1..2', 'file.txt', '.hidden', 'a/b', '..a', 'a..'])(
    'still sends %s, which holds no dot segment', async (value) => {
      const callEndpoint = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
      await decisionsTool().execute({ appId: 'X', type: value, revisionId: 'r1', decision: 'approve' }, { callEndpoint } as never);
      expect(callEndpoint).toHaveBeenCalledWith(expect.objectContaining({
        path: `/v1/apps/X/runtime-revisions/${encodeURIComponent(value)}/r1/decisions`,
      }));
    },
  );

  it('reports the refusal to the model as a tool error through the generated-tool shape', async () => {
    const callEndpoint = vi.fn();
    const aiTool = toolToAiTool(decisionsTool(), { callEndpoint } as never);
    const result = await aiTool.execute({ appId: '..', type: 'prompt', revisionId: 'r1', decision: 'approve' });
    expect(result).toMatchObject({ error: expect.stringMatching(/path parameter:? "appId"/) });
    expect(callEndpoint).not.toHaveBeenCalled();
  });
});
