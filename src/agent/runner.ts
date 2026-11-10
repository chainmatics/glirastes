import { APICallError, generateText, stepCountIs, tool, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { stepCostUsd } from './openrouter.js';
import { Workspace, WorkspaceRefusal } from './workspace.js';

/**
 * The headless skill runner of the managed job (spec 4.6): it runs the skills
 * the local coding agent uses, with the work list as the task, through an
 * ai@6 tool loop. The skills are the instructions; the runner adds no prompt
 * of its own, only the work list as data and the sandboxed tools.
 */

export const MAX_JOB_STEPS = 60;
/** Margin before the job key expires, so the ledger still reaches the Platform. */
const DEADLINE_MARGIN_MS = 3 * 60_000;

export interface JobSkill {
  name: string;
  text: string;
}

export interface RefreshSummary {
  /** Findings of the refresh, `resolution-rejected` among them; codes and subjects only. */
  findings: Array<{ code: string; subjectRef: string; message: string }>;
  changed: number;
}

export interface JobTools {
  refresh(): Promise<RefreshSummary>;
  evaluate(): Promise<{ failed: number; failures: unknown[] }>;
}

export type SkillJobOutcome = 'completed' | 'budget_stopped' | 'timed_out' | 'failed';

export interface SkillJobResult {
  outcome: SkillJobOutcome;
  reasonCode?: string;
  repairRounds: 0 | 1;
  servedModel: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** Findings of the last refresh the runner ran. */
  refresh?: RefreshSummary;
}

function refusalSafe<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  return run().catch((error: unknown) => {
    if (error instanceof WorkspaceRefusal) return { error: error.code };
    throw error;
  });
}

export function jobTools(workspace: Workspace, tools: JobTools) {
  return {
    list_files: tool({
      description: 'List files of the repository (relative paths; directories end with /).',
      inputSchema: z.object({ dir: z.string().max(500).optional(), recursive: z.boolean().optional() }),
      execute: ({ dir, recursive }) => refusalSafe(() => workspace.listFiles(dir ?? '', recursive ?? false)),
    }),
    read_file: tool({
      description: 'Read one repository file (at most 64 KB; secrets are redacted).',
      inputSchema: z.object({ path: z.string().min(1).max(500) }),
      execute: ({ path }) => refusalSafe(() => workspace.readFile(path)),
    }),
    grep: tool({
      description: 'Find lines that contain a literal text in the repository.',
      inputSchema: z.object({ text: z.string().min(2).max(200), dir: z.string().max(500).optional() }),
      execute: ({ text, dir }) => refusalSafe(() => workspace.grep(text, dir ?? '')),
    }),
    write_file: tool({
      description: 'Write a whole file: .glirastes/tool-resolutions.json, .glirastes/tool-semantics.json or a contract file the work list names.',
      inputSchema: z.object({ path: z.string().min(1).max(500), content: z.string().max(512 * 1024) }),
      execute: ({ path, content }) => refusalSafe(() => workspace.writeFile(path, content)),
    }),
    run_refresh: tool({
      description: 'Run glirastes tools refresh and return its findings (resolution-rejected names entries the generator ignored).',
      inputSchema: z.object({}),
      execute: () => tools.refresh(),
    }),
    run_eval: tool({
      description: 'Run glirastes tools eval and return the example sentences that do not find their tool.',
      inputSchema: z.object({}),
      execute: () => tools.evaluate(),
    }),
  };
}

function totals(steps: ReadonlyArray<{ usage: { inputTokens?: number; outputTokens?: number }; response?: { body?: unknown } }>) {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  for (const step of steps) {
    inputTokens += step.usage.inputTokens ?? 0;
    outputTokens += step.usage.outputTokens ?? 0;
    const cost = stepCostUsd(step);
    costUsd = cost === undefined || costUsd === null ? null : costUsd + cost;
  }
  return { inputTokens, outputTokens, costUsd };
}

function failure(error: unknown, signal: AbortSignal): { outcome: SkillJobOutcome; reasonCode: string } {
  if (signal.aborted) return { outcome: 'timed_out', reasonCode: 'job_deadline' };
  if (APICallError.isInstance(error) && error.statusCode === 402) {
    return { outcome: 'budget_stopped', reasonCode: 'key_limit_reached' };
  }
  if (APICallError.isInstance(error)) return { outcome: 'failed', reasonCode: `model_http_${error.statusCode ?? 0}` };
  return { outcome: 'failed', reasonCode: 'model_error' };
}

export async function runSkillJob(input: {
  model: LanguageModel;
  modelId: string;
  skills: ReadonlyArray<JobSkill>;
  /** The work lists exactly as `tools resolve --print` and `tools describe --print` print them. */
  worklists: Record<string, unknown>;
  workspace: Workspace;
  tools: JobTools;
  budgetUsd: number;
  deadline: Date;
  now?: () => Date;
  maxSteps?: number;
}): Promise<SkillJobResult> {
  const now = input.now ?? (() => new Date());
  const remaining = input.deadline.getTime() - now().getTime() - DEADLINE_MARGIN_MS;
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 as number | null };
  let servedModel = input.modelId;
  if (remaining <= 0) {
    return { outcome: 'timed_out', reasonCode: 'job_deadline', repairRounds: 0, servedModel, usage };
  }
  const signal = AbortSignal.timeout(remaining);
  const tools = jobTools(input.workspace, input.tools);
  const system = input.skills.map((skill) => skill.text).join('\n\n');
  const spent = () => usage.costUsd !== null && usage.costUsd >= input.budgetUsd;
  const add = (steps: Parameters<typeof totals>[0]) => {
    const round = totals(steps);
    usage.inputTokens += round.inputTokens;
    usage.outputTokens += round.outputTokens;
    usage.costUsd = usage.costUsd === null || round.costUsd === null ? null : usage.costUsd + round.costUsd;
  };
  const stopWhen = [
    stepCountIs(input.maxSteps ?? MAX_JOB_STEPS),
    ({ steps }: { steps: Parameters<typeof totals>[0] }) => {
      const round = totals(steps);
      return round.costUsd !== null && usage.costUsd !== null && usage.costUsd + round.costUsd >= input.budgetUsd;
    },
  ];
  let messages: ModelMessage[] = [{ role: 'user', content: JSON.stringify({ worklists: input.worklists }) }];
  let repairRounds: 0 | 1 = 0;
  let refresh: RefreshSummary | undefined;
  try {
    for (;;) {
      const result = await generateText({ model: input.model, system, messages, tools, stopWhen, abortSignal: signal });
      add(result.steps);
      servedModel = result.response.modelId || servedModel;
      refresh = await input.tools.refresh();
      const rejected = refresh.findings.filter((finding) => finding.code === 'resolution-rejected');
      if (rejected.length === 0 || repairRounds === 1 || spent() || signal.aborted) break;
      repairRounds = 1;
      messages = [
        ...messages,
        ...result.response.messages,
        { role: 'user', content: JSON.stringify({ rejected }) },
      ];
    }
  } catch (error) {
    return { ...failure(error, signal), repairRounds, servedModel, usage, ...(refresh ? { refresh } : {}) };
  }
  if (spent()) {
    return { outcome: 'budget_stopped', reasonCode: 'job_budget_reached', repairRounds, servedModel, usage, ...(refresh ? { refresh } : {}) };
  }
  return { outcome: 'completed', repairRounds, servedModel, usage, ...(refresh ? { refresh } : {}) };
}
