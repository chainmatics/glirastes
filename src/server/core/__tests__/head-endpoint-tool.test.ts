import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createFetchInternalApiCaller, endpointToolToTool } from '../index.js';

describe('HEAD endpoint tools', () => {
  it('send their input as a query string, never a body, and run without confirmation by default', async () => {
    const callEndpoint = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const tool = endpointToolToTool({
      id: 'tasks.head',
      toolName: 'tasks_head',
      description: 'Check whether tasks exist.',
      method: 'HEAD',
      path: '/api/tasks/:id',
      inputSchema: z.object({ id: z.string(), status: z.string().optional() }),
    });
    expect(tool.needsApproval).toBe(false);
    await tool.execute({ id: '7', status: 'open' }, { callEndpoint } as never);
    expect(callEndpoint).toHaveBeenCalledWith({ method: 'HEAD', path: '/api/tasks/7?status=open', body: undefined });
  });

  it('never attaches a body to a HEAD request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const call = createFetchInternalApiCaller({ baseUrl: 'https://app.example', fetchImpl });
    await expect(call({ method: 'HEAD', path: '/api/tasks', body: { status: 'open' } }))
      .resolves.toEqual({ ok: true, status: 200, data: undefined });
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({ method: 'HEAD', headers: {} });
  });
});
