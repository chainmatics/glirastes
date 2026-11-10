import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEndpointTool } from '../../../types.js';
import { endpointToolToTool, toolToAiTool, type EndpointToolContext } from '../index.js';

const definition = defineEndpointTool({
  id: 'tasks.create',
  toolName: 'tasks_create',
  description: 'Create a task.',
  method: 'POST',
  path: '/api/tasks',
  inputSchema: z.object({ title: z.string() }).strict(),
});

function context(status: number, onContractRejected?: EndpointToolContext['onContractRejected']): EndpointToolContext {
  return {
    currentDate: new Date('2026-10-05T10:00:00.000Z'),
    locale: 'de-DE',
    callEndpoint: async () => ({ ok: status < 400, status, data: { error: 'title is too short' }, error: 'title is too short' }),
    ...(onContractRejected ? { onContractRejected } : {}),
  };
}

describe('tool_contract_rejected at the endpoint tool', () => {
  it.each([400, 422] as const)('reports a schema-valid call the endpoint refuses with %i', async (status) => {
    const rejections: unknown[] = [];
    const tool = toolToAiTool(endpointToolToTool(definition), context(status, (rejection) => { rejections.push(rejection); }));
    const result = await tool.execute({ title: 'x' });
    expect(result).toMatchObject({ success: false, error: 'title is too short' });
    expect(rejections).toEqual([{ toolName: 'tasks_create', status }]);
  });

  it.each([401, 403, 404, 500])('leaves %i alone: it is no contract problem', async (status) => {
    const rejections: unknown[] = [];
    const tool = toolToAiTool(endpointToolToTool(definition), context(status, (rejection) => { rejections.push(rejection); }));
    await tool.execute({ title: 'x' });
    expect(rejections).toEqual([]);
  });

  it('never lets a failing reporter change the tool result', async () => {
    const tool = toolToAiTool(endpointToolToTool(definition), context(400, () => { throw new Error('sink down'); }));
    expect(await tool.execute({ title: 'x' })).toMatchObject({ success: false, error: 'title is too short' });
  });
});
