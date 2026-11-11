import { APICallError, generateText, stepCountIs, tool, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { TOOLS_PATHS } from '../codegen/tools/config.js';
import { stepCostUsd } from './openrouter.js';
import { Workspace, WorkspaceRefusal } from './workspace.js';

/**
 * The headless skill runner of the managed job (spec 4.6): it runs the skills
 * the local coding agent uses through an ai@6 tool loop. The skills are the
 * instructions. The runner leads: a plan hands out one small task after the
 * other (the resolve list, then a few tools of one module), each in a fresh
 * conversation with only its own work list, so the context stays small, a
 * finished task stays written and the model ending early ends one task only.
 */

/** Steps of one task. */
export const MAX_JOB_STEPS = 60;
/** Tasks of one job; the budget and the deadline normally end it earlier. */
export const MAX_JOB_TASKS = 120;
/** Explicit, so a provider default never cuts a tool call short. */
export const MAX_OUTPUT_TOKENS = 16_000;
/** The only words the runner adds to the skills: nobody answers a question in CI. */
export const HEADLESS_INSTRUCTIONS = 'No developer is present. Work every item of these work lists now, without asking, '
  + 'then stop. Add entries with upsert_semantics and upsert_resolutions; they keep every other entry of the file. '
  + 'Leave items owned by the developer open.';
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

/** One unit of work: the work lists as the CLI prints them, cut down to this task's items. */
export interface JobTask {
  id: string;
  worklists: Record<string, unknown>;
  /** Open items of the task, for the report. */
  open: number;
}

/** Hands out the next task from the current state of the repository; `null` when nothing is left. */
export interface JobPlan {
  next(): Promise<JobTask | null>;
}

/** Content-free facts about one finished task, for the CI log. */
export interface TaskReport {
  id: string;
  open: number;
  steps: number;
  finishReason: string;
  repaired: boolean;
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
  /** Tasks the runner started. */
  tasks: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
    upsert_semantics: tool({
      description: `Add or replace entries of ${TOOLS_PATHS.semantics} by stableKey. Fields you send replace the stored ones, every other field and entry stays. Use this instead of write_file for that file.`,
      inputSchema: z.object({ entries: z.array(z.record(z.string(), z.unknown())).min(1).max(20) }),
      execute: ({ entries }) => refusalSafe(async () => {
        if (entries.some((entry) => typeof entry.stableKey !== 'string' || entry.stableKey === '')) {
          throw new WorkspaceRefusal('write_invalid_json');
        }
        return workspace.updateJson(TOOLS_PATHS.semantics, (current) => {
          const stored = Array.isArray(current.tools) ? [...current.tools as Array<Record<string, unknown>>] : [];
          for (const entry of entries) {
            const index = stored.findIndex((candidate) => isRecord(candidate) && candidate.stableKey === entry.stableKey);
            if (index < 0) {
              stored.push(entry);
              continue;
            }
            const previous = stored[index]!;
            stored[index] = {
              ...previous,
              ...entry,
              ...(isRecord(previous.origin) && isRecord(entry.origin) ? { origin: { ...previous.origin, ...entry.origin } } : {}),
            };
          }
          return { schemaVersion: 1, ...current, tools: stored };
        });
      }),
    }),
    upsert_resolutions: tool({
      description: `Add or replace entries of ${TOOLS_PATHS.resolutions}, keyed by stableKey; every other entry stays. Use this instead of write_file for that file.`,
      inputSchema: z.object({ entries: z.record(z.string().min(1).max(2_100), z.record(z.string(), z.unknown())) }),
      execute: ({ entries }) => refusalSafe(() => workspace.updateJson(TOOLS_PATHS.resolutions, (current) => ({
        schemaVersion: 1,
        ...current,
        tools: { ...(isRecord(current.tools) ? current.tools : {}), ...entries },
      }))),
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
  plan: JobPlan;
  workspace: Workspace;
  tools: JobTools;
  budgetUsd: number;
  deadline: Date;
  now?: () => Date;
  maxSteps?: number;
  onTask?: (report: TaskReport) => void;
}): Promise<SkillJobResult> {
  const now = input.now ?? (() => new Date());
  const remaining = input.deadline.getTime() - now().getTime() - DEADLINE_MARGIN_MS;
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 as number | null };
  let servedModel = input.modelId;
  let tasks = 0;
  if (remaining <= 0) {
    return { outcome: 'timed_out', reasonCode: 'job_deadline', repairRounds: 0, servedModel, usage, tasks };
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
  let repairRounds: 0 | 1 = 0;
  let refresh: RefreshSummary | undefined;
  /** Entries an earlier task left rejected; a later task does not pay for them again. */
  const knownRejected = new Set<string>();
  const result = () => ({ repairRounds, servedModel, usage, ...(refresh ? { refresh } : {}), tasks });
  try {
    while (tasks < MAX_JOB_TASKS && !spent() && !signal.aborted) {
      const task = await input.plan.next();
      if (!task) break;
      tasks += 1;
      let messages: ModelMessage[] = [{
        role: 'user',
        content: JSON.stringify({ instructions: HEADLESS_INSTRUCTIONS, worklists: task.worklists }),
      }];
      let steps = 0;
      let finishReason = 'unknown';
      let repaired = false;
      for (;;) {
        const round = await generateText({
          model: input.model, system, messages, tools, stopWhen, abortSignal: signal, maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        add(round.steps);
        steps += round.steps.length;
        finishReason = round.finishReason;
        servedModel = round.response.modelId || servedModel;
        refresh = await input.tools.refresh();
        const rejected = refresh.findings
          .filter((finding) => finding.code === 'resolution-rejected' && !knownRejected.has(finding.subjectRef));
        if (rejected.length === 0 || repaired || spent() || signal.aborted) break;
        repaired = true;
        repairRounds = 1;
        messages = [
          ...messages,
          ...round.response.messages,
          { role: 'user', content: JSON.stringify({ rejected }) },
        ];
      }
      for (const finding of refresh.findings) if (finding.code === 'resolution-rejected') knownRejected.add(finding.subjectRef);
      input.onTask?.({ id: task.id, open: task.open, steps, finishReason, repaired });
    }
  } catch (error) {
    return { ...failure(error, signal), ...result() };
  }
  if (spent()) return { outcome: 'budget_stopped', reasonCode: 'job_budget_reached', ...result() };
  if (signal.aborted) return { outcome: 'timed_out', reasonCode: 'job_deadline', ...result() };
  return { outcome: 'completed', ...result() };
}
