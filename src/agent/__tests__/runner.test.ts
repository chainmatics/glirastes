import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSkillJob, type JobTools, type RefreshSummary } from '../runner.js';
import { Workspace } from '../workspace.js';

const MODEL = 'anthropic/claude-sonnet-5.5';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const DEADLINE = new Date('2026-10-22T13:00:00.000Z');
const SKILLS = [
  { name: 'maintaining-glirastes-tools', text: '# maintaining-glirastes-tools\nWork the resolve list.' },
  { name: 'describing-glirastes-tools', text: '# describing-glirastes-tools\nWork the describe list.' },
];
const WORKLISTS = { describe: { kind: 'describe', items: [{ stableKey: 'GET /api/tasks', gaps: ['description-templated'] }] } };
const SEMANTICS = JSON.stringify({ schemaVersion: 1, tools: { 'GET /api/tasks': { description: 'Lists the tasks.' } } });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glirastes-runner-'));
  await mkdir(join(root, '.glirastes'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/route.ts'), 'export async function GET() {}\n');
  await writeFile(join(root, '.glirastes/tool-semantics.json'), '{"schemaVersion":1,"tools":{}}\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

type Step = { calls?: Array<{ name: string; input: Record<string, unknown> }>; cost?: number };

function scripted(steps: Step[]) {
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      const calls = step.calls ?? [];
      return {
        content: calls.length > 0
          ? calls.map((call, position) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${index}-${position}`,
            toolName: call.name,
            input: JSON.stringify(call.input),
          }))
          : [{ type: 'text' as const, text: 'Fertig.' }],
        finishReason: { unified: calls.length > 0 ? 'tool-calls' as const : 'stop' as const, raw: undefined },
        usage: usage(100, 10),
        warnings: [],
        response: { id: `gen-${index}`, modelId: MODEL, timestamp: NOW, ...(step.cost === undefined ? {} : { body: { usage: { cost: step.cost } } }) },
      };
    },
  });
  return model;
}

function tools(refreshes: RefreshSummary[]): JobTools & { refresh: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    refresh: vi.fn(async () => refreshes[Math.min(index++, refreshes.length - 1)]!),
    evaluate: vi.fn(async () => ({ failed: 0, failures: [] })),
  };
}

function workspace() {
  return new Workspace({
    root,
    isIgnored: async () => new Set(),
    writableFiles: ['.glirastes/tool-resolutions.json', '.glirastes/tool-semantics.json'],
    creatableFiles: [],
  });
}

const clean: RefreshSummary = { findings: [], changed: 1 };
const rejected: RefreshSummary = {
  findings: [{ code: 'resolution-rejected', subjectRef: 'GET /api/tasks', message: 'unknown input key' }],
  changed: 0,
};

describe('managed skill runner', () => {
  it('runs the shipped skills headless with the work list as data and the sandboxed tools', async () => {
    const model = scripted([
      { calls: [{ name: 'read_file', input: { path: 'src/route.ts' } }], cost: 0.25 },
      { calls: [{ name: 'write_file', input: { path: '.glirastes/tool-semantics.json', content: SEMANTICS } }], cost: 0.5 },
      { cost: 0.125 },
    ]);
    const jobTools = tools([clean]);

    const result = await runSkillJob({
      model, modelId: MODEL, skills: SKILLS, worklists: WORKLISTS, workspace: workspace(),
      tools: jobTools, budgetUsd: 2, deadline: DEADLINE, now: () => NOW,
    });

    expect(result).toEqual({
      outcome: 'completed',
      repairRounds: 0,
      servedModel: MODEL,
      usage: { inputTokens: 300, outputTokens: 30, costUsd: 0.875 },
      refresh: clean,
    });
    const first = model.doGenerateCalls[0]!;
    expect(first.prompt[0]).toEqual({ role: 'system', content: `${SKILLS[0]!.text}\n\n${SKILLS[1]!.text}` });
    expect(first.prompt[1]).toEqual({ role: 'user', content: [{ type: 'text', text: JSON.stringify({ worklists: WORKLISTS }) }] });
    expect(first.tools?.map((definition) => definition.name).sort())
      .toEqual(['grep', 'list_files', 'read_file', 'run_eval', 'run_refresh', 'write_file']);
    expect(await readFile(join(root, '.glirastes/tool-semantics.json'), 'utf8')).toBe(`${SEMANTICS}\n`);
    expect(jobTools.refresh).toHaveBeenCalledTimes(1);
  });

  it('hands a refusal back to the model and goes on', async () => {
    const model = scripted([
      { calls: [{ name: 'read_file', input: { path: '.env' } }], cost: 0.01 },
      { cost: 0.01 },
    ]);

    const result = await runSkillJob({
      model, modelId: MODEL, skills: SKILLS, worklists: WORKLISTS, workspace: workspace(),
      tools: tools([clean]), budgetUsd: 2, deadline: DEADLINE, now: () => NOW,
    });

    const toolMessage = model.doGenerateCalls[1]!.prompt.find((message) => message.role === 'tool');
    expect(JSON.stringify(toolMessage)).toContain('path_denied');
    expect(result.outcome).toBe('completed');
  });

  it('repairs rejected entries once and never twice', async () => {
    const model = scripted([{ cost: 0.01 }]);
    const jobTools = tools([rejected, rejected, rejected]);

    const result = await runSkillJob({
      model, modelId: MODEL, skills: SKILLS, worklists: WORKLISTS, workspace: workspace(),
      tools: jobTools, budgetUsd: 2, deadline: DEADLINE, now: () => NOW,
    });

    expect([result.outcome, result.repairRounds, model.doGenerateCalls.length, jobTools.refresh.mock.calls.length])
      .toEqual(['completed', 1, 2, 2]);
    expect(model.doGenerateCalls[1]!.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify({ rejected: rejected.findings }) }],
    });
    expect(result.refresh).toEqual(rejected);
  });

  it('stops at the job budget, at the key limit and at the deadline', async () => {
    const run = (model: MockLanguageModelV3, now = NOW) => runSkillJob({
      model, modelId: MODEL, skills: SKILLS, worklists: WORKLISTS, workspace: workspace(),
      tools: tools([clean]), budgetUsd: 2, deadline: DEADLINE, now: () => now,
    });
    const spending = scripted([{ calls: [{ name: 'list_files', input: {} }], cost: 1.5 }]);
    const limited = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new APICallError({ message: 'Key limit', url: 'https://openrouter.ai/api/v1/chat/completions', requestBodyValues: {}, statusCode: 402, isRetryable: false });
      },
    });
    const idle = scripted([{ cost: 0 }]);

    const budget = await run(spending);
    const key = await run(limited);
    const late = await run(idle, new Date('2026-10-22T12:58:00.000Z'));

    expect([budget.outcome, budget.reasonCode, spending.doGenerateCalls.length, budget.usage.costUsd])
      .toEqual(['budget_stopped', 'job_budget_reached', 2, 3]);
    expect([key.outcome, key.reasonCode]).toEqual(['budget_stopped', 'key_limit_reached']);
    expect([late.outcome, late.reasonCode, idle.doGenerateCalls.length]).toEqual(['timed_out', 'job_deadline', 0]);
  });

  it('keeps an unknown cost unknown, never 0', async () => {
    const result = await runSkillJob({
      model: scripted([{ calls: [{ name: 'list_files', input: {} }], cost: 0.01 }, {}]),
      modelId: MODEL, skills: SKILLS, worklists: WORKLISTS, workspace: workspace(),
      tools: tools([clean]), budgetUsd: 2, deadline: DEADLINE, now: () => NOW,
    });

    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20, costUsd: null });
  });
});
