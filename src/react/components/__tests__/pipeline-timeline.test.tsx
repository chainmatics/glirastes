// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineState, PipelineStepReport } from '../../types.js';
import { PipelineTimeline } from '../pipeline-timeline.js';

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => ({
    classNames: {},
    locale: {
      pipelineTitle: 'Ablauf',
      pipelineRunningLabel: 'Läuft',
      pipelineCompletedLabel: 'Abgeschlossen',
      pipelineApprovalPendingLabel: 'Freigabe ausstehend',
      stopButton: 'Stopp',
    },
    toolLabels: {
      labels: {
        create_task: { singular: 'Aufgabe anlegen', plural: 'Aufgaben anlegen' },
        list_tasks: { singular: 'Aufgaben lesen', plural: 'Aufgaben lesen' },
      },
    },
  }),
}));

afterEach(cleanup);

function step(
  stepNumber: number,
  toolCalls: string[],
  overrides: Partial<PipelineStepReport> = {},
): PipelineStepReport {
  return {
    stepNumber,
    finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
    toolCalls,
    toolResults: toolCalls.length,
    requiresApproval: false,
    pendingApprovals: 0,
    summary: `Summary ${stepNumber}`,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    createdAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

function state(status: PipelineState['status']): PipelineState {
  return {
    status,
    totalSteps: 0,
    maxSteps: 10,
    stepLimitSource: 'module',
    updatedAt: '2026-10-28T10:00:00.000Z',
  };
}

function rows() {
  return Array.from(document.querySelectorAll('[data-element="step"]'));
}

describe('PipelineTimeline checklist', () => {
  it('stays hidden for a single tool call', () => {
    const { container } = render(
      <PipelineTimeline
        steps={[step(0, ['create_task']), step(1, [])]}
        pipelineState={state('completed')}
        isLoading={false}
        onStop={() => {}}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('stays hidden while a request runs before any tool call', () => {
    const { container } = render(
      <PipelineTimeline steps={[]} pipelineState={null} isLoading onStop={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('lists every tool call with a check once there are two of them', () => {
    render(
      <PipelineTimeline
        steps={[step(0, ['list_tasks']), step(1, ['create_task']), step(2, [])]}
        pipelineState={state('completed')}
        isLoading={false}
        onStop={() => {}}
      />,
    );
    const items = rows();
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual([
      'completed',
      'completed',
    ]);
    expect(items[0].textContent).toContain('Aufgaben lesen');
    expect(items[1].textContent).toContain('Aufgabe anlegen');
    for (const item of items) {
      expect(item.querySelector('[data-element="icon"]')?.getAttribute('data-icon')).toBe('check');
    }
  });

  it('counts tool calls of one step towards the threshold', () => {
    render(
      <PipelineTimeline
        steps={[step(0, ['create_task', 'create_task'])]}
        pipelineState={state('completed')}
        isLoading={false}
        onStop={() => {}}
      />,
    );
    expect(rows()).toHaveLength(2);
  });

  it('shows a spinner row while the pipeline still runs', () => {
    render(
      <PipelineTimeline
        steps={[step(0, ['list_tasks']), step(1, ['create_task'])]}
        pipelineState={state('running')}
        isLoading
        onStop={() => {}}
      />,
    );
    const items = rows();
    const last = items.at(-1)!;
    expect(items).toHaveLength(3);
    expect(last.getAttribute('data-status')).toBe('running');
    expect(last.querySelector('[data-element="icon"]')?.getAttribute('data-icon')).toBe('spinner');
    expect(last.textContent).toContain('Läuft');
  });

  it('dims tool calls that wait for approval as pending', () => {
    render(
      <PipelineTimeline
        steps={[
          step(0, ['list_tasks']),
          step(1, ['create_task'], { requiresApproval: true, pendingApprovals: 1 }),
        ]}
        pipelineState={state('running')}
        isLoading={false}
        onStop={() => {}}
      />,
    );
    const items = rows();
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual([
      'completed',
      'pending',
    ]);
    expect(items[1].querySelector('[data-element="icon"]')?.getAttribute('data-icon')).toBe('pending');
    expect(items[1].textContent).toContain('Freigabe ausstehend');
  });

  it('expands a step to show its summary', () => {
    render(
      <PipelineTimeline
        steps={[step(0, ['list_tasks']), step(1, ['create_task'])]}
        pipelineState={state('completed')}
        isLoading={false}
        onStop={() => {}}
      />,
    );
    const details = rows()[1].querySelector('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText('Aufgabe anlegen'));
    expect(details.open).toBe(true);
    expect(details.querySelector('[data-element="detail"]')?.textContent).toContain('Summary 1');
  });

  it('offers the stop button while loading', () => {
    const onStop = vi.fn();
    render(
      <PipelineTimeline
        steps={[step(0, ['list_tasks']), step(1, ['create_task'])]}
        pipelineState={state('running')}
        isLoading
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByText('Stopp'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
