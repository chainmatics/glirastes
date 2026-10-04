import { describe, expect, it, vi } from 'vitest';
import type { TurnToolDiscovery } from '../../../runtime/index.js';
import { createHybridToolDiscovery } from './tool-discovery.js';

function discovery(): TurnToolDiscovery {
  return {
    turnId: 'turn-1',
    eligibleNames: Object.freeze(['tasks_list', 'reports_summary']),
    search: (query) => Object.freeze(query.includes('report')
      ? [Object.freeze({
        name: 'reports_summary',
        description: 'Summarize reports.',
        module: 'reporting',
      })]
      : []),
  };
}

describe('createHybridToolDiscovery', () => {
  it('starts with routed eligible tools and find_tools', () => {
    const controller = createHybridToolDiscovery({
      discovery: discovery(),
      initialToolNames: ['tasks_list', 'unknown'],
    });
    expect(controller.activeToolNames()).toEqual(['find_tools', 'tasks_list']);
  });

  it('activates only exact names returned by its own search on the next step', async () => {
    const controller = createHybridToolDiscovery({
      discovery: discovery(),
      initialToolNames: ['tasks_list'],
    });
    const result = await controller.tool.execute({ query: 'report' });
    expect(result).toEqual({
      tools: [{
        name: 'reports_summary',
        description: 'Summarize reports.',
        module: 'reporting',
      }],
    });
    expect(controller.prepareStep()).toEqual({
      activeTools: ['find_tools', 'reports_summary', 'tasks_list'],
    });
  });

  it('never accepts model-supplied names or invokes a domain binding', async () => {
    const domain = vi.fn();
    const controller = createHybridToolDiscovery({
      discovery: discovery(),
      initialToolNames: [],
    });
    await controller.tool.execute({
      query: 'nothing',
      names: ['tasks_list'],
      execute: domain,
    } as never);
    expect(controller.activeToolNames()).toEqual(['find_tools']);
    expect(domain).not.toHaveBeenCalled();
  });

  it('keeps server-configured built-ins active without making them searchable', async () => {
    const controller = createHybridToolDiscovery({
      discovery: discovery(),
      initialToolNames: [],
      builtinToolNames: ['ask_clarification', 'find_tools', 'tasks_list'],
    });
    expect(controller.activeToolNames()).toEqual([
      'ask_clarification',
      'find_tools',
    ]);
    await controller.tool.execute({ query: 'ask_clarification' });
    expect(controller.activeToolNames()).toEqual([
      'ask_clarification',
      'find_tools',
    ]);
  });

  it('does not share loaded state across controllers or turns', async () => {
    const first = createHybridToolDiscovery({
      discovery: discovery(), initialToolNames: [],
    });
    await first.tool.execute({ query: 'report' });
    const second = createHybridToolDiscovery({
      discovery: { ...discovery(), turnId: 'turn-2' }, initialToolNames: [],
    });
    expect(first.activeToolNames()).toContain('reports_summary');
    expect(second.activeToolNames()).toEqual(['find_tools']);
  });
});
