import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createJsonSchemaLike } from '../../../runtime/json-schema.js';
import { createUiActionSchema } from '../../../types.js';
import { endpointToolToTool, normalizeResultUiAction, uiActionToolToTool } from '../index.js';

const context = { currentDate: new Date(), locale: 'en-US' } as never;
const anyObject = createJsonSchemaLike({ type: 'object' });

describe('uiActionToolToTool', () => {
  it('turns a navigation call into the href the app bridge pushes', async () => {
    const tool = uiActionToolToTool({
      id: 'ui.navigate',
      toolName: 'ui_navigate',
      description: 'Open a page of this app.',
      inputSchema: anyObject,
      needsApproval: false,
      action: { kind: 'navigate' },
    });
    expect(tool.needsApproval).toBe(false);
    await expect(tool.execute({ destination: '/tasks/:id', params: { id: '7' } }, context)).resolves.toEqual({
      success: true,
      message: 'Action executed.',
      uiAction: {
        type: 'glirastes.navigate',
        actionId: 'glirastes.navigate',
        payload: { href: '/tasks/7', destination: '/tasks/:id', params: { id: '7' } },
      },
    });
    await expect(tool.execute({ destination: '/tasks/:id' }, context)).resolves.toEqual({
      success: false,
      error: 'Missing route parameter id',
    });
  });

  it('puts only the declared filter keys into the query, in declaration order', async () => {
    const tool = uiActionToolToTool({
      id: 'ui.filter.tasks',
      toolName: 'ui_filter_tasks',
      description: 'Filter the tasks page.',
      inputSchema: anyObject,
      needsApproval: false,
      action: {
        kind: 'filter',
        destination: '/projects/:projectId/tasks',
        keys: [{ key: 'status' }, { key: 'tags', array: 'repeat' }],
      },
    });
    await expect(tool.execute({
      status: 'done', tags: ['a', 'b'], params: { projectId: 'p1' }, other: 'ignored',
    }, context)).resolves.toMatchObject({
      success: true,
      uiAction: {
        type: 'glirastes.navigate',
        payload: {
          href: '/projects/p1/tasks?status=done&tags=a&tags=b',
          destination: '/projects/:projectId/tasks',
          query: { status: 'done', tags: ['a', 'b'] },
        },
      },
    });
  });

  it('passes a client action payload through to the registered handler', async () => {
    const tool = uiActionToolToTool({
      id: 'ui.tasks.highlight',
      toolName: 'ui_tasks_highlight',
      description: 'Highlight a task.',
      inputSchema: anyObject,
      needsApproval: true,
      action: { kind: 'client-action', actionId: 'tasks.highlight' },
    });
    expect(tool.needsApproval).toBe(true);
    await expect(tool.execute({ taskId: '2' }, context)).resolves.toEqual({
      success: true,
      message: 'Action executed.',
      uiAction: { type: 'glirastes.action', actionId: 'tasks.highlight', payload: { taskId: '2' } },
    });
  });

  it('keeps its UI action through an app uiActionSchema built with createUiActionSchema', async () => {
    const navigate = uiActionToolToTool({
      id: 'ui.navigate', toolName: 'ui_navigate', description: 'Open a page of this app.',
      inputSchema: anyObject, needsApproval: false, action: { kind: 'navigate' },
    });
    const highlight = uiActionToolToTool({
      id: 'ui.tasks.highlight', toolName: 'ui_tasks_highlight', description: 'Highlight a task.',
      inputSchema: anyObject, needsApproval: false, action: { kind: 'client-action', actionId: 'tasks.highlight' },
    });
    const schema = createUiActionSchema();
    for (const result of [
      await navigate.execute({ destination: '/tasks' }, context),
      await highlight.execute({ taskId: '2' }, context),
    ]) {
      expect(normalizeResultUiAction(result, schema)).toEqual(result);
    }
  });
});

describe('endpoint results and the glirastes.* UI actions', () => {
  it('never carry a UI action reserved for generated tools, whatever the endpoint returns', async () => {
    const callEndpoint = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          title: 'Write tests',
          uiAction: [
            { type: 'glirastes.action', actionId: 'tasks.delete', payload: { taskId: '2' } },
            { type: 'navigate', path: '/tasks' },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/admin' } } },
      });
    const tool = endpointToolToTool({
      id: 'tasks.get',
      toolName: 'tasks_get',
      description: 'Read a task.',
      method: 'GET',
      path: '/api/tasks/:id',
      inputSchema: z.object({ id: z.string() }),
    });
    await expect(tool.execute({ id: '2' }, { callEndpoint } as never)).resolves.toEqual({
      success: true,
      title: 'Write tests',
      uiAction: [{ type: 'navigate', path: '/tasks' }],
    });
    await expect(tool.execute({ id: '2' }, { callEndpoint } as never)).resolves.toEqual({ success: true });
  });
});
